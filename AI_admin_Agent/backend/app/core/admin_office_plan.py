"""非邮件办公意图兜底规划：只信 NLU slots / scenario，组装确定性工具链。"""
from __future__ import annotations

from typing import Any


_CALENDAR_ACTIONS = frozenset(
    {"create", "list", "modify", "delete", "complete", "bulk_delete", "sync"}
)
_TASK_ACTIONS = frozenset({"create", "list", "complete", "delete", "modify"})
_CONTACT_ACTIONS = frozenset({"add", "list", "search", "import"})
_FILE_ACTIONS = frozenset({"list", "read", "write", "move", "mkdir"})
_SEARCH_ACTIONS = frozenset({"web", "knowledge"})


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


def _truthy_list_mode(slots: dict[str, str]) -> bool:
    return str(slots.get("list_mode") or "").strip().lower() in (
        "1",
        "true",
        "list",
        "yes",
    )


def resolve_calendar_action(understanding: dict[str, Any] | None) -> str:
    slots = _slots(understanding)
    action = str(slots.get("calendar_action") or "").strip().lower()
    if action in _CALENDAR_ACTIONS:
        return action
    if _truthy_list_mode(slots):
        return "list"
    sc = _scenario(understanding)
    if sc in ("feishu_calendar", "calendar_multi"):
        return "sync"
    if sc == "calendar_list":
        return "list"
    return ""


def resolve_task_action(understanding: dict[str, Any] | None) -> str:
    slots = _slots(understanding)
    action = str(slots.get("task_action") or "").strip().lower()
    if action in _TASK_ACTIONS:
        return action
    if _truthy_list_mode(slots):
        return "list"
    sc = _scenario(understanding)
    if sc == "minutes_to_tasks":
        return "create"
    if sc == "task_list":
        return "list"
    return ""


def resolve_contact_action(understanding: dict[str, Any] | None) -> str:
    slots = _slots(understanding)
    action = str(slots.get("contact_action") or "").strip().lower()
    if action in _CONTACT_ACTIONS:
        return action
    if _truthy_list_mode(slots):
        return "list"
    sc = _scenario(understanding)
    if sc == "add_contact":
        return "add"
    # 槽位齐全时可推断 add/search，仍不靠原话关键词
    name = str(slots.get("contact_name") or "").strip()
    email = str(slots.get("contact_email") or "").strip()
    if name and email:
        return "add"
    if name:
        return "search"
    return ""


def resolve_file_action(understanding: dict[str, Any] | None) -> str:
    slots = _slots(understanding)
    action = str(slots.get("file_action") or "").strip().lower()
    if action in _FILE_ACTIONS:
        return action
    if _truthy_list_mode(slots):
        return "list"
    path = str(slots.get("file_path") or "").strip()
    if path:
        return "read"
    return ""


def resolve_search_action(understanding: dict[str, Any] | None) -> str:
    slots = _slots(understanding)
    action = str(slots.get("search_action") or "").strip().lower()
    if action in _SEARCH_ACTIONS:
        return action
    target = str(slots.get("search_target") or "").strip().lower()
    if target in _SEARCH_ACTIONS:
        return target
    if target in ("rag", "kb", "knowledge_retrieval"):
        return "knowledge"
    if target in ("internet", "www", "web_search"):
        return "web"
    # 有查询词但无目标：默认 web（仍由 slots 驱动，非原话关键词）
    if str(slots.get("search_query") or "").strip():
        return "web"
    sc = _scenario(understanding)
    if sc == "web_search":
        return "web"
    if sc == "knowledge_retrieval":
        return "knowledge"
    return ""


