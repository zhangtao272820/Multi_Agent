"""Admin write slot checks and fail messages."""
from __future__ import annotations

import re
from typing import Any


_WRITE_TOOL_NAMES = frozenset({
    "add_event",
    "modify_event",
    "delete_event",
    "add_reminder",
    "add_task",
    "add_task_with_due",
    "complete_task",
    "delete_task",
    "send_email",
    "reply_email",
    "write_file",
    "move_file",
})


def plan_tool_names(plan: Any) -> frozenset[str]:
    if not isinstance(plan, list):
        return frozenset()
    return frozenset(
        str(item.get("name") or "").strip()
        for item in plan
        if isinstance(item, dict) and str(item.get("name") or "").strip()
    )


def extract_human_message_from_exec(text: str) -> str | None:
    raw = text or ""
    for pat in (
        r'"tool_result_text"\s*:\s*"([^"]+)"',
        r'"human_message"\s*:\s*"([^"]+)"',
        r"成功[：:]\s*([^|\n\"]+)",
        r"失败[：:]\s*([^|\n\"]+)",
    ):
        m = re.search(pat, raw)
        if m:
            line = m.group(1).strip()
            if line and "tool_result" not in line and "data=" not in line:
                return line
    return None


def _looks_like_manager_preamble(value: str) -> bool:
    text = str(value or "").strip()
    if not text:
        return False
    return (
        text.startswith("仅处理下列")
        or text.startswith("· ")
        or "【总管约束】" in text
        or text.startswith("若已给出会议")
        or "【只读编排】" in text
        or "（强制）不要等待人工确认" in text
        or text.startswith("已知信息（来自上游步骤")
    )


_PREAMBLE_LINE_PREFIXES = (
    "仅处理下列个人助理能力",
    "勿混入搜索",
    "勿混入知识库",
    "会议与日程须",
    "路线/地图问题必须",
    "路线/地图必须",
    "用户说「从这",
    "若已给出会议",
    "· 邮件",
    "· 联系人",
    "· 待办",
    "· 日程",
    "· 天气",
    "· 高德",
    "· 飞书",
    "【总管约束】",
    "【总管执行约束】",
    "【只读编排】",
    "（强制）不要等待人工确认",
    "已知信息（来自上游步骤",
)


def _is_admin_preamble_line(line: str) -> bool:
    l = str(line or "").strip()
    if not l:
        return True
    if any(l.startswith(p) for p in _PREAMBLE_LINE_PREFIXES):
        return True
    if l.startswith("· "):
        return True
    return False


def strip_admin_manager_guards(raw: str) -> str:
    """
    剥离总管 WS preamble / 【总管约束】，保留可执行子句（全部拼接）。
    对齐 shared/managerSubAgentProtocol.stripAdminManagerGuards。
    """
    s = str(raw or "").strip()
    if not s:
        return ""
    for marker in (
        "【总管约束】",
        "【总管执行约束】",
        "【只读编排】",
        "（强制）不要等待人工确认",
        "已知信息（来自上游步骤",
    ):
        i = s.find(marker)
        if i > 0:
            s = s[:i].strip()

    lines = [ln.strip() for ln in s.splitlines() if ln.strip() and len(ln.strip()) >= 4]
    if len(lines) <= 1:
        one = lines[0] if lines else s
        if _is_admin_preamble_line(one) or "仅处理下列个人助理能力" in one:
            parts = [p.strip() for p in one.replace(",", "，").split("，") if len(p.strip()) >= 4]
            if len(parts) > 1:
                lines = parts

    taskish = [ln for ln in lines if not _is_admin_preamble_line(ln)]
    if taskish:
        return "，".join(taskish)
    if lines:
        last = lines[-1]
        return "" if _is_admin_preamble_line(last) else last
    return "" if _is_admin_preamble_line(s) else s


def resolve_manager_persist_user_message(
    raw_message: str,
    client_context: dict | None = None,
) -> str:
    """
    总管编排落库 / HumanMessage 用文案：优先 manager_task.action_text，
    否则剥 WS preamble；直连用户消息原样返回。
    """
    raw = str(raw_message or "").strip()
    ctx = client_context if isinstance(client_context, dict) else {}
    task = ctx.get("manager_task") if isinstance(ctx.get("manager_task"), dict) else {}
    orchestrated = bool(ctx.get("manager_orchestrated") or task)
    if not orchestrated:
        return raw
    action = str(task.get("action_text") or "").strip()
    if action and not _looks_like_manager_preamble(action):
        return action
    peeled = strip_admin_manager_guards(raw)
    if peeled:
        return peeled
    return action or raw


