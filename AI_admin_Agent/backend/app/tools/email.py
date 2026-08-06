"""邮件动手：按用户绑定凭据的 IMAP/SMTP 读写。"""
from __future__ import annotations

import json
import re
import smtplib
import imaplib
from email import message_from_bytes
from email.header import Header, decode_header
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate, parseaddr
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.core.mailbox_binding import folder_name, resolve_mail_credentials
from app.core.mail_metrics import mail_metric_inc
from app.db.database import Contact, SessionLocal
from app.tools.common import (
    CONTACT_NOT_FOUND,
    get_mail_cache,
    set_mail_cache,
    _EMAIL_RE,
    _tool_err,
    _tool_ok,
)
from app.tools.files import _resolve_workspace_path, _workspace_root

_CONTACT_NOT_FOUND = CONTACT_NOT_FOUND


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


def _require_creds(user_id: str | None):
    creds, err = resolve_mail_credentials(user_id)
    if err or not creds:
        return None, _tool_err(
            "邮箱未绑定：请先在「连接邮箱」中绑定国内邮箱（QQ/163/126/企业邮）授权码。"
            "本地开发可设 ADMIN_MAIL_ALLOW_GLOBAL_FALLBACK=1 回退 .env。",
            data={"user_id": str(user_id or "")},
            code=err or "email_not_bound",
        )
    return creds, None


def _imap_credentials(user_id: str | None = None) -> tuple[str, int, str, str]:
    """Back-compat helper used by email_attachments; prefers per-user binding."""
    creds, err = resolve_mail_credentials(user_id)
    if creds:
        return creds.imap_server, creds.imap_port, creds.email_address, creds.auth_code
    return "", 993, "", ""


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


def _resolve_mailbox_folder(provider: str, mailbox: str = "") -> str:
    raw = str(mailbox or "").strip()
    if not raw or raw.upper() == "INBOX":
        return folder_name(provider, "inbox")
    key = raw.lower()
    if key in ("inbox", "收件箱"):
        return folder_name(provider, "inbox")
    if key in ("sent", "已发送", "sent messages"):
        return folder_name(provider, "sent")
    if key in ("drafts", "草稿", "draft"):
        return folder_name(provider, "drafts")
    if key in ("trash", "废纸篓", "deleted", "junk"):
        return folder_name(provider, "trash")
    return raw


def _parse_addr_list(raw: str) -> list[str]:
    parts = re.split(r"[,;，；\s]+", str(raw or "").strip())
    out: list[str] = []
    for p in parts:
        addr = p.strip()
        if addr and _EMAIL_RE.match(addr):
            out.append(addr)
    return out


def _recipient_allowed(to: str) -> tuple[bool, str, Optional[Contact]]:
    """通讯录命中或显式合法邮箱均可（发信仍走 RISKY HITL）。"""
    db = SessionLocal()
    try:
        contact = db.query(Contact).filter(Contact.email == to).first()
    finally:
        db.close()
    if contact:
        return True, "contacts", contact
    if _EMAIL_RE.match(to):
        return True, "explicit_email", None
    return False, "invalid", None


def _attach_workspace_files(message: MIMEMultipart, paths: list[str]) -> list[str]:
    attached: list[str] = []
    for raw in paths[:8]:
        rel = str(raw or "").strip().replace("\\", "/")
        if not rel:
            continue
        target = _resolve_workspace_path(rel, allow_missing=False)
        if target is None or not target.is_file():
            continue
        if _workspace_root() not in target.resolve().parents and target.resolve() != _workspace_root():
            # must stay under workspace
            try:
                target.resolve().relative_to(_workspace_root().resolve())
            except Exception:
                continue
        data = target.read_bytes()
        part = MIMEApplication(data, Name=target.name)
        part["Content-Disposition"] = f'attachment; filename="{target.name}"'
        message.attach(part)
        attached.append(str(target.name))
    return attached


