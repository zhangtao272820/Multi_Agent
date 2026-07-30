from __future__ import annotations

import json
import re
import smtplib
import imaplib
from email import message_from_bytes
from email.header import Header, decode_header
from email.mime.text import MIMEText
from email.utils import parseaddr
from typing import Any, Dict, List

from app.core.config import settings
from app.db.database import Contact, SessionLocal
from app.tools.common import (
    CONTACT_NOT_FOUND,
    _EMAIL_RE,
    _MAIL_CACHE_BY_SESSION,
    _tool_err,
    _tool_ok,
)

def _decode_mime_text(value: str) -> str:
    if not value:
        return ""
    parts = decode_header(value)
    decoded: List[str] = []
    for chunk, enc in parts:
        if isinstance(chunk, bytes):
            try:
                decoded.append(chunk.decode(enc or "utf-8", errors="replace"))
            except Exception:
                decoded.append(chunk.decode("utf-8", errors="replace"))
        else:
            decoded.append(str(chunk))
    return "".join(decoded).strip()


def _imap_credentials() -> tuple[str, int, str, str]:
    server = settings.IMAP_SERVER or settings.SMTP_SERVER.replace("smtp.", "imap.")
    port = settings.IMAP_PORT or 993
    user = settings.IMAP_USER or settings.SMTP_USER
    password = settings.IMAP_PASS or settings.SMTP_PASS
    return server, port, user, password


def _extract_body(msg) -> str:
    """从 MIME 消息提取可读正文（优先 plain）。"""
    if msg.is_multipart():
        plain_parts: list[str] = []
        html_parts: list[str] = []
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = str(part.get("Content-Disposition") or "")
            if "attachment" in disp.lower():
                continue
            try:
                payload = part.get_payload(decode=True)
                if not payload:
                    continue
                charset = part.get_content_charset() or "utf-8"
                text = payload.decode(charset, errors="replace")
            except Exception:
                continue
            if ctype == "text/plain":
                plain_parts.append(text)
            elif ctype == "text/html":
                html_parts.append(text)
        if plain_parts:
            return "\n\n".join(plain_parts).strip()
        if html_parts:
            import re

            html = html_parts[0]
            html = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html)
            html = re.sub(r"(?i)<br\s*/?>", "\n", html)
            html = re.sub(r"(?i)</p\s*>", "\n\n", html)
            html = re.sub(r"<[^>]+>", " ", html)
            html = re.sub(r"\s+\n", "\n", html)
            return re.sub(r"[ \t]+", " ", html).strip()
        return ""
    try:
        payload = msg.get_payload(decode=True)
        if not payload:
            return str(msg.get_payload() or "")
        charset = msg.get_content_charset() or "utf-8"
        return payload.decode(charset, errors="replace").strip()
    except Exception:
        return str(msg.get_payload() or "")


