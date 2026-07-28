"""总管编排专用：启发模型生成 tool_plan，避免走脆弱的大 planning prompt。"""
from __future__ import annotations

import json
from typing import Any

from app.core.llm import qwen_llm
from app.tools.registry import AVAILABLE_TOOLS

# 与 shared/adminCapabilities.ts MANAGER_ADMIN_TOOL_NAMES 对齐（总管编排硬边界）
MANAGER_ADMIN_TOOLS: frozenset[str] = frozenset(
    {
        "send_email",
        "list_emails",
        "reply_email",
        "classify_emails",
        "triage_emails",
        "add_contact",
        "search_contact",
        "get_contact_email",
        "list_contacts",
        "import_contacts",
        "add_task",
        "add_task_with_due",
        "list_tasks",
        "complete_task",
        "delete_task",
        "add_event",
        "list_events",
        "modify_event",
        "delete_event",
        "delete_all_meeting_reminders",
        "complete_event",
        "import_calendar_ics",
        "fetch_and_import_calendar",
        "export_calendar_ics",
        "sync_feishu_calendar",
        "sync_all_calendars",
        "add_reminder",
        "list_reminders",
        "cancel_reminder",
        "get_weather",
        "get_travel_route",
        "search_places_amap",
        "search_nearby_amap",
        "resolve_address_amap",
        "suggest_address_amap",
        "locate_coordinates_amap",
        "send_feishu_message",
    }
)

_MEETING_MARKERS = ("日程", "会议", "预约", "安排", "日历", "改期")


def _action_has_meeting(action_text: str) -> bool:
    t = str(action_text or "")
    return any(m in t for m in _MEETING_MARKERS)


def _manager_tool_catalog() -> str:
    """总管编排用的紧凑工具目录（禁止搜索/问数/玩法）。"""
    lines = [
        "个人助理工具目录（tool_plan.name 须从中选取）：",
        "- 邮件：send_email, list_emails, reply_email, classify_emails, triage_emails",
        "- 联系人：add_contact, search_contact, get_contact_email, list_contacts, import_contacts",
        "- 待办：add_task, add_task_with_due, list_tasks, complete_task, delete_task",
        "- 日程：add_event, list_events, modify_event, delete_event, delete_all_meeting_reminders, complete_event, "
        "add_reminder, list_reminders, cancel_reminder, sync_feishu_calendar",
        "- 天气：get_weather",
        "- 高德：get_travel_route, search_places_amap, search_nearby_amap, "
        "resolve_address_amap, suggest_address_amap, locate_coordinates_amap",
        "- 飞书：send_feishu_message",
    ]
    return "\n".join(lines)


def _upgrade_meeting_reminder_plan(
    plan: list[dict[str, Any]],
    action_text: str,
) -> list[dict[str, Any]]:
    """会议/日程语义：禁止裸 add_reminder，升级为 add_event（落日历库）。"""
    if not plan or not _action_has_meeting(action_text):
        return plan
    action = str(action_text or "").strip()
    out: list[dict[str, Any]] = []
    reminder_args: dict[str, Any] | None = None
    has_event = False
    for item in plan:
        name = str(item.get("name") or "").strip()
        args = item.get("args") if isinstance(item.get("args"), dict) else {}
        if name == "add_reminder":
            reminder_args = dict(args)
            continue
        if name == "add_event":
            has_event = True
        out.append(item)
    if not has_event:
        title = ""
        start = ""
        if reminder_args:
            title = str(
                reminder_args.get("content")
                or reminder_args.get("title")
                or ""
            ).strip()
            start = str(
                reminder_args.get("remind_time_str")
                or reminder_args.get("start_time_str")
                or ""
            ).strip()
        if not title:
            title = action[:120] or "会议"
        if not start:
            start = action
        syn = _normalize_tool_args(
            "add_event",
            {"title": title, "description": action[:240] or title, "start_time_str": start},
            action,
        )
        if syn:
            out.insert(0, {"name": "add_event", "args": syn})
    return out