def get_email_detail(email_id: int, session_id: str = "default", user_id: str = "") -> dict:
    """读取单封邮件正文（需先 list_emails 写入 session 缓存）。"""
    sid = (session_id or "default").strip() or "default"
    uid = str(user_id or "").strip()
    cache = get_mail_cache(uid, sid)
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

    creds, err = _require_creds(uid)
    if err:
        return err

    folder = meta.get("mailbox") or folder_name(creds.provider, "inbox")
    try:
        mailbox = imaplib.IMAP4_SSL(creds.imap_server, creds.imap_port)
        mailbox.login(creds.email_address, creds.auth_code)
        mailbox.select(folder, readonly=True)
        status, msg_data = mailbox.fetch(str(imap_uid).encode(), "(RFC822)")
        mailbox.logout()
        if status != "OK" or not msg_data or not msg_data[0]:
            return _tool_err("无法读取邮件正文。", code="imap_fetch_failed")
        msg = message_from_bytes(msg_data[0][1])
        body = _extract_body(msg)
        from_name, from_email = parseaddr(msg.get("From", ""))
        subject = _decode_mime_text(msg.get("Subject", "")) or meta.get("subject") or "(无主题)"
        return _tool_ok(
            f"邮件 #{email_id}：{subject}\n\n{body[:8000]}",
            data={
                "email_id": int(email_id),
                "subject": subject,
                "from_email": from_email or meta.get("from_email"),
                "from_name": _decode_mime_text(from_name) or meta.get("from_name"),
                "body": body,
                "date": msg.get("Date") or meta.get("date"),
                "message_id": (msg.get("Message-ID") or meta.get("message_id") or "").strip(),
            },
        )
    except Exception as e:
        return _tool_err(f"读取邮件失败：{e}", code="imap_exception")


def send_email(
    to: str,
    subject: str,
    content: str,
    session_id: str = "default",
    user_id: str = "",
    cc: str = "",
    bcc: str = "",
    attachment_paths: list | str = "",
) -> str:
    """发送新邮件（RISKY）。收件人可为通讯录或显式合法邮箱。"""
    to = (to or "").strip()
    subject = (subject or "").strip()
    content = content or ""
    uid = str(user_id or "").strip()

    if to == _CONTACT_NOT_FOUND or not to:
        return _tool_err(
            "邮件未发送：收件人无效。"
            f"若要通过姓名发信，请先调用 get_contact_email(name)，再将 send_email 的 to 设为 {{{{get_contact_email.result}}}}。",
            data={"to": to, "subject": subject},
            code="invalid_recipient",
        )

    if not _EMAIL_RE.match(to):
        return _tool_err(
            f"邮件未发送：收件人「{to}」不是合法邮箱地址。",
            data={"to": to, "subject": subject},
            code="invalid_recipient_email",
        )

    allowed, source, contact = _recipient_allowed(to)
    if not allowed:
        return _tool_err(
            f"邮件未发送：收件人邮箱「{to}」无效。",
            data={"to": to, "subject": subject},
            code="recipient_not_allowed",
        )

    creds, err = _require_creds(uid)
    if err:
        return err

    cc_list = _parse_addr_list(cc)
    bcc_list = _parse_addr_list(bcc)
    paths: list[str] = []
    if isinstance(attachment_paths, str) and attachment_paths.strip():
        try:
            parsed = json.loads(attachment_paths)
            if isinstance(parsed, list):
                paths = [str(x) for x in parsed]
            else:
                paths = [p for p in re.split(r"[,;]", attachment_paths) if p.strip()]
        except Exception:
            paths = [p for p in re.split(r"[,;]", attachment_paths) if p.strip()]
    elif isinstance(attachment_paths, list):
        paths = [str(x) for x in attachment_paths]

    try:
        if paths:
            message: MIMEMultipart | MIMEText = MIMEMultipart()
            message.attach(MIMEText(content, "plain", "utf-8"))
            attached = _attach_workspace_files(message, paths)
        else:
            message = MIMEText(content, "plain", "utf-8")
            attached = []
        message["From"] = creds.email_address
        message["To"] = to
        if cc_list:
            message["Cc"] = ", ".join(cc_list)
        message["Subject"] = Header(subject, "utf-8")
        message["Date"] = formatdate(localtime=True)

        recipients = [to] + cc_list + bcc_list
        with smtplib.SMTP_SSL(creds.smtp_server, creds.smtp_port) as server:
            server.login(creds.email_address, creds.auth_code)
            server.sendmail(creds.email_address, recipients, message.as_string())

        mail_metric_inc("mail_send")
        if contact:
            from app.core.user_preferences import learn_email_contact

            learn_email_contact(uid or "default", contact.name, to)

        return _tool_ok(
            f"邮件发送成功！已从 {creds.email_address} 向 {to} 发送主题为<{subject}>的邮件。",
            data={
                "to": to,
                "cc": cc_list,
                "bcc": bcc_list,
                "subject": subject,
                "from": creds.email_address,
                "recipient_source": source,
                "attachments": attached,
                "preview": {
                    "to": to,
                    "cc": cc_list,
                    "subject": subject,
                    "body": content[:2000],
                    "from": creds.email_address,
                },
            },
        )
    except Exception as e:
        return _tool_err(
            f"邮件发送过程中出现错误: {str(e)}",
            data={"to": to, "subject": subject},
            code="smtp_send_failed",
        )


