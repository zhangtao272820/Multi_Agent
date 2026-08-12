"""邮件工具规划兜底：按 NLU slots / scenario 组装 list→detail 等，避免错落 triage。"""
from __future__ import annotations

from typing import Any


_VALID_MAIL_ACTIONS = frozenset(
    {
        "list",
        "read",
        "triage",
        "send",
        "reply",
        "search",
        "mark_read",
        "forward",
        "delete",
        "list_attachments",
        "save_attachment",
        "classify",
    }
)


def _slots(understanding: dict[str, Any] | None) -> dict[str, str]:
    if not isinstance(understanding, dict):
        return {}
    raw = understanding.get("slots")
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v or "").strip() for k, v in raw.items()}


def _scenario(understanding: dict[str, Any] | None) -> str:
    if not isinstance(understanding, dict):
        return ""
    return str(understanding.get("admin_scenario") or "").strip()


def _email_id_from_slots(slots: dict[str, str], default: int = 1) -> int:
    raw = str(slots.get("email_id") or "").strip()
    if raw.isdigit():
        n = int(raw)
        return n if n >= 1 else default
    return default


def _attachment_index_from_slots(slots: dict[str, str], default: int = 1) -> int:
    raw = str(slots.get("attachment_index") or "").strip()
    if raw.isdigit():
        n = int(raw)
        return n if n >= 1 else default
    return default


def unread_only_from_slots(slots: dict[str, str], *, default: bool = True) -> bool:
    """只信 NLU slots.mail_unread_only；空则用 default（读信/列表默认未读）。"""
    raw = str(slots.get("mail_unread_only") or "").strip().lower()
    if raw in ("0", "false", "no", "all", "已读"):
        return False
    if raw in ("1", "true", "yes", "unread", "未读"):
        return True
    return default


def resolve_mail_action(understanding: dict[str, Any] | None) -> str:
    """从 slots.mail_action 与 admin_scenario 得到规范化动作。"""
    slots = _slots(understanding)
    action = str(slots.get("mail_action") or "").strip().lower()
    if action in _VALID_MAIL_ACTIONS:
        return action
    sc = _scenario(understanding)
    if sc == "email_read":
        return "read"
    if sc == "email_triage":
        return "triage"
    if sc == "email_attachments":
        return "list_attachments"
    if sc == "email_classify":
        return "classify"
    return ""


def build_mail_fallback_plan(
    user_message: str = "",
    understanding: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """模型规划为空时的邮件工具链（可多步）。

    优先级：slots.mail_action → admin_scenario → 空（交给规划 LLM）。
    读正文必须 list_emails（填会话 cache）再 get_email_detail，禁止用 triage 冒充读信。
    语义只信 understanding slots/scenario，不扫用户原话关键词。
    """
    _ = user_message  # 保留签名；语义以 understanding 为准（LLM slots/scenario）
    slots = _slots(understanding)
    action = resolve_mail_action(understanding)

    if action == "read":
        eid = _email_id_from_slots(slots, 1)
        unread = unread_only_from_slots(slots, default=True)
        return [
            {"name": "list_emails", "args": {"unread_only": unread, "limit": 20}},
            {"name": "get_email_detail", "args": {"email_id": eid}},
        ]
    if action == "triage":
        return [{"name": "triage_emails", "args": {"limit": 20}}]
    if action == "search":
        q = str(slots.get("email_subject") or slots.get("email_content") or "").strip()
        args: dict[str, Any] = {"limit": 20}
        if q:
            args["subject"] = q
        return [{"name": "search_emails", "args": args}]
    if action == "mark_read":
        eid = _email_id_from_slots(slots, 1)
        unread = unread_only_from_slots(slots, default=True)
        return [
            {"name": "list_emails", "args": {"unread_only": unread, "limit": 20}},
            {"name": "mark_email_read", "args": {"email_id": eid}},
        ]
    if action == "send":
        return [
            {
                "name": "send_email",
                "args": {
                    "to": slots.get("email_to_name_or_email") or "",
                    "subject": slots.get("email_subject") or "",
                    "content": slots.get("email_content") or "",
                },
            }
        ]
    if action == "reply":
        eid = _email_id_from_slots(slots, 1)
        unread = unread_only_from_slots(slots, default=True)
        return [
            {"name": "list_emails", "args": {"unread_only": unread, "limit": 20}},
            {
                "name": "draft_email_reply",
                "args": {"email_id": eid, "hint": slots.get("email_content") or ""},
            },
        ]
    if action == "forward":
        eid = _email_id_from_slots(slots, 1)
        unread = unread_only_from_slots(slots, default=True)
        return [
            {"name": "list_emails", "args": {"unread_only": unread, "limit": 20}},
            {
                "name": "forward_email",
                "args": {
                    "email_id": eid,
                    "to": slots.get("email_to_name_or_email") or "",
                    "note": slots.get("email_content") or "",
                },
            },
        ]
    if action == "delete":
        eid = _email_id_from_slots(slots, 1)
        unread = unread_only_from_slots(slots, default=False)
        return [
            {"name": "list_emails", "args": {"unread_only": unread, "limit": 20}},
            {"name": "delete_email", "args": {"email_id": eid}},
        ]
    if action == "list":
        unread = unread_only_from_slots(slots, default=True)
        return [{"name": "list_emails", "args": {"unread_only": unread, "limit": 20}}]
    if action == "list_attachments":
        eid = _email_id_from_slots(slots, 1)
        unread = unread_only_from_slots(slots, default=True)
        return [
            {"name": "list_emails", "args": {"unread_only": unread, "limit": 20}},
            {"name": "list_email_attachments", "args": {"email_id": eid}},
        ]
    if action == "save_attachment":
        eid = _email_id_from_slots(slots, 1)
        idx = _attachment_index_from_slots(slots, 1)
        unread = unread_only_from_slots(slots, default=True)
        return [
            {"name": "list_emails", "args": {"unread_only": unread, "limit": 20}},
            {
                "name": "save_email_attachment",
                "args": {"email_id": eid, "attachment_index": idx},
            },
        ]
    if action == "classify":
        return [{"name": "classify_emails", "args": {"limit": 20}}]

    # 无明确动作：返回空，交给规划 LLM（禁止默认 list 假装成功）
    return []
