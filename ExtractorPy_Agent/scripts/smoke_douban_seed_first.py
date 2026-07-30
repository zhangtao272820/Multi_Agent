#!/usr/bin/env python3
"""Smoke: douban structural → top250 seeds; ranking extract; no SERP-only path."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def test_seed_resolve() -> None:
    from app.runtime.seed_resolve import canonicalize_seed_url, is_valid_crawl_seed_url, resolve_crawl_seeds

    assert canonicalize_seed_url("https://movie.douban.com/", target_site="douban") == "https://movie.douban.com/top250"
    assert not is_valid_crawl_seed_url("http://searxng:8080/search?q=x")
    assert not is_valid_crawl_seed_url("https://www.bing.com/search?q=douban")

    seeds = resolve_crawl_seeds(
        manager_seeds=[
            "https://movie.douban.com/",
            "https://www.zhihu.com/search?q=douban",
            "https://www.douban.com/search?q=top250",
        ],
        serp_hits=[
            {"url": "https://movie.douban.com/", "title": "首页"},
            {"url": "https://www.zhihu.com/question/1", "title": "知乎"},
        ],
        target_site="douban",
        content_type="ranking",
        structural_locked=True,
        max_pages=2,
    )
    assert all("top250" in s for s in seeds), seeds
    assert len(seeds) >= 1
    print("OK seed_resolve prefers top250", seeds)


def test_structural_plan() -> None:
    from app.nlu.structural import infer_structural_task
    from app.nlu.task_plan import _merge_manager_hints, _merge_structural, StructuredTaskPlan
    from app.protocol.incoming import ManagerTaskHints

    s = infer_structural_task("帮我爬取豆瓣 top 10 的电影信息")
    assert s.target_site == "douban"
    assert s.limit == 10
    assert s.confidence >= 0.72

    plan = _merge_structural(StructuredTaskPlan(), s)
    assert plan.structural_locked
    assert plan.open_web_search is False
    plan = _merge_manager_hints(
        plan,
        ManagerTaskHints(source="ui", open_web_discovery=True, crawl_strategy="open_discovery"),
    )
    assert plan.open_web_search is False, "UI open_discovery must not override structural lock"
    print("OK structural", plan.to_meta())


def test_douban_extract() -> None:
    from app.llm.extract import _extract_douban_top250

    html = """
    <ol class="grid_view">
      <div class="item"><div class="pic"><em>1</em></div>
        <div class="hd"><a href="https://movie.douban.com/subject/1292052/">
          <span class="title">肖申克的救赎</span></a></div></div>
      <div class="item"><div class="pic"><em>2</em></div>
        <div class="hd"><a href="https://movie.douban.com/subject/1291546/">
          <span class="title">霸王别姬</span></a></div></div>
    </ol>
    """
    items = _extract_douban_top250(html, "", max_items=10)
    assert len(items) == 2
    assert items[0]["title"] == "肖申克的救赎"
    assert items[0]["rank"] == 1
    print("OK douban_extract", [x["title"] for x in items])


async def test_runner_skips_search_for_douban() -> None:
    from app.nlu import build_structured_task_plan
    from app.protocol.incoming import parse_manager_task_json
    from app.runtime.seed_resolve import resolve_crawl_seeds
    from app.nlu import default_seeds_for_site

    task = "帮我爬取豆瓣 top 10 的电影信息"
    hints = parse_manager_task_json(
        {
            "source": "ui",
            "open_web_discovery": True,
            "crawl_strategy": "open_discovery",
            "seed_urls": [],
        }
    )
    plan = await build_structured_task_plan(task, hints=hints)
    assert plan.structural_locked and plan.target_site == "douban"
    assert plan.open_web_search is False
    site_defaults = default_seeds_for_site(plan.target_site)
    assert site_defaults
    seeds = resolve_crawl_seeds(
        manager_seeds=[],
        serp_hits=[],
        target_site=plan.target_site,
        content_type=plan.content_type,
        structural_locked=True,
        max_pages=1,
    )
    assert "top250" in seeds[0]
    print("OK runner_path seeds", seeds, "limit", plan.limit)


def main() -> int:
    test_seed_resolve()
    test_structural_plan()
    test_douban_extract()
    asyncio.run(test_runner_skips_search_for_douban())
    print("ALL OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
