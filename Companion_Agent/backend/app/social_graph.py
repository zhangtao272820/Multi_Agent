"""社交关系图 SSOT 加载。"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .config import PROJECT_ROOT


class PreferencesDef(BaseModel):
    likes: list[str] = Field(default_factory=list)
    dislikes: list[str] = Field(default_factory=list)
    habits: list[str] = Field(default_factory=list)


class CharacterSocialDef(BaseModel):
    base_id: str
    cast_kind: str = "romance"
    role_to_pc: str = "陌生人"
    role_hint: str = ""
    occupation: str = ""
    home_locations: list[str] = Field(default_factory=list)
    schedule: dict[str, list[str]] = Field(default_factory=dict)
    schedule_workday: dict[str, list[str]] = Field(default_factory=dict)
    schedule_rest: dict[str, list[str]] = Field(default_factory=dict)
    preferences: PreferencesDef = Field(default_factory=PreferencesDef)
    contact_style: str = ""
    boundary: str = ""


class SocialEdge(BaseModel):
    a: str
    b: str
    relation: str
    kind: str = "acquaintance"  # friend|colleague|rival|ex_circle|neighbor|mentor|acquaintance
    secret: bool = False
    flag: str = ""


_KIND_TONE = {
    "rival": "提起她时语气可能微妙",
    "ex_circle": "涉及前任圈子时宜小心措辞",
    "colleague": "公事往来的熟识感",
    "mentor": "带一点指导或追随的气息",
    "neighbor": "邻里日常的松弛感",
    "friend": "朋友间的熟络",
    "acquaintance": "点头之交的分寸",
    "town": "镇上熟人路过时的闲话分寸",
    "gate": "守门人旁观时的警惕",
    "best_friend": "死党式护短",
    "family": "家人间的熟络与界线",
}


class LocationDef(BaseModel):
    id: str
    label: str
    scene_id: str = ""
    travel_cost: int = 1
    npc_ids: list[str] = Field(default_factory=list)


class SocialGraph(BaseModel):
    version: int = 1
    locations: list[LocationDef] = Field(default_factory=list)
    characters: dict[str, CharacterSocialDef] = Field(default_factory=dict)
    edges: list[SocialEdge] = Field(default_factory=list)


def _path() -> Path:
    return PROJECT_ROOT / "data" / "social_graph.json"


@lru_cache(maxsize=1)
def load_social_graph() -> SocialGraph:
    path = _path()
    if not path.is_file():
        return SocialGraph()
    raw = json.loads(path.read_text(encoding="utf-8"))
    chars_raw = raw.get("characters") or {}
    characters = {
        cid: CharacterSocialDef.model_validate(row) for cid, row in chars_raw.items()
    }
    return SocialGraph(
        version=int(raw.get("version") or 1),
        locations=[LocationDef.model_validate(x) for x in (raw.get("locations") or [])],
        characters=characters,
        edges=[SocialEdge.model_validate(x) for x in (raw.get("edges") or [])],
    )


def reload_social_graph() -> SocialGraph:
    load_social_graph.cache_clear()
    try:
        from .sprite_catalog import reload_sprite_paths

        reload_sprite_paths()
    except Exception:
        pass
    return load_social_graph()


def location_index() -> dict[str, LocationDef]:
    return {loc.id: loc for loc in load_social_graph().locations}


def public_locations() -> list[dict[str, Any]]:
    return [loc.model_dump() for loc in load_social_graph().locations]


def edges_for_character(character_id: str) -> list[SocialEdge]:
    out: list[SocialEdge] = []
    for e in load_social_graph().edges:
        if e.a == character_id or e.b == character_id:
            out.append(e)
    return out


def visible_edges(
    character_id: str,
    *,
    insight: dict[str, bool],
    name_lookup: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    names = name_lookup or {}
    visible: list[dict[str, Any]] = []
    for e in edges_for_character(character_id):
        key = e.flag or f"edge:{e.a}:{e.b}"
        if e.secret and not insight.get(key):
            continue
        other = e.b if e.a == character_id else e.a
        kind = (e.kind or "acquaintance").strip() or "acquaintance"
        visible.append(
            {
                "other_id": other,
                "other_name": names.get(other) or other,
                "relation": e.relation,
                "kind": kind,
                "tone": _KIND_TONE.get(kind) or _KIND_TONE["acquaintance"],
                "secret": e.secret,
                "flag": key,
            }
        )
    return visible


def edge_prompt_bits(
    character_id: str,
    *,
    insight: dict[str, bool],
    name_lookup: dict[str, str],
    limit: int = 4,
) -> list[str]:
    """组装带姓名与气氛提示的圈子关系短句。"""
    names = dict(name_lookup or {})
    try:
        from .town_npcs import npc_by_id

        for nid, row in npc_by_id().items():
            names.setdefault(nid, str(row.get("name") or nid))
    except Exception:
        pass
    bits: list[str] = []
    for e in visible_edges(character_id, insight=insight, name_lookup=names)[:limit]:
        oid = e.get("other_id") or ""
        name = e.get("other_name") or names.get(oid) or oid or "?"
        rel = e.get("relation") or ""
        tone = e.get("tone") or ""
        piece = f"{name}（{rel}"
        if tone and e.get("kind") in {"rival", "ex_circle", "colleague", "mentor", "town"}:
            piece += f"；{tone}"
        piece += "）"
        bits.append(piece)
    return bits