def _extract_json_object(raw_text: str) -> dict[str, Any]:
    text = (raw_text or "").strip()
    if "```json" in text:
        text = text.split("```json", 1)[1].split("```", 1)[0].strip()
    elif "```" in text:
        text = text.split("```", 1)[1].split("```", 1)[0].strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    start_idx = text.find("{")
    if start_idx < 0:
        raise ValueError("No JSON object found.")
    depth = 0
    in_string = False
    escaped = False
    for idx in range(start_idx, len(text)):
        ch = text[idx]
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                parsed = json.loads(text[start_idx : idx + 1])
                if not isinstance(parsed, dict):
                    raise ValueError("Parsed JSON is not an object.")
                return parsed
    raise ValueError("No complete JSON object found.")


def _llm_json(prompt: str) -> dict[str, Any]:
    out = qwen_llm.chat_text([{"role": "user", "content": prompt}])
    try:
        return _extract_json_object(out)
    except Exception:
        fixed = qwen_llm.chat_text(
            [{"role": "user", "content": f"只输出一个合法 JSON 对象（不要解释）：\n{out}"}]
        )
        return _extract_json_object(fixed)


def _normalize_tool_args(name: str, args: dict[str, Any], action_text: str = "") -> dict[str, Any] | None:
    """校正 tool_plan args，避免 pending_decide 执行时缺必填字段。"""
    out = dict(args or {})
    action = str(action_text or "").strip()
    if name == "add_event":
        reminder_keys = {
            "remind_time_str",
            "remind_time_local",
            "time_expression",
            "reminder",
            "remind_minutes",
            "reminder_minutes",
            "notify",
            "alarm",
        }
        out = {k: v for k, v in out.items() if k not in reminder_keys}
        title = str(out.get("title") or out.get("task_title") or out.get("content") or "").strip()
        if not title and action:
            title = action[:120]
        if title:
            out["title"] = title
        if not str(out.get("start_time_str") or out.get("start_time_local") or "").strip() and action:
            out.setdefault("start_time_str", action)
        if not str(out.get("description") or "").strip() and action:
            out.setdefault("description", action)
        if not str(out.get("title") or "").strip():
            return None
        return out
    if name == "add_reminder":
        content = str(out.get("content") or out.get("task_title") or out.get("title") or "").strip()
        remind = str(
            out.get("remind_time_str")
            or out.get("start_time_str")
            or out.get("time_expression")
            or ""
        ).strip()
        if not remind and action:
            remind = action
        if not content and action:
            content = action[:120]
        if not content or not remind:
            return None
        return {"content": content, "remind_time_str": remind}
    if name in ("add_task", "add_task_with_due"):
        title = str(out.get("title") or out.get("task_title") or "").strip()
        if not title and action:
            title = action[:120]
        if not title:
            return None
        out["title"] = title
        return out
    if name == "add_contact":
        cname = str(out.get("name") or out.get("contact_name") or "").strip()
        cemail = str(out.get("email") or out.get("contact_email") or "").strip()
        if not cname or not cemail:
            return None
        out["name"] = cname
        out["email"] = cemail
        desc = str(out.get("description") or out.get("contact_description") or "").strip()
        if desc:
            out["description"] = desc
        return out
    return out


def _sanitize_tools(
    raw: Any,
    action_text: str = "",
    *,
    manager_route: bool = True,
) -> list[dict[str, Any]]:
    """过滤并规范化 tool_plan；manager_route 时仅保留总管可编排工具并纠偏会议提醒。"""
    if not isinstance(raw, list):
        return []
    plan: list[dict[str, Any]] = []
    dropped: list[str] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        args = item.get("args") if isinstance(item.get("args"), dict) else {}
        if name not in AVAILABLE_TOOLS:
            continue
        if manager_route and name not in MANAGER_ADMIN_TOOLS:
            dropped.append(name)
            continue
        normalized = _normalize_tool_args(name, args, action_text)
        if normalized is None:
            continue
        plan.append({"name": name, "args": normalized})
    if dropped:
        print(f"DEBUG: manager_route dropped out-of-boundary tools: {dropped}")
    if manager_route:
        plan = _upgrade_meeting_reminder_plan(plan, action_text)
    return plan