def get_email_detail(email_id: int, session_id: str = "default") -> dict:
    """读取单封邮件正文（需先 list_emails 写入 session 缓存）。"""
    sid = (session_id or "default").strip() or "default"
    cache = _MAIL_CACHE_BY_SESSION.get(sid, {})
    meta = cache.get(int(email_id))
    if not meta:
        return _tool_err(
            "未找到该邮件，请先刷新收件箱。",
            data={"email_id": email_id, "session_id": sid},
            code="email_not_found_in_cache",
        )

    imap_uid = meta.get("imap_uid")
    if not imap_uid:
        return _tool_err(
            "邮件缓存不完整，请刷新收件箱后重试。",
            data={"email_id": email_id},
            code="email_cache_stale",
        )

    server, port, user, password = _imap_credentials()
    if not user or not password:
        return _tool_err("IMAP 未配置。", code="imap_not_configured")

    try:
        mailbox = imaplib.IMAP4_SSL(server, port)
        mailbox.login(user, password)
        mailbox.select("INBOX", readonly=True)
        status, msg_data = mailbox.fetch(str(imap_uid).encode(), "(RFC822)")
        mailbox.logout()
        if status != "OK" or not msg_data or not msg_data[0]:
            return _tool_err("无法读取邮件正文。", code="imap_fetch_failed")

        raw = msg_data[0][1]
        msg = message_from_bytes(raw)
        from_name, from_email = parseaddr(msg.get("From", ""))
        from_name = _decode_mime_text(from_name)
        subject = _decode_mime_text(msg.get("Subject", "")) or meta.get("subject") or "(无主题)"
        date = msg.get("Date", "") or meta.get("date", "")
        body = _extract_body(msg)
        if len(body) > 12000:
            body = body[:12000] + "\n\n…（正文已截断）"

        sender = f"{from_name} <{from_email}>" if from_name else from_email
        detail = {
            "id": int(email_id),
            "sender": sender or meta.get("sender", ""),
            "from_email": from_email or meta.get("from_email", ""),
            "subject": subject,
            "date": date,
            "body": body or "（无正文）",
            "message_id": (msg.get("Message-ID") or meta.get("message_id") or "").strip(),
        }
        # A1：邮件正文不可信 — 结构化打标，禁止当指令
        from app.core.content_trust import mark_payload_untrusted, wrap_untrusted_content

        detail = mark_payload_untrusted(detail, "email")
        preview = wrap_untrusted_content(
            source="email",
            text=f"主题：{subject}\n发件人：{detail.get('sender')}\n\n{body or '（无正文）'}",
            max_chars=4000,
        )
        return _tool_ok(
            preview or f"邮件 #{email_id}：{subject}",
            data=detail,
            code="email_detail_ok",
        )
    except Exception as exc:
        return _tool_err(f"读取邮件失败：{exc}", code="imap_exception")


def send_email(to: str, subject: str, content: str) -> str:
    """真实发送邮件技能"""
    to = (to or "").strip()
    if to == _CONTACT_NOT_FOUND or not to:
        return _tool_err(
            "邮件未发送：未找到该联系人的邮箱，请先添加联系人或手动提供收件人邮箱。",
            data={"to": to, "subject": subject},
            code="contact_email_not_found",
        )
    if not _EMAIL_RE.match(to):
        human = (
            f"邮件未发送：收件人「{to}」不是有效邮箱。"
            f"若要通过姓名发信，请先调用 get_contact_email(name)，再将 send_email 的 to 设为 {{{{get_contact_email.result}}}}。"
        )
        return _tool_err(
            human,
            data={"to": to, "subject": subject},
            code="invalid_recipient_email",
        )

    # 仅允许向通讯录中已存在的邮箱地址发送，避免模型伪造收件人地址
    db = SessionLocal()
    contact = db.query(Contact).filter(Contact.email == to).first()
    db.close()
    if not contact:
        human = (
            f"邮件未发送：收件人邮箱「{to}」不在当前联系人列表中。"
            f"请先通过 add_contact 添加联系人，或确认后手动使用真实邮箱地址。"
        )
        return _tool_err(
            human,
            data={"to": to, "subject": subject},
            code="recipient_not_in_contacts",
        )

    if not settings.SMTP_USER or not settings.SMTP_PASS:
        return _tool_err(
            "邮件发送失败：未在环境变量中配置 SMTP_USER 或 SMTP_PASS。",
            data={"to": to, "subject": subject},
            code="smtp_not_configured",
        )

    try:
        # 创建邮件对象
        message = MIMEText(content, 'plain', 'utf-8')
        message['From'] = settings.SMTP_USER
        message['To'] = to
        message['Subject'] = Header(subject, 'utf-8')

        # 连接服务器并发送
        # 默认使用 SSL (端口 465)
        with smtplib.SMTP_SSL(settings.SMTP_SERVER, settings.SMTP_PORT) as server:
            server.login(settings.SMTP_USER, settings.SMTP_PASS)
            server.sendmail(settings.SMTP_USER, [to], message.as_string())

        if contact:
            from app.core.user_preferences import learn_email_contact

            learn_email_contact("default", contact.name, to)

        return _tool_ok(
            f"邮件发送成功！已向 {to} 发送主题为<{subject}>的邮件。",
            data={"to": to, "subject": subject},
        )
    except Exception as e:
        return _tool_err(
            f"邮件发送过程中出现错误: {str(e)}",
            data={"to": to, "subject": subject},
            code="smtp_send_failed",
        )

