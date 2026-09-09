"""Admin 有界 replan（Phase E1）：verify→planning 默认最多 1 次，控 token。"""
from __future__ import annotations

import os
from typing import Any


def admin_max_replan(env: dict[str, str] | None = None) -> int:
    e = env if env is not None else os.environ
    raw = str(e.get("ADMIN_MAX_REPLAN") or "1").strip()
    try:
        n = int(raw)
    except ValueError:
        n = 1
    return max(0, min(2, n))


def should_replan_after_verify(
    *,
    verification_result: str,
    pending_actions: list[Any] | None,
    pending_decide_mode: bool,
    replan_count: int,
    max_replan: int | None = None,
) -> tuple[bool, str]:
    """
    结构信号：工具失败 / 空结果可回 planning；HITL pending / clarify / 闲聊不重规划。
    """
    cap = admin_max_replan() if max_replan is None else max(0, min(2, int(max_replan)))
    if pending_decide_mode:
        return False, "pending_decide"
    if pending_actions:
        return False, "pending_hitl"
    if replan_count >= cap:
        return False, "replan_budget_exhausted"

    text = str(verification_result or "")
    if text == "CHITCHAT" or text.startswith("CLARIFY:"):
        return False, "terminal_path"
    if "【待确认】" in text:
        return False, "pending_marker"

    low = text.lower()
    fail_markers = (
        "execute_failed",
        "tool_error",
        "timeout",
        "失败(",
        "失败：",
        "失败:",
        "工具未成功",
        "未能完成",
        "empty_result",
        "no_result",
    )
    if any(m.lower() in low or m in text for m in fail_markers):
        return True, "exec_failure"

    return False, "ok"
