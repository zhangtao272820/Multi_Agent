#!/usr/bin/env python3
"""Compute smoke: message assembly + optional live LLM if OPENAI_API_KEY set."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


async def main_async() -> int:
    from app.runtime.compute import build_compute_user_message, run_compute
    from app.protocol.incoming import parse_manager_task

    manager = parse_manager_task(
        {
            "source": "manager",
            "task_kind": "compute",
            "upstream_context": "收入=100，支出=40",
            "upstream_facts": [
                {"key": "income", "value": 100, "source": "db"},
                {"key": "expense", "value": 40, "source": "db"},
            ],
        }
    )
    user = build_compute_user_message(question="算结余", manager=manager)
    assert "收入=100" in user
    assert "income" in user
    print("OK user message assembly")

    if not (os.environ.get("OPENAI_API_KEY") or os.environ.get("QWEN_API_KEY")):
        print("SKIP live compute (no API key)")
        return 0

    result = await run_compute(
        message="算结余",
        manager_task=manager.raw,
        trace_id="smoke-compute",
    )
    assert result.get("agentResult", {}).get("agent") == "code"
    print("OK live compute", "ok=", result.get("ok"), "chars=", len(result.get("answer") or ""))
    return 0 if result.get("ok") else 1


def main() -> int:
    return asyncio.run(main_async())


if __name__ == "__main__":
    raise SystemExit(main())
