"""P7 smoke：Admin playbook 主路径 vs 总管旁路写闸对齐（无 LLM）。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("ADMIN_LOAD_PLAYBOOK", "1")


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    from app.core.admin_manager_plan_llm import MANAGER_ADMIN_TOOLS, build_manager_plan_tools_prompt
    from app.core.admin_playbook_prompts import get_planning_rules, get_write_gate_rules
    from app.core.admin_write_gate_contract import (
        WRITE_GATE_CONFIRM_TOOLS,
        WRITE_GATE_MANAGER_SUMMARY,
        assert_write_gate_contract_aligned,
    )

    errs = assert_write_gate_contract_aligned(MANAGER_ADMIN_TOOLS)
    assert_true(not errs, "write_gate contract: " + "; ".join(errs))

    overlap = MANAGER_ADMIN_TOOLS & WRITE_GATE_CONFIRM_TOOLS
    assert_true("send_email" in overlap, "send_email must be manager+gated")
    assert_true("add_event" in overlap, "add_event must be manager+gated")
    assert_true("write_file" in overlap, "write_file must be manager+gated")
    assert_true("add_tasks_from_minutes" in overlap, "add_tasks_from_minutes must be manager+gated")
    assert_true("get_weather" not in WRITE_GATE_CONFIRM_TOOLS, "get_weather is not gated write")
    assert_true("daily_briefing" in MANAGER_ADMIN_TOOLS, "daily_briefing in manager whitelist")
    assert_true("prepare_meeting" in MANAGER_ADMIN_TOOLS, "prepare_meeting in manager whitelist")
    assert_true("list_files" in MANAGER_ADMIN_TOOLS, "list_files in manager whitelist")
    assert_true("web_search" not in MANAGER_ADMIN_TOOLS, "web_search still out of manager whitelist")

    planning = get_planning_rules()
    assert_true(
        "HITL" in planning or "待确认" in planning or "write_gate" in planning,
        "planning rules must mention HITL/write_gate",
    )

    gate = get_write_gate_rules()
    assert_true("send_email" in gate or "待确认" in gate, "write_gate Planning loaded")

    assert_true("draft_email_reply" not in WRITE_GATE_CONFIRM_TOOLS, "draft_email_reply is not send-gated")
    assert_true("draft_email_reply" in MANAGER_ADMIN_TOOLS, "draft_email_reply in manager whitelist")
    assert_true("modify_task" in MANAGER_ADMIN_TOOLS, "modify_task in manager whitelist")

    bypass = build_manager_plan_tools_prompt(
        action="明天开会并发邮件",
        intent_hint="混合任务",
        intent="混合任务",
        u_summary={"intent": "混合任务"},
        hint_plan=None,
        source_user_task="创建明天会议，详细内容是项目复盘，并给张三发邮件说明",
    )
    assert_true("source_user_task" in bypass, "bypass injects source_user_task")
    assert_true("可写字段" in bypass or "description" in bypass, "bypass writable-field rules")
    assert_true("draft_email_reply" in bypass, "bypass mentions draft_email_reply")
    assert_true("write_gate" in bypass or "HITL" in bypass, "bypass has HITL")
    assert_true("auto_confirm" in bypass.lower() or "不得因" in bypass, "bypass forbids skip confirm")
    assert_true("send_email" in WRITE_GATE_MANAGER_SUMMARY, "summary lists send_email")
    assert_true(WRITE_GATE_MANAGER_SUMMARY.split("\n")[0] in bypass or "【写闸" in bypass, "summary injected")

    # 旁路目录工具必须 ⊆ MANAGER_ADMIN_TOOLS（抽 catalog 中的 snake_case）
    import re

    catalog_tools = set(re.findall(r"\b([a-z][a-z0-9_]{3,})\b", bypass))
    # 只检查明显工具名：与白名单交集应覆盖常见写工具
    for t in (
        "send_email",
        "add_event",
        "get_weather",
        "send_feishu_message",
        "daily_briefing",
        "prepare_meeting",
        "write_file",
        "draft_email_reply",
        "modify_task",
    ):
        assert_true(t in MANAGER_ADMIN_TOOLS, f"{t} in MANAGER_ADMIN_TOOLS")
        assert_true(t in bypass, f"bypass mentions {t}")

    print("smoke_admin_dual_path_prompt OK")


if __name__ == "__main__":
    main()
