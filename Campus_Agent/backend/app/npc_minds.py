"""NPC mind tick: sample candidates + apply Aux structured minds (PC-facing only)."""

from __future__ import annotations

from typing import Any

from . import catalog
from . import npc_intent
from . import relationship as rel
from . import sprite_context as sprite_ctx
from .campus_store import CampusSave
from .config import llm_api_key
from .llm_chat import NpcMindItem, run_npc_minds
from .prompt_budget import clip

MAX_MIND_SAMPLE = 5
VALID_MOODS = frozenset(
    {"neutral", "happy", "shy", "sad", "angry", "anxious", "excited"}
)
APPROACH_TYPES = frozenset({"greet", "pursuit", "comfort", "study_buddy"})


def _mood_to_emotion(mood: str) -> str:
    if mood in {"neutral", "happy", "shy", "sad", "angry"}:
        return mood
    if mood == "anxious":
        return "sad"
    if mood == "excited":
        return "happy"
    return "neutral"


def _sprite_for(save: CampusSave, student: dict[str, Any], *, emotion: str | None = None) -> dict[str, Any]:
    return sprite_ctx.resolve_for_student(
        student,
        save,
        emotion=_mood_to_emotion(str(emotion or "neutral")),
        prefer_scene=True,
    )


def _edge_affinity(save: CampusSave, sid: str) -> float:
    e = rel.find_edge(save.edges, "pc", sid)
    return float((e or {}).get("affinity") or 0)


def sample_mind_candidates(save: CampusSave, *, limit: int = MAX_MIND_SAMPLE) -> list[dict[str, Any]]:
    """Deterministic scoring (no LLM): affinity, colocated, pursuit proximity, event."""
    pc_loc = save.location_id
    has_event = bool(save.active_event)
    scored: list[tuple[float, dict[str, Any]]] = []
    for s in save.students:
        sid = s["id"]
        if sid == "pc":
            continue
        aff = _edge_affinity(save, sid)
        score = aff * 1.2
        if save.locations_now.get(sid) == pc_loc:
            score += 25
        thr = float(s.get("pursuit_threshold") or 70)
        if aff >= thr * 0.7:
            score += 18
        if has_event:
            score += 8
            stance = str(s.get("romance_stance") or "")
            if stance in {"bold", "playful", "caring"}:
                score += 4
        # slight id hash for stable tie-break without rng noise every call
        score += (sum(ord(c) for c in sid) % 7) * 0.1
        scored.append((score, s))
    scored.sort(key=lambda x: (-x[0], x[1]["id"]))
    return [s for _, s in scored[:limit]]


def _brief_for_prompt(s: dict[str, Any], save: CampusSave) -> str:
    edge = rel.find_edge(save.edges, "pc", s["id"])
    brief = clip(str(s.get("persona_brief") or s.get("model_prompt_zh") or ""), 160)
    likes = ",".join((s.get("likes") or [])[:3])
    mind = (save.npc_minds or {}).get(s["id"]) or {}
    parts = [
        f"id={s['id']} name={s.get('name')} mbti={s.get('mbti')}",
        f"speech={s.get('speech_style') or ''}",
        f"likes={likes}",
        f"romance={s.get('romance_stance') or ''}",
        f"affinity={float((edge or {}).get('affinity') or 0)} stage={(edge or {}).get('stage') or 'stranger'}",
        f"loc={save.locations_now.get(s['id'], '?')}",
        f"prev_mood={mind.get('mood') or 'neutral'}",
        brief,
    ]
    return " | ".join(p for p in parts if p)


def build_minds_user_prompt(save: CampusSave, candidates: list[dict[str, Any]]) -> str:
    period = catalog.period_by_id(save.period_id, save.day_kind) or {}
    lines = [
        f"日历：D-{101 - save.day_index} day={save.day_index} weekday={save.weekday} "
        f"period={period.get('label', save.period_id)} weather={save.weather_id}",
        f"玩家位置：{save.location_id} 主角：{(save.protagonist or {}).get('name', '林知行')}",
    ]
    if save.active_event:
        lines.append(
            f"突发：{save.active_event.get('label')} — {save.active_event.get('blurb')}"
        )
    else:
        lines.append("突发：无")
    lines.append("请为下列同学各输出一条内心（面向与玩家的关系/校园当下）：")
    for s in candidates:
        lines.append("- " + _brief_for_prompt(s, save))
    lines.append('只输出 JSON：{"minds":[...]}，student_id 必须在上述名单内。')
    return "\n".join(lines)


def _normalize_mood(mood: str) -> str:
    m = (mood or "neutral").strip().lower()
    return m if m in VALID_MOODS else "neutral"


