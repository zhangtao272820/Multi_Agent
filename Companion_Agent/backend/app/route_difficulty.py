"""每角攻略难度：正好感缩放、专属幕门槛偏移、告白抗性。"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from pydantic import BaseModel, Field

from .config import PROJECT_ROOT


class RouteDifficulty(BaseModel):
    affinity_gain_scale: float = 1.0
    story_unlock_bias: int = 0
    confess_resist: int = 0
    gate_strictness: str = "normal"
    difficulty_band: str = "medium"


class RouteDifficultyCatalog(BaseModel):
    version: int = 1
    defaults: RouteDifficulty = Field(default_factory=RouteDifficulty)
    characters: dict[str, RouteDifficulty] = Field(default_factory=dict)


@lru_cache(maxsize=1)
def load_route_difficulty() -> RouteDifficultyCatalog:
    path = PROJECT_ROOT / "data" / "route_difficulty.json"
    if not path.is_file():
        return RouteDifficultyCatalog()
    raw = json.loads(path.read_text(encoding="utf-8"))
    return RouteDifficultyCatalog.model_validate(raw)


def reload_route_difficulty() -> RouteDifficultyCatalog:
    load_route_difficulty.cache_clear()
    return load_route_difficulty()


def get_route_difficulty(character_id: str) -> RouteDifficulty:
    cat = load_route_difficulty()
    cid = (character_id or "").strip()
    if cid and cid in cat.characters:
        return cat.characters[cid]
    return cat.defaults


def scale_positive_affinity(character_id: str, affinity_delta: int) -> int:
    """仅缩放正向好感；负向不削弱惩罚。"""
    delta = int(affinity_delta or 0)
    if delta <= 0:
        return delta
    scale = float(get_route_difficulty(character_id).affinity_gain_scale or 1.0)
    scaled = int(round(delta * scale))
    return max(1, scaled) if delta > 0 and scaled < 1 else scaled


def effective_story_affinity_min(character_id: str, affinity_min: int | None) -> int | None:
    if affinity_min is None:
        return None
    bias = int(get_route_difficulty(character_id).story_unlock_bias or 0)
    return int(affinity_min) + bias


def gate_flags_for_romance(character_id: str) -> list[str]:
    """story_web 中立守门 flag 列表。"""
    from .story_web import load_story_web

    cid = (character_id or "").strip()
    if not cid:
        return []
    out: list[str] = []
    for edge in load_story_web().get("gate_edges") or []:
        if not isinstance(edge, dict):
            continue
        if str(edge.get("romance") or "") == cid:
            flag = str(edge.get("flag") or "").strip()
            if flag:
                out.append(flag)
    return out


def secret_gate_blocks(
    character_id: str,
    *,
    flags: dict[str, Any],
    ending_type: str,
) -> bool:
    """
    gate_strictness：
    - strict：secret 必须齐全部守门 flag
    - none：不额外强加守门
    - normal：不额外强加（仍尊重 ending 自身 conditions）
    返回 True = 应拦截该结局。
    """
    if str(ending_type or "") != "secret":
        return False
    strictness = (get_route_difficulty(character_id).gate_strictness or "normal").strip()
    if strictness != "strict":
        return False
    for flag in gate_flags_for_romance(character_id):
        if not flags.get(flag):
            return True
    return False


def confess_blocked_by_resist(
    character_id: str,
    *,
    affinity: int,
    stage_id: str,
) -> bool:
    """过早告白：resist 越高，越需要更高好感/阶段。"""
    resist = int(get_route_difficulty(character_id).confess_resist or 0)
    if resist <= 0:
        return False
    # 门槛：crush 起约 72+2*resist；未到 crush 一律挡
    if (stage_id or "") in {"stranger", "acquaintance", "friend", "close_friend"}:
        return True
    need = 70 + resist * 3
    return int(affinity or 0) < need
