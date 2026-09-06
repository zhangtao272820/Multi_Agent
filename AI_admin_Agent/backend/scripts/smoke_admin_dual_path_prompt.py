"""P7 smoke：Admin playbook 主路径 vs 总管旁路写闸对齐（无 LLM）。"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND.parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("ADMIN_LOAD_PLAYBOOK", "1")

# 与 shared/adminCapabilities.ts MANAGER_ADMIN_ROUTE_GROUPS 邮件组对齐（防 Python 白名单再漏）
SHARED_MANAGER_MAIL_TOOLS = frozenset(
    {
        "send_email",
        "list_emails",
        "search_emails",
        "mark_email_read",
        "reply_email",
        "forward_email",
        "delete_email",
        "draft_email_reply",
        "classify_emails",
        "triage_emails",
        "list_email_attachments",
        "save_email_attachment",
    }
)


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def _shared_manager_tool_names() -> set[str]:
    """从 shared/adminCapabilities.ts 抽取 MANAGER_ADMIN_ROUTE_GROUPS 工具名（契约防漂移）。"""
    ts_path = REPO_ROOT / "shared" / "adminCapabilities.ts"
    text = ts_path.read_text(encoding="utf-8")
    # 截取 MANAGER_ADMIN_ROUTE_GROUPS 块到 MANAGER_ADMIN_TOOL_NAMES
    start = text.find("export const MANAGER_ADMIN_ROUTE_GROUPS")
    end = text.find("export const MANAGER_ADMIN_TOOL_NAMES")
    assert_true(start >= 0 and end > start, "shared MANAGER_ADMIN_ROUTE_GROUPS block found")
    block = text[start:end]
    return set(re.findall(r"'([a-z][a-z0-9_]{2,})'", block))


def main() -> None:
    from app.core.admin_manager_plan_llm import (
        MANAGER_ADMIN_TOOLS,
        build_manager_plan_tools_prompt,
        sanitize_manager_admin_plan,
    )
    from app.core.admin_playbook_prompts import get_planning_rules, get_write_gate_rules
    from app.core.admin_write_gate_contract import (
        WRITE_GATE_CONFIRM_TOOLS,
        WRITE_GATE_MANAGER_SUMMARY,
        assert_write_gate_contract_aligned,
    )
    from app.tools.registry import AVAILABLE_TOOLS

    errs = assert_write_gate_contract_aligned(MANAGER_ADMIN_TOOLS)
    assert_true(not errs, "write_gate contract: " + "; ".join(errs))

    overlap = MANAGER_ADMIN_TOOLS & WRITE_GATE_CONFIRM_TOOLS
    assert_true("send_email" in overlap, "send_email must be manager+gated")
    assert_true("forward_email" in overlap, "forward_email must be manager+gated")
    assert_true("delete_email" in overlap, "delete_email must be manager+gated")
    assert_true("add_event" in overlap, "add_event must be manager+gated")
    assert_true("write_file" in overlap, "write_file must be manager+gated")
    assert_true("add_tasks_from_minutes" in overlap, "add_tasks_from_minutes must be manager+gated")
    assert_true("get_weather" not in WRITE_GATE_CONFIRM_TOOLS, "get_weather is not gated write")
    assert_true("daily_briefing" in MANAGER_ADMIN_TOOLS, "daily_briefing in manager whitelist")
    assert_true("prepare_meeting" in MANAGER_ADMIN_TOOLS, "prepare_meeting in manager whitelist")
    assert_true("list_files" in MANAGER_ADMIN_TOOLS, "list_files in manager whitelist")
    assert_true("web_search" not in MANAGER_ADMIN_TOOLS, "web_search still out of manager whitelist")

    missing_mail = SHARED_MANAGER_MAIL_TOOLS - MANAGER_ADMIN_TOOLS
    assert_true(not missing_mail, f"manager mail tools missing from Python whitelist: {sorted(missing_mail)}")

    shared_names = _shared_manager_tool_names()
    missing_shared = shared_names - set(MANAGER_ADMIN_TOOLS)
    assert_true(
        not missing_shared,
        f"MANAGER_ADMIN_TOOLS missing shared tools: {sorted(missing_shared)}",
    )

    for t in ("search_emails", "mark_email_read", "forward_email", "delete_email"):
        assert_true(t in MANAGER_ADMIN_TOOLS, f"{t} in MANAGER_ADMIN_TOOLS")
        assert_true(t in AVAILABLE_TOOLS, f"{t} registered in AVAILABLE_TOOLS")

    assert_true("get_email_detail" in AVAILABLE_TOOLS, "get_email_detail registered for Admin path")
    assert_true(
        "get_email_detail" not in MANAGER_ADMIN_TOOLS,
        "get_email_detail stays out of manager whitelist (shared SSOT)",
    )

    kept = sanitize_manager_admin_plan(
        [
            {"name": "search_emails", "args": {"subject": "报销"}},
            {"name": "mark_email_read", "args": {"email_id": 1}},
            {"name": "forward_email", "args": {"email_id": 1, "to": "a@qq.com"}},
            {"name": "delete_email", "args": {"email_id": 1}},
            {"name": "web_search", "args": {"query": "x"}},
        ],
        action_text="搜邮件并标已读",
    ) or []
    kept_names = [p["name"] for p in kept]
    for t in ("search_emails", "mark_email_read", "forward_email", "delete_email"):
        assert_true(t in kept_names, f"sanitize keeps {t} on manager_route")
    assert_true("web_search" not in kept_names, "sanitize still drops web_search")

    planning = get_planning_rules()
    assert_true(
        "HITL" in planning or "待确认" in planning or "write_gate" in planning,
        "planning rules must mention HITL/write_gate",
    )

    gate = get_write_gate_rules()
    assert_true("send_email" in gate or "待确认" in gate, "write_gate Planning loaded")
    assert_true("forward_email" in gate, "write_gate skill lists forward_email")
    assert_true("delete_email" in gate, "write_gate skill lists delete_email")

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
    assert_true("search_emails" in bypass, "bypass catalog mentions search_emails")
    assert_true("write_gate" in bypass or "HITL" in bypass, "bypass has HITL")
    assert_true("auto_confirm" in bypass.lower() or "不得因" in bypass, "bypass forbids skip confirm")
    assert_true("send_email" in WRITE_GATE_MANAGER_SUMMARY, "summary lists send_email")
    assert_true("forward_email" in WRITE_GATE_MANAGER_SUMMARY, "summary lists forward_email")
    assert_true(WRITE_GATE_MANAGER_SUMMARY.split("\n")[0] in bypass or "【写闸" in bypass, "summary injected")

    # P1 Compose：intent_routing 与 email_hands 对齐（无 body 不澄清）
    from app.core.admin_playbook_prompts import get_slot_fill_rules, get_semantic_understanding_rules

    slot_rules = get_slot_fill_rules("邮件")
    semantic = get_semantic_understanding_rules()
    assert_true("禁止" in slot_rules and ("正文" in slot_rules or "主题" in slot_rules), "dual-path: no body clarify")
    assert_true("Compose" in semantic or "主题/正文可空" in semantic or "正文可空" in semantic, "semantic Compose-minimal")

    # 旁路目录工具必须 ⊆ MANAGER_ADMIN_TOOLS（抽 catalog 中的 snake_case）
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
        "search_emails",
        "mark_email_read",
        "forward_email",
        "delete_email",
    ):
        assert_true(t in MANAGER_ADMIN_TOOLS, f"{t} in MANAGER_ADMIN_TOOLS")
        assert_true(t in bypass, f"bypass mentions {t}")

    print("smoke_admin_dual_path_prompt OK")


if __name__ == "__main__":
    main()
