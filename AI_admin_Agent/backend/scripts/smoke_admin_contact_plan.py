"""联系人 intent → add_contact 确定性规划 smoke（无 LLM、无网络）。"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ["ADMIN_NLU_MODE"] = "full"
os.environ["ADMIN_PLAN_FASTPATH"] = "on"
os.environ["ADMIN_MCP_ENABLED"] = "0"

from app.core.admin_manager_plan_llm import intent_from_manager_tool_plan
from app.core.admin_nlu import ADMIN_INTENTS, _EMPTY_SLOTS
from app.core.admin_plan_fastpath import build_deterministic_plan_from_understanding
from app.core.admin_text_sensitivity import enrich_time_and_literal_sensitivity


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    _assert("联系人" in ADMIN_INTENTS, "ADMIN_INTENTS must include 联系人")
    for key in ("contact_name", "contact_email", "contact_description"):
        _assert(key in _EMPTY_SLOTS, f"_EMPTY_SLOTS must include {key}")

    _assert(
        intent_from_manager_tool_plan([{"name": "add_contact", "args": {}}]) == "联系人",
        "add_contact maps to 联系人",
    )
    _assert(
        intent_from_manager_tool_plan([{"name": "list_contacts", "args": {}}]) == "联系人",
        "list_contacts maps to 联系人",
    )
    _assert(
        intent_from_manager_tool_plan([{"name": "add_task", "args": {}}]) == "待办",
        "add_task still maps to 待办",
    )

    contact_u = {
        "intent": "联系人",
        "slots": {
            "contact_name": "张三",
            "contact_email": "2728202806@qq.com",
        },
        "needs_clarification": False,
    }
    plan = build_deterministic_plan_from_understanding(
        contact_u, "添加联系人张三: 2728202806@qq.com"
    )
    _assert(plan is not None and len(plan) == 1, "contact plan has one step")
    _assert(plan[0]["name"] == "add_contact", "contact plan uses add_contact")
    _assert(plan[0]["args"].get("name") == "张三", "contact name from slots")
    _assert(plan[0]["args"].get("email") == "2728202806@qq.com", "contact email from slots")
    _assert(
        all(p["name"] not in ("add_task", "add_task_with_due") for p in plan),
        "contact must not produce add_task*",
    )

    list_u = {
        "intent": "联系人",
        "slots": {},
        "needs_clarification": False,
    }
    list_plan = build_deterministic_plan_from_understanding(list_u, "列出联系人")
    _assert(list_plan and list_plan[0]["name"] == "list_contacts", "list contacts plan")

    todo_u = {
        "intent": "待办",
        "slots": {"task_title": "联系张三"},
        "needs_clarification": False,
    }
    todo_plan = build_deterministic_plan_from_understanding(todo_u, "添加待办：联系张三")
    _assert(todo_plan and todo_plan[0]["name"] == "add_task", "todo still uses add_task")
    _assert(
        all(p["name"] != "add_contact" for p in todo_plan),
        "todo must not produce add_contact",
    )

    enriched = enrich_time_and_literal_sensitivity(
        {
            "intent": "联系人",
            "slots": {"contact_name": "张三", "contact_email": "a@b.com"},
            "has_time_reference": True,
            "time_expression": "明天10点",
        },
        "添加联系人张三 a@b.com",
    )
    _assert(enriched.get("has_time_reference") is False, "contact clears has_time_reference")
    _assert(not str(enriched.get("time_expression") or "").strip(), "contact clears time_expression")

    incomplete = {
        "intent": "联系人",
        "slots": {"contact_name": "张三", "contact_email": ""},
        "needs_clarification": False,
    }
    _assert(
        build_deterministic_plan_from_understanding(incomplete, "添加联系人张三") is None,
        "missing email yields no write plan",
    )

    print("smoke_admin_contact_plan: OK")


if __name__ == "__main__":
    main()