def list_emails(session_id: str = "default", limit: int = 10, unread_only: bool = True) -> str:
    server, port, user, password = _imap_credentials()
    if not user or not password or not server:
        return _tool_err(
            "收件箱读取失败：未配置 IMAP 账号。请在 .env 配置 IMAP_SERVER/IMAP_USER/IMAP_PASS。",
            data={"session_id": session_id, "limit": limit, "unread_only": unread_only},
            code="imap_not_configured",
        )

    sid = (session_id or "default").strip() or "default"
    limit = max(1, min(int(limit or 10), 30))
    criteria = "UNSEEN" if unread_only else "ALL"

    try:
        mailbox = imaplib.IMAP4_SSL(server, port)
        mailbox.login(user, password)
        mailbox.select("INBOX", readonly=True)
        status, data = mailbox.search(None, criteria)
        if status != "OK":
            mailbox.logout()
            return _tool_err(
                "收件箱读取失败：IMAP 搜索异常。",
                data={"session_id": sid, "criteria": criteria},
                code="imap_search_failed",
            )
        ids = data[0].split()
        if not ids:
            mailbox.logout()
            return _tool_ok(
                "收件箱为空。",
                data={"session_id": sid, "items": [], "count": 0, "criteria": criteria},
                code="empty",
            )

        selected_ids = list(reversed(ids))[:limit]
        lines = [f"收件箱邮件（{len(selected_ids)} 封，条件：{criteria}）："]
        cache: Dict[int, Dict[str, str]] = {}
        items = []

        for idx, msg_id_bytes in enumerate(selected_ids, start=1):
            status, msg_data = mailbox.fetch(msg_id_bytes, "(BODY.PEEK[HEADER])")
            if status != "OK" or not msg_data or not msg_data[0]:
                continue
            raw_header = msg_data[0][1]
            msg = message_from_bytes(raw_header)
            from_name, from_email = parseaddr(msg.get("From", ""))
            from_name = _decode_mime_text(from_name)
            subject = _decode_mime_text(msg.get("Subject", "")) or "(无主题)"
            date = msg.get("Date", "")
            message_id = (msg.get("Message-ID", "") or "").strip()
            sender = f"{from_name} <{from_email}>" if from_name else from_email
            lines.append(f"{idx}. 发件人: {sender} | 主题: {subject} | 时间: {date}")
            cache[idx] = {
                "from_email": from_email,
                "from_name": from_name,
                "subject": subject,
                "message_id": message_id,
                "date": date,
                "imap_uid": msg_id_bytes.decode() if isinstance(msg_id_bytes, bytes) else str(msg_id_bytes),
            }
            items.append(
                {
                    "id": idx,
                    "sender": sender,
                    "from_email": from_email,
                    "subject": subject,
                    "date": date,
                    "message_id": message_id,
                }
            )
        mailbox.logout()

        if not cache:
            return _tool_err(
                "收件箱读取成功，但没有可解析的邮件头。",
                data={"session_id": sid, "items": [], "count": 0},
                code="imap_no_parsed_headers",
            )

        _MAIL_CACHE_BY_SESSION[sid] = cache
        lines.append("可用 reply_email(email_id, content, session_id) 回复以上编号邮件。")
        return _tool_ok(
            "\n".join(lines),
            data={"session_id": sid, "items": items, "count": len(items), "criteria": criteria},
        )
    except Exception as e:
        return _tool_err(
            f"收件箱读取失败：{str(e)}",
            data={"session_id": sid, "criteria": criteria},
            code="imap_exception",
        )


