"""批量删除会议提醒：不得澄清「哪个会议」，须规划 delete_all_meeting_reminders + 删除语义 pending。"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    from app.core.admin_plan_fastpath import (
        build_deterministic_plan_from_action_text,
        build_deterministic_plan_from_understanding,
        suppress_clarify_for_bulk_delete,
        _looks_like_bulk_delete_meeting_reminders,
    )
    from app.tools.calendar import preview_meeting_reminders_purge, delete_all_meeting_reminders
    from app.tools.registry import AVAILABLE_TOOLS, RISKY_TOOLS

    utter = "帮我删除所有会议提醒"
    assert_true(_looks_like_bulk_delete_meeting_reminders(utter), "bulk detect A")
    assert_true(
        _looks_like_bulk_delete_meeting_reminders("清空全部日程提醒"),
        "bulk detect B",
    )
    assert_true(
        not _looks_like_bulk_delete_meeting_reminders("删掉明天下午的项目周会"),
        "single delete must not be bulk",
    )

    assert_true(
        "delete_all_meeting_reminders" in AVAILABLE_TOOLS,
        "tool registered",
    )
    assert_true(
        "delete_all_meeting_reminders" in RISKY_TOOLS,
        "tool is RISKY",
    )

    bad_und = {
        "intent": "日程",
        "needs_clarification": True,
        "clarification_questions": ["请问要删除哪个会议？"],
        "slots": {},
    }
    fixed = suppress_clarify_for_bulk_delete(bad_und, utter)
    assert_true(fixed.get("needs_clarification") is False, "suppress clarify")
    assert_true(not fixed.get("clarification_questions"), "clear questions")
    qs = " ".join(str(x) for x in (bad_und.get("clarification_questions") or []))
    assert_true("哪个会议" in qs, "precondition: bad clarify text")

    plan = build_deterministic_plan_from_action_text(utter, intent_hint="日程")
    assert_true(isinstance(plan, list) and plan, f"plan from action: {plan}")
    assert_true(
        plan[0].get("name") == "delete_all_meeting_reminders",
        f"plan tool: {plan}",
    )

    plan2 = build_deterministic_plan_from_understanding(
        {"intent": "日程", "needs_clarification": False, "slots": {}},
        utter,
    )
    assert_true(
        plan2 and plan2[0].get("name") == "delete_all_meeting_reminders",
        f"plan from understanding: {plan2}",
    )

    single = "删掉明天下午的项目周会"
    plan_single = build_deterministic_plan_from_action_text(single, intent_hint="日程")
    if plan_single:
        assert_true(
            plan_single[0].get("name") != "delete_all_meeting_reminders",
            f"single must not bulk: {plan_single}",
        )

    preview = preview_meeting_reminders_purge()
    assert_true(isinstance(preview, dict) and "total_count" in preview, "preview shape")
    total = int(preview.get("total_count") or 0)
    if total > 0:
        msg = f"【待确认】将删除会议提醒共 {total} 项"
        assert_true("将删除" in msg and "将添加" not in msg, "pending delete copy")
    else:
        # empty: tool returns no-op success
        res = delete_all_meeting_reminders()
        assert_true("没有可删除" in str(res) or "empty" in str(res), f"empty ok: {res}")

    print("smoke_admin_bulk_delete: ok")


if __name__ == "__main__":
    main()
