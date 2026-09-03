"""Assemble AVAILABLE_TOOLS from domain modules."""
from __future__ import annotations

from app.tools import (
    amap_tools,
    automation,
    briefing,
    calendar,
    collaboration,
    contacts,
    database,
    email,
    email_attachments,
    files,
    integrations_tools,
    knowledge,
    memory_tools,
    notes,
    office_docs,
    pending,
    playground,
    playground_warm,
    reminders,
    search,
    tasks,
    weather,
)

AVAILABLE_TOOLS = {
    # Contacts
    "add_contact": contacts.add_contact,
    "search_contact": contacts.search_contact,
    "get_contact_email": contacts.get_contact_email,
    "list_contacts": contacts.list_contacts,
    "import_contacts": contacts.import_contacts,
    "list_pending_actions": pending.list_pending_actions,
    "confirm_action": pending.confirm_action,
    "decide_action": pending.decide_action,
    # Tasks
    "add_task": tasks.add_task,
    "add_task_with_due": tasks.add_task_with_due,
    "modify_task": tasks.modify_task,
    "list_tasks": tasks.list_tasks,
    "complete_task": tasks.complete_task,
    "delete_task": tasks.delete_task,
    # Calendar
    "add_event": calendar.add_event,
    "list_events": calendar.list_events,
    "modify_event": calendar.modify_event,
    "delete_event": calendar.delete_event,
    "delete_all_meeting_reminders": calendar.delete_all_meeting_reminders,
    "complete_event": calendar.complete_event,
    "import_calendar_ics": calendar.import_calendar_ics,
    "fetch_and_import_calendar": calendar.fetch_and_import_calendar,
    "export_calendar_ics": calendar.export_calendar_ics,
    # Mail
    "send_email": email.send_email,
    "list_emails": email.list_emails,
    "search_emails": email.search_emails,
    "mark_email_read": email.mark_email_read,
    "get_email_detail": email.get_email_detail,
    "reply_email": email.reply_email,
    "forward_email": email.forward_email,
    "delete_email": email.delete_email,
    "draft_email_reply": email.draft_email_reply,
    "draft_batch_email_replies": email.draft_batch_email_replies,
    "classify_emails": email.classify_emails,
    "list_email_attachments": email_attachments.list_email_attachments,
    "save_email_attachment": email_attachments.save_email_attachment,
    # Search
    "web_search": search.web_search,
    "knowledge_retrieval": knowledge.knowledge_retrieval,
    # Weather
    "get_weather": weather.get_weather,
    # Files
    "list_files": files.list_files,
    "read_file_content": files.read_file_content,
    "write_file": files.write_file,
    "move_file": files.move_file,
    "create_directory": files.create_directory,
    "read_office_document": office_docs.read_office_document,
    "write_office_document": office_docs.write_office_document,
    # Reminders
    "add_reminder": reminders.add_reminder,
    "list_reminders": reminders.list_reminders,
    "cancel_reminder": reminders.cancel_reminder,
    # Batch 4: 国内场景
    "daily_briefing": briefing.daily_briefing,
    "triage_emails": briefing.triage_emails,
    "prepare_meeting": briefing.prepare_meeting,
    "weekly_report": briefing.weekly_report,
    "ask_database": database.ask_database,
    "send_wecom_message": collaboration.send_wecom_message,
    "send_dingtalk_message": collaboration.send_dingtalk_message,
    "send_feishu_message": collaboration.send_feishu_message,
    "send_team_notification": collaboration.send_team_notification,
    # Batch 5: 自动化 / 出行 / 纪要
    "lobster_browser_task": automation.lobster_browser_task,
    "extract_meeting_actions": automation.extract_meeting_actions,
    "get_travel_route": amap_tools.get_travel_route,
    "search_places_amap": amap_tools.search_places_amap,
    "search_nearby_amap": amap_tools.search_nearby_amap,
    "resolve_address_amap": amap_tools.resolve_address_amap,
    "suggest_address_amap": amap_tools.suggest_address_amap,
    "locate_coordinates_amap": amap_tools.locate_coordinates_amap,
    "sync_feishu_calendar": automation.sync_feishu_calendar,
    # Batch 6: 集成清单 / 多日历 / 纪要落库
    "show_integrations_status": integrations_tools.show_integrations_status,
    "sync_all_calendars": automation.sync_all_calendars,
    "add_tasks_from_minutes": automation.add_tasks_from_minutes,
    # Memory
    "add_memory": memory_tools.add_memory,
    # Playground（温情八件套 + 实用能力）
    "get_daily_quote": playground_warm.get_daily_quote,
    "random_wiki_trivia": playground_warm.random_wiki_trivia,
    "get_tech_pulse": playground_warm.get_tech_pulse,
    "get_hot_topics": playground.get_hot_topics,
    "search_bilibili": playground.search_bilibili,
    "search_arxiv": playground.search_arxiv,
    "memory_graph_manage": playground.memory_graph_manage,
    "list_scheduled_briefings": playground.list_scheduled_briefings,
    "fetch_url_content": playground.fetch_url_content,
    "parse_document": playground.parse_document,
    "create_thinking_outline": playground.create_thinking_outline,
    # Notes
    "add_note": notes.add_note,
    "list_notes": notes.list_notes,
    "delete_note": notes.delete_note,
}


def _merge_mcp_tools(base: dict) -> dict:
    try:
        from app.core.mcp_bridge import discover_mcp_tools

        merged = dict(base)
        merged.update(discover_mcp_tools())
        return merged
    except Exception:
        return dict(base)


AVAILABLE_TOOLS = _merge_mcp_tools(AVAILABLE_TOOLS)

RISKY_TOOLS = frozenset(
    {
        "send_email",
        "reply_email",
        "forward_email",
        "delete_email",
        "delete_task",
        "delete_event",
        "delete_all_meeting_reminders",
        "move_file",
        "write_file",
        "write_office_document",
        "save_email_attachment",
        "add_task_with_due",
        "add_event",
        "modify_event",
        "add_reminder",
        "import_contacts",
        "import_calendar_ics",
        "fetch_and_import_calendar",
        "send_wecom_message",
        "send_dingtalk_message",
        "send_feishu_message",
        "send_team_notification",
        "lobster_browser_task",
        "sync_feishu_calendar",
        "sync_all_calendars",
        "add_tasks_from_minutes",
        "memory_graph_manage",
    }
)

TIME_TOOL_EXPR_KEYS = {
    "add_event": ("start_time_str", "start_time_expression"),
    "modify_event": ("start_time_str", "start_time_expression"),
    "add_task_with_due": ("due_time_str", "task_due_time_expression"),
    "modify_task": ("due_time_str", "task_due_time_expression"),
    "add_reminder": ("remind_time_str", "time_expression"),
}

TIME_TOOL_LOCAL_KEYS = {
    "add_event": "start_time_local",
    "modify_event": "start_time_local",
    "add_task_with_due": "due_time_local",
    "modify_task": "due_time_local",
    "add_reminder": "remind_time_local",
}
