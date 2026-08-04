"""角色背景分层：厚文案进图鉴，薄 seed/unlock 进对话 prompt（控 token）。"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from pydantic import BaseModel, Field

from .config import PROJECT_ROOT

LINKED_CAST = frozenset({"linked", "neutral"})  # neutral = 旧档兼容别名
ROMANCEABLE_CAST = frozenset({"romance", "linked", "neutral"})


class CharacterLinkMeta(BaseModel):
    """关系向：锚点女主 + 双门 flag。"""

    anchor_id: str = ""
    relation_label: str = ""
    gate_summary: str = ""
    # 本人开放恋爱（齐则过本人门）
    open_flags: list[str] = Field(default_factory=list)
    # 锚点女主同盟/放行（查本人 bond.flags 或世界里锚点 bond / world_flags）
    anchor_gate_flags: list[str] = Field(default_factory=list)


class CharacterLore(BaseModel):
    character_id: str
    codex: str = ""
    prompt_seed: str = ""
    unlocks: dict[str, str] = Field(default_factory=dict)
    link: CharacterLinkMeta | None = None


class CharacterLoreCatalog(BaseModel):
    version: int = 1
    notes: str = ""
    pc: CharacterLore | None = None
    characters: dict[str, CharacterLore] = Field(default_factory=dict)


def _path():
    return PROJECT_ROOT / "data" / "character_lores.json"


@lru_cache(maxsize=1)
def load_character_lores() -> CharacterLoreCatalog:
    path = _path()
    if not path.is_file():
        return CharacterLoreCatalog()
    raw = json.loads(path.read_text(encoding="utf-8"))
    chars: dict[str, CharacterLore] = {}
    for cid, row in (raw.get("characters") or {}).items():
        data = dict(row or {})
        data["character_id"] = cid
        chars[cid] = CharacterLore.model_validate(data)
    pc = None
    if raw.get("pc"):
        pc_data = dict(raw["pc"])
        pc_data.setdefault("character_id", "pc")
        pc = CharacterLore.model_validate(pc_data)
    return CharacterLoreCatalog(
        version=int(raw.get("version") or 1),
        notes=str(raw.get("notes") or ""),
        pc=pc,
        characters=chars,
    )


def reload_character_lores() -> CharacterLoreCatalog:
    load_character_lores.cache_clear()
    return load_character_lores()


def normalize_cast_kind(raw: str | None) -> str:
    k = (raw or "").strip().lower()
    if k == "neutral":
        return "linked"
    if k in {"romance", "linked", "npc"}:
        return k
    return "romance"


def is_linked_cast(cast_kind: str | None) -> bool:
    return normalize_cast_kind(cast_kind) == "linked" or (cast_kind or "").strip().lower() == "neutral"


def is_romanceable_cast(cast_kind: str | None) -> bool:
    return normalize_cast_kind(cast_kind) in {"romance", "linked"}


def get_lore(character_id: str) -> CharacterLore | None:
    cat = load_character_lores()
    cid = (character_id or "").strip()
    if cid == "pc":
        return cat.pc
    return cat.characters.get(cid)


def get_pc_lore() -> CharacterLore | None:
    return load_character_lores().pc


def prompt_background_block(
    character_id: str,
    *,
    flags: dict[str, bool] | None = None,
    fallback: str = "",
) -> str:
    """【背景】薄注入：seed + 至多一条 unlock。"""
    lore = get_lore(character_id)
    seed = ""
    if lore and (lore.prompt_seed or "").strip():
        seed = lore.prompt_seed.strip()
    elif (fallback or "").strip():
        seed = fallback.strip()
    if len(seed) > 100:
        seed = seed[:99] + "…"

    unlock_line = ""
    if lore and lore.unlocks and flags:
        # 按 unlocks 声明顺序取第一条已点亮的
        for key, text in lore.unlocks.items():
            if flags.get(key) and (text or "").strip():
                unlock_line = (text or "").strip()
                if len(unlock_line) > 48:
                    unlock_line = unlock_line[:47] + "…"
                break

    if not seed and not unlock_line:
        return ""
    if unlock_line:
        return f"{seed}\n（近况补丁）{unlock_line}" if seed else unlock_line
    return seed


def _flags_satisfied(need: list[str], *flag_maps: dict[str, bool] | None) -> bool:
    if not need:
        return True
    merged: dict[str, bool] = {}
    for m in flag_maps:
        if m:
            merged.update({k: bool(v) for k, v in m.items()})
    return all(merged.get(f) for f in need)


def linked_self_open(character_id: str, flags: dict[str, bool] | None) -> bool:
    lore = get_lore(character_id)
    if not lore or not lore.link:
        return True
    return _flags_satisfied(list(lore.link.open_flags or []), flags)


def linked_anchor_open(
    character_id: str,
    *,
    self_flags: dict[str, bool] | None = None,
    anchor_flags: dict[str, bool] | None = None,
    world_flags: dict[str, bool] | None = None,
) -> bool:
    lore = get_lore(character_id)
    if not lore or not lore.link:
        return True
    need = list(lore.link.anchor_gate_flags or [])
    if not need:
        return True
    return _flags_satisfied(need, self_flags, anchor_flags, world_flags)


def linked_dating_unlocked(
    character_id: str,
    *,
    self_flags: dict[str, bool] | None = None,
    anchor_flags: dict[str, bool] | None = None,
    world_flags: dict[str, bool] | None = None,
) -> bool:
    """关系向：本人开放 + 锚点门（若有）齐才允许 dating+。"""
    lore = get_lore(character_id)
    if not lore or not lore.link:
        return True
    return linked_self_open(character_id, self_flags) and linked_anchor_open(
        character_id,
        self_flags=self_flags,
        anchor_flags=anchor_flags,
        world_flags=world_flags,
    )


def runtime_max_stage_for_linked(
    character_id: str,
    catalog_max: str,
    *,
    self_flags: dict[str, bool] | None = None,
    anchor_flags: dict[str, bool] | None = None,
    world_flags: dict[str, bool] | None = None,
) -> str:
    """未破双门时硬帽 close_friend。"""
    from .relationship import cap_stage_id, stage_order

    if linked_dating_unlocked(
        character_id,
        self_flags=self_flags,
        anchor_flags=anchor_flags,
        world_flags=world_flags,
    ):
        return catalog_max
    # 未开放：不超过挚友
    order = stage_order()
    return cap_stage_id("close_friend", catalog_max) if catalog_max in order else "close_friend"


def public_lore_for_bond(
    character_id: str,
    *,
    met: bool,
    flags: dict[str, bool] | None = None,
) -> dict[str, Any]:
    lore = get_lore(character_id)
    if not lore:
        return {}
    out: dict[str, Any] = {}
    if lore.link:
        out["link_anchor_id"] = lore.link.anchor_id
        out["link_relation_label"] = lore.link.relation_label
        # 关卡摘要：见过面才给，避免选角剧透过深
        if met:
            out["link_gate_summary"] = lore.link.gate_summary
            open_ok = linked_self_open(character_id, flags)
            # 锚点门是否齐：仅用本人 flags（多数同盟 flag 写在本人线）
            anchor_ok = linked_anchor_open(character_id, self_flags=flags)
            out["link_self_open"] = open_ok
            out["link_anchor_open"] = anchor_ok
            out["link_dating_ready"] = open_ok and anchor_ok
    if met and (lore.codex or "").strip():
        out["lore_codex"] = lore.codex.strip()
    return out