def list_emails(
    session_id: str = "default",
    limit: int = 10,
    unread_only: bool = True,
    user_id: str = "",
    mailbox: str = "INBOX",
) -> str:
    uid = str(user_id or "").strip()
    creds, err = _require_creds(uid)
    if err:
        return err

    sid = (session_id or "default").strip() or "default"
    limit = max(1, min(int(limit or 10), 30))
    criteria = "UNSEEN" if unread_only else "ALL"
    folder = _resolve_mailbox_folder(creds.provider, mailbox)

    try:
        mailbox_conn = imaplib.IMAP4_SSL(creds.imap_server, creds.imap_port)
        mailbox_conn.login(creds.email_address, creds.auth_code)
        mailbox_conn.select(folder, readonly=True)
        status, data = mailbox_conn.search(None, criteria)
        if status != "OK":
            mailbox_conn.logout()
            return _tool_err(
                "收件箱读取失败：IMAP 搜索异常。",
                data={"session_id": sid, "criteria": criteria, "mailbox": folder},
                code="imap_search_failed",
            )
        ids = data[0].split()
        if not ids:
            mailbox_conn.logout()
            mail_metric_inc("mail_list")
            return _tool_ok(
                f"{folder} 为空。",
                data={
                    "session_id": sid,
                    "user_id": uid,
                    "items": [],
                    "count": 0,
                    "criteria": criteria,
                    "mailbox": folder,
                    "from_account": creds.email_address,
                },
                code="empty",
            )

        selected_ids = list(reversed(ids))[:limit]
        lines = [
            f"邮箱 {creds.email_address} / {folder}（{len(selected_ids)} 封，条件：{criteria}）："
        ]
        cache: Dict[int, Dict[str, str]] = {}
        items = []

        for idx, msg_id_bytes in enumerate(selected_ids, start=1):
            status, msg_data = mailbox_conn.fetch(msg_id_bytes, "(BODY.PEEK[HEADER])")
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
                "mailbox": folder,
            }
            items.append(
                {
                    "id": idx,
                    "sender": sender,
                    "from_email": from_email,
                    "subject": subject,
                    "date": date,
                    "message_id": message_id,
                    "mailbox": folder,
                }
            )
        mailbox_conn.logout()

        if not cache:
            return _tool_err(
                "收件箱读取成功，但没有可解析的邮件头。",
                data={"session_id": sid, "items": [], "count": 0},
                code="imap_no_parsed_headers",
            )

        set_mail_cache(uid, sid, cache)
        mail_metric_inc("mail_list")
        lines.append("可用 reply_email(email_id, content) 回复以上编号邮件。")
        return _tool_ok(
            "\n".join(lines),
            data={
                "session_id": sid,
                "user_id": uid,
                "items": items,
                "count": len(items),
                "criteria": criteria,
                "mailbox": folder,
                "from_account": creds.email_address,
            },
        )
    except Exception as e:
        return _tool_err(
            f"收件箱读取失败：{str(e)}",
            data={"session_id": sid, "criteria": criteria},
            code="imap_exception",
        )