_TOOL_INTENT_MAP: dict[str, str] = {
    "add_event": "日程",
    "modify_event": "日程",
    "delete_event": "日程",
    "delete_all_meeting_reminders": "日程",
    "complete_event": "日程",
    "list_events": "日程",
    "add_reminder": "日程",
    "list_reminders": "日程",
    "cancel_reminder": "日程",
    "add_task": "待办",
    "add_task_with_due": "待办",
    "list_tasks": "待办",
    "complete_task": "待办",
    "delete_task": "待办",
    "send_email": "邮件",
    "list_emails": "邮件",
    "reply_email": "邮件",
    "get_weather": "天气",
    "daily_briefing": "简报",
    "weekly_report": "简报",
    "prepare_meeting": "会前准备",
    "get_travel_route": "混合任务",
    "search_nearby_amap": "混合任务",
    "search_places_amap": "混合任务",
    "list_files": "文件",
    "read_file_content": "文件",
    "add_contact": "联系人",
    "search_contact": "联系人",
    "list_contacts": "联系人",
    "get_contact_email": "联系人",
    "import_contacts": "联系人",
    "send_feishu_message": "其他",
}


def intent_from_manager_tool_plan(tool_plan: Any) -> str:
    if not isinstance(tool_plan, list):
        return ""
    for item in tool_plan:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        intent = _TOOL_INTENT_MAP.get(name)
        if intent:
            return intent
    return ""


def resolve_admin_intent_hint(
    manager_task: dict[str, Any] | None = None,
    action_text: str = "",
) -> str:
    """LLM-First：intent_hint → tool_plan 映射；仅 legacy 模式才 regex infer。"""
    from app.core.admin_plan_fastpath import infer_intent_from_action, is_admin_legacy_infer_enabled

    action = str(action_text or "").strip()
    if isinstance(manager_task, dict):
        hint = str(manager_task.get("intent_hint") or "").strip()
        if hint and hint != "其他":
            return hint
        hint = intent_from_manager_tool_plan(manager_task.get("tool_plan"))
        if hint and hint != "其他":
            return hint
        action = str(manager_task.get("action_text") or action).strip()
    if is_admin_legacy_infer_enabled() and action:
        return infer_intent_from_action(action)
    return "其他"


def normalize_manager_task(
    manager_task: dict[str, Any] | None,
    user_message: str,
) -> dict[str, Any]:
    """补全 action_text/source，保证总管编排可对齐；保留总管下发的 tool_plan/read_only。"""
    from app.core.admin_write_clarify import strip_admin_manager_guards

    mt = dict(manager_task) if isinstance(manager_task, dict) else {}
    mt.setdefault("source", "manager")
    action = str(mt.get("action_text") or "").strip()
    ws_raw = str(user_message or "").strip()

    def _peel(text: str) -> str:
        peeled = strip_admin_manager_guards(text)
        if peeled:
            return peeled
        # 兼容旧前缀剥离：仍无任务句时再按行过滤
        s = str(text or "").strip()
        for marker in (
            "【总管约束】",
            "【总管执行约束】",
            "【只读编排】",
            "（强制）不要等待人工确认",
            "已知信息（来自上游",
        ):
            i = s.find(marker)
            if i > 0:
                s = s[:i].strip()
        lines = [ln.strip() for ln in s.splitlines() if ln.strip()]
        skip_prefixes = (
            "仅处理下列个人助理",
            "勿混入",
            "会议与日程须",
            "路线/地图",
            "用户说「从这",
            "若已给出会议",
            "· ",
        )
        task_lines = [
            ln
            for ln in lines
            if ln
            and not any(ln.startswith(p) for p in skip_prefixes)
            and "【总管" not in ln
            and "（强制）" not in ln
        ]
        if task_lines:
            return "，".join(task_lines)
        return ""

    if action:
        peeled = _peel(action)
        # action 仅剩 preamble 时，从完整 WS 原文再剥一次
        if not peeled and ws_raw:
            peeled = _peel(ws_raw)
        action = peeled or action
    else:
        action = _peel(ws_raw) or ws_raw

    mt["action_text"] = action
    return mt