def build_calendar_fallback_plan(
    user_message: str = "",
    understanding: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    _ = user_message
    slots = _slots(understanding)
    action = resolve_calendar_action(understanding)
    if action == "list":
        return [{"name": "list_events", "args": {}}]
    if action == "bulk_delete":
        return [{"name": "delete_all_meeting_reminders", "args": {}}]
    if action == "sync":
        sc = _scenario(understanding)
        if sc == "calendar_multi":
            return [{"name": "sync_all_calendars", "args": {}}]
        return [{"name": "sync_feishu_calendar", "args": {}}]
    if action == "complete":
        title = str(slots.get("event_title") or "").strip()
        args: dict[str, Any] = {}
        if title:
            args["title"] = title
        return [{"name": "complete_event", "args": args}]
    if action == "delete":
        title = str(slots.get("event_title") or "").strip()
        args = {}
        if title:
            args["title"] = title
        return [{"name": "delete_event", "args": args}]
    if action == "modify":
        title = str(slots.get("event_title") or "").strip()
        start = str(slots.get("start_time_expression") or "").strip()
        args = {}
        if title:
            args["title"] = title
        if start:
            args["start_time_str"] = start
        desc = str(slots.get("event_description") or "").strip()
        if desc:
            args["description"] = desc
        return [{"name": "modify_event", "args": args}]
    if action == "create":
        title = str(slots.get("event_title") or "").strip()
        start = str(slots.get("start_time_expression") or "").strip()
        if not title or not start:
            return []
        args = {"title": title, "start_time_str": start}
        desc = str(slots.get("event_description") or "").strip()
        if desc:
            args["description"] = desc
        return [{"name": "add_event", "args": args}]
    return []


def build_task_fallback_plan(
    user_message: str = "",
    understanding: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    _ = user_message
    slots = _slots(understanding)
    action = resolve_task_action(understanding)
    if action == "list":
        return [{"name": "list_tasks", "args": {}}]
    if action == "complete":
        title = str(slots.get("task_title") or "").strip()
        args: dict[str, Any] = {}
        if title:
            args["title"] = title
        return [{"name": "complete_task", "args": args}]
    if action == "delete":
        title = str(slots.get("task_title") or "").strip()
        args = {}
        if title:
            args["title"] = title
        return [{"name": "delete_task", "args": args}]
    if action == "modify":
        title = str(slots.get("task_title") or "").strip()
        args = {}
        if title:
            args["title"] = title
        desc = str(slots.get("task_description") or "").strip()
        if desc:
            args["description"] = desc
        due = str(slots.get("task_due_time_expression") or "").strip()
        if due:
            args["due_time_str"] = due
        return [{"name": "modify_task", "args": args}]
    if action == "create":
        title = str(slots.get("task_title") or "").strip()
        if not title:
            return []
        due = str(slots.get("task_due_time_expression") or "").strip()
        desc = str(slots.get("task_description") or "").strip()
        if due:
            args = {"title": title, "due_time_str": due}
            if desc:
                args["description"] = desc
            return [{"name": "add_task_with_due", "args": args}]
        args = {"title": title}
        if desc:
            args["description"] = desc
        return [{"name": "add_task", "args": args}]
    return []


def build_contact_fallback_plan(
    user_message: str = "",
    understanding: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    _ = user_message
    slots = _slots(understanding)
    action = resolve_contact_action(understanding)
    if action == "list":
        return [{"name": "list_contacts", "args": {}}]
    if action == "import":
        return [{"name": "import_contacts", "args": {}}]
    if action == "search":
        name = str(slots.get("contact_name") or "").strip()
        if not name:
            return []
        return [{"name": "search_contact", "args": {"name": name}}]
    if action == "add":
        name = str(slots.get("contact_name") or "").strip()
        email = str(slots.get("contact_email") or "").strip()
        if not name or not email:
            return []
        args: dict[str, Any] = {"name": name, "email": email}
        desc = str(slots.get("contact_description") or "").strip()
        if desc:
            args["description"] = desc
        return [{"name": "add_contact", "args": args}]
    return []


def build_file_fallback_plan(
    user_message: str = "",
    understanding: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    _ = user_message
    slots = _slots(understanding)
    action = resolve_file_action(understanding)
    path = str(slots.get("file_path") or "").strip()
    if action == "list":
        return [{"name": "list_files", "args": {}}]
    if action == "read":
        if not path:
            return []
        return [{"name": "read_file_content", "args": {"path": path}}]
    if action == "write":
        if not path:
            return []
        content = str(slots.get("file_content") or "").strip()
        return [{"name": "write_file", "args": {"path": path, "content": content}}]
    if action == "move":
        dest = str(slots.get("file_dest") or "").strip()
        if not path or not dest:
            return []
        return [{"name": "move_file", "args": {"src": path, "dest": dest}}]
    if action == "mkdir":
        if not path:
            return []
        return [{"name": "create_directory", "args": {"path": path}}]
    return []


def build_search_fallback_plan(
    user_message: str = "",
    understanding: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    slots = _slots(understanding)
    action = resolve_search_action(understanding)
    query = str(slots.get("search_query") or "").strip() or str(user_message or "").strip()
    if not action or not query:
        return []
    if action == "knowledge":
        return [{"name": "knowledge_retrieval", "args": {"query": query}}]
    return [{"name": "web_search", "args": {"query": query}}]


def build_office_fallback_plan(
    intent: str,
    user_message: str = "",
    understanding: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """按 intent 分发；无动作/槽不足时返回空（交给规划 LLM）。"""
    intent = str(intent or "").strip()
    if intent == "日程":
        return build_calendar_fallback_plan(user_message, understanding)
    if intent == "待办":
        return build_task_fallback_plan(user_message, understanding)
    if intent == "联系人":
        return build_contact_fallback_plan(user_message, understanding)
    if intent == "文件":
        return build_file_fallback_plan(user_message, understanding)
    if intent == "搜索":
        return build_search_fallback_plan(user_message, understanding)
    if intent == "简报":
        sc = _scenario(understanding)
        if sc == "weekly_report":
            return [{"name": "weekly_report", "args": {}}]
        return [{"name": "daily_briefing", "args": {}}]
    if intent == "问数":
        q = str(_slots(understanding).get("search_query") or "").strip() or str(user_message or "").strip()
        return [{"name": "ask_database", "args": {"question": q}}] if q else []
    if intent in ("会前准备", "会议准备"):
        return [{"name": "prepare_meeting", "args": {"query": str(user_message or "")}}]
    return []
