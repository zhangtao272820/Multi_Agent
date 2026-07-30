"""将 NLU slots 注入 tool_plan args（轻量，无 graph/DB 依赖）。"""
from __future__ import annotations

from typing import Any


def inject_slots_into_plan(plan: list[dict[str, Any]] | Any, understanding: dict[str, Any]) -> list[dict[str, Any]] | Any:
    """
    Fill missing tool args from model-extracted slots.
    - Does not override args that already exist (except title-as-description).
    - Avoids additional regex heuristics; trusts the model slots.
    """
    if not isinstance(plan, list) or not isinstance(understanding, dict):
        return plan
    slots = understanding.get("slots") or {}
    if not isinstance(slots, dict) or not slots:
        return plan

    def _slot(name: str) -> str:
        v = slots.get(name)
        return str(v).strip() if v is not None else ""

    city = _slot("city")
    day = _slot("day")
    event_title = _slot("event_title")
    event_description = _slot("event_description")
    start_time_expr = _slot("start_time_expression")
    task_title = _slot("task_title")
    task_description = _slot("task_description")
    task_due_expr = _slot("task_due_time_expression")
    email_to = _slot("email_to_name_or_email")
    email_subject = _slot("email_subject")
    email_content = _slot("email_content")

    def _inject_desc(args: dict[str, Any], slot_desc: str, title_val: str) -> None:
        """注入真实详细内容；不覆盖已有非空非 title 的 description。"""
        if not slot_desc:
            return
        if title_val and slot_desc == title_val:
            return
        existing = str(args.get("description") or "").strip()
        if existing and (not title_val or existing != title_val):
            return
        args["description"] = slot_desc

    injected: list[dict[str, Any]] = []
    for item in plan:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        args = item.get("args") if isinstance(item.get("args"), dict) else {}

        if name == "get_weather":
            if city and not str(args.get("city", "")).strip():
                args["city"] = city
            if day and not str(args.get("day", "")).strip():
                args["day"] = day

        if name in ("add_event", "modify_event"):
            if event_title and not str(args.get("title", "")).strip():
                args["title"] = event_title
            if name == "add_event" and start_time_expr and not str(args.get("start_time_str", "")).strip():
                args["start_time_str"] = start_time_expr
            title_now = str(args.get("title") or event_title or "").strip()
            _inject_desc(args, event_description, title_now)

        if name in ("add_task", "add_task_with_due", "modify_task"):
            if task_title and not str(args.get("title", "")).strip():
                args["title"] = task_title
            if name == "add_task_with_due" and task_due_expr and not str(args.get("due_time_str", "")).strip():
                args["due_time_str"] = task_due_expr
            title_now = str(args.get("title") or task_title or "").strip()
            _inject_desc(args, task_description, title_now)

        if name == "add_contact":
            contact_name = _slot("contact_name")
            contact_email = _slot("contact_email")
            contact_desc = _slot("contact_description")
            if contact_name and not str(args.get("name", "")).strip():
                args["name"] = contact_name
            if contact_email and not str(args.get("email", "")).strip():
                args["email"] = contact_email
            if contact_desc and not str(args.get("description", "")).strip():
                args["description"] = contact_desc

        if name == "search_contact":
            contact_name = _slot("contact_name")
            if contact_name and not str(args.get("name", "")).strip():
                args["name"] = contact_name

        if name == "send_email":
            if email_to and not str(args.get("to", "")).strip():
                args["to"] = email_to
            if email_subject and not str(args.get("subject", "")).strip():
                args["subject"] = email_subject
            if email_content and not str(args.get("content", "")).strip():
                args["content"] = email_content

        if name == "get_travel_route":
            origin = _slot("route_origin")
            destination = _slot("route_destination")
            travel_mode = _slot("travel_mode")
            if origin and not str(args.get("origin", "")).strip():
                args["origin"] = origin
            if destination and not str(args.get("destination", "")).strip():
                args["destination"] = destination
            if travel_mode and not str(args.get("mode", "")).strip():
                args["mode"] = travel_mode

        injected.append({"name": name, "args": args})

    return injected
