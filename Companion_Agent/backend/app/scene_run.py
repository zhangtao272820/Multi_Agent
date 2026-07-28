"""场次边界（SceneRun）：回合预算、印象池、离场结算、日接触上限。

进场烧时段/AP；场内自由聊但好感进池；告辞或回合耗尽时一次结算。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from .world_store import BondShelf


class SceneRun(BaseModel):
    mode: str = "talk"  # talk | date | ping
    turns_max: int = 6
    turns_used: int = 0
    turns_left: int = 6
    affinity_pool: int = 0
    trust_pool: int = 0
    mood_pool: int = 0
    on_agenda_hits: int = 0
    off_agenda_hits: int = 0
    ended: bool = False
    end_reason: str = ""  # farewell | turns_exhausted | busy | she_leaves | awkward
    character_id: str = ""
    day_index: int = 1


def _catalog_int(name: str, default: int) -> int:
    from .world_engine import load_date_catalog

    cat = load_date_catalog()
    raw = getattr(cat, name, None)
    try:
        return int(raw if raw is not None else default)
    except (TypeError, ValueError):
        return default


def scene_turn_budget(mode: str) -> int:
    m = (mode or "talk").strip().lower()
    if m == "story":
        return max(4, _catalog_int("scene_story_turns", 8))
    if m == "date":
        return max(3, _catalog_int("scene_date_turns", 10))
    if m == "ping":
        return max(2, _catalog_int("scene_ping_turns", 4))
    return max(2, _catalog_int("scene_talk_turns", 6))


def bump_scene_for_story(run: SceneRun | dict[str, Any] | None) -> SceneRun | None:
    """专属故事幕触发时抬高回合预算，不缩短已用轮；日常 talk/date 默认上限不变。"""
    if not run:
        return None
    if isinstance(run, dict):
        run = SceneRun.model_validate(run)
    budget = scene_turn_budget("story")
    used = max(0, int(run.turns_used or 0))
    turns_max = max(int(run.turns_max or 0), budget)
    run.turns_max = turns_max
    run.turns_left = max(0, turns_max - used)
    return run


def daily_scene_limit() -> int:
    return max(1, _catalog_int("daily_scene_limit", 2))


def settle_affinity_cap() -> int:
    return max(1, _catalog_int("scene_settle_affinity_cap", 8))


def settle_trust_cap() -> int:
    return max(1, _catalog_int("scene_settle_trust_cap", 6))


def new_scene_run(
    *,
    mode: str,
    character_id: str,
    day_index: int,
) -> SceneRun:
    budget = scene_turn_budget(mode)
    return SceneRun(
        mode=mode or "talk",
        turns_max=budget,
        turns_used=0,
        turns_left=budget,
        character_id=character_id,
        day_index=day_index,
    )


def public_scene_run(run: SceneRun | dict[str, Any] | None) -> dict[str, Any] | None:
    if not run:
        return None
    if isinstance(run, dict):
        run = SceneRun.model_validate(run)
    return {
        "mode": run.mode,
        "turns_max": run.turns_max,
        "turns_used": run.turns_used,
        "turns_left": run.turns_left,
        "ended": run.ended,
        "end_reason": run.end_reason or "",
        "pool_hint": impression_pool_hint(run),
    }


def ensure_scene_day_counter(bond: BondShelf, day_index: int) -> BondShelf:
    living = bond.living
    if int(living.scenes_day_index or 0) != int(day_index):
        bond.living.scenes_day_index = int(day_index)
        bond.living.scenes_today = 0
    return bond


def can_start_scene(bond: BondShelf, day_index: int, *, counts_toward_limit: bool = True) -> tuple[bool, str]:
    """日接触上限：talk/date 计入；ping 不计入。"""
    if not counts_toward_limit:
        return True, ""
    bond = ensure_scene_day_counter(bond, day_index)
    limit = daily_scene_limit()
    if int(bond.living.scenes_today or 0) >= limit:
        return False, f"今天和她已经聊得够多了（{limit} 场），明天再来吧"
    return True, ""


def note_scene_started(bond: BondShelf, day_index: int, *, counts_toward_limit: bool = True) -> BondShelf:
    bond = ensure_scene_day_counter(bond, day_index)
    if counts_toward_limit:
        bond.living.scenes_today = int(bond.living.scenes_today or 0) + 1
    return bond


def pool_turn_deltas(
    run: SceneRun,
    *,
    affinity_delta: int,
    trust_delta: int,
    mood_delta: int,
    on_agenda: bool,
) -> SceneRun:
    run.affinity_pool += int(affinity_delta or 0)
    run.trust_pool += int(trust_delta or 0)
    run.mood_pool += int(mood_delta or 0)
    if on_agenda:
        run.on_agenda_hits += 1
    else:
        run.off_agenda_hits += 1
    return run


def tick_scene_turn(run: SceneRun) -> SceneRun:
    if run.ended:
        return run
    run.turns_used = int(run.turns_used or 0) + 1
    run.turns_left = max(0, int(run.turns_max or 0) - run.turns_used)
    return run


def compute_settlement(run: SceneRun) -> tuple[int, int, int, str]:
    """按议程对齐度缩放印象池，并硬封顶。"""
    hits = int(run.on_agenda_hits or 0) + int(run.off_agenda_hits or 0)
    on_ratio = 1.0 if hits <= 0 else int(run.on_agenda_hits or 0) / hits
    # 跑题多 → 结算打折；贴议程 → 全额（仍受 cap）
    scale = 0.55 + 0.45 * on_ratio
    aff = int(round(int(run.affinity_pool or 0) * scale))
    trust = int(round(int(run.trust_pool or 0) * scale))
    mood = int(round(int(run.mood_pool or 0) * scale))
    aff_cap = settle_affinity_cap()
    trust_cap = settle_trust_cap()
    aff = max(-aff_cap, min(aff_cap, aff))
    trust = max(-trust_cap, min(trust_cap, trust))
    mood = max(-8, min(8, mood))
    if aff > 2:
        note = "这场聊下来，她对你的印象好了一些"
    elif aff < -2:
        note = "这场聊下来，气氛有点僵"
    elif trust > 1:
        note = "她好像更肯信你一点了"
    else:
        note = "这场见面就到这里"
    return aff, trust, mood, note


def mark_ended(run: SceneRun, reason: str) -> SceneRun:
    run.ended = True
    run.end_reason = reason
    run.turns_left = 0
    return run


def farewell_line(*, reason: str, character_name: str = "") -> str:
    name = (character_name or "她").strip() or "她"
    if reason == "turns_exhausted":
        return f"{name}看了看时间：「……差不多了，我先走了。」"
    if reason == "she_leaves":
        return f"{name}先起身告别：「我先走啦，下次再聊。」"
    if reason == "busy":
        return f"{name}有事要忙，你们先分开了。"
    if reason == "awkward":
        return f"气氛有点僵，{name}找了个借口离开了。"
    return f"你和{name}告了别，各自继续这一天。"


def impression_pool_hint(run: SceneRun) -> str:
    """场内不泄数字，只给方向感。"""
    aff = int(run.affinity_pool or 0)
    if aff >= 4:
        return "她似乎心情不错"
    if aff <= -3:
        return "气氛有点微妙"
    if int(run.turns_left or 0) <= 1 and not run.ended:
        return "她好像要走了"
    if int(run.turns_left or 0) <= 2 and not run.ended:
        return "时间所剩不多"
    return ""


def scene_prompt_block(run: SceneRun | dict[str, Any] | None) -> str:
    if not run:
        return ""
    if isinstance(run, dict):
        run = SceneRun.model_validate(run)
    if run.ended:
        return "\n【场次】这场见面已结束，简短收尾即可，不要再开启新话题。"
    left = int(run.turns_left or 0)
    used = int(run.turns_used or 0)
    if left <= 0:
        return (
            "\n【场次】你必须主动结束这场见面：用一两句自然道别收束，"
            "不要再抛新问题或邀请继续聊。"
        )
    if left <= 2:
        return (
            f"\n【场次】这场还能再聊大约 {left} 句，你有点赶时间。"
            "语气里自然流露「该走了」；可以主动道别结束见面；"
            "不要念出系统数字，不要开启全新长话题。"
        )
    if used == 0:
        return f"\n【场次】这是一场有限的见面（大约 {run.turns_max} 轮），自然开场即可。"
    return ""


def counts_toward_daily_limit(mode: str) -> bool:
    return (mode or "talk").strip().lower() in {"talk", "date"}


def build_judge_scene_ctx(
    run: SceneRun | dict[str, Any] | None,
    *,
    fatigue: int = 0,
    cold_war: bool = False,
    agenda_source: str = "",
    character_id: str = "",
) -> dict[str, Any]:
    """给 Judge 的场次上下文：按「本轮结束后」的剩余句数估算。"""
    if not run:
        return {}
    if isinstance(run, dict):
        run = SceneRun.model_validate(run)
    left_after = max(0, int(run.turns_left or 0) - 1)
    return {
        "turns_left": left_after,
        "turns_used": int(run.turns_used or 0) + 1,
        "turns_max": int(run.turns_max or 0),
        "fatigue": int(fatigue or 0),
        "cold_war": bool(cold_war),
        "agenda_source": str(agenda_source or ""),
        "character_id": character_id or run.character_id,
    }