def search_emails(
    query: str = "",
    subject: str = "",
    from_addr: str = "",
    since: str = "",
    unread_only: bool = False,
    limit: int = 10,
    session_id: str = "default",
    user_id: str = "",
    mailbox: str = "INBOX",
) -> str:
    """IMAP SEARCH：SUBJECT/FROM/SINCE/UNSEEN 组合。"""
    uid = str(user_id or "").strip()
    creds, err = _require_creds(uid)
    if err:
        return err
    sid = (session_id or "default").strip() or "default"
    limit = max(1, min(int(limit or 10), 30))
    folder = _resolve_mailbox_folder(creds.provider, mailbox)

    parts: list[str] = []
    if unread_only:
        parts.append("UNSEEN")
    subj = (subject or query or "").strip()
    if subj:
        safe = subj.replace('"', "")
        parts.append(f'SUBJECT "{safe}"')
    fr = (from_addr or "").strip()
    if fr:
        safe = fr.replace('"', "")
        parts.append(f'FROM "{safe}"')
    if since.strip():
        # Expect IMAP date like 01-Jan-2024; pass through if looks safe
        s = since.strip().replace('"', "")
        if re.match(r"^[\w\-]+$", s.replace(" ", "")) or re.match(
            r"^\d{1,2}-[A-Za-z]{3}-\d{4}$", s
        ):
            parts.append(f"SINCE {s}")
    criteria = " ".join(parts) if parts else "ALL"

    try:
        mailbox_conn = imaplib.IMAP4_SSL(creds.imap_server, creds.imap_port)
        mailbox_conn.login(creds.email_address, creds.auth_code)
        mailbox_conn.select(folder, readonly=True)
        status, data = mailbox_conn.search(None, criteria)
        if status != "OK":
            mailbox_conn.logout()
            return _tool_err("邮件搜索失败。", data={"criteria": criteria}, code="imap_search_failed")
        ids = data[0].split() if data and data[0] else []
        if not ids:
            mailbox_conn.logout()
            mail_metric_inc("mail_search")
            return _tool_ok(
                f"未找到匹配邮件（条件：{criteria}）。",
                data={"items": [], "count": 0, "criteria": criteria},
                code="empty",
            )
        selected_ids = list(reversed(ids))[:limit]
        cache: Dict[int, Dict[str, str]] = {}
        items = []
        lines = [f"搜索结果（{len(selected_ids)} 封，{criteria}）："]
        for idx, msg_id_bytes in enumerate(selected_ids, start=1):
            status, msg_data = mailbox_conn.fetch(msg_id_bytes, "(BODY.PEEK[HEADER])")
            if status != "OK" or not msg_data or not msg_data[0]:
                continue
            msg = message_from_bytes(msg_data[0][1])
            from_name, from_email = parseaddr(msg.get("From", ""))
            from_name = _decode_mime_text(from_name)
            subj_h = _decode_mime_text(msg.get("Subject", "")) or "(无主题)"
            date = msg.get("Date", "")
            message_id = (msg.get("Message-ID", "") or "").strip()
            sender = f"{from_name} <{from_email}>" if from_name else from_email
            lines.append(f"{idx}. 发件人: {sender} | 主题: {subj_h} | 时间: {date}")
            cache[idx] = {
                "from_email": from_email,
                "from_name": from_name,
                "subject": subj_h,
                "message_id": message_id,
                "date": date,
                "imap_uid": msg_id_bytes.decode() if isinstance(msg_id_bytes, bytes) else str(msg_id_bytes),
                "mailbox": folder,
            }
            items.append(
                {
                    "id": idx,
                    "sender": sender,
                    "from_email": from_email,
                    "subject": subj_h,
                    "date": date,
                    "message_id": message_id,
                }
            )
        mailbox_conn.logout()
        set_mail_cache(uid, sid, cache)
        mail_metric_inc("mail_search")
        return _tool_ok(
            "\n".join(lines),
            data={
                "session_id": sid,
                "user_id": uid,
                "items": items,
                "count": len(items),
                "criteria": criteria,
                "mailbox": folder,
            },
        )
    except Exception as e:
        return _tool_err(f"邮件搜索失败：{e}", code="imap_exception")


