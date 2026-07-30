#!/usr/bin/env python3
"""Channel smoke: mock CRW + playwright_mcp upgrade path (no real network required)."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


async def main() -> int:
    from app.runtime import channel as channel_mod
    from app.runtime.runner import run_extract

    calls: list[str] = []

    async def fake_crw(url: str, *, signal_aborted: bool = False) -> dict[str, Any] | None:
        calls.append(f"crw:{url}")
        if "fail-crw" in url:
            return None
        return {
            "url": url,
            "title": "CRW Page",
            "markdown": "# Hello from CRW\n\nBody text about smoke test.",
            "html": "<h1>Hello</h1>",
            "channel": "mcp",
        }

    async def fake_pw(url: str) -> dict[str, Any] | None:
        calls.append(f"pw:{url}")
        return {
            "url": url,
            "title": "PW Page",
            "markdown": "Playwright snapshot text for smoke.",
            "html": "",
            "channel": "browser",
        }

    channel_mod.crw_scrape = fake_crw  # type: ignore[attr-defined]
    channel_mod.scrape_via_playwright_mcp = fake_pw  # type: ignore[attr-defined]

    # Patch imports used inside fetch_page (bound at call time via module attrs)
    import app.tools.crw_scrape as crw_mod
    import app.tools.playwright_mcp as pw_mod

    crw_mod.scrape_url = fake_crw  # type: ignore[assignment]
    pw_mod.scrape_via_playwright_mcp = fake_pw  # type: ignore[assignment]
    channel_mod.crw_scrape = fake_crw  # type: ignore[assignment]
    channel_mod.scrape_via_playwright_mcp = fake_pw  # type: ignore[assignment]

    # 1) CRW success
    calls.clear()
    r1 = await run_extract(
        task="smoke crw",
        manager_task_json={
            "source": "manager",
            "crawl_strategy": "crawl_seeds",
            "seed_urls": ["https://example.com/ok"],
        },
        options={"maxItems": 3, "maxPages": 1},
        trace_id="smoke-ch-1",
    )
    assert r1.get("ok"), r1
    assert r1["items"], r1
    assert any(c.startswith("crw:") for c in calls), calls
    print("OK CRW path", r1["meta"])

    # 2) CRW fail → PW upgrade
    calls.clear()
    r2 = await run_extract(
        task="smoke pw fallback",
        manager_task_json={
            "source": "manager",
            "crawl_strategy": "crawl_seeds",
            "seed_urls": ["https://example.com/fail-crw"],
        },
        options={"maxItems": 3, "maxPages": 1},
        trace_id="smoke-ch-2",
    )
    assert r2.get("ok"), r2
    assert any(c.startswith("pw:") for c in calls), calls
    print("OK PW upgrade", calls, r2["meta"])

    # 3) preferred_channel=browser → PW first
    calls.clear()
    r3 = await run_extract(
        task="smoke prefer browser",
        manager_task_json={
            "source": "manager",
            "preferred_channel": "browser",
            "seed_urls": ["https://example.com/prefer"],
        },
        options={"maxItems": 3, "maxPages": 1},
        trace_id="smoke-ch-3",
    )
    assert r3.get("ok"), r3
    assert calls and calls[0].startswith("pw:"), calls
    print("OK preferred browser", calls)

    print("ALL PASS")
    return 0


if __name__ == "__main__":
    import asyncio

    raise SystemExit(asyncio.run(main()))
