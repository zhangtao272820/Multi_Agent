#!/usr/bin/env python3
"""NLU smoke: playbook prompts + structural lock + plan schema (no API key required for structural)."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def test_playbook() -> None:
    from app.nlu.playbook import resolve_playbook_section
    from app.nlu.prompts import build_structured_task_plan_prompt, build_slot_infer_prompt

    parser = resolve_playbook_section("structured_task_plan", "LlmParser", "")
    assert "结构化任务计划" in parser or "网页抓取任务解析器" in parser, parser[:80]
    open_web = resolve_playbook_section("structured_task_plan", "OpenWebSearch", "")
    assert "openWebSearch" in open_web
    sys_p, user_p = build_structured_task_plan_prompt("抓取豆瓣电影 Top10")
    assert "仅输出 JSON" in sys_p or "JSON" in sys_p
    assert "豆瓣" in user_p
    s2, _ = build_slot_infer_prompt("随便看看")
    assert "槽位" in s2
    print("OK playbook sections")


def test_structural() -> None:
    from app.nlu.structural import infer_structural_task

    z = infer_structural_task("抓取知乎热榜前十")
    assert z.target_site == "zhihu", z
    assert z.confidence >= 0.72, z
    assert z.open_web_search is False
    assert z.limit == 10, z
    print("OK structural zhihu lock", z)


async def test_plan_no_key() -> None:
    from app.nlu.task_plan import build_structured_task_plan
    from app.protocol.incoming import ManagerTaskHints

    plan = await build_structured_task_plan(
        "抓取知乎热榜前五",
        hints=ManagerTaskHints(source="ui"),
    )
    assert plan.target_site == "zhihu"
    assert plan.structural_locked
    assert plan.open_web_search is False
    assert plan.limit == 5
    print("OK plan structural-locked", plan.to_meta())

    plan2 = await build_structured_task_plan(
        "帮我找一些公开资料说明大模型 Agent 最近进展",
        hints=ManagerTaskHints(source="ui", open_web_discovery=True),
    )
    # without API key may set open_web via ui heuristic
    print("OK open discovery plan", plan2.to_meta())


def main() -> int:
    test_playbook()
    test_structural()
    asyncio.run(test_plan_no_key())
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