def mark_email_read(
    email_id: int = 0,
    email_ids: list | str = "",
    unread: bool = False,
    session_id: str = "default",
    user_id: str = "",
) -> str:
    """IMAP STORE \\Seen（可批量）。"""
    uid = str(user_id or "").strip()
    sid = (session_id or "default").strip() or "default"
    creds, err = _require_creds(uid)
    if err:
        return err
    cache = get_mail_cache(uid, sid)
    ids: list[int] = []
    if email_id:
        ids.append(int(email_id))
    if isinstance(email_ids, list):
        ids.extend(int(x) for x in email_ids if str(x).strip())
    elif isinstance(email_ids, str) and email_ids.strip():
        try:
            parsed = json.loads(email_ids)
            if isinstance(parsed, list):
                ids.extend(int(x) for x in parsed)
            else:
                ids.extend(int(x) for x in re.split(r"[,;\s]+", email_ids) if x.strip().isdigit())
        except Exception:
            ids.extend(int(x) for x in re.split(r"[,;\s]+", email_ids) if x.strip().isdigit())
    ids = list(dict.fromkeys(ids))[:50]
    if not ids:
        return _tool_err("请指定 email_id 或 email_ids。", code="missing_email_id")

    flag = r"(\Seen)"
    op = "-FLAGS" if unread else "+FLAGS"
    done = []
    try:
        by_folder: dict[str, list[tuple[int, str]]] = {}
        for eid in ids:
            meta = cache.get(int(eid))
            if not meta or not meta.get("imap_uid"):
                continue
            folder = meta.get("mailbox") or folder_name(creds.provider, "inbox")
            by_folder.setdefault(folder, []).append((int(eid), str(meta["imap_uid"])))
        if not by_folder:
            return _tool_err("未找到邮件编号，请先 list_emails / search_emails。", code="email_not_found_in_cache")

        mailbox_conn = imaplib.IMAP4_SSL(creds.imap_server, creds.imap_port)
        mailbox_conn.login(creds.email_address, creds.auth_code)
        for folder, rows in by_folder.items():
            mailbox_conn.select(folder, readonly=False)
            for eid, imap_uid in rows:
                mailbox_conn.store(imap_uid.encode(), op, flag)
                done.append(eid)
        mailbox_conn.logout()
        mail_metric_inc("mail_mark_read", len(done))
        action = "标为未读" if unread else "标为已读"
        return _tool_ok(
            f"已{action} {len(done)} 封邮件：{done}",
            data={"email_ids": done, "unread": bool(unread)},
        )
    except Exception as e:
        return _tool_err(f"标记已读失败：{e}", code="imap_store_failed")


