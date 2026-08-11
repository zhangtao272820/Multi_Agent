#!/usr/bin/env python3
"""Smoke: cast_star_tiers 1–5 + intro card merge + gallery star fields."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from app.cast_pick import build_gallery_payload  # noqa: E402
from app.cast_star_tiers import get_star_tier, load_cast_star_tiers, public_star_tiers  # noqa: E402
from app.intro_cards import public_intro_card, public_intro_cards_catalog  # noqa: E402


EXPECTED = {
    5: {"xiaoyou", "wanyu", "linxi", "ruolin", "jingliu", "aili", "shuli"},
    4: {"taotao", "shizuku", "qiansha", "shiori", "miara"},
    3: {"youwei", "yuxi", "jingning", "lingke", "aichen"},
    2: {"xingnai", "fengyin", "qingcai", "xiaoyang", "luna"},
}


def main() -> int:
    errors: list[str] = []
    data = load_cast_star_tiers()
    chars = data.get("characters") or {}
    if len(chars) != 22:
        errors.append(f"cast_star_tiers 期望 22 人，实际 {len(chars)}")

    by_w: dict[int, set[str]] = {5: set(), 4: set(), 3: set(), 2: set(), 1: set()}
    for cid, row in chars.items():
        w = int((row or {}).get("story_weight") or 0)
        if w < 1 or w > 5:
            errors.append(f"{cid}: story_weight={w} 须在 1..5")
            continue
        stars = str((row or {}).get("tier_stars") or "")
        if stars != "★" * w:
            errors.append(f"{cid}: tier_stars={stars!r} 须为 {'★' * w!r}")
        by_w[w].add(cid)

    for w, expect in EXPECTED.items():
        if by_w[w] != expect:
            errors.append(f"{w}★ 集合不符: got={sorted(by_w[w])} want={sorted(expect)}")
    if by_w[1]:
        errors.append(f"1★ 预留档不应有角色: {sorted(by_w[1])}")

    xy = get_star_tier("xiaoyou")
    if xy.get("story_weight") != 5 or xy.get("tier_stars") != "★★★★★":
        errors.append(f"xiaoyou 星级错误: {xy}")

    card = public_intro_card("xiaoyou")
    if not card or card.get("tier_stars") != "★★★★★":
        errors.append(f"intro card xiaoyou 星级错误: {card and card.get('tier_stars')}")
    if card and "戏份·核心" not in str(card.get("tier_label") or ""):
        errors.append(f"intro card xiaoyou tier_label: {card.get('tier_label')}")

    catalog = public_intro_cards_catalog()
    if not (catalog.get("cards") or []):
        errors.append("intro-cards catalog 为空")

    pub = public_star_tiers()
    if len(pub.get("characters") or []) != 22:
        errors.append("public_star_tiers 人数不对")

    gallery = build_gallery_payload(mode="browse")
    gal_chars = gallery.get("characters") or []
    starred = [c for c in gal_chars if c.get("tier_stars")]
    if len(starred) < 18:
        errors.append(f"gallery 带星级角色过少: {len(starred)}")
    xy_g = next((c for c in gal_chars if c.get("character_id") == "xiaoyou"), None)
    if not xy_g or xy_g.get("story_weight") != 5:
        errors.append(f"gallery xiaoyou 缺星级: {xy_g}")

    # intro JSON 自身也应对齐
    intro_raw = json.loads((DATA / "character_intro_cards.json").read_text(encoding="utf-8"))
    xy_raw = (intro_raw.get("cards") or {}).get("xiaoyou") or {}
    if xy_raw.get("tier_stars") != "★★★★★":
        errors.append(f"character_intro_cards.json xiaoyou tier_stars={xy_raw.get('tier_stars')!r}")

    if errors:
        print("FAIL")
        for e in errors:
            print(" -", e)
        return 1
    print("OK cast_star_tiers + intro + gallery stars")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
