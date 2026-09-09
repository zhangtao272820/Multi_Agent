"""Admin 有界 replan 契约 smoke（不调 LLM / 无副作用）。"""
from __future__ import annotations

import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app.core.admin_bounded_replan import admin_max_replan, should_replan_after_verify


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise SystemExit(f"[smoke_admin_bounded_replan] {msg}")


print("smoke_admin_bounded_replan: start")

assert_true(admin_max_replan({"ADMIN_MAX_REPLAN": "9"}) == 2, "hard cap 2")
assert_true(admin_max_replan({"ADMIN_MAX_REPLAN": "0"}) == 0, "zero allowed")

ok, reason = should_replan_after_verify(
    verification_result="工具执行成功：已列出待办",
    pending_actions=None,
    pending_decide_mode=False,
    replan_count=0,
    max_replan=1,
)
assert_true(ok is False and reason == "ok", "success no replan")

fail, r2 = should_replan_after_verify(
    verification_result="execute_failed: inbox timeout",
    pending_actions=None,
    pending_decide_mode=False,
    replan_count=0,
    max_replan=1,
)
assert_true(fail is True and r2 == "exec_failure", "exec failure replan")

blocked, r3 = should_replan_after_verify(
    verification_result="execute_failed",
    pending_actions=[{"id": "p1"}],
    pending_decide_mode=False,
    replan_count=0,
    max_replan=1,
)
assert_true(blocked is False and r3 == "pending_hitl", "HITL no replan")

exhausted, r4 = should_replan_after_verify(
    verification_result="失败：工具未成功",
    pending_actions=None,
    pending_decide_mode=False,
    replan_count=1,
    max_replan=1,
)
assert_true(exhausted is False and r4 == "replan_budget_exhausted", "budget")

print("smoke_admin_bounded_replan: ok")
