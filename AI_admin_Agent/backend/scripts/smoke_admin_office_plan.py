"""全办公场景兜底规划：动作槽 → 工具链；多 paraphrase 同契约。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("ADMIN_LOAD_PLAYBOOK", "0")


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def _names(plan: list) -> list[str]:
    return [p["name"] for p in plan]


def main() -> None:
    from app.core.admin_office_plan import (
        build_office_fallback_plan,
        resolve_calendar_action,
        resolve_contact_action,
        resolve_file_action,
        resolve_search_action,
        resolve_task_action,
    )
    from app.core.admin_plan_fastpath import build_deterministic_plan_from_understanding
    from app.core.admin_slot_inject import inject_slots_into_plan
    from app.core.amap_nlu import scenario_id_for_query_type

    for msg in ("看看明天有什么会", "列出我的日程", "show my calendar events"):
        u = {"intent": "日程", "slots": {"calendar_action": "list"}}
        plan = build_office_fallback_plan("日程", msg, u)
        assert_true(_names(plan) == ["list_events"], f"calendar list {msg!r} → {_names(plan)}")
        assert_true(resolve_calendar_action(u) == "list", "resolve calendar list")

    u_sc = {"intent": "日程", "admin_scenario": "calendar_list", "slots": {}}
    assert_true(
        _names(build_office_fallback_plan("日程", "日程", u_sc)) == ["list_events"],
        "scenario calendar_list",
    )

    bulk = {"intent": "日程", "slots": {"calendar_action": "bulk_delete"}}
    assert_true(
        _names(build_office_fallback_plan("日程", "删除全部会议提醒", bulk))
        == ["delete_all_meeting_reminders"],
        "bulk_delete plan",
    )

    create = {
        "intent": "日程",
        "slots": {
            "calendar_action": "create",
            "event_title": "周会",
            "start_time_expression": "明天下午3点",
        },
    }
    assert_true(
        _names(build_office_fallback_plan("日程", "建周会", create)) == ["add_event"],
        "create event plan",
    )

    for msg in ("列出待办", "我有哪些任务", "list my todos"):
        u = {"intent": "待办", "slots": {"task_action": "list"}}
        assert_true(
            _names(build_office_fallback_plan("待办", msg, u)) == ["list_tasks"],
            f"task list {msg!r}",
        )
    done = {"intent": "待办", "slots": {"task_action": "complete", "task_title": "写周报"}}
    assert_true(
        _names(build_office_fallback_plan("待办", "完成写周报", done)) == ["complete_task"],
        "complete task",
    )

    clist = {"intent": "联系人", "slots": {"contact_action": "list"}}
    assert_true(
        _names(build_office_fallback_plan("联系人", "xxx", clist)) == ["list_contacts"],
        "contact list",
    )
    cadd = {
        "intent": "联系人",
        "slots": {"contact_action": "add", "contact_name": "张三", "contact_email": "a@b.com"},
    }
    assert_true(
        _names(build_office_fallback_plan("联系人", "添加", cadd)) == ["add_contact"],
        "contact add",
    )
    csearch = {"intent": "联系人", "slots": {"contact_name": "李四"}}
    assert_true(resolve_contact_action(csearch) == "search", "resolve contact search")
    assert_true(
        _names(build_office_fallback_plan("联系人", "查邮箱", csearch)) == ["search_contact"],
        "contact search plan",
    )

    for msg in ("网上搜一下这个新闻", "帮我查一下网上资料"):
        u = {
            "intent": "搜索",
            "slots": {"search_action": "web", "search_query": "最新政策"},
        }
        plan = build_office_fallback_plan("搜索", msg, u)
        assert_true(_names(plan) == ["web_search"], f"web search {msg!r}")
        assert_true(plan[0]["args"].get("query") == "最新政策", "search query arg")
    know = {
        "intent": "搜索",
        "slots": {"search_action": "knowledge", "search_query": "报销制度"},
    }
    assert_true(
        _names(build_office_fallback_plan("搜索", "知识库", know)) == ["knowledge_retrieval"],
        "knowledge search",
    )
    assert_true(resolve_search_action(know) == "knowledge", "resolve knowledge")

    flist = {"intent": "文件", "slots": {"file_action": "list"}}
    assert_true(
        _names(build_office_fallback_plan("文件", "列工作区", flist)) == ["list_files"],
        "file list",
    )
    fread = {"intent": "文件", "slots": {"file_action": "read", "file_path": "notes.md"}}
    assert_true(resolve_file_action(fread) == "read", "resolve file read")
    plan_f = build_office_fallback_plan("文件", "打开 notes", fread)
    assert_true(_names(plan_f) == ["read_file_content"], "file read plan")
    assert_true(plan_f[0]["args"].get("path") == "notes.md", "file path arg")

    assert_true(
        _names(build_office_fallback_plan("简报", "早报", {"slots": {}})) == ["daily_briefing"],
        "daily briefing",
    )
    assert_true(
        _names(
            build_office_fallback_plan(
                "简报", "周报", {"admin_scenario": "weekly_report", "slots": {}}
            )
        )
        == ["weekly_report"],
        "weekly report",
    )
    q = build_office_fallback_plan("问数", "本周销量多少", {"slots": {}})
    assert_true(
        _names(q) == ["ask_database"] and "销量" in q[0]["args"]["question"],
        "ask_database",
    )
    assert_true(
        _names(build_office_fallback_plan("会前准备", "准备明天的会", {"slots": {}}))
        == ["prepare_meeting"],
        "meeting prep",
    )

    det = build_deterministic_plan_from_understanding(
        {"intent": "日程", "slots": {"calendar_action": "list"}, "needs_clarification": False},
        "看看明天有什么会",
    )
    assert_true(det is not None and _names(det) == ["list_events"], f"fastpath list got {det}")

    det_c = build_deterministic_plan_from_understanding(
        {"intent": "联系人", "slots": {"contact_action": "list"}, "needs_clarification": False},
        "随便说点什么",
    )
    assert_true(
        det_c is not None and _names(det_c) == ["list_contacts"],
        "fastpath contact list",
    )

    inj = inject_slots_into_plan(
        [{"name": "web_search", "args": {}}, {"name": "read_file_content", "args": {}}],
        {"slots": {"search_query": "AI", "file_path": "a.txt"}},
    )
    assert_true(inj[0]["args"].get("query") == "AI", "inject search_query")
    assert_true(inj[1]["args"].get("path") == "a.txt", "inject file_path")

    assert_true(scenario_id_for_query_type("route") == "travel_route", "map route scenario")
    assert_true(scenario_id_for_query_type("nearby") == "amap_poi", "map nearby scenario")
    assert_true(scenario_id_for_query_type("geocode") == "amap_geocode", "map geocode scenario")
    assert_true(scenario_id_for_query_type("route") != "route", "no raw route id")

    lm = {"intent": "待办", "slots": {"list_mode": "true"}}
    assert_true(resolve_task_action(lm) == "list", "list_mode alias")
    assert_true(
        _names(build_office_fallback_plan("待办", "list", lm)) == ["list_tasks"],
        "list_mode plan",
    )

    print("smoke_admin_office_plan OK")


if __name__ == "__main__":
    main()