def apply_minds_result(
    save: CampusSave,
    items: list[NpcMindItem],
    *,
    allowed_ids: set[str],
) -> list[dict[str, Any]]:
    """Write npc_minds + pending_intents; return event reaction snippets."""
    intents: list[dict[str, Any]] = []
    reactions: list[dict[str, Any]] = []
    for item in items:
        sid = item.student_id
        if sid not in allowed_ids or sid == "pc":
            continue
        stu = next((s for s in save.students if s["id"] == sid), None)
        if not stu:
            continue
        mood = _normalize_mood(item.mood)
        thought = clip(item.thought or "", 80)
        event_take = clip(item.event_take, 60) if item.event_take else None
        save.npc_minds[sid] = {
            "mood": mood,
            "thought": thought,
            "event_take": event_take,
            "updated_day": save.day_index,
            "updated_period": save.period_id,
            "intent_type": item.intent_type,
        }
        delta = max(-1.0, min(2.0, float(item.affinity_delta)))
        if abs(delta) >= 0.05:
            edge = rel.ensure_edge(
                save.edges,
                "pc",
                sid,
                gender_a="male",
                gender_b=str(stu.get("gender") or "female"),
            )
            rel.apply_affinity_delta(edge, delta)
        if item.approach_pc and item.intent_type in APPROACH_TYPES:
            blurb = clip(item.blurb or thought or f"{stu.get('name')}想找你。", 60)
            intents.append(
                {
                    "type": item.intent_type,
                    "from_id": sid,
                    "from_name": stu.get("name"),
                    "blurb": blurb,
                    "mood": mood,
                    "location_id": save.locations_now.get(sid),
                    "sprite": _sprite_for(save, stu, emotion=mood),
                }
            )
        if event_take and save.active_event:
            reactions.append(
                {
                    "id": sid,
                    "name": stu.get("name"),
                    "mood": mood,
                    "event_take": event_take,
                    "sprite": _sprite_for(save, stu, emotion=mood),
                }
            )
    save.pending_intents = intents[:3]
    return reactions[:3]


def rules_fallback_intents(save: CampusSave) -> None:
    """Offline / Aux-null: keep legacy pursuit rules (no fake LLM thoughts)."""
    pc = next((s for s in save.students if s["id"] == "pc"), None)
    pc_charm = int((pc or {}).get("charm") or 50)
    intents: list[dict[str, Any]] = []
    import random

    rng = random.Random(f"{save.save_id}-{save.day_index}-{save.period_id}-fb")
    for s in save.students:
        if s["id"] == "pc":
            continue
        edge = rel.find_edge(save.edges, "pc", s["id"])
        intent = npc_intent.evaluate_pursuit(npc=s, edge=edge, pc_charm=pc_charm, rng=rng)
        if intent:
            intent["location_id"] = save.locations_now.get(s["id"])
            intent["sprite"] = _sprite_for(save, s)
            intents.append(intent)
    save.pending_intents = intents[:3]


def run_mind_tick(save: CampusSave) -> dict[str, Any]:
    """Sample + Aux minds; returns meta for hub/period_summary."""
    candidates = sample_mind_candidates(save)
    allowed = {s["id"] for s in candidates}
    reactions: list[dict[str, Any]] = []
    used_llm = False
    if candidates and llm_api_key():
        prompt = build_minds_user_prompt(save, candidates)
        result = run_npc_minds(user_prompt=prompt)
        if result and result.minds:
            used_llm = True
            reactions = apply_minds_result(save, result.minds, allowed_ids=allowed)
        else:
            rules_fallback_intents(save)
    else:
        rules_fallback_intents(save)
    return {
        "used_llm": used_llm,
        "sampled": [s["id"] for s in candidates],
        "event_reactions": reactions,
        "intent_count": len(save.pending_intents),
    }


def mind_public(save: CampusSave, student_id: str) -> dict[str, Any] | None:
    m = (save.npc_minds or {}).get(student_id)
    if not m:
        return None
    return {
        "mood": m.get("mood") or "neutral",
        "thought": m.get("thought") or "",
        "event_take": m.get("event_take"),
        "updated_day": m.get("updated_day"),
        "updated_period": m.get("updated_period"),
    }


def event_reactions_public(save: CampusSave, *, limit: int = 3) -> list[dict[str, Any]]:
    if not save.active_event:
        return []
    out: list[dict[str, Any]] = []
    for sid, m in (save.npc_minds or {}).items():
        take = m.get("event_take")
        if not take:
            continue
        stu = next((s for s in save.students if s["id"] == sid), None)
        if not stu:
            continue
        mood = _normalize_mood(str(m.get("mood") or "neutral"))
        out.append(
            {
                "id": sid,
                "name": stu.get("name"),
                "mood": mood,
                "event_take": take,
                "sprite": _sprite_for(save, stu, emotion=mood),
            }
        )
        if len(out) >= limit:
            break
    return out
