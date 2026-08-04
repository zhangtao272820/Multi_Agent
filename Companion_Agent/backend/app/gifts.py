"""便利店礼物 SSOT。"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from pydantic import BaseModel, Field

from .config import PROJECT_ROOT
from .memory import MemoryFact, merge_memories
from .world_store import BondShelf, WorldSave, upsert_world_save


class GiftDef(BaseModel):
    id: str
    label: str
    tags: list[str] = Field(default_factory=list)
    affinity_delta: int = 1
    trust_delta: int = 0
    money_cost: int | None = None
    note: str = ""


class GiftCatalog(BaseModel):
    location_id: str = "store"
    cost: int = 1
    money_cost: int = 25
    gifts: list[GiftDef] = Field(default_factory=list)


@lru_cache(maxsize=1)
def load_gift_catalog() -> GiftCatalog:
    path = PROJECT_ROOT / "data" / "gift_catalog.json"
    if not path.is_file():
        return GiftCatalog()
    return GiftCatalog.model_validate(json.loads(path.read_text(encoding="utf-8")))


def score_gift_for_bond(gift: GiftDef, bond: BondShelf) -> int:
    likes = " ".join(bond.preferences.likes or [])
    dislikes = " ".join(bond.preferences.dislikes or [])
    score = 0
    for tag in gift.tags:
        if tag and tag in likes:
            score += 3
        if tag and tag in dislikes:
            score -= 4
    return score


def buy_gift(
    save: WorldSave,
    *,
    character_id: str,
    gift_id: str,
) -> tuple[WorldSave, dict[str, Any]]:
    from .world_engine import can_spend, spend_ap

    cat = load_gift_catalog()
    if save.location_id != cat.location_id:
        return save, {"ok": False, "error": "只有在便利店才能买小礼物"}
    bond = save.bonds.get(character_id)
    if not bond:
        return save, {"ok": False, "error": "还不认识她"}
    day = int(save.calendar.day_index or 1)
    if int(bond.living.gift_day_index or 0) != day:
        bond.living.gift_day_index = day
        bond.living.gifts_today = 0
    if int(bond.living.gifts_today or 0) >= 1:
        return save, {
            "ok": False,
            "error": "今天已经送过她了，明天再带点心意吧",
        }
    gift = next((g for g in cat.gifts if g.id == gift_id), None)
    if not gift:
        return save, {"ok": False, "error": "没有这件礼物"}
    cost = int(cat.cost)
    if not can_spend(save, cost):
        return save, {"ok": False, "error": "心力不够了"}

    score = score_gift_for_bond(gift, bond)
    save = spend_ap(save, cost)
    rel = bond.relationship_state
    aff = int(gift.affinity_delta)
    tru = int(gift.trust_delta)
    if score >= 3:
        aff += 1
        impression = f"她眼睛亮了一下——这份「{gift.label}」很合她胃口。"
    elif score < 0:
        aff = max(0, aff - 1)
        impression = f"她收下了「{gift.label}」，礼貌但兴致一般。"
    else:
        impression = f"她轻轻点头，收下了「{gift.label}」。"

    from .route_difficulty import scale_positive_affinity

    aff = scale_positive_affinity(bond.character_id, aff)

    bond.relationship_state = rel.model_copy(
        update={
            "affinity": min(100, rel.affinity + aff),
            "trust": min(100, max(0, rel.trust + tru)),
        }
    )
    fact = MemoryFact(
        text=f"你在便利店送她「{gift.label}」。{gift.note or ''}".strip(),
        source="system",
        tags=["gift", "daily_life"],
    )
    bond.memories = merge_memories(bond.memories, [fact])
    bond.living.gift_day_index = day
    bond.living.gifts_today = int(bond.living.gifts_today or 0) + 1
    save.bonds[character_id] = bond
    upsert_world_save(save)
    return save, {
        "ok": True,
        "gift_id": gift.id,
        "label": gift.label,
        "impression": impression,
        "character_id": character_id,
        "action_points": save.action_points,
        "money": save.protagonist.money,
        "money_spent": 0,
    }


def public_store_shop(save: WorldSave) -> dict[str, Any]:
    cat = load_gift_catalog()
    if save.location_id != cat.location_id:
        return {"available": False, "cost": cat.cost, "gifts": [], "recipients": []}
    people = [
        {
            "character_id": cid,
            "name": b.profile.name,
            "role": b.social_role_to_pc,
        }
        for cid, b in save.bonds.items()
        if b.relationship_state.affinity >= 10 or b.living.talked_day_index > 0
    ]
    return {
        "available": True,
        "cost": cat.cost,
        "money_cost": 0,
        "gifts": [
            {
                **g.model_dump(),
                "money_cost": 0,
            }
            for g in cat.gifts
        ],
        "recipients": people[:12],
    }
