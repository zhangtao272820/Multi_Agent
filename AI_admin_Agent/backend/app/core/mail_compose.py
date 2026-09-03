"""邮件 Compose 契约：结构化草稿 + digest（纯函数，可 smoke）。

对标 Corresync preview→commit / Copilot 嵌入 draft：
用户在 UI 改 to/subject/content 后再确认，不以 chat 全文为唯一输入。
"""
from __future__ import annotations

import hashlib
import json
from typing import Any


MAIL_COMPOSE_TOOLS = frozenset({"send_email", "reply_email", "forward_email", "delete_email"})
MAIL_COMPOSE_EDITABLE = frozenset({"send_email", "reply_email", "forward_email"})


def _list_field(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, list):
        return ", ".join(str(x).strip() for x in v if str(x).strip())
    return str(v).strip()


def mail_compose_digest(compose: dict[str, Any] | None) -> str:
    """对可发送字段做稳定 digest（不含 title/message）。"""
    c = dict(compose or {})
    payload = {
        "tool": str(c.get("tool") or ""),
        "to": _list_field(c.get("to")),
        "cc": _list_field(c.get("cc")),
        "bcc": _list_field(c.get("bcc")),
        "subject": str(c.get("subject") or "").strip(),
        "content": str(c.get("content") or "").strip(),
        "email_id": c.get("email_id"),
        "from_address": str(c.get("from_address") or "").strip(),
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def build_mail_compose(
    tool_name: str,
    tool_args: dict[str, Any] | None,
    *,
    from_address: str = "",
) -> dict[str, Any]:
    """从工具 args 组装前端 Compose Card 载荷。"""
    args = dict(tool_args or {})
    name = str(tool_name or "").strip()
    to = _list_field(args.get("to") or args.get("recipient") or "")
    cc = _list_field(args.get("cc") or "")
    bcc = _list_field(args.get("bcc") or "")
    subject = str(args.get("subject") or "").strip()
    content = str(args.get("content") or args.get("body") or args.get("note") or "")
    email_id = args.get("email_id")
    try:
        email_id_out: int | None = (
            int(email_id) if email_id is not None and str(email_id).strip() != "" else None
        )
    except (TypeError, ValueError):
        email_id_out = None

    if name == "reply_email" and subject and not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"
    elif name == "forward_email" and subject and not subject.lower().startswith("fwd:"):
        subject = f"Fwd: {subject}"

    editable = name in MAIL_COMPOSE_EDITABLE
    compose: dict[str, Any] = {
        "tool": name,
        "from_address": str(from_address or "").strip(),
        "to": to,
        "cc": cc,
        "bcc": bcc,
        "subject": subject,
        "content": content if editable else "",
        "email_id": email_id_out,
        "editable": editable,
    }
    compose["digest"] = mail_compose_digest(compose)
    return compose


def apply_mail_compose_override(
    tool_args: dict[str, Any] | None,
    mail_compose: dict[str, Any] | None,
    *,
    tool_name: str = "",
) -> dict[str, Any]:
    """将 UI 编辑后的 mail_compose 合并进待执行 tool_args（仅白名单字段）。"""
    out = dict(tool_args or {})
    mc = dict(mail_compose or {})
    if not mc:
        return out
    name = str(tool_name or out.get("__tool_name__") or mc.get("tool") or "").strip()
    if name == "delete_email":
        return out
    if "to" in mc and str(mc.get("to") or "").strip():
        out["to"] = _list_field(mc.get("to"))
    if "cc" in mc:
        out["cc"] = _list_field(mc.get("cc"))
    if "bcc" in mc:
        out["bcc"] = _list_field(mc.get("bcc"))
    if "subject" in mc and str(mc.get("subject") or "").strip():
        out["subject"] = str(mc.get("subject") or "").strip()
    if "content" in mc:
        out["content"] = str(mc.get("content") or "")
    out["__mail_compose_commit_digest__"] = mail_compose_digest(
        build_mail_compose(
            name or str(mc.get("tool") or "send_email"),
            out,
            from_address=str(mc.get("from_address") or ""),
        )
    )
    return out


def compose_prefills_from_report_body(
    body: str,
    *,
    to: str = "",
    subject: str = "",
    from_address: str = "",
) -> dict[str, Any]:
    """周报 / 纪要正文 → 发信 Compose 预填（不发信）。"""
    content = str(body or "").strip()
    subj = str(subject or "").strip() or "工作周报"
    return build_mail_compose(
        "send_email",
        {"to": to, "subject": subj, "content": content},
        from_address=from_address,
    )


def assemble_batch_draft_composes(items: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """
    批量回复草稿装配（纯函数）。
    每项至少含：email_id, to?, subject?, draft_content|content
    """
    out: list[dict[str, Any]] = []
    for raw in items or []:
        if not isinstance(raw, dict):
            continue
        eid = raw.get("email_id")
        try:
            email_id = int(eid) if eid is not None else None
        except (TypeError, ValueError):
            continue
        if email_id is None:
            continue
        content = str(raw.get("draft_content") or raw.get("content") or "").strip()
        if not content:
            continue
        compose = build_mail_compose(
            "reply_email",
            {
                "email_id": email_id,
                "to": raw.get("to") or "",
                "subject": raw.get("subject") or "",
                "content": content,
            },
            from_address=str(raw.get("from_address") or ""),
        )
        out.append(compose)
    return out


def resolve_recipient_to_email(to_or_name: str, lookup_email) -> tuple[str | None, str]:
    """
    联系人静默解析链：已是邮箱则直通；否则 lookup_email(name) → 邮箱。
    返回 (email|None, reason_code)。
    """
    s = str(to_or_name or "").strip()
    if not s:
        return None, "empty"
    if "@" in s and "." in s.split("@")[-1]:
        return s, "email_literal"
    try:
        found = lookup_email(s)
    except Exception:
        return None, "lookup_failed"
    found_s = str(found or "").strip()
    if (
        not found_s
        or found_s.startswith("CONTACT_NOT_FOUND")
        or found_s.startswith("__CONTACT_NOT_FOUND__")
        or "未找到" in found_s
    ):
        return None, "contact_not_found"
    if "@" not in found_s:
        return None, "contact_not_found"
    return found_s, "contact_resolved"
