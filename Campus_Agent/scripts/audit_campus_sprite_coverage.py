#!/usr/bin/env python3
"""Audit T0/T1/T2 female variety gaps (signature / date / end / Q).

Scope: school_belle + extreme + high only. T3 and males are out of scope.

Usage:
  python scripts/audit_campus_sprite_coverage.py
  python scripts/audit_campus_sprite_coverage.py --json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SPRITES = ROOT / "data" / "sprites" / "students"
BUDGET = ROOT / "data" / "sprite_budget.json"
ROSTER = ROOT / "data" / "class_roster.json"

DATE_ACTIONS = ("date_chat", "date_stroll", "date_walk")
DATE_EMOTIONS = ("happy", "shy", "neutral")
END_FILES = ("end_stand_happy.png", "end_stand_shy.png", "end_stand_neutral.png")
Q_FOCUS = ("q_stand_neutral.png", "q_stand_happy.png", "q_stand_shy.png", "q_stand_sad.png")


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def focus_ids(budget: dict[str, Any]) -> list[tuple[str, str]]:
    """Return [(id, tier)] for T0/T1/T2 females."""
    out: list[tuple[str, str]] = []
    fb = budget.get("female_by_beauty") or {}
    for key in ("school_belle", "extreme", "high"):
        block = fb.get(key) or {}
        tier = str(block.get("tier") or key)
        for sid in block.get("ids") or []:
            out.append((str(sid), tier))
    return out


def _files(sid: str) -> set[str]:
    root = SPRITES / sid
    if not root.is_dir():
        return set()
    return {p.name for p in root.glob("*.png")}


def _sig_expected(plan: list[dict[str, Any]]) -> list[str]:
    names: list[str] = []
    for entry in plan:
        outfit = str(entry.get("outfit") or "summer")
        action = str(entry.get("action") or "")
        if not action:
            continue
        emos = entry.get("emotions") or ["neutral", "happy", "shy"]
        for emo in emos:
            names.append(f"{outfit}_{action}_{emo}.png")
    return names


def _date_expected() -> list[str]:
    names: list[str] = []
    for action in DATE_ACTIONS:
        for emo in DATE_EMOTIONS:
            names.append(f"summer_{action}_{emo}.png")
    return names


def audit_one(sid: str, tier: str, student: dict[str, Any] | None) -> dict[str, Any]:
    have = _files(sid)
    plan = list((student or {}).get("signature_plan") or [])
    sig_need = _sig_expected(plan)
    sig_have = [n for n in sig_need if n in have]
    sig_miss = [n for n in sig_need if n not in have]

    date_need = _date_expected()
    date_have = [n for n in date_need if n in have]
    date_miss = [n for n in date_need if n not in have]

    end_have = [n for n in END_FILES if n in have]
    end_miss = [n for n in END_FILES if n not in have]

    q_have = [n for n in Q_FOCUS if n in have]
    q_miss = [n for n in Q_FOCUS if n not in have]

    playable = sorted(n for n in have if not n.startswith("_") and n != "identity_neutral.png")
    return {
        "id": sid,
        "tier": tier,
        "name": (student or {}).get("name") or sid,
        "png_count": len(playable),
        "signature_plan_count": len(plan),
        "signature_hooks": [str(e.get("id") or e.get("action") or "") for e in plan],
        "signature_have": len(sig_have),
        "signature_need": len(sig_need),
        "signature_missing": sig_miss,
        "date_have": len(date_have),
        "date_need": len(date_need),
        "date_missing": date_miss,
        "end_have": len(end_have),
        "end_need": len(END_FILES),
        "end_missing": end_miss,
        "q_have": len(q_have),
        "q_need": len(Q_FOCUS),
        "q_missing": q_miss,
        "variety_ready": bool(plan)
        and len(sig_miss) == 0
        and len(date_miss) == 0
        and len(end_miss) == 0
        and "q_stand_sad.png" not in q_miss,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit T0–T2 female sprite variety gaps")
    parser.add_argument("--json", action="store_true", help="Print JSON report")
    args = parser.parse_args()

    budget = _load_json(BUDGET)
    roster = _load_json(ROSTER)
    by_id = {
        str(s.get("id")): s
        for s in (roster.get("students") or [])
        if isinstance(s, dict) and s.get("id")
    }

    rows = [audit_one(sid, tier, by_id.get(sid)) for sid, tier in focus_ids(budget)]
    summary = {
        "scope": "T0/T1/T2 female only",
        "count": len(rows),
        "with_signature_plan": sum(1 for r in rows if r["signature_plan_count"] > 0),
        "signature_files_missing": sum(len(r["signature_missing"]) for r in rows),
        "date_files_missing": sum(len(r["date_missing"]) for r in rows),
        "end_files_missing": sum(len(r["end_missing"]) for r in rows),
        "q_sad_missing": sum(1 for r in rows if "q_stand_sad.png" in r["q_missing"]),
        "variety_ready": sum(1 for r in rows if r["variety_ready"]),
        "characters": rows,
    }

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(
            f"T0–T2 female={summary['count']}  "
            f"signature_plan={summary['with_signature_plan']}/{summary['count']}  "
            f"sig_miss={summary['signature_files_missing']}  "
            f"date_miss={summary['date_files_missing']}  "
            f"end_miss={summary['end_files_missing']}  "
            f"q_sad_miss={summary['q_sad_missing']}  "
            f"variety_ready={summary['variety_ready']}"
        )
        for r in rows:
            print(
                f"  {r['tier']} {r['id']} {r['name']}: png={r['png_count']}  "
                f"sig={r['signature_have']}/{r['signature_need']}  "
                f"date={r['date_have']}/{r['date_need']}  "
                f"end={r['end_have']}/{r['end_need']}  "
                f"q={r['q_have']}/{r['q_need']}  "
                f"hooks={','.join(r['signature_hooks']) or '-'}"
            )

    # Non-zero exit only if no signature plans at all (wiring not landed)
    if summary["with_signature_plan"] == 0:
        print("WARN: no signature_plan on roster — run W1 inject first", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
