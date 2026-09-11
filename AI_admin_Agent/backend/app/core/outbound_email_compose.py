"""新写信：把「用户意图」扩成可发的正文/主题（LLM）；纯判定可 smoke。"""
from __future__ import annotations

from typing import Any


def needs_outbound_body_compose(content: str, user_message: str = "") -> bool:
    """
    正文是否仍是「意图说明」而非成稿。
    结构判定：空、与用户原话相同、或是用户原话的真子串（槽位常把「说明…」抽成 content）。
    """
    c = str(content or "").strip()
    u = str(user_message or "").strip()
    if not c:
        return True
    if u and c == u:
        return True
    if u and c in u and len(c) + 2 < len(u):
        return True
    # 过短且无换行：多半不是成稿（新写信）
    if len(c) < 40 and "\n" not in c:
        return True
    return False


def refine_outbound_email_body(content: str, tone: str = "") -> str:
    """
    就地改写草稿正文（不发信）。失败返回空字符串。
    tone 示例：更正式 / 缩短 / 更柔和
    """
    from app.core.llm import qwen_llm

    body = str(content or "").strip()
    if not body:
        return ""
    tone_text = str(tone or "").strip() or "更正式"
    prompt = f"""你是邮件润色助手。按要求改写下面邮件正文，只输出改写后的纯文本正文（不要主题行、不要解释、不要 JSON）。
改写要求：{tone_text}
原文：
{body}
"""
    try:
        out = str(qwen_llm.chat_text([{"role": "user", "content": prompt}]) or "").strip()
    except Exception:
        return ""
    if out.startswith("```"):
        out = out.strip("`")
        if "\n" in out:
            out = out.split("\n", 1)[-1].strip()
    return out


def compose_outbound_email_fields(
    *,
    intent: str,
    to: str = "",
    subject_hint: str = "",
    tone: str = "",
    user_message: str = "",
) -> dict[str, str]:
    """
    调用 LLM 生成 subject + content。失败时返回空 dict（调用方保留原 args）。
    """
    from app.core.llm import qwen_llm

    intent_text = str(intent or user_message or "").strip()
    if not intent_text:
        return {}
    tone_text = str(tone or "").strip() or "正式、简洁、职场"
    to_text = str(to or "").strip() or "（收件人）"
    subj_hint = str(subject_hint or "").strip()
    prompt = f"""你是邮件撰写助手。根据用户意图写一封可直接发送的纯文本邮件。
要求：
- 输出合法 JSON 对象，字段仅 subject、content（不要 markdown、不要解释）
- subject：简短明确；若已有主题提示可参考但可改写得更得体
- content：完整正文（称呼、说明、结尾礼貌语）；不要把「用户意图原话」或「语气要求」原样当作正文
- 语气：{tone_text}
收件人：{to_text}
主题提示：{subj_hint or "（无）"}
用户意图：
{intent_text}
"""
    try:
        raw = str(qwen_llm.chat_text([{"role": "user", "content": prompt}]) or "").strip()
    except Exception:
        return {}
    if not raw:
        return {}
    # 剥代码围栏
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.startswith("json"):
            raw = raw[4:].strip()
    try:
        import json

        data = json.loads(raw)
    except Exception:
        # 再试一次：只抽 JSON 对象
        try:
            import json
            import re

            m = re.search(r"\{[\s\S]*\}", raw)
            data = json.loads(m.group(0)) if m else None
        except Exception:
            return {}
    if not isinstance(data, dict):
        return {}
    subject = str(data.get("subject") or "").strip()
    content = str(data.get("content") or data.get("body") or "").strip()
    if not content:
        return {}
    out: dict[str, str] = {"content": content}
    if subject:
        out["subject"] = subject
    return out


def enrich_send_email_args(
    tool_args: dict[str, Any] | None,
    *,
    user_message: str = "",
    understanding: dict[str, Any] | None = None,
    upstream_handoff: dict[str, Any] | str | None = None,
) -> dict[str, Any]:
    """
    发信前：联系人解析 + 意图→成稿。纯函数外壳；LLM 仅在需要成稿时调用。
    upstream_handoff：总管上游 softHandoff / 识图结构化交接，优先静默预填正文。
    """
    out = dict(tool_args or {})
    slots = {}
    if isinstance(understanding, dict) and isinstance(understanding.get("slots"), dict):
        slots = understanding["slots"]

    to = str(out.get("to") or "").strip()
    if to and "@" not in to:
        try:
            from app.core.mail_compose import resolve_recipient_to_email
            from app.tools.contacts import get_contact_email

            resolved, reason = resolve_recipient_to_email(to, get_contact_email)
            if resolved and reason == "contact_resolved":
                out["__resolved_from_name__"] = to
                out["to"] = resolved
        except Exception:
            pass

    content = str(out.get("content") or out.get("body") or "").strip()
    subject = str(out.get("subject") or "").strip()
    need_body = needs_outbound_body_compose(content, user_message)
    need_subject = not subject

    if need_body and upstream_handoff:
        try:
            from app.core.mail_compose import compose_prefills_from_upstream_handoff

            pre = compose_prefills_from_upstream_handoff(
                upstream_handoff,
                to=str(out.get("to") or to or ""),
                subject=subject,
            )
            if str(pre.get("content") or "").strip():
                out["content"] = str(pre["content"]).strip()
                content = out["content"]
                need_body = needs_outbound_body_compose(content, user_message)
            if need_subject and str(pre.get("subject") or "").strip():
                out["subject"] = str(pre["subject"]).strip()
                subject = out["subject"]
                need_subject = False
            if not str(out.get("to") or "").strip() and str(pre.get("to") or "").strip():
                out["to"] = str(pre["to"]).strip()
        except Exception:
            pass

    intent = (
        content
        or str(slots.get("email_content") or "").strip()
        or str(user_message or "").strip()
    )
    tone = str(slots.get("email_tone") or "").strip()
    if need_body or need_subject:
        drafted = compose_outbound_email_fields(
            intent=intent,
            to=str(out.get("to") or to or ""),
            subject_hint=subject or str(slots.get("email_subject") or ""),
            tone=tone,
            user_message=user_message,
        )
        if need_body and drafted.get("content"):
            out["content"] = drafted["content"]
        if drafted.get("subject") and (need_subject or need_body):
            out["subject"] = drafted["subject"]
    return out
