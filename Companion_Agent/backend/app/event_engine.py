"""GAL 事件：YAML 加载、触发判定、奖励与选项效果。"""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

from .config import PROJECT_ROOT
from .relationship import RelationshipState, stage_order


class EventTrigger(BaseModel):
    stage_id: str = ""
    stage_min: str = ""
    stage_max: str = ""
    affinity_min: int | None = None
    affinity_max: int | None = None
    trust_min: int | None = None
    trust_max: int | None = None
    growth_mode: str = ""
    flags_present: list[str] = Field(default_factory=list)
    flags_absent: list[str] = Field(default_factory=list)
    character_ids: list[str] = Field(default_factory=list)
    base_ids: list[str] = Field(default_factory=list)
    # 社会式日历门：须已到达该航点（顺序）；可选季节/节日精确匹配
    waypoint_min: str = ""
    season: str = ""
    festival: str = ""


class ChoiceEffect(BaseModel):
    trust_delta: int = 0
    affinity_delta: int = 0
    mood_delta: int = 0
    label: str = ""
    flags: dict[str, bool] = Field(default_factory=dict)


class StoryBeatPage(BaseModel):
    """拍前 VN 翻页（玩家叙事层；0 Token 给女主）。"""

    text: str = ""
    voice: str = "narration"  # narration | pc | heroine
    sprite: dict[str, str] = Field(default_factory=dict)
    bg: str = ""


class StoryBeat(BaseModel):
    """专属故事幕单拍。

    - pages：拍前 VN 翻页（优先）
    - narration / pc_thought：玩家 UI 叙事层；无 pages 时合成 1–2 页
    - brief：进女主 prompt（≤80）；空则回退 summary
    - summary：兼容旧幕；新稿与 brief 对齐
    """

    id: str = ""
    summary: str = ""
    narration: str = ""
    pc_thought: str = ""
    brief: str = ""
    pages: list[StoryBeatPage] = Field(default_factory=list)
    sprite_hint: list[str] = Field(default_factory=list)
    soft_options: list[str] = Field(default_factory=list)


class GameEvent(BaseModel):
    id: str
    label: str = ""
    priority: int = 0
    once: bool = True
    """1.0=必触发；<1 为加权随机（条件满足后仍可能错过，下次再 roll）。"""
    chance: float = Field(1.0, ge=0.0, le=1.0)
    scene_id: str = ""
    trigger: EventTrigger = Field(default_factory=EventTrigger)
    prompt_snippet: str = ""
    """结构化节拍；有则运行时只注入当前拍。无则回退 prompt_snippet。"""
    beats: list[StoryBeat] = Field(default_factory=list)
    """on_player_turn=每玩家一轮推进一拍；on_choice=点选项才推进。"""
    advance: str = "on_player_turn"
    rewards: dict[str, Any] = Field(default_factory=dict)
    choice_effects: list[ChoiceEffect] = Field(default_factory=list)


def _events_dir() -> Path:
    return PROJECT_ROOT / "data" / "events"


def _stage_rank(stage_id: str) -> int:
    order = stage_order()
    if stage_id not in order:
        return -1
    return order.index(stage_id)


def load_events() -> list[GameEvent]:
    directory = _events_dir()
    if not directory.is_dir():
        return []
    events: list[GameEvent] = []
    for path in sorted(directory.glob("*.yaml")):
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            events.append(GameEvent.model_validate(raw))
    events.sort(key=lambda e: (-e.priority, e.id))
    return events


def load_gal_flags() -> dict[str, str]:
    path = PROJECT_ROOT / "data" / "gal_flags.json"
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return dict(data.get("flags") or {})


def _event_done_flag(event_id: str) -> str:
    return f"event_done_{event_id}"


