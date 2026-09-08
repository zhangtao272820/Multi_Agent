#!/usr/bin/env python3
"""Lightweight checklist runner for eval_prompts.jsonl (manual quality gate).

Does not call a model by default — prints expected keywords so you can paste
replies during lab review. Optional --call uses OPENAI_* env like infer smoke.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--prompts",
        default=str(Path(__file__).parent / "eval_prompts.jsonl"),
    )
    ap.add_argument(
        "--call",
        action="store_true",
        help="Call OpenAI-compatible API and print crude keyword hits",
    )
    args = ap.parse_args()

    rows = []
    with open(args.prompts, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))

    client = None
    model = os.environ.get("OPENAI_MODEL", "qwen2.5-7b")
    if args.call:
        from openai import OpenAI

        client = OpenAI(
            base_url=os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:8000/v1"),
            api_key=os.environ.get("OPENAI_API_KEY", "sk-local"),
        )

    for row in rows:
        print("=" * 60)
        print(f"id={row['id']}")
        print(f"prompt: {row['prompt']}")
        print(f"expect_contains: {row.get('expect_contains')}")
        if client is None:
            continue
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": row["prompt"]}],
            max_tokens=256,
            temperature=0,
        )
        text = resp.choices[0].message.content or ""
        print("--- model ---")
        print(text)
        hits = [k for k in row.get("expect_contains", []) if k in text]
        miss = [k for k in row.get("expect_contains", []) if k not in text]
        print(f"hits={hits} miss={miss}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
