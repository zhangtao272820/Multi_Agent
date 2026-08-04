"""J2：RISKY 写闸 — 缺 auto_confirm 时不可静默写；auto_confirm 不跳过缺槽（与 write_clarify 分工）。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("ADMIN_PROMPT_EVOLUTION", "0")


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    from app.core.risky_hitl import requires_risky_hitl
    from app.core.admin_write_clarify import manager_write_plan_missing_slots
    from app.tools.registry import RISKY_TOOLS

    assert_true("add_event" in RISKY_TOOLS, "add_event must be RISKY")
    assert_true("send_email" in RISKY_TOOLS, "send_email must be RISKY")
    assert_true("get_weather" not in RISKY_TOOLS, "get_weather must not be RISKY")

    assert_true(
        requires_risky_hitl("add_event", auto_confirm_risky=False),
        "add_event without auto_confirm must HITL",
    )
    assert_true(
        requires_risky_hitl("send_email", auto_confirm_risky=False),
        "send_email without auto_confirm must HITL",
    )
    assert_true(
        not requires_risky_hitl("add_event", auto_confirm_risky=True),
        "auto_confirm may skip write HITL for RISKY",
    )
    assert_true(
        not requires_risky_hitl("get_weather", auto_confirm_risky=False),
        "non-RISKY never forced HITL by this gate",
    )
    assert_true(
        not requires_risky_hitl("", auto_confirm_risky=False),
        "empty tool name is not HITL",
    )

    # 缺槽与写闸正交：即使将来 auto_confirm=True，缺槽仍须澄清（不静默写）
    missing = manager_write_plan_missing_slots(
        [{"name": "add_event", "args": {"title": "", "start_time_str": ""}}],
        {"slots": {}, "resolved_time": None},
    )
    assert_true(len(missing) > 0, "empty slots must still be missing under auto_confirm world")
    assert_true(
        requires_risky_hitl("add_event", auto_confirm_risky=True) is False
        and len(missing) > 0,
        "auto_confirm skips HITL but cannot invent slots — caller must clarify first",
    )

    print("smoke_admin_risky_hitl: ok")


if __name__ == "__main__":
    main()