def _manager_weather_needs_slot_llm(manager_task: dict[str, Any], understanding: dict[str, Any]) -> bool:
    """天气工具缺 city 时需补跑 slot LLM（不从 action_text regex 抽取）。"""
    intent = str(understanding.get("intent") or "").strip()
    tool_plan = manager_task.get("tool_plan")
    is_weather = intent == "天气"
    if isinstance(tool_plan, list) and tool_plan:
        first = tool_plan[0]
        if isinstance(first, dict) and str(first.get("name") or "").strip() == "get_weather":
            is_weather = True
    if not is_weather:
        return False
    slots = understanding.get("slots") if isinstance(understanding.get("slots"), dict) else {}
    if str(slots.get("city") or "").strip():
        return False
    if isinstance(tool_plan, list) and tool_plan:
        first = tool_plan[0]
        if isinstance(first, dict):
            args = first.get("args") if isinstance(first.get("args"), dict) else {}
            if str(args.get("city") or "").strip():
                return False
    return True


def _resolve_orchestrated_slot_intent(manager_task: dict[str, Any], understanding: dict[str, Any]) -> str:
    intent = str(understanding.get("intent") or "").strip()
    tool_plan = manager_task.get("tool_plan")
    if isinstance(tool_plan, list) and tool_plan:
        first = tool_plan[0]
        if isinstance(first, dict):
            name = str(first.get("name") or "").strip()
            if name == "get_weather":
                return "天气"
            if name == "get_travel_route":
                return "混合任务"
            if name in ("list_emails", "send_email", "reply_email"):
                return "邮件"
            if name in (
                "add_event",
                "modify_event",
                "delete_event",
                "delete_all_meeting_reminders",
                "add_reminder",
                "add_task",
                "add_task_with_due",
            ):
                return "日程" if name not in ("add_task", "add_task_with_due") else "待办"
    hint = str(manager_task.get("intent_hint") or "").strip()
    return hint if hint and hint != "其他" else intent


def _manager_route_needs_slot_llm(manager_task: dict[str, Any], understanding: dict[str, Any]) -> bool:
    intent = _resolve_orchestrated_slot_intent(manager_task, understanding)
    if intent not in ("混合任务", "路线"):
        tool_plan = manager_task.get("tool_plan")
        if not (isinstance(tool_plan, list) and tool_plan):
            return False
        first = tool_plan[0]
        if not isinstance(first, dict) or str(first.get("name") or "") != "get_travel_route":
            return False
    slots = understanding.get("slots") if isinstance(understanding.get("slots"), dict) else {}
    if str(slots.get("route_origin") or "").strip() and str(slots.get("route_destination") or "").strip():
        return False
    tool_plan = manager_task.get("tool_plan")
    if isinstance(tool_plan, list) and tool_plan:
        first = tool_plan[0]
        if isinstance(first, dict):
            args = first.get("args") if isinstance(first.get("args"), dict) else {}
            if str(args.get("origin") or "").strip() and str(args.get("destination") or "").strip():
                return False
    return True


def _manager_email_needs_slot_llm(manager_task: dict[str, Any], understanding: dict[str, Any]) -> bool:
    """发信/回信缺 to/subject 时需补跑 slot LLM（不从 action_text regex 抽取）。"""
    intent = _resolve_orchestrated_slot_intent(manager_task, understanding)
    tool_plan = manager_task.get("tool_plan")
    tool_name = ""
    if isinstance(tool_plan, list) and tool_plan:
        first = tool_plan[0]
        if isinstance(first, dict):
            tool_name = str(first.get("name") or "").strip()
    is_email = intent == "邮件" or tool_name in ("send_email", "reply_email")
    if not is_email or tool_name == "list_emails":
        return False
    slots = understanding.get("slots") if isinstance(understanding.get("slots"), dict) else {}
    args: dict[str, Any] = {}
    if isinstance(tool_plan, list) and tool_plan:
        first = tool_plan[0]
        if isinstance(first, dict) and isinstance(first.get("args"), dict):
            args = first["args"]
    has_to = bool(str(slots.get("email_to_name_or_email") or args.get("to") or "").strip())
    has_subject = bool(str(slots.get("email_subject") or args.get("subject") or "").strip())
    if tool_name == "reply_email":
        return not has_to
    if tool_name == "send_email" or intent == "邮件":
        return not (has_to and has_subject)
    return False