def _matches_trigger(
    event: GameEvent,
    *,
    state: RelationshipState,
    character_id: str,
    base_id: str = "",
    day_index: int | None = None,
    waypoint_id: str = "",
    waypoints_reached: list[str] | None = None,
) -> bool:
    t = event.trigger
    flags = state.flags or {}

    if event.once and flags.get(_event_done_flag(event.id)):
        return False

    if t.character_ids and character_id not in t.character_ids:
        return False
    if t.base_ids and base_id and base_id not in t.base_ids:
        return False
    if t.growth_mode and state.growth_mode != t.growth_mode:
        return False

    if t.stage_id and state.stage_id != t.stage_id:
        return False
    if t.stage_min and _stage_rank(state.stage_id) < _stage_rank(t.stage_min):
        return False
    if t.stage_max and _stage_rank(state.stage_id) > _stage_rank(t.stage_max):
        return False

    from .route_difficulty import effective_story_affinity_min

    aff_min = effective_story_affinity_min(character_id, t.affinity_min)
    if aff_min is not None and state.affinity < aff_min:
        return False
    if t.affinity_max is not None and state.affinity > t.affinity_max:
        return False
    if t.trust_min is not None and state.trust < t.trust_min:
        return False
    if t.trust_max is not None and state.trust > t.trust_max:
        return False

    for flag in t.flags_present:
        if not flags.get(flag):
            return False
    for flag in t.flags_absent:
        if flags.get(flag):
            return False

    # 日历/航点门
    info: dict[str, Any] = {}
    if day_index is not None:
        try:
            from .china_calendar import day_info

            info = day_info(day_index)
        except Exception:
            info = {}
    if t.season:
        if str(info.get("season") or "").lower() != str(t.season).lower():
            return False
    if t.festival:
        fest = str(info.get("festival") or "")
        need = str(t.festival).strip()
        if need and need not in fest and fest != need:
            return False
    if t.waypoint_min:
        from .season_waypoints import has_reached_ids

        if not has_reached_ids(
            waypoint_id=waypoint_id or "q_summer_start",
            waypoints_reached=list(waypoints_reached or []),
            target_id=t.waypoint_min,
        ):
            return False

    return True


def pick_active_event(
    *,
    state: RelationshipState,
    character_id: str,
    base_id: str = "",
    day_index: int | None = None,
    waypoint_id: str = "",
    waypoints_reached: list[str] | None = None,
) -> GameEvent | None:
    festival = ""
    if day_index is not None:
        try:
            from .china_calendar import day_info

            festival = str(day_info(day_index).get("festival") or "")
        except Exception:
            festival = ""

    matched: list[GameEvent] = []
    for event in load_events():
        if not _matches_trigger(
            event,
            state=state,
            character_id=character_id,
            base_id=base_id,
            day_index=day_index,
            waypoint_id=waypoint_id,
            waypoints_reached=waypoints_reached,
        ):
            continue
        matched.append(event)

    # 主线幕优先于旁支软事件（KS/Ren'Py：Act 门优先）
    matched.sort(
        key=lambda e: (
            0 if (e.id or "").lower().startswith("story_") else 1,
            -int(e.priority or 0),
            e.id or "",
        )
    )

    for event in matched:
        chance = float(event.chance if event.chance is not None else 1.0)
        eid = (event.id or "").lower()
        if eid.startswith("story_"):
            chance = 1.0
        else:
            label = (event.label or "") + (event.prompt_snippet or "")
            if festival and (
                "festival" in eid
                or "节日" in label
                or "七夕" in label
                or "圣诞" in label
                or "生日" in label
            ):
                chance = min(1.0, chance * 1.8 + 0.15)
            pity_key = f"event_pity:{event.id}"
            if (state.flags or {}).get(pity_key):
                chance = 1.0
        if chance < 1.0 and random.random() > chance:
            flags = dict(state.flags or {})
            flags[f"event_pity:{event.id}"] = True
            state.flags = flags
            continue
        if not eid.startswith("story_"):
            flags = dict(state.flags or {})
            pity_key = f"event_pity:{event.id}"
            if pity_key in flags:
                flags.pop(pity_key, None)
                state.flags = flags
        return event
    return None


def apply_event_rewards(state: RelationshipState, event: GameEvent) -> RelationshipState:
    rewards = event.rewards or {}
    flags = dict(state.flags or {})
    for flag in rewards.get("flags_set") or []:
        flags[str(flag)] = True
    for flag in rewards.get("flags_clear") or []:
        flags.pop(str(flag), None)
    if event.once:
        flags[_event_done_flag(event.id)] = True
    return state.model_copy(update={"flags": flags})


def choice_effect_for_index(event: GameEvent | None, index: int) -> ChoiceEffect:
    """仅用于带 choice_effects 的事件分支。无 effects 时返回空效果（不按 index 默认加减好感）。"""
    import logging

    if event and event.choice_effects:
        if 0 <= index < len(event.choice_effects):
            return event.choice_effects[index]
        return event.choice_effects[-1]
    logging.getLogger(__name__).debug(
        "choice_effect_for_index: no event effects (event=%s index=%s) → empty",
        getattr(event, "id", None),
        index,
    )
    return ChoiceEffect()


def event_has_branch_choices(event: GameEvent | None) -> bool:
    """无 beats 的旧分支事件才走 choice_effects；有 beats 时由 soft_options 接管。"""
    if not event or not event.choice_effects:
        return False
    if event.beats:
        return False
    return True


def get_event_by_id(event_id: str) -> GameEvent | None:
    eid = (event_id or "").strip()
    if not eid:
        return None
    for event in load_events():
        if event.id == eid:
            return event
    return None


def public_events_catalog() -> list[dict[str, Any]]:
    return [
        {"id": e.id, "label": e.label, "once": e.once, "scene_id": e.scene_id}
        for e in load_events()
    ]
