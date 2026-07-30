"""Playwright MCP (streamable HTTP) — navigate + snapshot fallback."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlparse

import httpx

from app.config import get_settings


def _extract_text_from_mcp_result(result: Any) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, list):
            parts = []
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text":
                    parts.append(str(c.get("text") or ""))
            if parts:
                return "\n".join(parts)
        if result.get("structuredContent") is not None:
            try:
                return json.dumps(result["structuredContent"], ensure_ascii=False)
            except Exception:
                pass
        # JSON-RPC wrap
        if "result" in result:
            return _extract_text_from_mcp_result(result["result"])
    return str(result)[:20000]


class PlaywrightMcpClient:
    """Minimal JSON-RPC over streamable-HTTP for @playwright/mcp."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self._session_id: str | None = None
        self._req_id = 0

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    async def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        # Docker MCP often expects Host: localhost:8931
        try:
            host = urlparse(self.base_url).hostname or ""
            if host and host not in ("localhost", "127.0.0.1"):
                headers["Host"] = "localhost:8931"
        except Exception:
            pass
        if self._session_id:
            headers["mcp-session-id"] = self._session_id

        async with httpx.AsyncClient(timeout=90.0) as client:
            res = await client.post(self.base_url, headers=headers, json=payload)
            sid = res.headers.get("mcp-session-id") or res.headers.get("Mcp-Session-Id")
            if sid:
                self._session_id = sid
            text = res.text
            if res.status_code >= 400:
                raise RuntimeError(f"playwright_mcp HTTP {res.status_code}: {text[:240]}")
            # SSE: data: {...}
            if "text/event-stream" in (res.headers.get("content-type") or "") or text.startswith("event:"):
                return self._parse_sse_json(text)
            try:
                data = res.json()
            except Exception as e:
                raise RuntimeError(f"playwright_mcp bad json: {text[:200]}") from e
            if isinstance(data, dict) and data.get("error"):
                raise RuntimeError(str(data["error"])[:300])
            return data if isinstance(data, dict) else {"result": data}

    @staticmethod
    def _parse_sse_json(text: str) -> dict[str, Any]:
        last: dict[str, Any] | None = None
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            raw = line[5:].strip()
            if not raw or raw == "[DONE]":
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                last = obj
        if last is None:
            raise RuntimeError("playwright_mcp empty SSE")
        if last.get("error"):
            raise RuntimeError(str(last["error"])[:300])
        return last

    async def initialize(self) -> None:
        resp = await self._post(
            {
                "jsonrpc": "2.0",
                "id": self._next_id(),
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "extractorpy", "version": "0.1.0"},
                },
            }
        )
        # notify initialized
        try:
            await self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        except Exception:
            pass
        _ = resp

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> str:
        resp = await self._post(
            {
                "jsonrpc": "2.0",
                "id": self._next_id(),
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            }
        )
        return _extract_text_from_mcp_result(resp.get("result", resp))


async def scrape_via_playwright_mcp(url: str) -> dict[str, Any] | None:
    settings = get_settings()
    if not settings.playwright_mcp_enabled:
        return None
    u = (url or "").strip()
    if not u.startswith(("http://", "https://")):
        return None
    client = PlaywrightMcpClient(settings.playwright_mcp_url)
    try:
        await client.initialize()
        await client.call_tool("browser_navigate", {"url": u})
        snap = await client.call_tool("browser_snapshot", {})
    except Exception:
        return None
    text = (snap or "").strip()
    if not text:
        return None
    # first line-ish as title
    title = ""
    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith("-") and len(s) < 200:
            title = s[:160]
            break
    return {
        "url": u,
        "title": title,
        "markdown": text[:24000],
        "html": "",
        "channel": "browser",
    }


async def probe_playwright_mcp() -> dict[str, Any]:
    settings = get_settings()
    if not settings.playwright_mcp_enabled:
        return {"ok": False, "skipped": True, "url": settings.playwright_mcp_url}
    try:
        # Lightweight TCP/HTTP reachability — full MCP init is slow for /api/ready
        async with httpx.AsyncClient(timeout=2.5) as client:
            res = await client.get(settings.playwright_mcp_url.replace("/mcp", "/").rstrip("/") or settings.playwright_mcp_url)
        return {
            "ok": res.status_code < 500,
            "status": res.status_code,
            "url": settings.playwright_mcp_url,
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:200], "url": settings.playwright_mcp_url}