def _clean_slot_value(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if _looks_like_manager_preamble(text):
        recovered = strip_admin_manager_guards(text)
        if recovered and not _looks_like_manager_preamble(recovered):
            return recovered
        return ""
    return text

def _looks_like_composite_manager_dump(text: str) -> bool:
    s = str(text or "").strip()
    if len(s) < 28:
        return False
    data_marks = ("知识库", "检索", "数据库", "图表", "对比图", "提炼要点", "生成对比")
    meeting_marks = ("会议", "日程", "提醒", "标题为", "周会")
    has_data = any(m in s for m in data_marks)
    has_meeting = any(m in s for m in meeting_marks)
    if has_data and has_meeting:
        return True
    if s.count("，") + s.count(",") >= 2 and len(s) >= 40:
        return True
    return False


def _extract_quoted_title(text: str) -> str:
    import re

    for pat in (
        r"[「『\"]([^」』\"]+)[」』\"]",
        r"《([^》]+)》",
    ):
        m = re.search(pat, text or "")
        if m and m.group(1).strip():
            return m.group(1).strip()[:80]
    return ""


def _resolve_event_title_for_backfill(action: str, title: str) -> str:
    t = _clean_slot_value(title)
    if t and not _looks_like_composite_manager_dump(t):
        return t[:80]
    quoted = _extract_quoted_title(action)
    if quoted and not _looks_like_composite_manager_dump(quoted):
        return quoted
    for marker in ("标题为", "标题：", "标题:"):
        idx = (action or "").find(marker)
        if idx < 0:
            continue
        tail = action[idx + len(marker) :].strip()
        q = _extract_quoted_title(tail)
        if q:
            return q
    return ""


def backfill_manager_write_plan_from_action(
    plan: Any,
    understanding: dict[str, Any] | None,
    action_text: str = "",
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """
    总管编排：写工具缺槽时，用 action_text / slots / resolved_time 回填 plan args。
    不从用户原话 regex 抽意图；仅把编排子句作为时间表达载体（与 legacy start_time_str=action 对齐）。
    """
    und: dict[str, Any] = dict(understanding) if isinstance(understanding, dict) else {}
    slots = dict(und.get("slots") if isinstance(und.get("slots"), dict) else {})
    resolved = und.get("resolved_time") if isinstance(und.get("resolved_time"), dict) else {}
    action = _clean_slot_value(action_text)
    if not action:
        action = strip_admin_manager_guards(str(action_text or ""))
    if not isinstance(plan, list) or not plan:
        und["slots"] = slots
        return [], und

    out: list[dict[str, Any]] = []
    for item in plan:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        args = dict(item.get("args") if isinstance(item.get("args"), dict) else {})
        if name in ("add_event", "modify_event"):
            title = _resolve_event_title_for_backfill(
                action, str(args.get("title") or slots.get("event_title") or "")
            )
            time_raw = _clean_slot_value(
                args.get("start_time_str")
                or args.get("start_time_expression")
                or args.get("start_time_local")
                or slots.get("start_time_expression")
                or resolved.get("start_time_local")
                or ""
            )
            # 编排子句已含会议语义时，整句可作为时间解析输入（与 Manager legacy infer 一致）
            if not time_raw and action:
                time_raw = action
            if title:
                args["title"] = title
                slots["event_title"] = title
                desc = _clean_slot_value(args.get("description") or slots.get("event_description") or "")
                # 禁止用 title 顶替详细内容；复合 dump 清空
                if desc and _looks_like_composite_manager_dump(desc):
                    desc = ""
                if desc and desc == title:
                    desc = ""
                if desc:
                    args["description"] = desc
                    slots["event_description"] = desc
                else:
                    args.pop("description", None)
            if time_raw:
                args["start_time_str"] = time_raw
                if not _clean_slot_value(slots.get("start_time_expression")):
                    slots["start_time_expression"] = time_raw
        elif name in ("add_task", "add_task_with_due", "modify_task"):
            title = _clean_slot_value(
                args.get("title") or args.get("content") or slots.get("task_title") or ""
            )
            if not title and action and not _looks_like_composite_manager_dump(action):
                title = action[:120]
            if title and not _looks_like_composite_manager_dump(title):
                args["title"] = title
                if not _clean_slot_value(slots.get("task_title")):
                    slots["task_title"] = title
            desc = _clean_slot_value(args.get("description") or slots.get("task_description") or "")
            if desc and desc == title:
                desc = ""
            if desc:
                args["description"] = desc
                slots["task_description"] = desc
            else:
                args.pop("description", None)
            if name == "add_task_with_due":
                due = _clean_slot_value(
                    args.get("due_time_str")
                    or args.get("due_time_local")
                    or slots.get("task_due_time_expression")
                    or resolved.get("start_time_local")
                    or action
                    or ""
                )
                if due:
                    args["due_time_str"] = due
                    if not _clean_slot_value(slots.get("task_due_time_expression")):
                        slots["task_due_time_expression"] = due
        elif name == "add_reminder":
            time_raw = _clean_slot_value(
                args.get("remind_time_str")
                or args.get("remind_time_local")
                or slots.get("start_time_expression")
                or resolved.get("start_time_local")
                or action
                or ""
            )
            content = _resolve_event_title_for_backfill(
                action, str(args.get("content") or slots.get("event_title") or "")
            ) or _clean_slot_value(args.get("content") or "")
            if content and not _looks_like_composite_manager_dump(content):
                args["content"] = content
            if time_raw:
                args["remind_time_str"] = time_raw
                if not _clean_slot_value(slots.get("start_time_expression")):
                    slots["start_time_expression"] = time_raw
        out.append({"name": name, "args": args})

    und["slots"] = slots
    return out, und


def manager_write_plan_missing_slots(
    plan: Any,
    understanding: dict[str, Any] | None,
) -> list[str]:
    if not isinstance(plan, list) or not plan:
        return []
    slots = (
        understanding.get("slots")
        if isinstance(understanding, dict) and isinstance(understanding.get("slots"), dict)
        else {}
    )
    slots = slots if isinstance(slots, dict) else {}
    resolved = understanding.get("resolved_time") if isinstance(understanding, dict) else None
    names = plan_tool_names(plan)
    if not (names & _WRITE_TOOL_NAMES):
        return []
    missing: list[str] = []
    for item in plan:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        args = item.get("args") if isinstance(item.get("args"), dict) else {}
        if name in ("add_event", "modify_event"):
            title = str(args.get("title") or slots.get("event_title") or "").strip()
            time_raw = str(
                args.get("start_time_str")
                or args.get("start_time_expression")
                or args.get("start_time_local")
                or slots.get("start_time_expression")
                or ""
            ).strip()
            if _looks_like_manager_preamble(time_raw):
                time_raw = ""
            if _looks_like_manager_preamble(title):
                title = ""
            time_ok = bool(time_raw or (isinstance(resolved, dict) and resolved.get("start_time_local")))
            if len(title) < 2:
                missing.append("event_title")
            elif len(title) >= 28 and (
                ("知识库" in title or "检索" in title or "图表" in title)
                and ("会议" in title or "日程" in title or "提醒" in title)
            ):
                # 复合总管原话误入 title：视为缺槽，交由 backfill 抽「」标题
                missing.append("event_title")
            if not time_ok:
                missing.append("start_time_expression")
        elif name in ("add_task", "add_task_with_due"):
            title = str(args.get("title") or args.get("content") or slots.get("task_title") or "").strip()
            if _looks_like_manager_preamble(title):
                title = ""
            if len(title) < 2:
                missing.append("task_title")
            if name == "add_task_with_due":
                due_raw = str(
                    args.get("due_time_str")
                    or args.get("due_time_local")
                    or slots.get("task_due_time_expression")
                    or ""
                ).strip()
                if _looks_like_manager_preamble(due_raw):
                    due_raw = ""
                if not due_raw:
                    missing.append("start_time_expression")
        elif name == "add_reminder":
            time_raw = str(
                args.get("remind_time_str")
                or args.get("remind_time_local")
                or slots.get("start_time_expression")
                or ""
            ).strip()
            if _looks_like_manager_preamble(time_raw):
                time_raw = ""
            if not time_raw and not (isinstance(resolved, dict) and resolved.get("start_time_local")):
                missing.append("start_time_expression")
    seen: set[str] = set()
    out: list[str] = []
    for m in missing:
        if m not in seen:
            seen.add(m)
            out.append(m)
    return out


def compose_write_fail_reply(exec_results: str, failed_lines: list[str]) -> tuple[str, bool]:
    text = str(exec_results or "")
    joined = "\n".join(failed_lines) if failed_lines else text
    human = extract_human_message_from_exec(joined) or extract_human_message_from_exec(text)

    if "plan_empty" in text:
        return (
            "未能完成写操作：未生成可执行的日历/待办计划。"
            "请补充会议标题与具体时间（如「明天上午10点」「项目周会」）后重试。",
            True,
        )
    if "time_parse_failed" in text or "time_parse_failed" in joined:
        detail = human or "无法解析时间表达"
        return (
            f"未能完成写操作：时间解析失败（{detail}）。"
            "请问具体在什么时间？（例如：明天上午10点 / next Friday 9am）",
            True,
        )
    if re.search(r"标题|title|不能为空|缺少", joined, re.I) and re.search(
        r"时间|title|标题", joined, re.I
    ):
        return (
            "未能完成写操作：缺少会议标题或时间。"
            "请确认会议时间与标题（如「明天上午10点」「项目周会」）后重试。",
            True,
        )
    if human:
        return (f"未能完成写操作：{human}", False)
    if failed_lines:
        tip = failed_lines[0]
        tip = re.sub(r"^\[.*?\]\s*", "", tip)
        tip = re.sub(r"^.*?结果:\s*", "", tip)
        return (f"未能完成写操作：{tip.strip()[:240]}", False)
    return (
        "未能完成写操作：日历/待办工具未成功执行。"
        "请确认会议时间与标题（如「明天上午10点」「项目周会」）后重试。",
        True,
    )
