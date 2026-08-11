"""戏份星级 SSOT：data/cast_star_tiers.json（卡面/排期/厚度权威）。"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from .config import PROJECT_ROOT


def _path():
    return PROJECT_ROOT / "data" / "cast_star_tiers.json"


@lru_cache(maxsize=1)
def load_cast_star_tiers() -> dict[str, Any]:
    path = _path()
    if not path.is_file():
        return {"version": 0, "labels": {}, "characters": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def reload_cast_star_tiers() -> dict[str, Any]:
    load_cast_star_tiers.cache_clear()
    return load_cast_star_tiers()


def get_star_tier(character_id: str) -> dict[str, Any]:
    cid = (character_id or "").strip()
    row = (load_cast_star_tiers().get("characters") or {}).get(cid) or {}
    weight = int(row.get("story_weight") or 0)
    labels = load_cast_star_tiers().get("labels") or {}
    stars = str(row.get("tier_stars") or ("★" * weight if weight else ""))
    label = str(row.get("tier_label") or labels.get(str(weight)) or "")
    return {
        "character_id": cid,
        "name": str(row.get("name") or cid),
        "story_weight": weight,
        "tier_stars": stars,
        "tier_label": label,
        "resource_tier": str(row.get("resource_tier") or ""),
    }


def public_star_tiers() -> dict[str, Any]:
    data = load_cast_star_tiers()
    chars = data.get("characters") or {}
    ordered = sorted(
        chars.items(),
        key=lambda kv: (-int((kv[1] or {}).get("story_weight") or 0), kv[0]),
    )
    return {
        "version": data.get("version"),
        "notes": data.get("notes") or "",
        "labels": data.get("labels") or {},
        "characters": [
            {
                "character_id": cid,
                **{k: v for k, v in (row or {}).items()},
            }
            for cid, row in ordered
        ],
    }


def stars_for_gallery(character_id: str) -> dict[str, Any]:
    """图鉴卡片用的精简字段。"""
    row = get_star_tier(character_id)
    return {
        "story_weight": row["story_weight"],
        "tier_stars": row["tier_stars"],
        "tier_label": row["tier_label"],
        "resource_tier": row["resource_tier"],
    }
