#!/usr/bin/env python3
"""Smoke: display-name SSOT + no yeyu in live cast."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

FORBIDDEN_IN_BACKSTORY = [
    "白霜雫",
    "顾悠微",
    "沈雨汐",
    "林千纱",
    "楚铃可",
    "夏艾辰",
    "莫米拉",
    "叶诗织",
    "叶小阳",
]


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    raise SystemExit(1)


def main() -> None:
    mr = json.loads((DATA / "model_roles.json").read_text(encoding="utf-8"))
    ids: list[str] = []
    for base in mr.get("bases") or []:
        for row in base.get("characters") or []:
            cid = row.get("id") or ""
            ids.append(cid)
            if cid == "yeyu":
                fail("yeyu still in model_roles")
            label = (row.get("label") or "").strip()
            name = ((row.get("profile") or {}).get("name") or "").strip()
            if label and name and label != name:
                fail(f"{cid}: label={label!r} name={name!r}")
            bs = ((row.get("profile") or {}).get("backstory") or "")
            for bad in FORBIDDEN_IN_BACKSTORY:
                if bad in bs:
                    fail(f"{cid} backstory contains {bad}")

    routes = json.loads((DATA / "story_routes.json").read_text(encoding="utf-8"))
    if "yeyu" in (routes.get("characters") or {}):
        fail("yeyu in story_routes.characters")

    intro = json.loads((DATA / "cast_intro.json").read_text(encoding="utf-8"))
    if "yeyu" in (intro.get("characters") or {}):
        fail("yeyu in cast_intro")

    sprite_live = DATA / "sprites" / "romance" / "yeyu"
    if sprite_live.is_dir():
        fail("live sprite dir romance/yeyu still exists")

    npc_pol = routes.get("npc_policy") or {}
    if npc_pol.get("story_branches") is True:
        fail("npc_policy.story_branches must be false")
    if npc_pol.get("allowed_endings"):
        fail("npc_policy.allowed_endings must be empty")

    town = json.loads((DATA / "town_npcs.json").read_text(encoding="utf-8"))
    npcs = town.get("npcs") or []
    if len(npcs) < 8:
        fail(f"expected >=8 town npcs, got {len(npcs)}")
    for n in npcs:
        if n["id"] in ids:
            fail(f"town npc id collides with cast: {n['id']}")

    voices = json.loads((DATA / "romance_voice_cards.json").read_text(encoding="utf-8"))
    cards = voices.get("cards") or {}
    for cid in ids:
        if cid not in cards:
            fail(f"missing voice card: {cid}")
        v = (cards[cid].get("voice") or "").strip()
        if not v or len(v) > 80:
            fail(f"voice card length for {cid}: {len(v)}")

    print(f"OK name-ssot + no-yeyu + town/voice ({len(ids)} cast)")


if __name__ == "__main__":
    try:
        main()
    except FileNotFoundError as e:
        fail(str(e))
        sys.exit(1)