def reply_email(
    email_id: int,
    content: str,
    session_id: str = "default",
    user_id: str = "",
    cc: str = "",
) -> str:
    sid = (session_id or "default").strip() or "default"
    uid = str(user_id or "").strip()
    cache = get_mail_cache(uid, sid)
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
    creds, err = _require_creds(uid)
    if err:
        return err

    raw_subject = (meta.get("subject") or "").strip() or "(无主题)"
    subject = raw_subject if raw_subject.lower().startswith("re:") else f"Re: {raw_subject}"
    message_id = (meta.get("message_id") or "").strip()
    cc_list = _parse_addr_list(cc)
    try:
        message = MIMEText(content or "", "plain", "utf-8")
        message["From"] = creds.email_address
        message["To"] = to
        if cc_list:
            message["Cc"] = ", ".join(cc_list)
        message["Subject"] = Header(subject, "utf-8")
        if message_id:
            message["In-Reply-To"] = message_id
            message["References"] = message_id

        with smtplib.SMTP_SSL(creds.smtp_server, creds.smtp_port) as server:
            server.login(creds.email_address, creds.auth_code)
            server.sendmail(creds.email_address, [to] + cc_list, message.as_string())
        mail_metric_inc("mail_send")
        return _tool_ok(
            f"邮件回复成功！已从 {creds.email_address} 回复编号 {email_id}（{to}）。",
            data={
                "email_id": email_id,
                "to": to,
                "cc": cc_list,
                "subject": subject,
                "from": creds.email_address,
                "preview": {"to": to, "subject": subject, "body": (content or "")[:2000], "from": creds.email_address},
            },
        )
    except Exception as e:
        return _tool_err(
            f"邮件回复失败：{str(e)}",
            data={"email_id": email_id, "to": to, "subject": subject},
            code="smtp_reply_failed",
        )


def forward_email(
    email_id: int,
    to: str,
    note: str = "",
    session_id: str = "default",
    user_id: str = "",
) -> str:
    """转发原信（RISKY）。"""
    uid = str(user_id or "").strip()
    sid = (session_id or "default").strip() or "default"
    to = (to or "").strip()
    allowed, source, _contact = _recipient_allowed(to) if to else (False, "invalid", None)
    if not allowed:
        return _tool_err(
            "转发失败：请提供通讯录联系人或显式合法邮箱。",
            data={"to": to},
            code="invalid_recipient_email",
        )
    detail = get_email_detail(int(email_id), session_id=sid, user_id=uid)
    if isinstance(detail, dict) and not detail.get("ok"):
        return detail
    data = (detail.get("data") if isinstance(detail, dict) else {}) or {}
    body = str(data.get("body") or "")
    subject_raw = str(data.get("subject") or "(无主题)")
    subject = subject_raw if subject_raw.lower().startswith("fwd:") else f"Fwd: {subject_raw}"
    note_text = (note or "").strip()
    content = (note_text + "\n\n" if note_text else "") + "---------- Forwarded message ----------\n" + body
    result = send_email(
        to=to,
        subject=subject,
        content=content,
        session_id=sid,
        user_id=uid,
    )
    if isinstance(result, dict) and result.get("ok"):
        mail_metric_inc("mail_forward")
    return result


