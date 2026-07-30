"""Parse manager_task_json (aligned with ManagerCrawlerTaskPayload)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ExtractOptions:
    max_items: int = 20
    max_pages: int = 5
    use_browser: bool = False


@dataclass
class ManagerTaskHints:
    source: str = ""
    refined_task: str = ""
    hint_fields: list[str] = field(default_factory=list)
    preferred_channel: str | None = None  # http | browser | mcp
    must_filters: list[str] = field(default_factory=list)
    open_web_discovery: bool = False
    seed_urls: list[str] = field(default_factory=list)
    serp_context: str = ""
    serp_hits: list[dict[str, Any]] = field(default_factory=list)
    search_context: dict[str, Any] | None = None
    crawl_strategy: str | None = None  # serp_only | crawl_seeds | open_discovery


def _as_list_str(v: Any) -> list[str]:
    if not isinstance(v, list):
        return []
    out: list[str] = []
    for x in v:
        s = str(x or "").strip()
        if s:
            out.append(s)
    return out


def parse_manager_task_json(raw: str | dict[str, Any] | None) -> ManagerTaskHints:
    if raw is None or raw == "":
        return ManagerTaskHints()
    data: Any = raw
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return ManagerTaskHints()
    if not isinstance(data, dict):
        return ManagerTaskHints()

    preferred = str(data.get("preferred_channel") or "").strip().lower() or None
    if preferred not in (None, "http", "browser", "mcp"):
        preferred = None

    strategy = str(data.get("crawl_strategy") or "").strip().lower() or None
    if strategy not in (None, "serp_only", "crawl_seeds", "open_discovery"):
        strategy = None

    hits_raw = data.get("serp_hits")
    hits: list[dict[str, Any]] = []
    if isinstance(hits_raw, list):
        for h in hits_raw:
            if not isinstance(h, dict):
                continue
            url = str(h.get("url") or "").strip()
            if not url:
                continue
            hits.append(
                {
                    "title": str(h.get("title") or "").strip(),
                    "url": url,
                    "snippet": str(h.get("snippet") or h.get("content") or "").strip(),
                    "crawlAction": str(h.get("crawlAction") or "").strip() or None,
                }
            )

    seeds = [u for u in _as_list_str(data.get("seed_urls")) if u.startswith(("http://", "https://"))]

    sc = data.get("search_context")
    search_context = sc if isinstance(sc, dict) else None

    return ManagerTaskHints(
        source=str(data.get("source") or "").strip(),
        refined_task=str(data.get("refined_task") or "").strip(),
        hint_fields=_as_list_str(data.get("hint_fields")),
        preferred_channel=preferred,
        must_filters=_as_list_str(data.get("must_filters")),
        open_web_discovery=bool(data.get("open_web_discovery")),
        seed_urls=seeds,
        serp_context=str(data.get("serp_context") or "").strip(),
        serp_hits=hits,
        search_context=search_context,
        crawl_strategy=strategy,
    )


def parse_options(raw: dict[str, Any] | None, *, default_items: int, default_pages: int) -> ExtractOptions:
    raw = raw or {}
    try:
        mi = int(raw.get("maxItems") or raw.get("max_items") or default_items)
    except (TypeError, ValueError):
        mi = default_items
    try:
        mp = int(raw.get("maxPages") or raw.get("max_pages") or default_pages)
    except (TypeError, ValueError):
        mp = default_pages
    return ExtractOptions(
        max_items=max(1, min(100, mi)),
        max_pages=max(1, min(30, mp)),
        use_browser=bool(raw.get("useBrowser") or raw.get("use_browser")),
    )