def _manager_missing_intent_llm(manager_task: dict[str, Any], understanding: dict[str, Any]) -> bool:
    """总管未传 intent_hint / tool_plan 时，需 LLM 分类 intent。"""
    intent = str(understanding.get("intent") or "").strip()
    if intent and intent != "其他":
        return False
    tool_plan = manager_task.get("tool_plan")
    if isinstance(tool_plan, list) and tool_plan:
        return False
    return bool(str(manager_task.get("action_text") or "").strip())


def _manager_schedule_needs_slot_llm(manager_task: dict[str, Any], understanding: dict[str, Any]) -> bool:
    intent = _resolve_orchestrated_slot_intent(manager_task, understanding)
    if intent not in ("日程", "待办"):
        return False
    slots = understanding.get("slots") if isinstance(understanding.get("slots"), dict) else {}
    resolved = understanding.get("resolved_time")
    resolved = resolved if isinstance(resolved, dict) else {}
    tool_plan = manager_task.get("tool_plan")
    plan_title = ""
    plan_time = ""
    if isinstance(tool_plan, list) and tool_plan:
        first = tool_plan[0]
        if isinstance(first, dict):
            args = first.get("args") if isinstance(first.get("args"), dict) else {}
            plan_title = str(args.get("title") or args.get("content") or "").strip()
            plan_time = str(
                args.get("start_time_str")
                or args.get("start_time_expression")
                or args.get("remind_time_str")
                or args.get("due_time_str")
                or ""
            ).strip()
    if intent == "待办":
        return len(str(slots.get("task_title") or plan_title or "").strip()) < 2
    title = str(slots.get("event_title") or plan_title or "").strip()
    time_expr = str(slots.get("start_time_expression") or plan_time or "").strip()
    has_time = bool(time_expr or str(resolved.get("start_time_local") or "").strip())
    # 无 tool_plan 时：有 action_text 也需 slot LLM（或后续 backfill）；此处仍报缺槽以触发 fill
    action = str(manager_task.get("action_text") or "").strip()
    if not has_time and action and intent == "日程":
        # action_text 可作为时间载体，仍建议跑一次 slot LLM 抽 title；若已有 title 则可不跑
        if len(title) >= 2:
            return False
    return len(title) < 2 or not has_time


def _manager_orchestrated_needs_slot_llm(manager_task: dict[str, Any], understanding: dict[str, Any]) -> bool:
    if _manager_weather_needs_slot_llm(manager_task, understanding):
        return True
    if _manager_route_needs_slot_llm(manager_task, understanding):
        return True
    if _manager_email_needs_slot_llm(manager_task, understanding):
        return True
    if _manager_schedule_needs_slot_llm(manager_task, understanding):
        return True
    return False


