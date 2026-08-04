"""角色养成路线：start / target / max_stage 封顶。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .config import PROJECT_ROOT


class CharacterRoute(BaseModel):
    character_id: str
    base_id: str = ""
    growth_mode: str = Field("fixed", pattern="^(fixed|progressive)$")
    start_stage_id: str = "dating"
    target_stage_id: str = "dating"
    max_stage_id: str = "dating"
    allowed_endings: list[str] = Field(default_factory=list)
    route_label: str = ""
    cast_role: str = Field("romance", pattern="^(romance|linked|neutral|npc)$")
    story_tier: str = ""


def _normalize_route_cast(role: str) -> str:
    from .character_lores import normalize_cast_kind

    return normalize_cast_kind(role)


def _catalog_path() -> Path:
    return PROJECT_ROOT / "data" / "route_catalog.json"


def _archetype_caps_path() -> Path:
    return PROJECT_ROOT / "data" / "archetype_caps.json"


def load_route_catalog() -> dict[str, Any]:
    path = _catalog_path()
    if not path.is_file():
        return {"routes": []}
    return json.loads(path.read_text(encoding="utf-8"))


def load_archetype_caps() -> dict[str, str]:
    path = _archetype_caps_path()
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return dict(data.get("caps") or {})


def list_routes() -> list[CharacterRoute]:
    raw = load_route_catalog().get("routes") or []
    return [CharacterRoute.model_validate(row) for row in raw]


def route_index() -> dict[str, CharacterRoute]:
    return {r.character_id: r for r in list_routes()}


def get_route(character_id: str) -> CharacterRoute | None:
    cid = (character_id or "").strip()
    if not cid:
        return None
    return route_index().get(cid)


def effective_max_stage_id(character_id: str, base_id: str = "") -> str:
    route = get_route(character_id)
    if route:
        return route.max_stage_id
    caps = load_archetype_caps()
    if base_id and base_id in caps:
        return caps[base_id]
    return "dating"


def effective_target_stage_id(character_id: str, fallback: str = "dating") -> str:
    route = get_route(character_id)
    if route:
        return route.target_stage_id
    return fallback


def load_story_route(character_id: str) -> dict[str, Any] | None:
    path = PROJECT_ROOT / "data" / "story_routes.json"
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    chars = data.get("characters") or {}
    row = chars.get(character_id)
    return row if isinstance(row, dict) else None


def route_prompt_block(character_id: str) -> str:
    route = get_route(character_id)
    if not route:
        return ""
    max_stage = route.max_stage_id
    from .relationship import stage_index

    stages = stage_index()
    max_label = stages.get(max_stage).label if max_stage in stages else max_stage
    lines = [f"【关系上限】长期相处最高到「{max_label}」。"]
    story = load_story_route(character_id)
    if story:
        title = str(story.get("route_title") or route.route_label or "").strip()
        theme = str(story.get("theme") or "").strip()
        logline = str(story.get("logline") or "").strip()
        tier = str(story.get("tier") or route.story_tier or "").strip()
        if title:
            lines.append(f"【专属路线{f' · {tier}' if tier else ''}】{title}")
        if theme:
            lines.append(f"主题：{theme}")
        if logline:
            lines.append(logline)
        acts = story.get("acts") or []
        if acts:
            # 只塞当前可感知的幕名，控制 token
            titles = " → ".join(str(a.get("title") or "") for a in acts[:4] if a.get("title"))
            if titles:
                lines.append(f"故事节拍：{titles}")
        lines.append("推进时贴合上述路线气质；不要剧透未发生的结局名。")
        if str(story.get("cast_kind") or "") in {"linked", "neutral"} or tier in {"N", "L"}:
            lines.append(
                "你是关系向难攻略角色：未过系统闸门前不开放恋人阶段；"
                "可有情愫与试探，破门后才可谨慎恋爱，禁止剧透结局名。"
            )
    from .character_lores import is_linked_cast, linked_dating_unlocked

    if route.cast_role == "npc" or max_stage in {"friend", "acquaintance"}:
        if route.cast_role == "npc":
            lines.append("你是周边配角：推动线索与传闻即可，不必发展恋爱。")
        else:
            lines.append("这条线亲昵止于家人或挚友。")
    elif is_linked_cast(route.cast_role):
        # 路由文案层不读运行时 flag；只给总原则
        lines.append(
            "关系向：须经锚点认识并过双门后才可恋爱；未破门时拒绝正式恋人称呼。"
        )
    elif max_stage == "close_friend" and not is_linked_cast(route.cast_role):
        lines.append("这条线不会发展到恋人/结婚；亲昵止于家人或挚友。")
    elif max_stage == "married":
        lines.append("可以慢慢走到恋爱，日后也不禁止结婚叙述（需系统阶段到达后才自然切换）。")
    return "\n".join(lines)


def public_routes() -> list[dict[str, Any]]:
    return [r.model_dump() for r in list_routes()]
