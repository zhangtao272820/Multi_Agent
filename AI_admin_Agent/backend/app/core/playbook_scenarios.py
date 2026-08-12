"""国内办公场景识别：LLM + Playbook RAG，注入对应 Playbook 段落。"""
from __future__ import annotations

from app.core.amap_client import amap_configured
from app.core.amap_nlu import build_amap_tool_plan
from app.core.playbook_loader import resolve_playbook_section_or_fallback


def detect_admin_scenario(user_message: str, intent: str = "") -> str | None:
    """场景识别（LLM + RAG；不再使用 regex 关键词表）。"""
    from app.core.admin_nlu import resolve_admin_scenario

    return resolve_admin_scenario(user_message, intent=intent)


def get_scenario_planning_addon(scenario: str | None) -> str:
    if not scenario:
        return ""
    section_map = {
        "daily_briefing": ("daily_briefing", "Planning"),
        "email_triage": ("email_triage", "Planning"),
        "email_read": ("email_hands", "Planning"),
        "email_attachments": ("email_hands", "Planning"),
        "email_classify": ("email_hands", "Planning"),
        "meeting_prep": ("meeting_prep", "Planning"),
        "ask_database": ("ask_database", "Planning"),
        "weekly_report": ("weekly_report", "Planning"),
        "meeting_minutes": ("meeting_minutes", "Planning"),
        "lobster_automation": ("lobster_automation", "Planning"),
        "travel_route": ("travel_route", "Planning"),
        "amap_poi": ("amap_poi", "Planning"),
        "amap_geocode": ("amap_geocode", "Planning"),
        "feishu_calendar": ("feishu_calendar", "Planning"),
        "calendar_multi": ("calendar_multi", "Planning"),
        "feishu_notify": ("feishu_notify", "Planning"),
        "minutes_to_tasks": ("meeting_minutes", "Planning"),
        "reminder_notify": ("reminder_notify", "Planning"),
        "integrations_status": ("integrations_setup", "Planning"),
        "web_search": ("task_planning", "Planning"),
        "knowledge_retrieval": ("task_planning", "Planning"),
        "calendar_list": ("task_planning", "Planning"),
        "task_list": ("task_planning", "Planning"),
    }
    pair = section_map.get(scenario)
    if not pair:
        return ""
    body = resolve_playbook_section_or_fallback(pair[0], pair[1], "")
    return f"\n\n## 场景规划（{scenario}）\n{body}" if body.strip() else ""


def get_scenario_verification_addon(scenario: str | None) -> str:
    if not scenario:
        return ""
    body = resolve_playbook_section_or_fallback(scenario, "Reply", "")
    return f"\n\n## 场景回复（{scenario}）\n{body}" if body.strip() else ""


def preferred_tool_for_scenario(
    scenario: str | None,
    user_message: str,
    client_context: dict | None = None,
    understanding: dict | None = None,
) -> dict | None:
    """确定性兜底：场景 → 单工具调用（参数来自模型 resolved_amap，不用 regex 拆原话）。"""
    if scenario == "daily_briefing":
        return {"name": "daily_briefing", "args": {}}
    if scenario == "email_read":
        # 多步由 _mail_fallback_plan 组装；此处不单给 triage
        return None
    if scenario == "email_attachments":
        return None
    if scenario == "email_classify":
        return {"name": "classify_emails", "args": {"limit": 20}}
    if scenario == "email_triage":
        return {"name": "triage_emails", "args": {"limit": 20}}
    if scenario == "web_search":
        return None
    if scenario == "knowledge_retrieval":
        return None
    if scenario == "calendar_list":
        return {"name": "list_events", "args": {}}
    if scenario == "task_list":
        return {"name": "list_tasks", "args": {}}
    if scenario == "meeting_prep":
        return {"name": "prepare_meeting", "args": {"query": user_message}}
    if scenario == "ask_database":
        return {"name": "ask_database", "args": {"question": user_message}}
    if scenario == "weekly_report":
        return {"name": "weekly_report", "args": {}}
    if scenario == "meeting_minutes":
        return {"name": "extract_meeting_actions", "args": {"minutes_text": user_message}}
    if scenario == "lobster_automation":
        return {"name": "lobster_browser_task", "args": {"task": user_message}}
    if scenario in ("travel_route", "amap_poi", "amap_geocode"):
        if not amap_configured():
            return None
        if isinstance(understanding, dict):
            plan = build_amap_tool_plan(understanding.get("resolved_amap"), client_context)
            if plan:
                return plan
        return None
    if scenario == "feishu_calendar":
        return {"name": "sync_feishu_calendar", "args": {}}
    if scenario == "calendar_multi":
        return {"name": "sync_all_calendars", "args": {}}
    if scenario == "feishu_notify":
        return {"name": "send_feishu_message", "args": {"title": "办公助理", "content": user_message}}
    if scenario == "minutes_to_tasks":
        return {"name": "add_tasks_from_minutes", "args": {"minutes_text": user_message}}
    if scenario == "reminder_notify":
        return None
    if scenario == "integrations_status":
        return {"name": "show_integrations_status", "args": {}}
    return None
