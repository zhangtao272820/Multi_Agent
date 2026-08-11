"""角色介绍卡文案 SSOT + 戏份星级合并。"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from .cast_star_tiers import get_star_tier, load_cast_star_tiers
from .config import PROJECT_ROOT

# A/B → 设置·攻略；C–F → 局内（人物看板 / 登场）
_GUIDE_KEYS = ("card_a", "card_b")
_INGAME_KEYS = ("card_c", "card_d", "card_e", "card_f")
_ALL_CARD_KEYS = _GUIDE_KEYS + _INGAME_KEYS


def _path():
    return PROJECT_ROOT / "data" / "character_intro_cards.json"


@lru_cache(maxsize=1)
def load_intro_cards() -> dict[str, Any]:
    path = _path()
    if not path.is_file():
        return {"version": 0, "cards": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def reload_intro_cards() -> dict[str, Any]:
    load_intro_cards.cache_clear()
    return load_intro_cards()


def _card_image_urls(character_id: str) -> dict[str, Any]:
    root = PROJECT_ROOT / "data" / "sprites" / "intro_cards" / character_id
    out: dict[str, Any] = {}
    guide: dict[str, str] = {}
    ingame: dict[str, str] = {}
    for key in _ALL_CARD_KEYS:
        fname = f"{key}.png"
        if (root / fname).is_file():
            url = f"/api/sprites/intro_cards/{character_id}/{fname}"
            out[key] = url
            if key in _GUIDE_KEYS:
                guide[key] = url
            else:
                ingame[key] = url
    if guide:
        out["guide"] = guide
    if ingame:
        out["ingame"] = ingame
    return out


def public_intro_card(character_id: str) -> dict[str, Any] | None:
    cid = (character_id or "").strip()
    if not cid:
        return None
    cards = load_intro_cards().get("cards") or {}
    star = get_star_tier(cid)
    if not star.get("story_weight") and cid not in cards:
        return None
    base = dict(cards.get(cid) or {})
    # 星级以 cast_star_tiers 为准
    base["character_id"] = cid
    base["story_weight"] = star["story_weight"]
    base["tier_stars"] = star["tier_stars"]
    base["tier_label"] = star["tier_label"]
    if star.get("resource_tier"):
        base["tier"] = star["resource_tier"]
    if star.get("name") and not base.get("name_zh"):
        base["name_zh"] = star["name"]
    images = _card_image_urls(cid)
    if images:
        base["images"] = images
    return base


def public_intro_cards_catalog() -> dict[str, Any]:
    stars = load_cast_star_tiers().get("characters") or {}
    cards = load_intro_cards().get("cards") or {}
    ids = sorted(
        set(stars) | set(cards),
        key=lambda cid: (-int((stars.get(cid) or {}).get("story_weight") or 0), cid),
    )
    return {
        "version": load_intro_cards().get("version"),
        "notes": load_intro_cards().get("notes") or "",
        "schema": load_intro_cards().get("schema") or {},
        "cards": [public_intro_card(cid) for cid in ids if public_intro_card(cid)],
    }
