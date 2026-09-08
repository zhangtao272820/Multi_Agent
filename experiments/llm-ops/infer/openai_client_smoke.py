#!/usr/bin/env python3
"""Minimal OpenAI-compatible smoke test for vLLM / Ollama / cloud APIs."""

from __future__ import annotations

import os
import sys

try:
    from openai import OpenAI
except ImportError:
    print("pip install openai", file=sys.stderr)
    raise


def main() -> int:
    base_url = os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:8000/v1")
    api_key = os.environ.get("OPENAI_API_KEY", "sk-local")
    model = os.environ.get("OPENAI_MODEL", "qwen2.5-7b")

    client = OpenAI(base_url=base_url, api_key=api_key)
    print(f"base_url={base_url} model={model}")

    models = client.models.list()
    ids = [m.id for m in models.data]
    print("models:", ids)

    resp = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "system",
                "content": "你是简洁助手。没有证据时明确说不知道，不要编造。",
            },
            {"role": "user", "content": "用两句话解释：为什么 Agent 要用 OpenAI 兼容 API 接本地模型？"},
        ],
        max_tokens=256,
        temperature=0.2,
    )
    text = resp.choices[0].message.content or ""
    print("--- reply ---")
    print(text)
    print("--- ok ---")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
