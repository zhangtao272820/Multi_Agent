#!/usr/bin/env python3
"""Audit male playable sprite pack vs locked list (identity separate).

Usage:
  python scripts/audit_male_sprite_pack.py
  python scripts/audit_male_sprite_pack.py --json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPRITES = ROOT / "data" / "sprites" / "students"
BUDGET = ROOT / "data" / "sprite_budget.json"

DEFAULT_PACK = [
    "summer_stand_neutral.png",
    "q_stand_neutral.png",
    "summer_stand_happy.png",
    "summer_stand_angry.png",
    "summer_study_neutral.png",
    "summer_eat_neutral.png",
    "summer_chat_happy.png",
    "summer_listen_neutral.png",
    "summer_wave_happy.png",
    "summer_think_neutral.png",
    "winter_stand_neutral.png",
    "summer_rain_neutral.png",
    "summer_sc_classroom_lean_neutral.png",
    "summer_sc_hallway_window_neutral.png",
]

DEFAULT_IDS = ["pc", "m01", "m02", "m03", "m04", "m05", "m06", "m07", "m08", "m09"]


def load_ssot() -> tuple[list[str], list[str]]:
    pack = list(DEFAULT_PACK)
    ids = list(DEFAULT_IDS)
    if BUDGET.is_file():
        data = json.loads(BUDGET.read_text(encoding="utf-8"))
        male = (data.get("male_by_beauty") or {}).get("all") or {}
        if male.get("ids"):
            ids = list(male["ids"])
        if data.get("male_pack_files"):
            pack = list(data["male_pack_files"])
    return ids, pack


def audit_one(sid: str, pack: list[str]) -> dict:
    root = SPRITES / sid
    have = [n for n in pack if (root / n).is_file()]
    missing = [n for n in pack if n not in have]
    identity = (root / "_identity_neutral.png").is_file()
    return {
        "id": sid,
        "identity": identity,
        "have_count": len(have),
        "target": len(pack),
        "have": have,
        "missing": missing,
        "complete": len(missing) == 0 and identity,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit male sprite pack gaps")
    parser.add_argument("--json", action="store_true", help="Print JSON report")
    args = parser.parse_args()

    ids, pack = load_ssot()
    rows = [audit_one(sid, pack) for sid in ids]
    complete = sum(1 for r in rows if r["complete"])
    missing_total = sum(len(r["missing"]) for r in rows)

    if args.json:
        print(
            json.dumps(
                {"rows": rows, "complete": complete, "missing_total": missing_total, "pack": pack},
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(f"Male pack audit: {complete}/{len(rows)} complete · missing files total {missing_total}")
        print(f"Target per character: {len(pack)} (+ identity)")
        for r in rows:
            flag = "OK" if r["complete"] else "GAP"
            print(
                f"  [{flag}] {r['id']}: {r['have_count']}/{r['target']} "
                f"identity={'Y' if r['identity'] else 'N'}"
            )
            if r["missing"]:
                shown = ", ".join(r["missing"][:8])
                more = "…" if len(r["missing"]) > 8 else ""
                print(f"         missing: {shown}{more}")
    return 0 if missing_total == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
