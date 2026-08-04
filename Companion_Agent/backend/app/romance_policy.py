"""P6：女主恋爱思想参数 + 开放后宫下的关系决策裁定。

系统管 flag / 世界伴侣表；模型只管在边界内演戏。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .config import PROJECT_ROOT
from .relationship import RelationshipState
from .world_store import BondShelf, WorldRumor, WorldSave


class RomancePolicy(BaseModel):
    """每角恋爱立场（SSOT）。"""

    pursuit: str = "reciprocal"  # passive | reciprocal | pursues
    exclusivity: str = "tolerates_harem"  # exclusive | tolerates_harem | poly_ok
    rivalry: str = "confront"  # withdraw | confront | interfere
    jealousy: int = Field(50, ge=0, le=100)
    confess_init: bool = False


_DEFAULT = RomancePolicy()

# 世界默认：开放后宫（可同时多线 dating；各角自行决定接不接受）
WORLD_ROMANCE_MODE = "open_harem"

_PARTNER_STAGES = frozenset({"dating", "married"})


class RomancePolicyCatalog(BaseModel):
    version: int = 1
    default: RomancePolicy = Field(default_factory=RomancePolicy)
    characters: dict[str, RomancePolicy] = Field(default_factory=dict)


def _path() -> Path:
    return PROJECT_ROOT / "data" / "romance_policy.json"


@lru_cache(maxsize=1)
def load_romance_policies() -> RomancePolicyCatalog:
    path = _path()
    if not path.is_file():
        return RomancePolicyCatalog()
    raw = json.loads(path.read_text(encoding="utf-8"))
    return RomancePolicyCatalog.model_validate(raw)


def reload_romance_policies() -> RomancePolicyCatalog:
    load_romance_policies.cache_clear()
    return load_romance_policies()


def get_romance_policy(character_id: str) -> RomancePolicy:
    cat = load_romance_policies()
    return cat.characters.get(character_id) or cat.default or _DEFAULT


def policy_prompt_line(policy: RomancePolicy) -> str:
    """进主对话 prompt 的 1 句口吻，不念字段名。"""
    pursuit = {
        "passive": "你偏被动，对方不主动你很少先捅破窗户纸。",
        "reciprocal": "你愿来往回应，但不会无缘无故硬上。",
        "pursues": "你心动时会主动靠近、试探，甚至倒追。",
    }.get(policy.pursuit, "你愿来往回应。")
    excl = {
        "exclusive": "你心里只要一对一；后宫/同时多人你会难受或拒绝。",
        "tolerates_harem": "你更想专一，但若他坦白且真心，你或许能咬牙容忍后宫。",
        "poly_ok": "你不排斥多人亲密，只要尊重与坦诚。",
    }.get(policy.exclusivity, "你更想专一。")
    rival = {
        "withdraw": "若他和别人走得近，你会退一步留体面，少打扰。",
        "confront": "若他和别人走得近，你会想问清楚，可能吃醋摊牌。",
        "interfere": "若他和别人走得近，你可能插手试探，不愿轻易放手。",
    }.get(policy.rivalry, "你会想问清楚。")
    return f"\n【恋爱立场】{pursuit}{excl}{rival}用口语体现，禁止念「政策/后宫flag」。"


def is_romantic_partner(bond: BondShelf) -> bool:
    st = bond.relationship_state
    if st.stage_id in _PARTNER_STAGES:
        return True
    flags = st.flags or {}
    return bool(flags.get("partner_confirmed"))


def list_partners(save: WorldSave, *, exclude_id: str = "") -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for cid, bond in save.bonds.items():
        if exclude_id and cid == exclude_id:
            continue
        if bond.cast_kind not in {"romance", "linked", "neutral"}:
            continue
        if is_romantic_partner(bond) or save.world_flags.get(f"partner:{cid}"):
            out.append((cid, bond.profile.name or cid))
    return out


def partner_count(save: WorldSave) -> int:
    return len(list_partners(save))


def sync_world_romance_flags(save: WorldSave) -> None:
    """根据各 bond 阶段刷新世界伴侣/后宫就绪旗（开放后宫）。"""
    save.world_flags["romance_mode_open_harem"] = True
    partners: list[str] = []
    for cid, bond in save.bonds.items():
        if bond.cast_kind not in {"romance", "linked", "neutral"}:
            continue
        key = f"partner:{cid}"
        if is_romantic_partner(bond):
            save.world_flags[key] = True
            partners.append(cid)
        elif (bond.relationship_state.flags or {}).get("broke_up"):
            save.world_flags[key] = False
    n = len(partners)
    save.world_flags["world_multi_partner"] = n >= 2
    ready = 0
    for cid in partners:
        flags = save.bonds[cid].relationship_state.flags or {}
        pol = get_romance_policy(cid)
        if flags.get("harem_accepted"):
            ready += 1
        elif pol.exclusivity == "poly_ok" and flags.get("confessed"):
            ready += 1
    save.world_flags["world_harem_ready"] = n >= 2 and ready >= 2


@dataclass
class RomanceApplyResult:
    affinity_delta: int = 0
    trust_delta: int = 0
    mood_delta: int = 0
    new_flags: dict[str, bool] = field(default_factory=dict)
    note: str = ""


def apply_relation_move(
    save: WorldSave | None,
    *,
    character_id: str,
    move: str,
    state: RelationshipState,
    policy: RomancePolicy | None = None,
) -> RomanceApplyResult:
    """
    将 Judge 的 relation_move 裁定为 flag / 数值修正。
    开放后宫：允许多 partner；专一诉求由角色 exclusivity 决定反应。
    """
    move = (move or "none").strip().lower()
    if move in {"", "none"}:
        return RomanceApplyResult()

    pol = policy or get_romance_policy(character_id)
    result = RomanceApplyResult()
    others = list_partners(save, exclude_id=character_id) if save else []

    if move == "flirt":
        result.affinity_delta += 1
        result.mood_delta += 1
        result.note = "flirt"
        return result

    if move == "confess":
        from .route_difficulty import confess_blocked_by_resist
        from .character_lores import is_linked_cast, linked_dating_unlocked

        if character_id and is_linked_cast(
            (save.bonds.get(character_id).cast_kind if save and character_id in save.bonds else "")
            or ""
        ):
            bond = save.bonds.get(character_id) if save else None
            self_flags = dict((bond.relationship_state.flags if bond else state.flags) or {})
            if not linked_dating_unlocked(character_id, self_flags=self_flags):
                result.new_flags["confess_blocked_gate"] = True
                result.affinity_delta -= 1
                result.trust_delta -= 2
                result.mood_delta -= 3
                result.note = "linked_gate_block"
                return result

        if confess_blocked_by_resist(
            character_id,
            affinity=int(state.affinity or 0),
            stage_id=str(state.stage_id or ""),
        ):
            result.new_flags["confess_too_soon"] = True
            result.affinity_delta -= 2
            result.trust_delta -= 3
            result.mood_delta -= 2
            result.note = "confess_resist"
            return result
        result.new_flags["confessed"] = True
        result.affinity_delta += 3
        result.trust_delta += 2
        result.mood_delta += 2
        # 告白成功且阶段已到 crush+ → 可记伴侣确认（dating 仍靠养成涨）
        if state.stage_id in _PARTNER_STAGES or state.affinity >= 88:
            result.new_flags["partner_confirmed"] = True
        result.note = "confess"
        return result

    if move == "ask_exclusive":
        result.new_flags["exclusive_offer"] = True
        if pol.exclusivity == "exclusive":
            result.new_flags["exclusive_accepted"] = True
            result.affinity_delta += 4
            result.trust_delta += 3
            result.mood_delta += 3
            result.note = "exclusive_ok"
        elif pol.exclusivity == "tolerates_harem":
            # 她更想专一，听到「只要你」会开心
            result.new_flags["exclusive_accepted"] = True
            result.affinity_delta += 3
            result.mood_delta += 2
            result.note = "exclusive_prefer"
        else:  # poly_ok
            result.new_flags["exclusive_soft_reject"] = True
            result.mood_delta -= 1
            result.affinity_delta -= 1
            result.note = "exclusive_soft_no"
        return result

    if move == "propose_harem":
        result.new_flags["harem_proposed"] = True
        if pol.exclusivity == "exclusive":
            result.new_flags["harem_rejected"] = True
            result.affinity_delta -= 6
            result.trust_delta -= 4
            result.mood_delta -= 8
            result.note = "harem_hard_no"
        elif pol.exclusivity == "tolerates_harem":
            # 勉强可谈，需信任够
            if state.trust >= 65 and state.affinity >= 70:
                result.new_flags["harem_accepted"] = True
                result.mood_delta -= 2
                result.trust_delta += 1
                result.note = "harem_tolerate"
            else:
                result.new_flags["harem_rejected"] = True
                result.affinity_delta -= 3
                result.mood_delta -= 5
                result.note = "harem_not_yet"
        else:  # poly_ok
            result.new_flags["harem_accepted"] = True
            result.affinity_delta += 2
            result.mood_delta += 1
            result.note = "harem_ok"
        return result

    if move == "mention_other":
        result.new_flags["mentioned_other"] = True
        j = pol.jealousy
        if others or j >= 40:
            if pol.rivalry == "withdraw":
                result.mood_delta -= 2
                result.affinity_delta -= 1
            elif pol.rivalry == "interfere":
                result.mood_delta -= 4
                result.affinity_delta -= 2
                result.new_flags["jealousy_flare"] = True
            else:
                result.mood_delta -= 3
                result.new_flags["jealousy_flare"] = True
        result.note = "mention_other"
        return result

    if move == "breakup":
        result.new_flags["broke_up"] = True
        result.new_flags["partner_confirmed"] = False
        result.affinity_delta -= 12
        result.trust_delta -= 8
        result.mood_delta -= 15
        result.note = "breakup"
        return result

    return result


def hang_pursuit_confession_if_needed(
    *,
    character_id: str,
    state: RelationshipState,
    agenda_source: str,
) -> RelationshipState:
    """pursuit 议程：系统直接挂 pending_confession（不靠 Judge 必出）。"""
    if (agenda_source or "").strip() != "pursuit":
        return state
    flags = state.flags or {}
    if flags.get("pending_confession") or flags.get("confessed"):
        return state
    hi = apply_heroine_initiative(
        character_id=character_id,
        initiative="confess",
        state=state,
    )
    if not hi.new_flags.get("pending_confession"):
        return state
    new_flags = dict(flags)
    new_flags.update(hi.new_flags)
    return state.model_copy(
        update={
            "flags": new_flags,
            "mood": max(-100, min(100, int(state.mood or 0) + int(hi.mood_delta or 0))),
            "affinity": max(
                0, min(100, int(state.affinity or 0) + int(hi.affinity_delta or 0))
            ),
            "trust": max(0, min(100, int(state.trust or 0) + int(hi.trust_delta or 0))),
        }
    )


def apply_heroine_initiative(
    *,
    character_id: str,
    initiative: str,
    state: RelationshipState,
    policy: RomancePolicy | None = None,
) -> RomanceApplyResult:
    """女主主动意向 → flag（表白挂起等）；不代替玩家应承。"""
    move = (initiative or "none").strip().lower()
    if move in {"", "none"}:
        return RomanceApplyResult()
    pol = policy or get_romance_policy(character_id)
    result = RomanceApplyResult()
    flags = state.flags or {}

    if move == "confess":
        if not pol.confess_init:
            return result
        if flags.get("confessed") or flags.get("pending_confession"):
            return result
        if flags.get("confess_rejected_once") and state.mood < 0:
            return result
        from .route_difficulty import confess_blocked_by_resist

        if confess_blocked_by_resist(
            character_id,
            affinity=int(state.affinity or 0),
            stage_id=str(state.stage_id or ""),
        ):
            # 未到暧昧：若已有 pending crush 仍可轻表白挂起
            pending = (getattr(state, "pending_stage_id", None) or "").strip()
            if pending not in {"crush", "dating", "married"} and int(state.affinity or 0) < 70:
                return result
        result.new_flags["pending_confession"] = True
        result.mood_delta += 1
        result.note = "heroine_confess_offer"
        return result

    if move == "ask_exclusive":
        if pol.exclusivity == "poly_ok":
            return result
        result.new_flags["exclusive_offer"] = True
        result.note = "heroine_ask_exclusive"
        return result

    if move == "cool_off":
        result.mood_delta -= 2
        result.affinity_delta -= 1
        result.note = "heroine_cool_off"
        return result

    return result


def apply_stage_offer(
    *,
    offer: str,
    state: RelationshipState,
) -> str:
    """Judge stage_offer → 可写入的 pending_stage_id（空串=不改）。"""
    offer = (offer or "none").strip().lower()
    if offer in {"", "none"}:
        return ""
    if offer not in {"crush", "dating", "married"}:
        return ""
    if (getattr(state, "pending_stage_id", None) or "").strip():
        return ""
    from .relationship import romance_auto_cap_id, stage_for_affinity, stage_order

    order = stage_order()

    def _rank(sid: str) -> int:
        return order.index(sid) if sid in order else -1

    natural = stage_for_affinity(state.affinity)
    if _rank(natural.id) < _rank(offer):
        return ""
    auto = romance_auto_cap_id(state.flags or {})
    if _rank(offer) <= _rank(auto):
        return ""
    return offer


def rivalry_agenda_for(
    save: WorldSave,
    *,
    character_id: str,
    bond: BondShelf,
) -> tuple[str, str] | None:
    """若存在其他伴侣，返回 (goal, hook)；无则 None。"""
    others = list_partners(save, exclude_id=character_id)
    if not others:
        return None
    pol = get_romance_policy(character_id)
    from .character_lores import is_romanceable_cast

    if not is_romanceable_cast(bond.cast_kind):
        return None
    who = "、".join(n for _, n in others[:2])
    if pol.rivalry == "withdraw":
        return (
            f"心里知道他和{who}走得近，想保持体面、少打扰，但仍在意",
            f"听说他和{who}挺近",
        )
    if pol.rivalry == "interfere":
        return (
            f"不想轻易放手：旁敲侧击他和{who}的关系，试探自己还有没有位置",
            f"他好像和{who}很亲近",
        )
    # confront
    return (
        f"想问清楚他和{who}到底怎样，吃醋可以，但别无理取闹",
        f"他和{who}走得很近",
    )


def maybe_append_rivalry_rumor(
    save: WorldSave,
    *,
    about_id: str,
    source_id: str,
) -> None:
    """男主与某人确认伴侣后，给世界加一句软传闻（供其他角 cross_impression）。"""
    bond = save.bonds.get(about_id)
    if not bond:
        return
    name = bond.profile.name or about_id
    text = f"好像和{name}走得很近"
    # 避免重复刷屏
    for r in save.rumors[-4:]:
        if r.about_id == about_id and "走得很近" in (r.text or ""):
            return
    save.rumors.append(
        WorldRumor(
            day=save.calendar.day_index,
            about_id=about_id,
            text=text,
            source_id=source_id or "town",
        )
    )
    save.rumors = save.rumors[-8:]


def maybe_append_decision_echo(
    save: WorldSave,
    *,
    about_id: str,
    new_flags: dict[str, Any],
) -> None:
    """专一/后宫拍板 → 镇上闲话（不泄 flag 名）。"""
    candidates: list[tuple[str, str]] = []
    if new_flags.get("exclusive_accepted"):
        candidates.append(("认真起来了", "听说他认真起来了，身边清净了不少"))
    if new_flags.get("harem_accepted"):
        candidates.append(("不止一个人", "有人说他身边不止一个人……"))
    if new_flags.get("harem_rejected"):
        candidates.append(("不愿意分享", "好像有人不愿意分享"))
    if not candidates:
        return
    for needle, text in candidates:
        if any(needle in (r.text or "") for r in save.rumors[-6:]):
            continue
        save.rumors.append(
            WorldRumor(
                day=save.calendar.day_index,
                about_id=about_id,
                text=text,
                source_id="town",
            )
        )
    save.rumors = save.rumors[-8:]


def public_romance_snapshot(save: WorldSave, character_id: str = "") -> dict[str, Any]:
    pol = get_romance_policy(character_id) if character_id else None
    partners = [{"id": cid, "name": name} for cid, name in list_partners(save)]
    return {
        "mode": WORLD_ROMANCE_MODE,
        "partners": partners,
        "multi_partner": bool(save.world_flags.get("world_multi_partner")),
        "harem_ready": bool(save.world_flags.get("world_harem_ready")),
        "policy": pol.model_dump() if pol else None,
    }
