"""Lean caps for crawl runs."""

from __future__ import annotations

from dataclasses import dataclass

from app.config import get_settings
from app.protocol.incoming import ExtractOptions


@dataclass
class LeanCaps:
    max_items: int
    max_pages: int
    mcp_max_calls: int
    concurrency: int


def resolve_lean_caps(options: ExtractOptions) -> LeanCaps:
    s = get_settings()
    return LeanCaps(
        max_items=max(1, min(100, options.max_items or s.default_max_items)),
        max_pages=max(1, min(30, options.max_pages or s.default_max_pages)),
        mcp_max_calls=s.mcp_max_calls,
        concurrency=s.max_concurrency,
    )