def enrich_manager_orchestrated_understanding(
    understanding: dict[str, Any],
    manager_task: dict[str, Any],
    action_text: str,
    dialogue: str = "",
    user_message: str = "",
) -> dict[str, Any]:
    """
    总管编排：manager_task 已对齐 intent/tool，但 args/slots 可能为空。
    缺槽时补跑 fill_admin_slots（LLM），禁止 regex 从用户原话抽 city/day。
    """
    if not isinstance(understanding, dict) or not isinstance(manager_task, dict):
        return understanding if isinstance(understanding, dict) else {}

    merged = dict(understanding)
    action = str(action_text or manager_task.get("action_text") or "").strip()

    from app.core.admin_nlu import classify_admin_intent, fill_admin_slots, is_admin_nlu_enabled

    if is_admin_nlu_enabled() and _manager_missing_intent_llm(manager_task, merged) and action:
        try:
            classified = classify_admin_intent(action, "")
            ci = str(classified.get("intent") or "").strip()
            if ci and ci != "其他":
                merged["intent"] = ci
                if classified.get("admin_scenario"):
                    merged["admin_scenario"] = classified["admin_scenario"]
                merged["manager_intent_llm_classified"] = True
        except Exception:
            pass

    if not _manager_orchestrated_needs_slot_llm(manager_task, merged):
        return merged

    if not is_admin_nlu_enabled():
        return merged

    intent = _resolve_orchestrated_slot_intent(manager_task, merged) or "其他"
    if not action:
        return merged

    # 总管子任务：仅用 action_text 填槽，避免 Manager 会话 history 污染 city/day 抽取
    slot_dialogue = ""

    try:
        slot_part = fill_admin_slots(action, slot_dialogue, intent)
    except Exception:
        return merged

    base_slots = dict(merged.get("slots") or {})
    llm_slots = slot_part.get("slots") if isinstance(slot_part.get("slots"), dict) else {}
    for k, v in llm_slots.items():
        vs = str(v or "").strip()
        if vs and not str(base_slots.get(k) or "").strip():
            base_slots[k] = vs

    if not str(base_slots.get("city") or "").strip() and user_message:
        fallback_action = str(
            normalize_manager_task({}, user_message).get("action_text") or ""
        ).strip()
        if fallback_action and fallback_action != action:
            try:
                slot_part2 = fill_admin_slots(fallback_action, "", intent)
                llm_slots2 = (
                    slot_part2.get("slots")
                    if isinstance(slot_part2.get("slots"), dict)
                    else {}
                )
                for k, v in llm_slots2.items():
                    vs = str(v or "").strip()
                    if vs and not str(base_slots.get(k) or "").strip():
                        base_slots[k] = vs
            except Exception:
                pass

    merged["slots"] = base_slots

    if slot_part.get("needs_clarification") and not str(base_slots.get("city") or "").strip():
        merged["needs_clarification"] = True
        merged["clarification_questions"] = list(slot_part.get("clarification_questions") or [])[:4]
    elif str(base_slots.get("city") or "").strip():
        merged["needs_clarification"] = False
    elif str(base_slots.get("route_origin") or "").strip() and str(base_slots.get("route_destination") or "").strip():
        merged["needs_clarification"] = False

    merged["manager_slots_llm_enriched"] = True
    return merged


def understanding_from_manager_task(manager_task: dict[str, Any]) -> dict[str, Any]:
    """总管编排：跳过 NLU LLM，直接从 manager_task 对齐 intent/slots。"""
    from app.core.admin_nlu import _EMPTY_SLOTS, _default_confirm_action
    from app.core.admin_plan_fastpath import resolve_event_title

    action = str(manager_task.get("action_text") or "").strip()
    tool_plan = manager_task.get("tool_plan")

    intent = resolve_admin_intent_hint(manager_task, action)

    slots = dict(_EMPTY_SLOTS)
    if isinstance(tool_plan, list) and tool_plan:
        first = tool_plan[0]
        if isinstance(first, dict):
            args = first.get("args") if isinstance(first.get("args"), dict) else {}
            name = str(first.get("name") or "").strip()
            title = str(args.get("title") or args.get("content") or "").strip()
            if name in ("add_event", "modify_event"):
                title = resolve_event_title(action, {"event_title": title}) or title
                if title:
                    slots["event_title"] = title
            elif name == "add_reminder":
                title = resolve_event_title(action, {"event_title": title}) or title
                if title:
                    slots["event_title"] = title
            elif name in ("add_task", "add_task_with_due") and title:
                slots["task_title"] = title[:120]
            for slot_key, arg_key in (
                ("start_time_expression", "start_time_str"),
                ("start_time_expression", "remind_time_str"),
                ("task_due_time_expression", "due_time_str"),
            ):
                raw = args.get(arg_key)
                if isinstance(raw, str) and raw.strip():
                    slots[slot_key] = raw.strip()
                    break
            if name == "get_weather":
                city = str(args.get("city") or "").strip()
                day = str(args.get("day") or "").strip()
                if city:
                    slots["city"] = city
                if day:
                    slots["day"] = day
            if name == "get_travel_route":
                origin = str(args.get("origin") or "").strip()
                dest = str(args.get("destination") or "").strip()
                if origin:
                    slots["route_origin"] = origin
                if dest:
                    slots["route_destination"] = dest
                mode = str(args.get("mode") or "").strip()
                if mode:
                    slots["travel_mode"] = mode

    sub_queries = manager_task.get("sub_queries")
    if isinstance(sub_queries, list) and len(sub_queries) >= 2:
        slots["admin_sub_queries"] = [str(x).strip() for x in sub_queries if str(x).strip()][:6]

    return {
        "intent": intent or "其他",
        "slots": slots,
        "needs_clarification": False,
        "confirm_action": _default_confirm_action(),
        "manager_task_aligned": True,
    }


