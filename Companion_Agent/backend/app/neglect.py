"""日结冷落衰减（美德层 · 确定性 · 不调 LLM）。"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from .config import PROJECT_ROOT
from .life_friction import apply_missed_soft_cold
from .relationship import RelationshipState, apply_judge_to_state
from .world_store import BondShelf, WorldSave


@lru_cache(maxsize=1)
def load_neglect_decay() -> dict[str, Any]:
    path = PROJECT_ROOT / "data" / "neglect_decay.json"
    if not path.is_file():
        return {
            "grace_days": 2,
            "soft_cold_after_days": 4,
            "soft_cold_duration_days": 3,
            "by_stage": {},
        }
    return json.loads(path.read_text(encoding="utf-8"))


def reload_neglect_decay() -> dict[str, Any]:
    load_neglect_decay.cache_clear()
    return load_neglect_decay()


def days_since_talk(bond: BondShelf, day_index: int) -> int:
    talked = int(bond.living.talked_day_index or 0)
    if talked <= 0:
        return 0
    return max(0, int(day_index) - talked)


def decay_for_stage(stage_id: str) -> dict[str, int]:
    cat = load_neglect_decay()
    row = (cat.get("by_stage") or {}).get(stage_id) or {}
    return {
        "affinity": int(row.get("affinity") or 0),
        "trust": int(row.get("trust") or 0),
        "mood": int(row.get("mood") or 0),
    }


def apply_neglect_to_bond(
    bond: BondShelf,
    *,
    day_index: int,
    character_id: str = "",
) -> BondShelf:
    """对单个 bond 结算一次日结冷落；未过宽限则原样返回。"""
    if bond.relationship_state.active_ending_id:
        return bond
    from .character_lores import is_romanceable_cast, normalize_cast_kind

    if not is_romanceable_cast(bond.cast_kind):
        return bond

    cat = load_neglect_decay()
    grace = int(cat.get("grace_days") or 2)
    gap = days_since_talk(bond, day_index)
    if gap <= grace:
        return bond

    deltas = decay_for_stage(bond.relationship_state.stage_id or "stranger")
    if not any(deltas.values()):
        return bond

    # 冷战中略加重 mood（仍确定性）
    flags = bond.relationship_state.flags or {}
    mood_extra = -1 if flags.get("cold_war_active") else 0

    state, _, _ = apply_judge_to_state(
        bond.relationship_state,
        affinity_delta=int(deltas["affinity"]),
        trust_delta=int(deltas["trust"]),
        mood_delta=int(deltas["mood"]) + mood_extra,
        character_id=character_id or bond.character_id,
    )
    bond.relationship_state = state

    cold_after = int(cat.get("soft_cold_after_days") or 4)
    cold_dur = int(cat.get("soft_cold_duration_days") or 3)
    if gap >= cold_after and normalize_cast_kind(bond.cast_kind) == "romance":
        bond = apply_missed_soft_cold(bond, until_day=int(day_index) + cold_dur)
        fl = dict(bond.relationship_state.flags or {})
        fl["neglect_cold"] = True
        bond.relationship_state = bond.relationship_state.model_copy(update={"flags": fl})
    return bond


def apply_end_day_neglect(save: WorldSave) -> WorldSave:
    """日历已翻到新一天后：对「昨日未交谈」的 romance/neutral 扣一次。"""
    ended_day = max(1, save.calendar.day_index - 1)
    for cid, bond in list(save.bonds.items()):
        if int(bond.living.talked_day_index or 0) == ended_day:
            continue
        # 从未聊过：不扣（陌生人无锚定）
        if int(bond.living.talked_day_index or 0) <= 0:
            continue
        save.bonds[cid] = apply_neglect_to_bond(
            bond, day_index=save.calendar.day_index, character_id=cid
        )
    return save


def reset_neglect_anchors_on_waypoint_jump(save: WorldSave) -> WorldSave:
    """航点跳过：中间空日不衰减；从新 day_index 起算。"""
    di = int(save.calendar.day_index or 1)
    for cid, bond in list(save.bonds.items()):
        talked = int(bond.living.talked_day_index or 0)
        if talked > 0 and talked < di:
            bond.living.talked_day_index = di
            save.bonds[cid] = bond
    return save


def pending_relationship_prompt_line(state: RelationshipState) -> str:
    """短注入：pending 阶段/表白（控 token）。"""
    bits: list[str] = []
    pending = (getattr(state, "pending_stage_id", None) or "").strip()
    if pending:
        labels = {
            "crush": "暧昧",
            "dating": "正式交往",
            "married": "更进一步",
        }
        lab = labels.get(pending, pending)
        bits.append(f"关系卡在可升级到「{lab}」，等他明确表态；勿自己宣布已升级。")
    flags = state.flags or {}
    if flags.get("pending_confession"):
        bits.append("你想向他表白，等他回应；勿假装已经在一起。")
    if not bits:
        return ""
    return "\n【关系待确认】" + "".join(bits)
