"""OpenAI-compatible DashScope client."""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Callable, Awaitable
from typing import Any

import httpx

from app.config import get_settings


def _strip_fences(text: str) -> str:
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    return t.strip()


def _chat_body(
    *,
    system: str,
    user: str,
    max_tokens: int,
    temperature: float,
    stream: bool = False,
    tools: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    body: dict[str, Any] = {
        "model": settings.openai_model,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": stream,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    if not settings.enable_thinking:
        body["enable_thinking"] = False
        body["extra_body"] = {"enable_thinking": False}
    return body


async def chat_text(
    *,
    system: str,
    user: str,
    max_tokens: int | None = None,
    temperature: float = 0.2,
) -> str | None:
    settings = get_settings()
    if not settings.openai_api_key:
        return None
    url = f"{settings.openai_base_url}/chat/completions"
    tokens = max_tokens if max_tokens is not None else settings.llm_json_max_tokens
    body = _chat_body(system=system, user=user, max_tokens=tokens, temperature=temperature)
    headers = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout_sec) as client:
            res = await client.post(url, headers=headers, json=body)
            if res.status_code >= 400:
                return None
            data = res.json()
        return str(data["choices"][0]["message"]["content"] or "").strip()
    except Exception:
        return None


async def chat_json(
    *,
    system: str,
    user: str,
    max_tokens: int | None = None,
) -> dict[str, Any] | list[Any] | None:
    settings = get_settings()
    raw = await chat_text(
        system=system,
        user=user,
        max_tokens=max_tokens if max_tokens is not None else settings.llm_json_max_tokens,
        temperature=0.1,
    )
    if not raw:
        return None
    text = _strip_fences(raw)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"[\{\[].*[\}\]]", text, re.S)
        if not m:
            return None
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return None


async def chat_stream_text(
    *,
    system: str,
    user: str,
    max_tokens: int | None = None,
    temperature: float = 0.2,
    on_delta: Callable[[str], Awaitable[None] | None] | None = None,
) -> str | None:
    """Stream completion; return full text. Calls on_delta for each chunk."""
    settings = get_settings()
    if not settings.openai_api_key:
        return None
    url = f"{settings.openai_base_url}/chat/completions"
    tokens = max_tokens if max_tokens is not None else settings.llm_json_max_tokens
    body = _chat_body(
        system=system,
        user=user,
        max_tokens=tokens,
        temperature=temperature,
        stream=True,
    )
    headers = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }
    buf: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout_sec) as client:
            async with client.stream("POST", url, headers=headers, json=body) as res:
                if res.status_code >= 400:
                    return None
                async for line in res.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        data = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    delta = (((data.get("choices") or [{}])[0]).get("delta") or {}).get("content")
                    if not delta:
                        continue
                    piece = str(delta)
                    buf.append(piece)
                    if on_delta:
                        r = on_delta(piece)
                        if hasattr(r, "__await__"):
                            await r  # type: ignore[misc]
    except Exception:
        return "".join(buf) if buf else None
    return "".join(buf).strip() or None


async def chat_messages(
    *,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    max_tokens: int | None = None,
    temperature: float = 0.2,
) -> dict[str, Any] | None:
    """Multi-turn chat with optional tools; returns assistant message dict."""
    settings = get_settings()
    if not settings.openai_api_key:
        return None
    url = f"{settings.openai_base_url}/chat/completions"
    tokens = max_tokens if max_tokens is not None else settings.llm_json_max_tokens
    body: dict[str, Any] = {
        "model": settings.openai_model,
        "temperature": temperature,
        "max_tokens": tokens,
        "messages": messages,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    if not settings.enable_thinking:
        body["enable_thinking"] = False
        body["extra_body"] = {"enable_thinking": False}
    headers = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout_sec) as client:
            res = await client.post(url, headers=headers, json=body)
            if res.status_code >= 400:
                return None
            data = res.json()
        return (data.get("choices") or [{}])[0].get("message")
    except Exception:
        return None
