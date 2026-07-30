"""Fetch channel selection: CRW first, playwright_mcp upgrade."""

from __future__ import annotations

from typing import Any, Callable, Awaitable

from app.config import get_settings
from app.tools.crw_scrape import scrape_url as crw_scrape
from app.tools.playwright_mcp import scrape_via_playwright_mcp


LogFn = Callable[[str, str], Awaitable[None] | None]


async def fetch_page(
    url: str,
    *,
    preferred_channel: str | None,
    force_browser: bool,
    mcp_calls_left: int,
    emit_log: LogFn | None = None,
) -> tuple[dict[str, Any] | None, int]:
    """
    Returns (snapshot, remaining_mcp_budget).
    preferred_channel browser|mcp → try playwright first when enabled.
    """
    settings = get_settings()
    remaining = mcp_calls_left

    async def _log(level: str, msg: str) -> None:
        if emit_log:
            r = emit_log(level, msg)
            if hasattr(r, "__await__"):
                await r  # type: ignore[misc]

    prefer_pw = force_browser or (preferred_channel in ("browser", "mcp") and settings.playwright_mcp_enabled)

    if prefer_pw and remaining > 0 and settings.playwright_mcp_enabled:
        await _log("info", f"playwright_mcp 抓取 {url}")
        snap = await scrape_via_playwright_mcp(url)
        remaining -= 1
        if snap:
            return snap, remaining
        await _log("warn", f"playwright_mcp 失败，回退 CRW：{url}")

    if remaining > 0:
        await _log("info", f"CRW scrape {url}")
        snap = await crw_scrape(url)
        remaining -= 1
        if snap:
            return snap, remaining

    if not prefer_pw and remaining > 0 and settings.playwright_mcp_enabled:
        await _log("info", f"CRW 失败，升级 playwright_mcp：{url}")
        snap = await scrape_via_playwright_mcp(url)
        remaining -= 1
        if snap:
            return snap, remaining

    return None, remaining
