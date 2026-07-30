"""SearXNG client for seed discovery."""

from __future__ import annotations

from typing import Any

import httpx

from app.config import get_settings


async def search_searxng(query: str, *, max_results: int = 6) -> list[dict[str, str]]:
    settings = get_settings()
    q = (query or "").strip()
    if not q:
        return []
    params = {
        "q": q,
        "format": "json",
        "language": "zh-CN",
        "categories": "general",
    }
    timeout = max(8.0, settings.searxng_timeout_ms / 1000.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        res = await client.get(
            f"{settings.searxng_base_url}/search",
            params=params,
            headers={
                "Accept": "application/json",
                "User-Agent": "ExtractorPy/0.1 (SearXNG client)",
            },
        )
        res.raise_for_status()
        data: dict[str, Any] = res.json()
    out: list[dict[str, str]] = []
    for r in (data.get("results") or [])[: max(1, max_results)]:
        url = str(r.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        out.append(
            {
                "title": str(r.get("title") or "").strip(),
                "url": url,
                "snippet": str(r.get("content") or "").strip(),
            }
        )
    return out


async def probe_searxng() -> dict[str, Any]:
    settings = get_settings()
    try:
        async with httpx.AsyncClient(timeout=2.5) as client:
            res = await client.get(f"{settings.searxng_base_url}/")
        return {"ok": res.status_code < 500, "status": res.status_code, "url": settings.searxng_base_url}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:200], "url": settings.searxng_base_url}
