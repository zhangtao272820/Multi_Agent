"""
Backward-compatible tool exports.
Domain implementations live in app.tools.* modules; registry assembles AVAILABLE_TOOLS.
"""
from __future__ import annotations

from app.tools.registry import AVAILABLE_TOOLS, RISKY_TOOLS
from app.tools.time_parse import prepare_time_sensitive_tool_args, filter_tool_call_kwargs
from app.tools.pending import (
    confirm_action,
    create_pending_action,
    decide_action,
    list_pending_actions,
)
from app.tools.contacts import (
    add_contact,
    get_contact_email,
    list_contacts,
    search_contact,
)
from app.tools.tasks import (
    add_task,
    add_task_with_due,
    complete_task,
    delete_task,
    list_tasks,
)
from app.tools.calendar import (
    add_event,
    complete_event,
    delete_all_meeting_reminders,
    delete_event,
    list_events,
    modify_event,
)
from app.tools.notes import add_note, delete_note, list_notes
from app.tools.email import classify_emails, get_email_detail, list_emails, reply_email, send_email
from app.tools.search import web_search
from app.tools.knowledge import knowledge_retrieval
from app.tools.weather import get_weather
from app.tools.files import (
    create_directory,
    list_files,
    move_file,
    read_file_content,
    write_file,
)
from app.tools.reminders import (
    add_reminder,
    cancel_reminder,
    list_reminders,
    restore_event_reminders,
)
from app.tools.memory_tools import add_memory, get_memories

__all__ = [
    "AVAILABLE_TOOLS",
    "RISKY_TOOLS",
    "prepare_time_sensitive_tool_args",
    "filter_tool_call_kwargs",
    "create_pending_action",
    "list_pending_actions",
    "confirm_action",
    "decide_action",
    "get_memories",
    "restore_event_reminders",
    "list_contacts",
    "list_emails",
    "reply_email",
    "classify_emails",
]
