"""Smoke：可写字段契约（description/content/source_user_task），无 LLM。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("ADMIN_LOAD_PLAYBOOK", "0")
os.environ.setdefault("ADMIN_PLAN_FASTPATH", "1")


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    from app.core.admin_manager_plan_llm import (
        MANAGER_ADMIN_TOOLS,
        _manager_writable_desc_needs_slot_llm,
        _normalize_tool_args,
        build_manager_plan_tools_prompt,
        normalize_manager_task,
        understanding_from_manager_task,
    )
    from app.core.admin_nlu import _EMPTY_SLOTS
    from app.core.admin_plan_fastpath import (
        build_deterministic_plan_from_understanding,
        resolve_event_description,
        resolve_task_description,
    )
    from app.core.admin_write_clarify import backfill_manager_write_plan_from_action
    from app.core.admin_slot_inject import inject_slots_into_plan
    from app.tools.registry import AVAILABLE_TOOLS

    assert_true("event_description" in _EMPTY_SLOTS, "event_description slot")
    assert_true("task_description" in _EMPTY_SLOTS, "task_description slot")

    assert_true("draft_email_reply" in MANAGER_ADMIN_TOOLS, "draft_email_reply in manager whitelist")
    assert_true("modify_task" in MANAGER_ADMIN_TOOLS, "modify_task in manager whitelist")
    assert_true("draft_email_reply" in AVAILABLE_TOOLS, "draft_email_reply registered")
    assert_true("modify_task" in AVAILABLE_TOOLS, "modify_task registered")
    assert_true("draft_email_reply" not in __import__(
        "app.tools.registry", fromlist=["RISKY_TOOLS"]
    ).RISKY_TOOLS, "draft_email_reply is not HITL send gate")

    # description 不得等于 title
    ev = _normalize_tool_args(
        "add_event",
        {"title": "项目周会", "description": "项目周会", "start_time_str": "明天上午10点"},
        "创建明天上午10点的会议日程，标题为「项目周会」，详细内容是：明天项目总结和反思",
    )
    assert_true(ev is not None, "add_event normalize ok")
    assert_true(ev.get("title") == "项目周会", "title kept")
    assert_true(not str(ev.get("description") or "").strip(), "title-as-description cleared")

    ev2 = _normalize_tool_args(
        "add_event",
        {
            "title": "项目周会",
            "description": "明天项目总结和反思",
            "start_time_str": "明天上午10点",
        },
        "scoped only",
    )
    assert_true(ev2.get("description") == "明天项目总结和反思", "real description kept")

    task = _normalize_tool_args(
        "add_task",
        {"title": "周报", "description": "周报"},
        "添加待办周报，详细说明是写本周进度",
    )
    assert_true(task is not None and not str(task.get("description") or "").strip(), "task title!=description")

    task2 = _normalize_tool_args(
        "add_task",
        {"title": "周报", "description": "写本周进度与风险"},
        "",
    )
    assert_true(task2.get("description") == "写本周进度与风险", "task description kept")

    mt = normalize_manager_task(
        {
            "source": "manager",
            "action_text": "创建日程并设置提醒",
            "source_user_task": "创建明天上午10点的会议日程，标题为「项目周会」，详细内容是：明天项目总结和反思，并设置会议提醒",
        },
        "ws fallback",
    )
    assert_true("项目周会" in str(mt.get("source_user_task") or ""), "source_user_task preserved")

    prompt = build_manager_plan_tools_prompt(
        action="创建日程并设置提醒",
        intent_hint="日程",
        intent="日程",
        u_summary={"intent": "日程"},
        hint_plan=[{"name": "add_event", "args": {"title": "项目周会"}}],
        source_user_task="创建明天上午10点的会议日程，标题为「项目周会」，详细内容是：明天项目总结和反思",
    )
    assert_true("source_user_task" in prompt, "prompt has source_user_task")
    assert_true("可写字段" in prompt or "description" in prompt, "prompt mentions writable fields")
    assert_true("draft_email_reply" in prompt, "prompt catalogs draft_email_reply")
    assert_true("禁止用 title 顶替" in prompt or "禁止用标题顶替" in prompt, "forbid title as description")

    # 快路径：禁止 title 顶 description；槽位有详细内容时写入
    assert_true(
        not resolve_event_description("创建会议", "项目周会"),
        "resolve_event_description never returns title",
    )
    assert_true(
        resolve_event_description(
            "scoped",
            "项目周会",
            {"event_description": "明天项目总结和反思"},
        )
        == "明天项目总结和反思",
        "resolve_event_description from slot",
    )
    assert_true(
        resolve_task_description("周报", {"task_description": "写本周进度与风险"})
        == "写本周进度与风险",
        "resolve_task_description from slot",
    )

    # scoped 丢详情：快路径 + slots → description 恢复
    scoped = "创建明天上午10点的会议日程，标题为「项目周会」，并设置会议提醒"
    source = (
        "创建明天上午10点的会议日程，标题为「项目周会」，"
        "详细内容是：明天项目总结和反思，并设置会议提醒"
    )
    und = {
        "intent": "日程",
        "slots": {
            **_EMPTY_SLOTS,
            "event_title": "项目周会",
            "event_description": "明天项目总结和反思",
            "start_time_expression": "明天上午10点",
        },
        "needs_clarification": False,
    }
    plan = build_deterministic_plan_from_understanding(und, scoped)
    assert_true(plan and plan[0]["name"] == "add_event", f"fastpath add_event: {plan}")
    assert_true(
        str(plan[0]["args"].get("description") or "") == "明天项目总结和反思",
        f"fastpath description from slot: {plan[0]['args']}",
    )
    assert_true(
        str(plan[0]["args"].get("description")) != str(plan[0]["args"].get("title")),
        "fastpath description != title",
    )

    # 注入：plan 无 description / 或 description==title 时，用 event_description 覆盖
    empty_desc_plan = [
        {"name": "add_event", "args": {"title": "项目周会", "start_time_str": "明天上午10点"}}
    ]
    injected = inject_slots_into_plan(empty_desc_plan, und)
    assert_true(
        str(injected[0]["args"].get("description") or "") == "明天项目总结和反思",
        f"inject event_description: {injected[0]['args']}",
    )
    title_as_desc_plan = [
        {
            "name": "add_event",
            "args": {
                "title": "项目周会",
                "description": "项目周会",
                "start_time_str": "明天上午10点",
            },
        }
    ]
    injected2 = inject_slots_into_plan(title_as_desc_plan, und)
    assert_true(
        str(injected2[0]["args"].get("description") or "") == "明天项目总结和反思",
        f"inject replaces title-as-description: {injected2[0]['args']}",
    )

    # 待办对称
    task_und = {
        "intent": "待办",
        "slots": {
            **_EMPTY_SLOTS,
            "task_title": "周报",
            "task_description": "写本周进度与风险",
        },
        "needs_clarification": False,
    }
    task_plan = build_deterministic_plan_from_understanding(task_und, "添加待办周报")
    assert_true(task_plan and task_plan[0]["name"] == "add_task", f"task fastpath: {task_plan}")
    assert_true(
        str(task_plan[0]["args"].get("description") or "") == "写本周进度与风险",
        f"task description from slot: {task_plan[0]['args']}",
    )
    task_injected = inject_slots_into_plan(
        [{"name": "add_task", "args": {"title": "周报"}}],
        task_und,
    )
    assert_true(
        str(task_injected[0]["args"].get("description") or "") == "写本周进度与风险",
        f"inject task_description: {task_injected[0]['args']}",
    )

    # 邮件：scoped 丢正文时由 email_content 注入
    mail_und = {
        "intent": "邮件",
        "slots": {
            **_EMPTY_SLOTS,
            "email_to_name_or_email": "a@b.com",
            "email_subject": "周报",
            "email_content": "本周进度与风险如下。",
        },
    }
    mail_injected = inject_slots_into_plan(
        [{"name": "send_email", "args": {"to": "a@b.com", "subject": "周报"}}],
        mail_und,
    )
    assert_true(
        str(mail_injected[0]["args"].get("content") or "") == "本周进度与风险如下。",
        f"inject email_content: {mail_injected[0]['args']}",
    )

    # backfill：有 event_description 时写入，禁止用 title 顶替
    bf_plan, bf_und = backfill_manager_write_plan_from_action(
        [{"name": "add_event", "args": {"title": "项目周会", "start_time_str": ""}}],
        {
            "slots": {
                "event_title": "项目周会",
                "event_description": "明天项目总结和反思",
            },
            "resolved_time": None,
        },
        scoped,
    )
    assert_true(
        str(bf_plan[0]["args"].get("description") or "") == "明天项目总结和反思",
        f"backfill description from slot: {bf_plan[0]['args']}",
    )

    # source_user_task 与 scoped 不同 → 需要 slot LLM 抽可写字段
    needs = _manager_writable_desc_needs_slot_llm(
        {
            "action_text": scoped,
            "source_user_task": source,
        },
        {"slots": {"event_title": "项目周会"}, "intent": "日程"},
        "日程",
        "",
    )
    assert_true(needs is True, "writable desc needs slot llm when source richer")

    # tool_plan 已带真实 description → understanding 对齐槽位
    aligned = understanding_from_manager_task(
        {
            "source": "manager",
            "action_text": scoped,
            "intent_hint": "日程",
            "tool_plan": [
                {
                    "name": "add_event",
                    "args": {
                        "title": "项目周会",
                        "description": "明天项目总结和反思",
                        "start_time_str": "明天上午10点",
                    },
                }
            ],
        }
    )
    assert_true(
        str((aligned.get("slots") or {}).get("event_description") or "") == "明天项目总结和反思",
        f"understanding_from_manager_task copies description: {aligned.get('slots')}",
    )

    print("smoke_admin_writable_fields OK")


if __name__ == "__main__":
    main()
