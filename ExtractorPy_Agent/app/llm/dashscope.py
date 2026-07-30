"""OpenAI-compatible DashScope client (T0 CAP_ROUTE, thinking off)."""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

from app.config import get_settings


def _strip_fences(text: str) -> str:
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    return t.strip()


async def chat_text(
    *,
    system: str,
    user: str,
    max_tokens: int | None = None,
    temperature: float = 0.2,
) -> str | None:
    settings = get_settings()
    if not settings.qwen_api_key:
        return None
    url = f"{settings.qwen_base_url}/chat/completions"
    tokens = max_tokens if max_tokens is not None else settings.llm_json_max_tokens
    body: dict[str, Any] = {
        "model": settings.qwen_model,
        "temperature": temperature,
        "max_tokens": tokens,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    # 对齐 CAP_ENABLE_THINKING=off，避免思考链烧额度
    if not settings.enable_thinking:
        body["enable_thinking"] = False
        body["extra_body"] = {"enable_thinking": False}
    headers = {
        "Authorization": f"Bearer {settings.qwen_api_key}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
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