def reply_email(email_id: int, content: str, session_id: str = "default") -> str:
    sid = (session_id or "default").strip() or "default"
    cache = _MAIL_CACHE_BY_SESSION.get(sid, {})
    meta = cache.get(int(email_id))
    if not meta:
        return _tool_err(
            "回复失败：未找到该邮件编号。请先调用 list_emails 获取最新编号。",
            data={"email_id": email_id, "session_id": sid},
            code="email_not_found_in_cache",
        )

    to = (meta.get("from_email") or "").strip()
    if not to or not _EMAIL_RE.match(to):
        return _tool_err(
            f"回复失败：邮件编号 {email_id} 对应发件人地址无效。",
            data={"email_id": email_id, "to": to},
            code="invalid_sender_email",
        )
    if not settings.SMTP_USER or not settings.SMTP_PASS:
        return _tool_err(
            "回复失败：未在环境变量中配置 SMTP_USER 或 SMTP_PASS。",
            data={"email_id": email_id, "to": to},
            code="smtp_not_configured",
        )

    raw_subject = (meta.get("subject") or "").strip() or "(无主题)"
    subject = raw_subject if raw_subject.lower().startswith("re:") else f"Re: {raw_subject}"
    message_id = (meta.get("message_id") or "").strip()
    try:
        message = MIMEText(content or "", "plain", "utf-8")
        message["From"] = settings.SMTP_USER
        message["To"] = to
        message["Subject"] = Header(subject, "utf-8")
        if message_id:
            message["In-Reply-To"] = message_id
            message["References"] = message_id

        with smtplib.SMTP_SSL(settings.SMTP_SERVER, settings.SMTP_PORT) as server:
            server.login(settings.SMTP_USER, settings.SMTP_PASS)
            server.sendmail(settings.SMTP_USER, [to], message.as_string())
        return _tool_ok(
            f"邮件回复成功！已回复编号 {email_id}（{to}）。",
            data={"email_id": email_id, "to": to, "subject": subject},
        )
    except Exception as e:
        return _tool_err(
            f"邮件回复失败：{str(e)}",
            data={"email_id": email_id, "to": to, "subject": subject},
            code="smtp_reply_failed",
        )


def draft_email_reply(
    email_id: int,
    hint: str = "",
    tone: str = "",
    session_id: str = "default",
) -> dict:
    """只起草回复正文，不发信、不走发送闸。返回 draft_content 供前端回填快速回复框。"""
    from app.core.llm import qwen_llm

    sid = (session_id or "default").strip() or "default"
    cache = _MAIL_CACHE_BY_SESSION.get(sid, {})
    meta = cache.get(int(email_id))
    if not meta:
        # 尝试拉详情
        detail = get_email_detail(int(email_id), session_id=sid)
        if isinstance(detail, dict) and detail.get("ok"):
            data = detail.get("data") or {}
            meta = {
                "from_email": data.get("from_email") or data.get("sender") or "",
                "subject": data.get("subject") or "",
                "snippet": (data.get("body") or "")[:800],
            }
        else:
            return _tool_err(
                "起草失败：未找到该邮件编号。请先调用 list_emails 或打开邮件详情。",
                data={"email_id": email_id, "session_id": sid},
                code="email_not_found_in_cache",
            )

    subject = (meta.get("subject") or "").strip() or "(无主题)"
    sender = (meta.get("from_email") or meta.get("sender") or "").strip()
    snippet = (meta.get("snippet") or meta.get("preview") or "").strip()[:800]
    guide = str(hint or tone or "").strip() or "根据邮件内容起草得体回复"
    prompt = f"""你是邮件回复起草助手。根据下列邮件起草一段纯文本回复正文（不要主题行、不要解释）。
语气/要求：{guide}
发件人：{sender}
主题：{subject}
正文摘要：
{snippet or '（无摘要）'}
只输出回复正文。"""
    try:
        draft = str(qwen_llm.chat_text([{"role": "user", "content": prompt}]) or "").strip()
    except Exception as e:
        return _tool_err(
            f"起草失败：{e}",
            data={"email_id": email_id},
            code="draft_llm_failed",
        )
    if not draft:
        return _tool_err(
            "起草失败：模型未返回正文。",
            data={"email_id": email_id},
            code="draft_empty",
        )
    return _tool_ok(
        f"已起草邮件 #{email_id} 的回复（未发送），可在快速回复框确认后发送。",
        data={
            "email_id": email_id,
            "draft_content": draft,
            "mail_draft": {"email_id": email_id, "content": draft},
            "subject": subject,
            "to": sender,
        },
        code="mail_draft_ok",
    )


