"""Firecrawl-compatible CRW scrape (MCP_BASE_URL)."""

from __future__ import annotations

from typing import Any

import httpx

from app.config import get_settings


async def scrape_url(url: str, *, signal_aborted: bool = False) -> dict[str, Any] | None:
    """Return {url, title, markdown, html, channel} or None on failure."""
    if signal_aborted:
        return None
    settings = get_settings()
    u = (url or "").strip()
    if not u.startswith(("http://", "https://")):
        return None
    if settings.mcp_provider not in ("firecrawl", "generic", ""):
        # lean path only implements firecrawl-compatible POST body
        if settings.mcp_provider not in ("firecrawl",):
            pass

    endpoint = settings.mcp_base_url
    headers = {
        "Authorization": f"Bearer {settings.mcp_api_key}",
        "Content-Type": "application/json",
        "User-Agent": "ExtractorPy/0.1",
        "Accept": "application/json",
    }
    body = {
        "url": u,
        "formats": ["markdown", "html"],
        "waitFor": 3000 if settings.mcp_render else 0,
    }
    timeout = max(15.0, settings.request_timeout_ms / 1000.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.post(endpoint, headers=headers, json=body)
            if res.status_code >= 400:
                return None
            data = res.json()
    except Exception:
        return None

    # Firecrawl shape: { success, data: { markdown, html, metadata } } or flat
    payload = data.get("data") if isinstance(data, dict) and isinstance(data.get("data"), dict) else data
    if not isinstance(payload, dict):
        return None
    markdown = str(payload.get("markdown") or payload.get("content") or "").strip()
    html = str(payload.get("html") or "").strip()
    meta = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    title = str(meta.get("title") or payload.get("title") or "").strip()
    if not markdown and not html:
        return None
    return {
        "url": u,
        "title": title,
        "markdown": markdown or html[:12000],
        "html": html[:50000] if html else "",
        "channel": "mcp",
    }


async def probe_crw() -> dict[str, Any]:
    settings = get_settings()
    url = settings.mcp_base_url
    probe = url.rsplit("/v1/", 1)[0] if "/v1/" in url else url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=2.5) as client:
            res = await client.get(probe)
        return {"ok": res.status_code < 500, "status": res.status_code, "url": probe}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:200], "url": probe}
