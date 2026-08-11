"""有名镇民 SSOT：只读事实注入，不可攻略。"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import PROJECT_ROOT

NPC_FACTS_BUDGET = 120


@lru_cache(maxsize=1)
def load_town_npcs() -> dict[str, Any]:
    path = PROJECT_ROOT / "data" / "town_npcs.json"
    if not path.is_file():
        return {"version": 1, "npcs": []}
    return json.loads(path.read_text(encoding="utf-8"))


def reload_town_npcs() -> dict[str, Any]:
    load_town_npcs.cache_clear()
    return load_town_npcs()


def npc_by_id() -> dict[str, dict[str, Any]]:
    return {n["id"]: n for n in (load_town_npcs().get("npcs") or []) if n.get("id")}


def npc_ids_for_location(location_id: str) -> list[str]:
    lid = (location_id or "").strip()
    out: list[str] = []
    for n in load_town_npcs().get("npcs") or []:
        if (n.get("location") or "") == lid:
            out.append(str(n["id"]))
    return out


def met_npc_ids(flags: dict[str, Any] | None, location_id: str = "") -> list[str]:
    """已见面或本场地点默认认识的镇民 id（控量）。"""
    flags = flags or {}
    met: list[str] = []
    for nid, row in npc_by_id().items():
        flag = f"met_npc:{nid}"
        if flags.get(flag) or flags.get(f"introduced:{nid}"):
            met.append(nid)
            continue
        # 与女主有 ties 且同场地点：视为可点名熟人（仍禁止编造秘密）
        if location_id and (row.get("location") or "") == location_id:
            met.append(nid)
    return met[:4]


def build_npc_facts_block(
    *,
    character_id: str,
    location_id: str,
    flags: dict[str, Any] | None = None,
    budget: int = NPC_FACTS_BUDGET,
) -> str:
    """组装【镇上熟人｜只读】，总长 ≤budget。"""
    cid = (character_id or "").strip()
    index = npc_by_id()
    lines: list[str] = []
    for nid in met_npc_ids(flags, location_id):
        row = index.get(nid) or {}
        name = (row.get("name") or nid).strip()
        one = (row.get("one_line") or "").strip()
        ties = row.get("ties_to") or []
        if cid and cid not in ties and (row.get("location") or "") != (location_id or ""):
            continue
        bit = f"{name}：{one}" if one else name
        if len(bit) > 40:
            bit = bit[:40]
        lines.append(bit)
    if not lines:
        return ""
    body = "；".join(lines)
    prefix = "\n【镇上熟人｜只读】"
    text = prefix + body + "。可点名闲话，禁止编造未写明的秘密或把对方当恋爱对象。"
    if len(text) > budget:
        # keep prefix + truncated body
        keep = budget - len(prefix) - 8
        body = body[: max(0, keep)] + "…"
        text = prefix + body + "。"
    return text