def classify_emails(session_id: str = "default", limit: int = 20) -> dict:
    """读取收件箱并用 LLM 打标签：工作 / 社交 / 通知 / 广告 / 其他。"""
    import json

    from app.core.llm import qwen_llm

    mail_result = list_emails(session_id=session_id, limit=limit, unread_only=False)
    if isinstance(mail_result, dict):
        if not mail_result.get("ok"):
            return mail_result
        items = (mail_result.get("data") or {}).get("items") or []
        if not items:
            return _tool_ok(
                "收件箱为空，无需分类。",
                data={"items": [], "stats": {}, "session_id": session_id},
                code="empty",
            )
    else:
        text = str(mail_result)
        if "收件箱读取失败" in text or "收件箱为空" in text:
            return _tool_err(text, code="imap_failed" if "失败" in text else "empty")
        return _tool_err("邮件列表格式异常，无法分类。", code="invalid_mail_list")

    lines = []
    for item in items[:20]:
        if not isinstance(item, dict):
            continue
        lines.append(
            f"id={item.get('id')}; 发件人={item.get('sender', '')}; 主题={item.get('subject', '')}"
        )
    if not lines:
        return _tool_ok("没有可分类的邮件。", data={"items": [], "stats": {}}, code="empty")

    prompt = f"""
你是邮件分类器。请为下列邮件各打一个标签，标签只能是：工作、社交、通知、广告、其他。
只输出 JSON 数组，每项格式：{{"id": 数字, "label": "标签"}}
不要输出其它文字。

邮件列表：
{chr(10).join(lines)}
"""
    try:
        raw = qwen_llm.chat_text([{"role": "user", "content": prompt}])
        text = raw.strip()
        if "```json" in text:
            text = text.split("```json", 1)[1].split("```", 1)[0].strip()
        elif "```" in text:
            text = text.split("```", 1)[1].split("```", 1)[0].strip()
        labels = json.loads(text)
        if not isinstance(labels, list):
            raise ValueError("分类结果不是数组")
    except Exception as e:
        return _tool_err(
            f"邮件分类失败：{e}",
            data={"session_id": session_id, "mail_count": len(items)},
            code="classify_failed",
        )

    label_by_id: dict[int, str] = {}
    for row in labels:
        if not isinstance(row, dict):
            continue
        try:
            eid = int(row.get("id"))
            label = str(row.get("label") or "其他").strip()
            if label not in ("工作", "社交", "通知", "广告", "其他"):
                label = "其他"
            label_by_id[eid] = label
        except (TypeError, ValueError):
            continue

    stats: dict[str, int] = {}
    classified = []
    for item in items:
        eid = int(item.get("id", 0) or 0)
        label = label_by_id.get(eid, "其他")
        stats[label] = stats.get(label, 0) + 1
        classified.append({**item, "label": label})

    stat_lines = [f"- {k}：{v} 封" for k, v in sorted(stats.items(), key=lambda x: -x[1])]
    human = "邮件分类统计：\n" + "\n".join(stat_lines)
    detail_lines = [f"[{c.get('id')}] {c.get('label')} | {c.get('subject', '')}" for c in classified[:15]]
    if detail_lines:
        human += "\n\n明细（前15封）：\n" + "\n".join(detail_lines)

    return _tool_ok(
        human,
        data={
            "session_id": session_id,
            "stats": stats,
            "items": classified,
            "count": len(classified),
        },
    )

