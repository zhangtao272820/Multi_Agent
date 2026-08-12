"""批量删除会议提醒：NLU 填 calendar_action=bulk_delete → 规划 delete_all；主路径不扫原话关键词。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 主路径：full（禁止关键词路由）
os.environ["ADMIN_NLU_MODE"] = "full"
os.environ.setdefault("ADMIN_PLAN_FASTPATH", "on")


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    from app.core.admin_plan_fastpath import (
        build_deterministic_plan_from_action_text,
        build_deterministic_plan_from_understanding,
        suppress_clarify_for_bulk_delete,
        _looks_like_bulk_delete_meeting_reminders,
        is_admin_legacy_infer_enabled,
    )
    from app.tools.calendar import preview_meeting_reminders_purge, delete_all_meeting_reminders
    from app.tools.registry import AVAILABLE_TOOLS, RISKY_TOOLS

    assert_true(not is_admin_legacy_infer_enabled(), "full mode: legacy infer off")

    # legacy 辅助函数仍可检测（仅供 legacy 模式用）
    utter = "帮我删除所有会议提醒"
    assert_true(_looks_like_bulk_delete_meeting_reminders(utter), "helper detect A")
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

    # 主路径：只信 slots.calendar_action=bulk_delete（模型填槽）
    bad_und = {
        "intent": "日程",
        "needs_clarification": True,
        "clarification_questions": ["请问要删除哪个会议？"],
        "slots": {"calendar_action": "bulk_delete"},
    }
    fixed = suppress_clarify_for_bulk_delete(bad_und, utter)
    assert_true(fixed.get("needs_clarification") is False, "suppress clarify from slots")
    assert_true(not fixed.get("clarification_questions"), "clear questions")

    # 无 slots 时 full 模式不得靠原话关键词清澄清
    no_slot = {
        "intent": "日程",
        "needs_clarification": True,
        "clarification_questions": ["请问要删除哪个会议？"],
        "slots": {},
    }
    still = suppress_clarify_for_bulk_delete(no_slot, utter)
    assert_true(still.get("needs_clarification") is True, "full mode: no keyword suppress")

    # 无 understanding 时 action_text 关键词不得出 plan（full）
    plan_kw = build_deterministic_plan_from_action_text(utter, intent_hint="日程")
    assert_true(plan_kw is None, f"full mode: no keyword plan from action alone: {plan_kw}")

    # 有 slots → 正确工具
    und = {
        "intent": "日程",
        "needs_clarification": False,
        "slots": {"calendar_action": "bulk_delete"},
    }
    plan = build_deterministic_plan_from_understanding(und, utter)
    assert_true(
        plan and plan[0].get("name") == "delete_all_meeting_reminders",
        f"plan from slots: {plan}",
    )
    plan2 = build_deterministic_plan_from_action_text(utter, intent_hint="日程", understanding=und)
    assert_true(
        plan2 and plan2[0].get("name") == "delete_all_meeting_reminders",
        f"plan via action+understanding: {plan2}",
    )

    preview = preview_meeting_reminders_purge()
    assert_true(isinstance(preview, dict) and "total_count" in preview, "preview shape")
    total = int(preview.get("total_count") or 0)
    if total > 0:
        msg = f"【待确认】将删除会议提醒共 {total} 项"
        assert_true("将删除" in msg and "将添加" not in msg, "pending delete copy")
    else:
        res = delete_all_meeting_reminders()
        assert_true("没有可删除" in str(res) or "empty" in str(res), f"empty ok: {res}")

    print("smoke_admin_bulk_delete: ok")


if __name__ == "__main__":
    main()
