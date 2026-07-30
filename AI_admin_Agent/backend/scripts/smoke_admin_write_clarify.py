"""Admin 写缺槽澄清 / 写失败文案：auto_confirm 不得跳过缺槽。"""
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
    from app.core.admin_write_clarify import (
        backfill_manager_write_plan_from_action,
        compose_write_fail_reply,
        manager_write_plan_missing_slots,
        strip_admin_manager_guards,
    )
    from app.core.admin_manager_plan_llm import normalize_manager_task

    missing = manager_write_plan_missing_slots(
        [{"name": "add_event", "args": {"title": "", "start_time_str": ""}}],
        {"slots": {}, "resolved_time": None},
    )
    assert_true("event_title" in missing, "missing title")
    assert_true("start_time_expression" in missing, "missing time")

    ok_slots = manager_write_plan_missing_slots(
        [
            {
                "name": "add_event",
                "args": {"title": "项目周会", "start_time_str": "明天上午10点"},
            }
        ],
        {"slots": {"event_title": "项目周会", "start_time_expression": "明天上午10点"}},
    )
    assert_true(ok_slots == [], f"complete slots should be empty, got {ok_slots}")

    # action_text 含明天上午10点+项目周会：回填后不应再缺槽
    action = "帮我创建明天上午10点的会议日程，标题为「项目周会」，并设置会议提醒。"
    filled_plan, filled_und = backfill_manager_write_plan_from_action(
        [{"name": "add_event", "args": {"title": "项目周会", "start_time_str": ""}}],
        {"slots": {"event_title": "项目周会"}, "resolved_time": None},
        action,
    )
    assert_true(len(filled_plan) == 1, "backfill keeps one tool")
    assert_true(
        str(filled_plan[0]["args"].get("start_time_str") or "").strip() == action,
        f"backfill time from action: {filled_plan[0]['args']}",
    )
    after = manager_write_plan_missing_slots(filled_plan, filled_und)
    assert_true(after == [], f"after backfill should not miss slots, got {after}")

    # 复合总管原话误入 title：回填应抽成「项目周会」
    composite = (
        "在知识库中检索个人月度财务情况，提炼要点并生成对比图表，"
        "并帮我创建明天上午10点的会议日程，标题为「项目周会」，并设置会议提醒。"
    )
    fixed_plan, fixed_und = backfill_manager_write_plan_from_action(
        [{"name": "add_event", "args": {"title": composite, "description": composite, "start_time_str": composite}}],
        {"slots": {"event_title": composite}, "resolved_time": None},
        composite,
    )
    assert_true(
        str(fixed_plan[0]["args"].get("title") or "") == "项目周会",
        f"composite title must become 项目周会, got {fixed_plan[0]['args']}",
    )
    assert_true(
        not str(fixed_plan[0]["args"].get("description") or "").strip(),
        f"composite description must clear (no title substitute), got {fixed_plan[0]['args']}",
    )

    # preamble 包裹的 action：剥净后回填不得再缺槽
    preamble_wrapped = "\n".join(
        [
            "仅处理下列个人助理能力：邮件/联系人/待办/日程/提醒；天气预报（get_weather）；高德路线与耗时。",
            "勿混入搜索/问数/玩法/简报/文件。会议与日程须 add_event 落库，禁止仅用 add_reminder。",
            "若已给出会议标题与时间，直接创建，勿追问知识库或图表相关缺失项。",
            action,
            "【总管约束】只执行本条中的日程/提醒/邮件/待办",
        ]
    )
    peeled = strip_admin_manager_guards(preamble_wrapped)
    assert_true("项目周会" in peeled and "明天上午10点" in peeled, f"strip preamble: {peeled}")
    assert_true("仅处理下列" not in peeled, f"strip must drop preamble: {peeled}")

    pre_plan, pre_und = backfill_manager_write_plan_from_action(
        [{"name": "add_event", "args": {"title": "", "start_time_str": ""}}],
        {"slots": {}, "resolved_time": None},
        preamble_wrapped,
    )
    pre_missing = manager_write_plan_missing_slots(pre_plan, pre_und)
    assert_true(pre_missing == [], f"preamble-wrapped backfill must fill slots, got {pre_missing}")
    assert_true(
        str(pre_plan[0]["args"].get("title") or "") == "项目周会",
        f"preamble backfill title: {pre_plan[0]['args']}",
    )

    mt = normalize_manager_task(
        {"source": "manager", "action_text": preamble_wrapped},
        preamble_wrapped,
    )
    assert_true(
        "项目周会" in str(mt.get("action_text") or "") and "仅处理下列" not in str(mt.get("action_text") or ""),
        f"normalize_manager_task peel: {mt.get('action_text')}",
    )

    msg, clarify = compose_write_fail_reply(
        "失败：time_parse_failed\n[1] add_event 结果: 失败：无法解析时间",
        ["[1] add_event 结果: 失败：无法解析时间"],
    )
    assert_true(clarify is True, "time_parse → clarify")
    assert_true("时间" in msg, "time_parse message mentions time")

    msg2, clarify2 = compose_write_fail_reply(
        "失败：未生成可执行工具计划（plan_empty）",
        [],
    )
    assert_true(clarify2 is True and "计划" in msg2, "plan_empty clarify")

    print("smoke_admin_write_clarify: ok")


if __name__ == "__main__":
    main()