def delete_email(
    email_id: int,
    session_id: str = "default",
    user_id: str = "",
    permanent: bool = False,
) -> str:
    """移入废纸篓或标记删除（RISKY）。"""
    uid = str(user_id or "").strip()
    sid = (session_id or "default").strip() or "default"
    creds, err = _require_creds(uid)
    if err:
        return err
    cache = get_mail_cache(uid, sid)
    meta = cache.get(int(email_id))
    if not meta or not meta.get("imap_uid"):
        return _tool_err("未找到邮件编号，请先 list_emails。", code="email_not_found_in_cache")
    folder = meta.get("mailbox") or folder_name(creds.provider, "inbox")
    trash = folder_name(creds.provider, "trash")
    imap_uid = str(meta["imap_uid"])
    try:
        mailbox_conn = imaplib.IMAP4_SSL(creds.imap_server, creds.imap_port)
        mailbox_conn.login(creds.email_address, creds.auth_code)
        mailbox_conn.select(folder, readonly=False)
        if permanent:
            mailbox_conn.store(imap_uid.encode(), "+FLAGS", r"(\Deleted)")
            mailbox_conn.expunge()
            human = f"已永久删除邮件 #{email_id}。"
        else:
            moved = False
            try:
                status, _ = mailbox_conn.copy(imap_uid.encode(), trash)
                if status == "OK":
                    mailbox_conn.store(imap_uid.encode(), "+FLAGS", r"(\Deleted)")
                    mailbox_conn.expunge()
                    moved = True
                    human = f"已将邮件 #{email_id} 移入废纸篓（{trash}）。可在邮箱废纸篓中恢复。"
            except Exception:
                moved = False
            if not moved:
                mailbox_conn.store(imap_uid.encode(), "+FLAGS", r"(\Deleted)")
                mailbox_conn.expunge()
                human = f"已删除邮件 #{email_id}。若误删请到邮箱废纸篓尝试恢复。"
        mailbox_conn.logout()
        mail_metric_inc("mail_delete")
        cache.pop(int(email_id), None)
        set_mail_cache(uid, sid, cache)
        return _tool_ok(human, data={"email_id": int(email_id), "trash": trash, "permanent": bool(permanent)})
    except Exception as e:
        return _tool_err(f"删除邮件失败：{e}", code="imap_delete_failed")


def draft_email_reply(
    email_id: int,
    hint: str = "",
    tone: str = "",
    session_id: str = "default",
    user_id: str = "",
) -> dict:
    """只起草回复正文，不发信、不走发送闸。返回 draft_content 供前端回填快速回复框。"""
    from app.core.llm import qwen_llm

    sid = (session_id or "default").strip() or "default"
    uid = str(user_id or "").strip()
    cache = get_mail_cache(uid, sid)
    meta = cache.get(int(email_id))
    if not meta:
        detail = get_email_detail(int(email_id), session_id=sid, user_id=uid)
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
    creds, _ = resolve_mail_credentials(uid)
    from_addr = creds.email_address if creds else ""
    return _tool_ok(
        f"已起草邮件 #{email_id} 的回复（未发送），请确认后再发送。",
        data={
            "email_id": email_id,
            "draft_content": draft,
            "mail_draft": {"email_id": email_id, "content": draft},
            "subject": subject if subject.lower().startswith("re:") else f"Re: {subject}",
            "to": sender,
            "from": from_addr,
            "preview": {
                "to": sender,
                "subject": subject,
                "body": draft,
                "from": from_addr,
            },
        },
        code="mail_draft_ok",
    )


def classify_emails(session_id: str = "default", limit: int = 20, user_id: str = "") -> dict:
    """读取收件箱并用 LLM 打标签：工作 / 社交 / 通知 / 广告 / 其他。"""
    from app.core.llm import qwen_llm

    uid = str(user_id or "").strip()
    mail_result = list_emails(session_id=session_id, limit=limit, unread_only=False, user_id=uid)
    if isinstance(mail_result, dict):
        if not mail_result.get("ok"):
            return mail_result
        items = (mail_result.get("data") or {}).get("items") or []
        if not items:
            return _tool_ok(
                "收件箱为空，无需分类。",
                data={"items": [], "stats": {}, "session_id": session_id, "user_id": uid},
                code="empty",
            )
    else:
        text = str(mail_result)
        if "收件箱读取失败" in text or "收件箱为空" in text or "邮箱未绑定" in text:
            return _tool_err(text, code="imap_failed" if "失败" in text or "未绑定" in text else "empty")
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
不要输出其它文字。不要编造邮件正文。

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
            "user_id": uid,
            "stats": stats,
            "items": classified,
            "count": len(classified),
        },
    )