def passthrough_manager_tool_plan(client_context: dict[str, Any] | None) -> list[dict[str, Any]] | None:
    """仅透传总管下发的结构化 tool_plan。"""
    if not isinstance(client_context, dict):
        return None
    task = client_context.get("manager_task")
    if not isinstance(task, dict) or str(task.get("source") or "") != "manager":
        return None
    action = str(task.get("action_text") or "").strip()
    plan = _sanitize_tools(task.get("tool_plan"), action, manager_route=True)
    return plan or None


def sanitize_manager_admin_plan(
    plan: list[dict[str, Any]] | None,
    action_text: str = "",
) -> list[dict[str, Any]] | None:
    """总管编排路径：硬过滤越界工具 + 会议→add_event。"""
    if not plan:
        return None
    out = _sanitize_tools(plan, action_text, manager_route=True)
    return out or None


def plan_tools_from_manager_context(
    client_context: dict[str, Any] | None,
    understanding: dict[str, Any] | None,
    user_message: str,
) -> list[dict[str, Any]] | None:
    """启发模型：从 manager_task + NLU 理解生成 tool_plan。"""
    if not isinstance(client_context, dict):
        return None
    task = client_context.get("manager_task")
    if not isinstance(task, dict) or str(task.get("source") or "") != "manager":
        return None

    action = str(task.get("action_text") or user_message or "").strip()
    if not action:
        return None

    intent_hint = str(task.get("intent_hint") or "").strip()
    u = understanding if isinstance(understanding, dict) else {}
    intent = str(u.get("intent") or intent_hint or "其他").strip()
    u_summary = {
        k: u.get(k)
        for k in ("intent", "slots", "resolved_time", "resolved_amap")
        if u.get(k) is not None
    }
    hint_plan = task.get("tool_plan")

    prompt = f"""你是个人助手工具规划器。总管 Agent 已编排任务，请选定要调用的工具。
只输出 JSON：{{"tools":[{{"name":"工具名","args":{{...}}}}]}}

用户动作（action_text）：
{action[:1200]}

intent_hint：{intent_hint or "无"}
NLU intent：{intent}
语义理解（JSON）：{json.dumps(u_summary, ensure_ascii=False)[:1500]}
总管预填 tool_plan：{json.dumps(hint_plan, ensure_ascii=False)[:800] if hint_plan else "无"}

{_manager_tool_catalog()}

规则：
1. name 必须来自上方总管可编排工具目录（禁止 web_search/knowledge_retrieval/ask_database/玩法工具）；
2. 若总管 tool_plan 已给出且合理，优先采用并补全 args；
3. 日程/会议/创建日程→必须 add_event（落日历库）；仅闹钟/叫我且无会议语义→add_reminder；
   待办→add_task/add_task_with_due；邮件→send_email/list_emails；联系人→add_contact/list_contacts；
   路线/导航/多久到→get_travel_route；附近/POI→search_nearby_amap；天气→get_weather；飞书消息→send_feishu_message；
4. 时间类 args 可填 start_time_str/remind_time_str 等自然语言，勿编造用户未说的时间地点；
5. 只输出 JSON，不要 markdown。"""

    last_err: Exception | None = None
    for _ in range(2):
        try:
            data = _llm_json(prompt)
            tools = _sanitize_tools(data.get("tools"), action)
            if tools:
                return tools
        except Exception as e:
            last_err = e
            continue
    if last_err:
        print(f"DEBUG: plan_tools_from_manager_context failed: {last_err}")
    return None
