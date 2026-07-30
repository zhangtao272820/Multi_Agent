from __future__ import annotations

import datetime
import inspect
from typing import Any, Dict

from app.core.time_nlu import (
    resolve_datetime_to_local_dt,
    resolve_datetime_with_llm,
)
from app.core.time_utils import user_tz

_TIME_TOOL_EXPR_KEYS: Dict[str, tuple[str, str]] = {
    "add_event": ("start_time_str", "start_time_expression"),
    "modify_event": ("start_time_str", "start_time_expression"),
    "add_task_with_due": ("due_time_str", "task_due_time_expression"),
    "modify_task": ("due_time_str", "task_due_time_expression"),
    "add_reminder": ("remind_time_str", "time_expression"),
}
_TIME_TOOL_LOCAL_KEYS: Dict[str, str] = {
    "add_event": "start_time_local",
    "modify_event": "start_time_local",
    "add_task_with_due": "due_time_local",
    "modify_task": "due_time_local",
    "add_reminder": "remind_time_local",
}


def filter_tool_call_kwargs(tool_name: str, tool_args: dict | None) -> dict:
    """只保留工具函数签名允许的参数；剥离 __time_display__ 等内部字段。"""
    from app.tools.registry import AVAILABLE_TOOLS

    raw = dict(tool_args or {})
    fn = AVAILABLE_TOOLS.get(tool_name)
    if fn is None:
        return {k: v for k, v in raw.items() if not str(k).startswith("__")}
    allowed = set(inspect.signature(fn).parameters.keys())
    return {k: v for k, v in raw.items() if k in allowed}


def _strip_parenthetical_notes(expr: str) -> str:
    """去掉括号备注，保留用户时间原话；不做正则抽取时间点。"""
    s = (expr or "").strip()
    if not s:
        return ""
    out = []
    depth = 0
    for ch in s:
        if ch in "(（":
            depth += 1
            continue
        if ch in ")）":
            depth = max(0, depth - 1)
            continue
        if depth == 0:
            out.append(ch)
    return "".join(out).strip()


def prepare_time_sensitive_tool_args(
    tool_name: str,
    tool_args: dict,
    user_message: str = "",
    understanding: dict | None = None,
) -> dict:
    """
    在创建待确认 / 执行前，由大模型拆解时间并锁定为 *_time_local。
    确认执行时只读锁定值，不再用正则重新猜时间。
    """
    if tool_name not in _TIME_TOOL_EXPR_KEYS:
        return dict(tool_args or {})

    args = dict(tool_args or {})
    expr_key, slot_key = _TIME_TOOL_EXPR_KEYS[tool_name]
    local_key = _TIME_TOOL_LOCAL_KEYS[tool_name]

    if args.get(local_key):
        return args

    hint = _strip_parenthetical_notes(str(args.get(expr_key, "") or "").strip())
    slots = {}
    if isinstance(understanding, dict):
        slots = understanding.get("slots") or {}
    if isinstance(slots, dict):
        slot_expr = _strip_parenthetical_notes(str(slots.get(slot_key, "") or "").strip())
        if slot_expr:
            hint = slot_expr if not hint else hint

    resolved = understanding.get("resolved_time") if isinstance(understanding, dict) else None
    if isinstance(resolved, dict) and resolved.get("start_time_local"):
        local = str(resolved["start_time_local"]).strip()
        args[local_key] = local
        if resolved.get("time_expression"):
            args[expr_key] = str(resolved["time_expression"]).strip()
        elif hint:
            args[expr_key] = hint
        args["__time_display__"] = str(resolved.get("display_text") or local).strip()
        return args

    anchor = (user_message or "").strip()
    if anchor or hint:
        llm_res = resolve_datetime_with_llm(anchor, hint)
        if llm_res.get("ok"):
            args[local_key] = llm_res["start_time_local"]
            args[expr_key] = llm_res.get("time_expression") or hint or anchor
            args["__time_display__"] = llm_res.get("display_text") or llm_res["start_time_local"]
            return args

    if hint:
        args[expr_key] = hint
    return args


def _resolve_stored_event_time(
    start_time_str: str,
    start_time_local: str | None = None,
    user_message: str = "",
) -> datetime.datetime:
    """优先读已锁定的本地 ISO；否则调用时间模型，不用正则规则表。"""
    if start_time_local and str(start_time_local).strip():
        local = str(start_time_local).strip()
        try:
            return datetime.datetime.strptime(local[:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return datetime.datetime.strptime(local[:16], "%Y-%m-%d %H:%M")

    expr = _strip_parenthetical_notes(str(start_time_str or "").strip())
    return resolve_datetime_to_local_dt(expr, user_message=user_message, hint_expression=expr)


def _naive_local(dt: datetime.datetime) -> datetime.datetime:
    """Convert any datetime into naive user-local wall clock."""
    if dt.tzinfo is not None:
        return dt.astimezone(user_tz()).replace(tzinfo=None)
    return dt


# 兼容旧引用：自然语言不再走规则解析，仅保留别名避免 import 断裂
def _parse_event_datetime(start_time_str: str, user_message: str = "") -> datetime.datetime:
    return _resolve_stored_event_time(start_time_str, None, user_message)


def _normalize_time_expression(expr: str) -> str:
    return _strip_parenthetical_notes(expr)
