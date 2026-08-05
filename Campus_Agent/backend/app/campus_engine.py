"""Deterministic campus world engine."""

from __future__ import annotations

import random
from typing import Any

from . import catalog
from . import charm as charm_mod
from . import endings as endings_mod
from . import npc_greeting
from . import npc_intent
from . import npc_minds
from . import npc_social
from . import relationship as rel
from . import scores as scores_mod
from . import seating as seating_mod
from . import sprite_context as sprite_ctx
from . import sprites as sprites_mod
from . import weather as weather_mod
from . import weekly_events as weekly_mod
from .campus_store import CampusSave, clone_students, new_save_id, store
from .llm_chat import run_character, run_date_decision, run_judge
from .config import llm_api_key

ACTIONABLE_KINDS = frozenset({"free", "free_day", "meal", "dorm"})
MAX_SKIP_STEPS = 12

# roster schedule keys → period_id / kind fallbacks
_SCHEDULE_PERIOD_KEYS = {
    "morning_study": "morning_study",
    "breakfast": "lunch",
    "lunch": "lunch",
    "dinner": "lunch",
    "evening_study": "after_school",
    "weekend_morning": "after_school",
    "weekend_afternoon": "after_school",
    "weekend_evening": "evening",
    "recess": "recess",
}


def _rng_for(save: CampusSave) -> random.Random:
    return random.Random(f"{save.save_id}-{save.day_index}-{save.period_id}")


def _weekday_from_day(day_index: int) -> int:
    # day 1 = Monday
    return ((day_index - 1) % 7) + 1


def _day_kind(weekday: int) -> str:
    return "weekend" if weekday >= 6 else "weekday"


def _student_by_id(save: CampusSave, sid: str) -> dict[str, Any] | None:
    for s in save.students:
        if s["id"] == sid:
            return s
    return None


def _period_meta(save: CampusSave) -> dict[str, Any]:
    return catalog.period_by_id(save.period_id, save.day_kind) or {
        "id": save.period_id,
        "label": save.period_id,
        "kind": "free",
    }


def _subject_for_class(save: CampusSave, period: dict[str, Any]) -> str:
    if period.get("subject_id"):
        return str(period["subject_id"])
    rot = catalog.campus_map().get("class_subject_rotation") or ["math"]
    return str(rot[(save.day_index - 1) % len(rot)])


def _study_mult(save: CampusSave) -> float:
    ev = save.active_event or {}
    effects = ev.get("effects") or {}
    return float(effects.get("study_mult", 1.0))


def _schedule_location_for(student: dict[str, Any], save: CampusSave, kind: str, rng: random.Random) -> str | None:
    """Prefer roster schedule; return None to fall back to kind RNG."""
    sched = student.get("schedule") or {}
    if not isinstance(sched, dict):
        return None
    pid = save.period_id
    # Direct period_id key
    if pid in sched and sched[pid]:
        return str(sched[pid])
    mapped = _SCHEDULE_PERIOD_KEYS.get(pid)
    if mapped and mapped in sched and sched[mapped]:
        return str(sched[mapped])
    if kind == "meal" and sched.get("lunch"):
        return str(sched["lunch"])
    if kind == "free" and pid == "morning_study" and sched.get("morning_study"):
        return str(sched["morning_study"])
    if kind == "free" and sched.get("after_school"):
        # evening study / free study → after_school bias
        if pid in {"evening_study"}:
            return str(sched["after_school"])
    if kind in {"dorm", "end"} and sched.get("evening"):
        # prefer dorm_id over evening gate when dorm period
        return str(student.get("dorm_id") or sched["evening"])
    # weekends keep weekend_bias / intent path (do not hard-pin after_school)
    return None


def _refresh_locations(save: CampusSave) -> None:
    """Assign NPC locations for current period into save.locations_now."""
    period = _period_meta(save)
    kind = period.get("kind", "free")
    rng = _rng_for(save)
    loc_now: dict[str, str] = {}
    for s in save.students:
        sid = s["id"]
        if sid == "pc":
            loc_now[sid] = save.location_id
            continue
        scheduled = _schedule_location_for(s, save, str(kind), rng)
        if scheduled and scheduled in catalog.location_ids():
            loc_now[sid] = scheduled
            continue
        if kind == "class":
            loc_now[sid] = "classroom"
        elif kind == "meal":
            loc_now[sid] = "cafeteria" if rng.random() > 0.12 else rng.choice(["hallway", "shop"])
        elif kind == "dorm":
            loc_now[sid] = str(s.get("dorm_id") or "dorm_gate")
        elif kind == "end":
            loc_now[sid] = str(s.get("dorm_id") or "dorm_gate")
        elif kind == "free_day" or save.day_kind == "weekend":
            loc_now[sid] = npc_intent.weekend_location_for(s, save.weather_id, rng)
        elif kind == "free":
            # study period: mostly classroom/library
            bias = s.get("weekend_bias") or "classroom"
            choices = ["classroom", "classroom", "library", str(bias)]
            loc_now[sid] = rng.choice(choices)
        else:
            loc_now[sid] = "hallway"
    # Apply invite stick (AA2-style follow for 1 period), then consume TTL
    stick = dict(save.invite_stick or {})
    next_stick: dict[str, dict[str, Any]] = {}
    for sid, meta in stick.items():
        if not isinstance(meta, dict):
            continue
        loc = str(meta.get("location_id") or "")
        ttl = int(meta.get("ttl") or 0)
        if not loc or ttl <= 0 or sid not in loc_now:
            continue
        loc_now[sid] = loc
        if ttl > 1:
            next_stick[sid] = {"location_id": loc, "ttl": ttl - 1}
    save.invite_stick = next_stick
    save.locations_now = loc_now
    # Free sandbox: dating NPC couples cling to the same spot
    npc_social.apply_couple_stick(save)


def _sprite_emotion(mood: str) -> str:
    if mood in {"neutral", "happy", "shy", "sad", "angry"}:
        return mood
    if mood == "anxious":
        return "sad"
    if mood == "excited":
        return "happy"
    return "neutral"


def _resolve_sprite(
    student: dict[str, Any],
    save: CampusSave,
    *,
    emotion: str | None = None,
    verb: str | None = None,
    prefer_scene: bool = True,
) -> dict[str, Any]:
    emo = _sprite_emotion(str(emotion or "neutral"))
    return sprite_ctx.resolve_for_student(
        student,
        save,
        emotion=emo,
        verb=verb,
        prefer_scene=prefer_scene,
    )


def _student_public(s: dict[str, Any], save: CampusSave | None = None) -> dict[str, Any]:
    mind = npc_minds.mind_public(save, s["id"]) if save else None
    mood = (mind or {}).get("mood") or "neutral"
    sprite_emotion = _sprite_emotion(str(mood))
    if save:
        sprite = _resolve_sprite(s, save, emotion=sprite_emotion, prefer_scene=True)
    else:
        sprite = sprites_mod.resolve_student_sprite(s["id"], emotion=sprite_emotion)
    q_sprite = sprites_mod.resolve_q_sprite(s["id"], emotion=sprite_emotion)
    out: dict[str, Any] = {
        "id": s["id"],
        "name": s["name"],
        "gender": s["gender"],
        "mbti": s["mbti"],
        "grade_tier": s["grade_tier"],
        "look_tag": s.get("look_tag", ""),
        "charm": s.get("charm") or charm_mod.compute_charm(s),
        "is_pc": bool(s.get("is_pc_slot")) or s["id"] == "pc",
        "sprite": sprite,
        "q_sprite": q_sprite,
        "mind": mind,
    }
    if save:
        if s["id"] in save.scores:
            out["scores"] = scores_mod.public_scores(save.scores[s["id"]])
        if save.locations_now:
            out["location_id"] = save.locations_now.get(s["id"])
    return out


def present_at(save: CampusSave, location_id: str | None = None) -> list[dict[str, Any]]:
    loc = location_id or save.location_id
    if not save.locations_now:
        _refresh_locations(save)
    out: list[dict[str, Any]] = []
    for s in save.students:
        if save.locations_now.get(s["id"]) == loc:
            out.append(_student_public(s, save))
    return out


def hub_public(save: CampusSave) -> dict[str, Any]:
    period = _period_meta(save)
    cmap = catalog.campus_map()
    if not save.locations_now:
        _refresh_locations(save)
    locations = []
    for loc in cmap["locations"]:
        here = present_at(save, loc["id"])
        locations.append(
            {
                **loc,
                "present_count": len(here),
                "present_preview": [
                    {
                        "id": p["id"],
                        "name": p["name"],
                        "sprite": p.get("sprite"),
                        "q_sprite": p.get("q_sprite"),
                        "is_pc": p.get("is_pc"),
                    }
                    for p in here[:8]
                ],
            }
        )
    bg = sprites_mod.resolve_bg(save.location_id, save.weather_id)
    active_event = save.active_event
    if active_event and active_event.get("talk_npc_id"):
        tid = str(active_event["talk_npc_id"])
        other = _student_by_id(save, tid)
        active_event = {
            **active_event,
            "talk_npc_name": (other or {}).get("name") or tid,
            "talk_npc_q": sprites_mod.resolve_q_sprite(
                tid, emotion=_sprite_emotion(str((save.npc_minds.get(tid) or {}).get("mood") or "neutral"))
            ),
        }
    return {
        "save_id": save.save_id,
        "calendar": {
            "day_index": save.day_index,
            "days_left": max(0, 101 - save.day_index),
            "weekday": save.weekday,
            "day_kind": save.day_kind,
            "period_id": save.period_id,
            "period_label": period.get("label", save.period_id),
            "period_kind": period.get("kind"),
            "weather_id": save.weather_id,
            "weather_label": weather_mod.weather_label(save.weather_id),
        },
        "location_id": save.location_id,
        "locations": locations,
        "present": present_at(save),
        "protagonist": save.protagonist,
        "class_name": catalog.class_roster().get("class_name", ""),
        "edge_count": len(save.edges),
        "student_count": len(save.students),
        "chat_actions_left": save.chat_actions_left,
        "note_actions_left": save.note_actions_left,
        "club_action_used": bool(save.club_action_used),
        "spot_action_used": bool(save.spot_action_used),
        "active_event": active_event,
        "pending_intents": save.pending_intents,
        "event_reactions": npc_minds.event_reactions_public(save),
        "world_events": list(save.world_events or [])[:6],
        "pc_scores": scores_mod.public_scores(save.scores.get("pc", scores_mod.empty_scores())),
        "bg": bg,
        "ended": bool(save.ended),
        "ending": save.ending,
        "seating_summary": {
            "pc": seating_mod.find_seat(save.seating, "pc"),
        },
    }


_STAGE_LABEL_CN = {
    "stranger": "陌生",
    "acquaintance": "相识",
    "friend": "朋友",
    "close": "亲近",
    "crush": "心动",
    "dating": "约会中",
}


def compute_gaokao_ending(save: CampusSave) -> dict[str, Any]:
    """D-0 高考结算：成绩排名 × 感情阶段矩阵（零 LLM）。"""
    ranking = scores_mod.mock_exam_snapshot(save.scores)
    name_by_id = {s["id"]: s["name"] for s in save.students}
    pc_row = next((r for r in ranking if r["student_id"] == "pc"), None)
    pc_rank = int((pc_row or {}).get("rank") or len(ranking))
    pc_total = float((pc_row or {}).get("total") or 0)

    top = []
    for r in ranking[:5]:
        sid = r["student_id"]
        top.append(
            {
                "id": sid,
                "name": name_by_id.get(sid, sid),
                "total": round(float(r["total"]), 1),
                "rank": r["rank"],
                "is_pc": sid == "pc",
            }
        )

    romance = None
    pc_edges = [e for e in save.edges if "pc" in {e.get("a"), e.get("b")}]
    pc_edges.sort(key=lambda e: float(e.get("affinity") or 0), reverse=True)
    if pc_edges and float(pc_edges[0].get("affinity") or 0) >= 35:
        best = pc_edges[0]
        other_id = best["b"] if best.get("a") == "pc" else best["a"]
        other = _student_by_id(save, other_id)
        romance = {
            "id": other_id,
            "name": (other or {}).get("name") or name_by_id.get(other_id, other_id),
            "affinity": float(best.get("affinity") or 0),
            "stage": best.get("stage") or "stranger",
            "stage_label": _STAGE_LABEL_CN.get(str(best.get("stage") or "stranger"), best.get("stage")),
            "sprite": (
                _resolve_sprite(other, save, emotion="happy", prefer_scene=False)
                if other
                else sprites_mod.resolve_student_sprite(other_id, emotion="happy")
            ),
            "q_sprite": sprites_mod.resolve_q_sprite(other_id, emotion="happy"),
        }

    resolved = endings_mod.resolve_ending(pc_rank=pc_rank, pc_total=pc_total, romance=romance)
    social_epilogue = npc_social.build_social_epilogue(save)

    return {
        "kind": "gaokao",
        "ending_id": resolved["ending_id"],
        "title": resolved["title"],
        "tone": resolved["tone"],
        "blurb": resolved["blurb"],
        "grade_band": resolved["grade_band"],
        "romance_bucket": resolved["romance_bucket"],
        "pc_rank": pc_rank,
        "pc_total": round(pc_total, 1),
        "pc_scores": scores_mod.public_scores(save.scores.get("pc", scores_mod.empty_scores())),
        "ranking_top": top,
        "romance": romance,
        "social_epilogue": social_epilogue,
        "day_index": save.day_index,
        "protagonist_name": save.protagonist.get("name") or "主角",
    }


def create_new(*, name: str, grade_tier: str, mbti: str) -> dict[str, Any]:
    if grade_tier not in catalog.grade_tier_ids():
        raise ValueError(f"invalid_grade_tier:{grade_tier}")
    if mbti not in catalog.mbti_types():
        raise ValueError(f"invalid_mbti:{mbti}")

    roster = catalog.class_roster()
    students = clone_students(roster["students"])
    display_name = (name or "").strip() or "林知行"
    for s in students:
        s["charm"] = charm_mod.compute_charm(s)
        if s["id"] == "pc":
            s["name"] = display_name
            s["mbti"] = mbti
            s["grade_tier"] = grade_tier
            s["gender"] = "male"
            s["is_pc_slot"] = True
            s["charm"] = charm_mod.compute_charm(s)

    males = [s for s in students if s.get("gender") == "male"]
    females = [s for s in students if s.get("gender") == "female"]
    composition = roster.get("composition") or {}
    expect_m = int(composition.get("male", 10))
    expect_f = int(composition.get("female", 25))
    expect_total = expect_m + expect_f
    if len(students) != expect_total or len(males) != expect_m or len(females) != expect_f:
        raise RuntimeError(
            f"roster_invalid:total={len(students)} male={len(males)} female={len(females)} "
            f"expected={expect_total}/{expect_m}/{expect_f}"
        )

    ids = [s["id"] for s in students]
    seating = seating_mod.assign_seating(ids, rng=random.Random(display_name + grade_tier + mbti))
    score_map = {s["id"]: scores_mod.initial_scores(s["grade_tier"]) for s in students}

    day_index = 1
    weekday = _weekday_from_day(day_index)
    day_kind = _day_kind(weekday)
    periods = catalog.period_ids(day_kind)
    weather_id = weather_mod.roll_weather(random.Random(display_name))

    cmap = catalog.campus_map()
    save = CampusSave(
        save_id=new_save_id(),
        day_index=day_index,
        weekday=weekday,
        day_kind=day_kind,
        period_id=periods[0],
        weather_id=weather_id,
        location_id="classroom",
        protagonist={"name": display_name, "grade_tier": grade_tier, "mbti": mbti},
        students=students,
        seating=seating,
        scores=score_map,
        edges=[],
        chat_actions_left=int(cmap.get("chat_actions_per_free", 3)),
        note_actions_left=int(cmap.get("note_actions_per_free", 2)),
        title=f"{display_name} · 入学",
    )
    _roll_day_event(save)
    _refresh_locations(save)
    npc_social.seed_initial_bonds(save)
    # Day-1 life: one social pulse + colocated minds so map/location aren't empty
    save.world_events = npc_social.run_social_tick(save)
    npc_minds.apply_colocated_rule_minds(save)
    store.set_active(save)
    store.persist(save, kind="auto")
    return hub_public(save)


def travel(location_id: str) -> dict[str, Any]:
    if location_id not in catalog.location_ids():
        raise ValueError(f"invalid_location:{location_id}")
    save = store.require_active()
    save.location_id = location_id
    save.locations_now["pc"] = location_id
    return hub_public(save)


_SEAT_REL_LABEL = {
    "deskmate": "同桌",
    "front_back": "前后",
    "aisle": "过道",
    "diagonal": "斜角",
    "note": "纸条",
}


def _apply_class_period(save: CampusSave, period: dict[str, Any]) -> dict[str, Any]:
    subject = _subject_for_class(save, period)
    mult = _study_mult(save)
    pc = _student_by_id(save, "pc") or {}
    pc_sc = save.scores.setdefault("pc", scores_mod.initial_scores(str(pc.get("grade_tier") or "mid")))
    pc_gain = scores_mod.apply_class_gain(
        pc_sc, subject_id=subject, grade_tier=str(pc.get("grade_tier") or "mid"), study_mult=mult
    )
    for s in save.students:
        sid = s["id"]
        if sid == "pc":
            continue
        sc = save.scores.setdefault(sid, scores_mod.initial_scores(s["grade_tier"]))
        scores_mod.apply_class_gain(sc, subject_id=subject, grade_tier=s["grade_tier"], study_mult=mult)
    # passive affinity for PC neighbors
    neighbor_deltas: list[dict[str, Any]] = []
    for nid, seat_rel in seating_mod.neighbors_of(save.seating, "pc"):
        other = _student_by_id(save, nid)
        if not other:
            continue
        edge = rel.ensure_edge(
            save.edges, "pc", nid, gender_a="male", gender_b=str(other.get("gender"))
        )
        delta = 0.15 * seating_mod.RELATION_MULT.get(seat_rel, 1.0)
        rel.apply_affinity_delta(edge, delta)
        neighbor_deltas.append(
            {
                "id": nid,
                "name": other.get("name", nid),
                "delta": round(delta, 2),
                "seat_relation": seat_rel,
                "seat_label": _SEAT_REL_LABEL.get(seat_rel, seat_rel),
            }
        )
    subject_label = next(
        (s["label"] for s in (catalog.subjects_catalog().get("subjects") or []) if s["id"] == subject),
        subject,
    )
    return {
        "type": "class",
        "subject_id": subject,
        "subject_label": subject_label,
        "pc_gain": round(pc_gain, 2),
        "neighbors": neighbor_deltas,
    }


def _roll_day_event(save: CampusSave) -> None:
    rng = _rng_for(save)
    weekly = weekly_mod.pick_weekly_event(save, rng)
    if weekly:
        save.active_event = weekly
        save.events.append({"day_index": save.day_index, **weekly})
        return
    ev = weather_mod.pick_event(save.weather_id, rng)
    if ev:
        ev = {**ev, "source": "weather", "talk_npc_id": None}
    save.active_event = ev
    if ev:
        save.events.append({"day_index": save.day_index, **ev})


def _collect_intents(save: CampusSave) -> dict[str, Any]:
    """Mind tick (Aux) or rules fallback. Replaces pure pursuit RNG when model available."""
    return npc_minds.run_mind_tick(save)


def _start_new_day(save: CampusSave) -> None:
    save.day_index += 1
    if save.day_index > 100:
        save.day_index = 100
    save.weekday = _weekday_from_day(save.day_index)
    save.day_kind = _day_kind(save.weekday)
    periods = catalog.period_ids(save.day_kind)
    save.period_id = periods[0]
    save.weather_id = weather_mod.roll_weather(random.Random(f"{save.save_id}-{save.day_index}"))
    _roll_day_event(save)
    cmap = catalog.campus_map()
    save.chat_actions_left = int(cmap.get("chat_actions_per_free", 3))
    save.note_actions_left = int(cmap.get("note_actions_per_free", 2))
    save.club_action_used = False
    save.spot_action_used = False
    save.active_date = None
    # auto mock exam days
    mock_days = catalog.campus_map().get("mock_exam_days") or []
    if save.day_index in mock_days:
        run_mock_exam(persist=False)


def _build_period_recap(
    *,
    from_period: dict[str, Any],
    hub: dict[str, Any],
    class_summary: dict[str, Any] | None,
    mind_meta: dict[str, Any],
    day_ended: bool,
    skipped: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    intents = hub.get("pending_intents") or []
    reactions = mind_meta.get("event_reactions") or []
    event = hub.get("active_event")
    neighbors = (class_summary or {}).get("neighbors") or []
    summary_bits: list[str] = []
    if class_summary:
        summary_bits.append(f"{class_summary['subject_label']} +{class_summary['pc_gain']}")
        if neighbors:
            names = "、".join(f"{n['name']}(+{n['delta']})" for n in neighbors[:3])
            summary_bits.append(f"邻座好感 {names}")
    elif day_ended:
        summary_bits.append(f"{from_period.get('label')}结束，进入新的一天")
        if event:
            summary_bits.append(str(event.get("label") or "突发"))
    else:
        summary_bits.append(f"{from_period.get('label')} → {hub['calendar'].get('period_label')}")
    if skipped:
        summary_bits.insert(0, f"跳过 {len(skipped)} 个时段")
    world_events = hub.get("world_events") or mind_meta.get("world_events") or []
    if world_events:
        summary_bits.append(str(world_events[0].get("blurb") or "班级里有点动静"))
    if intents:
        summary_bits.append(str(intents[0].get("blurb") or "有人想找你"))
    if reactions:
        summary_bits.append(f"{reactions[0].get('name')}：{reactions[0].get('event_take')}")

    return {
        "from_period": {
            "id": from_period.get("id"),
            "label": from_period.get("label"),
            "kind": from_period.get("kind"),
        },
        "to_period": {
            "id": hub["calendar"].get("period_id"),
            "label": hub["calendar"].get("period_label"),
            "kind": hub["calendar"].get("period_kind"),
        },
        "day_index": hub["calendar"].get("day_index"),
        "days_left": hub["calendar"].get("days_left"),
        "class_gain": (
            {
                "subject_id": class_summary["subject_id"],
                "subject_label": class_summary["subject_label"],
                "pc_gain": class_summary["pc_gain"],
            }
            if class_summary
            else None
        ),
        "neighbors": neighbors,
        "intents": [
            {
                "from_id": i.get("from_id"),
                "from_name": i.get("from_name"),
                "blurb": i.get("blurb"),
                "type": i.get("type"),
            }
            for i in intents[:3]
        ],
        "event": (
            {
                "id": event.get("id"),
                "label": event.get("label"),
                "blurb": event.get("blurb"),
                "talk_npc_id": event.get("talk_npc_id"),
                "location_id": event.get("location_id"),
                "source": event.get("source"),
            }
            if event
            else None
        ),
        "reactions": reactions[:3],
        "world_events": [
            {
                "type": w.get("type"),
                "blurb": w.get("blurb"),
                "a": w.get("a"),
                "b": w.get("b"),
                "a_name": w.get("a_name"),
                "b_name": w.get("b_name"),
                "location_id": w.get("location_id"),
                "bond_kind": w.get("bond_kind"),
                "dramatic": w.get("dramatic"),
            }
            for w in world_events[:6]
        ],
        "skipped_periods": skipped or [],
        "summary": " · ".join(summary_bits),
    }


def advance_period() -> dict[str, Any]:
    save = store.require_active()
    if save.ended:
        hub = hub_public(save)
        hub["last_action"] = {"type": "ended"}
        hub["period_summary"] = "百日已终，请查看高考结算。"
        hub["period_recap"] = None
        return hub

    period = _period_meta(save)
    kind = period.get("kind")
    period_label = str(period.get("label") or save.period_id)
    class_summary: dict[str, Any] | None = None
    if kind == "class":
        class_summary = _apply_class_period(save, period)

    periods = catalog.period_ids(save.day_kind)
    idx = periods.index(save.period_id) if save.period_id in periods else 0
    day_ended = idx + 1 >= len(periods) or kind == "end"
    gaokao = False
    if day_ended and save.day_index >= 100:
        # D-0：第 100 日最后时段结束 → 高考结算，不再开新一天
        save.ending = compute_gaokao_ending(save)
        save.ended = True
        gaokao = True
        store.persist(save, kind="auto")
        hub = hub_public(save)
        hub["last_action"] = {"type": "gaokao"}
        hub["period_summary"] = "高考日到了，百日冲刺结束。"
        hub["mind_tick"] = {"used_llm": False, "sampled": [], "intent_count": 0}
        hub["period_recap"] = {
            "from_period": {"id": period.get("id"), "label": period_label, "kind": kind},
            "to_period": None,
            "day_index": save.day_index,
            "days_left": 0,
            "class_gain": None,
            "neighbors": [],
            "intents": [],
            "event": None,
            "reactions": [],
            "skipped_periods": [],
            "summary": hub["period_summary"],
            "ended": True,
        }
        return hub

    if day_ended:
        _start_new_day(save)
    else:
        save.period_id = periods[idx + 1]
        cmap = catalog.campus_map()
        pnext = catalog.period_by_id(save.period_id, save.day_kind) or {}
        if pnext.get("kind") in {"free", "free_day", "meal", "dorm"}:
            save.chat_actions_left = int(cmap.get("chat_actions_per_free", 3))
            save.note_actions_left = int(cmap.get("note_actions_per_free", 2))
            save.club_action_used = False
            save.spot_action_used = False
            save.active_date = None

    _refresh_locations(save)
    world_events = npc_social.run_social_tick(save)
    mind_meta = _collect_intents(save)
    mind_meta["world_events"] = world_events
    store.persist(save, kind="auto")
    hub = hub_public(save)
    hub["world_events"] = world_events

    last_action: dict[str, Any]
    if class_summary:
        last_action = {
            "type": "class",
            "subject_id": class_summary["subject_id"],
            "gain": class_summary["pc_gain"],
            "neighbors": class_summary["neighbors"],
        }
    elif day_ended:
        last_action = {"type": "day_end"}
    else:
        last_action = {"type": "advance", "from_period": period.get("id")}

    recap = _build_period_recap(
        from_period=period,
        hub=hub,
        class_summary=class_summary,
        mind_meta=mind_meta,
        day_ended=day_ended,
    )
    hub["last_action"] = last_action
    hub["period_summary"] = recap["summary"]
    hub["period_recap"] = recap
    hub["mind_tick"] = {
        "used_llm": mind_meta.get("used_llm"),
        "sampled": mind_meta.get("sampled"),
        "intent_count": mind_meta.get("intent_count"),
    }
    if gaokao:
        hub["ending"] = save.ending
    return hub


def _is_actionable_hub(hub: dict[str, Any]) -> bool:
    if hub.get("ended"):
        return True
    kind = (hub.get("calendar") or {}).get("period_kind")
    if kind in ACTIONABLE_KINDS:
        return True
    if hub.get("pending_intents"):
        return True
    ev = hub.get("active_event") or {}
    if ev.get("talk_npc_id"):
        return True
    return False


def advance_until_actionable(*, max_steps: int | None = None) -> dict[str, Any]:
    """Skip class/end grind until free/meal/dorm (or social hooks / ending)."""
    save = store.require_active()
    if save.ended:
        return advance_period()

    limit = max(1, min(int(max_steps or MAX_SKIP_STEPS), MAX_SKIP_STEPS))
    skipped: list[dict[str, Any]] = []
    class_agg: dict[str, Any] | None = None
    neighbors_acc: list[dict[str, Any]] = []
    world_acc: list[dict[str, Any]] = []
    last_hub: dict[str, Any] | None = None

    for _ in range(limit):
        before = _period_meta(save)
        before_kind = before.get("kind")
        hub = advance_period()
        last_hub = hub
        recap = hub.get("period_recap") or {}
        if before_kind not in ACTIONABLE_KINDS:
            skipped.append(
                {
                    "id": before.get("id"),
                    "label": before.get("label"),
                    "kind": before_kind,
                }
            )
        if recap.get("class_gain"):
            cg = recap["class_gain"]
            if class_agg is None:
                class_agg = {
                    "subject_id": cg["subject_id"],
                    "subject_label": cg["subject_label"],
                    "pc_gain": float(cg["pc_gain"]),
                }
            else:
                class_agg["pc_gain"] = round(float(class_agg["pc_gain"]) + float(cg["pc_gain"]), 2)
                class_agg["subject_label"] = f"{class_agg['subject_label']}+{cg['subject_label']}"
        for n in recap.get("neighbors") or []:
            neighbors_acc.append(n)
        for w in recap.get("world_events") or hub.get("world_events") or []:
            world_acc.append(w)
        if hub.get("ended") or _is_actionable_hub(hub):
            break
        save = store.require_active()

    assert last_hub is not None
    base_recap = dict(last_hub.get("period_recap") or {})
    if class_agg:
        base_recap["class_gain"] = class_agg
    if neighbors_acc:
        by_id: dict[str, dict[str, Any]] = {}
        for n in neighbors_acc:
            by_id[str(n.get("id"))] = n
        base_recap["neighbors"] = list(by_id.values())[:6]
    if world_acc:
        # de-dupe by blurb, prefer dramatic first
        seen: set[str] = set()
        merged: list[dict[str, Any]] = []
        for w in sorted(world_acc, key=lambda x: (0 if x.get("dramatic") else 1)):
            key = str(w.get("blurb") or "")
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(w)
            if len(merged) >= 6:
                break
        base_recap["world_events"] = merged
        last_hub["world_events"] = merged
    base_recap["skipped_periods"] = skipped
    if skipped:
        summary = str(base_recap.get("summary") or "")
        bits = [f"跳过 {len(skipped)} 个时段"]
        if world_acc:
            bits.append(str((world_acc[0] or {}).get("blurb") or "班级里有点动静"))
        if summary and "跳过" not in summary:
            bits.append(summary)
        base_recap["summary"] = " · ".join(bits)
    last_hub["period_recap"] = base_recap
    last_hub["period_summary"] = base_recap.get("summary") or last_hub.get("period_summary")
    last_hub["last_action"] = {
        "type": "advance_skip",
        "skipped": len(skipped),
        "gain": (class_agg or {}).get("pc_gain"),
        "neighbors": base_recap.get("neighbors"),
    }
    return last_hub


def study(*, subject_id: str) -> dict[str, Any]:
    save = store.require_active()
    period = _period_meta(save)
    if period.get("kind") not in {"free", "free_day"}:
        raise ValueError("not_study_period")
    if subject_id not in scores_mod.SUBJECT_IDS:
        raise ValueError(f"invalid_subject:{subject_id}")
    sc = save.scores.setdefault("pc", scores_mod.empty_scores())
    pc = _student_by_id(save, "pc") or {}
    gain = scores_mod.apply_study_gain(
        sc,
        subject_id=subject_id,
        grade_tier=str(pc.get("grade_tier") or save.protagonist.get("grade_tier")),
        at_library=save.location_id == "library",
        study_mult=_study_mult(save),
    )
    store.persist(save, kind="auto")
    hub = hub_public(save)
    hub["last_action"] = {"type": "study", "subject_id": subject_id, "gain": round(gain, 2)}
    return hub


def prepare_talk(target_id: str) -> dict[str, Any]:
    save = store.require_active()
    target = _student_by_id(save, target_id)
    if not target or target_id == "pc":
        raise ValueError("invalid_target")
    if save.locations_now.get(target_id) != save.location_id:
        raise ValueError("target_not_present")

    period = _period_meta(save)
    active_date = save.active_date if isinstance(save.active_date, dict) else None
    is_date = bool(
        active_date
        and str(active_date.get("target_id") or "") == target_id
        and str(active_date.get("location_id") or "") == save.location_id
    )

    seat_rel = None
    cost = 1
    # Date short scene: no classroom seat/note gate
    if not is_date and period.get("kind") == "free" and save.location_id == "classroom":
        seat_rel = seating_mod.relation_between(save.seating, "pc", target_id)
        cost = seating_mod.chat_cost(seat_rel)
        if seating_mod.can_direct_chat(seat_rel):
            if save.chat_actions_left < 1:
                raise ValueError("no_chat_actions")
        else:
            if save.note_actions_left < 1 and save.chat_actions_left < cost:
                raise ValueError("no_note_actions")

    edge = rel.ensure_edge(
        save.edges,
        "pc",
        target_id,
        gender_a="male",
        gender_b=str(target.get("gender")),
    )
    target_pub = _student_public(target, save)
    # Ensure opening talk always has a mind bubble (rule seed if empty)
    if not (target_pub.get("mind") or {}).get("thought"):
        npc_minds.apply_colocated_rule_minds(save)
        target_pub = _student_public(target, save)
    soft_date = (
        ["随便走走吧", "聊聊最近心里的事", "时间不早了，我送你回去"] if is_date else []
    )
    loc_name = next(
        (l["name"] for l in catalog.campus_map()["locations"] if l["id"] == save.location_id),
        save.location_id,
    )
    opening = None
    if not is_date:
        opening = npc_greeting.build_opening_line(
            save=save,
            target=target,
            edge=edge,
            period_label=str(period.get("label") or save.period_id),
            location_name=str(loc_name),
            seat_relation=seat_rel if isinstance(seat_rel, str) else None,
            is_date=False,
            active_event=save.active_event,
        )
        npc_greeting.consume_intent_for(save, target_id)
        if opening:
            save.talk_log.append({"role": "assistant", "text": opening, "target": target_id})
            if len(save.talk_log) > 40:
                save.talk_log = save.talk_log[-40:]
            store.persist(save, kind="auto")

    return {
        "target": target_pub,
        "edge": rel.public_edge(edge),
        "seat_relation": seat_rel,
        "action_cost": cost,
        "chat_actions_left": save.chat_actions_left,
        "note_actions_left": save.note_actions_left,
        "calendar": hub_public(save)["calendar"],
        "location_id": save.location_id,
        "bg": sprites_mod.resolve_bg(save.location_id, save.weather_id),
        "active_event": save.active_event,
        "sprite": target_pub.get("sprite"),
        "q_sprite": target_pub.get("q_sprite"),
        "scene": "date" if is_date else "talk",
        "soft_options": soft_date,
        "opening_line": opening,
        "memory_hooks": list((edge.get("memories") or [])[-2:]),
    }


def chat_turn(*, target_id: str, text: str, verb: str | None = None) -> dict[str, Any]:
    save = store.require_active()
    prep = prepare_talk(target_id)
    target = _student_by_id(save, target_id)
    assert target
    edge = rel.find_edge(save.edges, "pc", target_id)
    assert edge

    period = _period_meta(save)
    seat_rel = prep.get("seat_relation")
    cost = int(prep.get("action_cost") or 1)
    force_note = verb == "note"
    is_date = prep.get("scene") == "date"
    if not is_date and period.get("kind") == "free" and save.location_id == "classroom":
        if force_note or (seat_rel and not seating_mod.can_direct_chat(seat_rel)):  # type: ignore[arg-type]
            if save.note_actions_left >= 1:
                save.note_actions_left -= 1
            elif save.chat_actions_left >= cost:
                save.chat_actions_left = max(0, save.chat_actions_left - cost)
            else:
                raise ValueError("no_note_actions")
        elif seat_rel and seating_mod.can_direct_chat(seat_rel):  # type: ignore[arg-type]
            if save.chat_actions_left < 1:
                raise ValueError("no_chat_actions")
            save.chat_actions_left = max(0, save.chat_actions_left - 1)
        else:
            if save.note_actions_left >= 1:
                save.note_actions_left -= 1
            else:
                save.chat_actions_left = max(0, save.chat_actions_left - cost)
    elif is_date and verb not in {"date_stroll", "date_chat", "date_walk_home", "greet", "talk", None, "date"}:
        pass  # date scene: free dialogue turns (no seat spend)
    elif is_date:
        pass

    loc_name = next(
        (l["name"] for l in catalog.campus_map()["locations"] if l["id"] == save.location_id),
        save.location_id,
    )
    recent = save.talk_log[-8:]

    from .prompt_budget import assemble_character_context

    effective_verb = verb
    if is_date and not effective_verb:
        effective_verb = "date"
    context = assemble_character_context(
        student=target,
        edge=edge,
        weather_id=save.weather_id,
        period_label=str(period.get("label")),
        location_name=loc_name,
        seat_relation=seat_rel if isinstance(seat_rel, str) else None,
        recent_turns=recent,
        active_event=save.active_event,
        mind=npc_minds.mind_public(save, target_id),
        verb=effective_verb,
        scene="date" if is_date else None,
    )
    judge = run_judge(user_text=text, context=context)
    public_deltas: dict[str, Any] = {}
    stance = "neutral"
    emotion = "neutral"
    mind = npc_minds.mind_public(save, target_id)
    if judge:
        mult = 1.0
        if isinstance(seat_rel, str):
            mult = seating_mod.RELATION_MULT.get(seat_rel, 1.0)
        if save.active_event:
            mult += float((save.active_event.get("effects") or {}).get("chat_affinity_bonus") or 0)
        if verb == "greet":
            mult *= 0.85
        if is_date:
            mult *= 1.15
        delta = float(judge.affinity_delta) * mult
        rel.apply_affinity_delta(edge, delta)
        if judge.memory_line:
            mems = edge.setdefault("memories", [])
            mems.append(judge.memory_line)
            if len(mems) > 12:
                del mems[:-12]
        stance = judge.stance_hint
        emotion = judge.emotion
        public_deltas = {"affinity_delta": round(delta, 2), "stage": edge["stage"]}

    line = run_character(
        student=target,
        edge=edge,
        weather_id=save.weather_id,
        period_label=str(period.get("label")),
        location_name=loc_name,
        seat_relation=seat_rel if isinstance(seat_rel, str) else None,
        recent_turns=recent,
        active_event=save.active_event,
        user_text=text,
        stance_hint=stance,
        mind=mind,
    )
    if emotion and line.emotion == "neutral":
        line.emotion = emotion
    if line.emotion == "neutral" and mind and mind.get("mood"):
        m = str(mind["mood"])
        if m in {"happy", "shy", "sad", "angry"}:
            line.emotion = m

    if line.emotion or line.thought:
        prev = save.npc_minds.get(target_id) or {}
        save.npc_minds[target_id] = {
            **prev,
            "mood": line.emotion if line.emotion in npc_minds.VALID_MOODS else prev.get("mood", "neutral"),
            "thought": (line.thought or prev.get("thought") or "")[:80],
            "judgment": (getattr(line, "judgment", None) or prev.get("judgment") or "")[:60],
            "updated_day": save.day_index,
            "updated_period": save.period_id,
        }

    save.talk_log.append({"role": "user", "text": text, "target": target_id})
    save.talk_log.append({"role": "assistant", "text": line.line, "target": target_id})
    if len(save.talk_log) > 40:
        save.talk_log = save.talk_log[-40:]

    sprite = _resolve_sprite(
        target, save, emotion=line.emotion, verb=verb, prefer_scene=False
    )
    q_sprite = sprites_mod.resolve_q_sprite(target_id, emotion=line.emotion)
    action_blurb = None
    if is_date and verb == "date_walk_home":
        save.active_date = None
        action_blurb = "约会短场景结束 · 已送她回去"
    soft = list(line.soft_options or [])
    if is_date and not soft:
        soft = ["再逛一会儿", "继续聊", "该回去了"]
    store.persist(save, kind="auto")
    return {
        "line": line.line,
        "emotion": line.emotion,
        "thought": line.thought or "",
        "judgment": getattr(line, "judgment", "") or "",
        "soft_options": soft,
        "public_deltas": public_deltas,
        "edge": rel.public_edge(edge),
        "sprite": sprite,
        "q_sprite": q_sprite,
        "judge_ok": judge is not None,
        "chat_actions_left": save.chat_actions_left,
        "note_actions_left": save.note_actions_left,
        "verb": verb or ("date" if is_date else "talk"),
        "action_blurb": action_blurb,
        "scene": "date" if is_date and save.active_date else prep.get("scene"),
    }


INTERACT_VERBS = frozenset(
    {"greet", "talk", "study_together", "invite", "note", "date_stroll", "date_chat", "date_walk_home"}
)

_VERB_SEEDS = {
    "greet": "嗨，最近怎么样？",
    "talk": "想认真跟你说几句。",
    "note": "（纸条）课后有空一起去图书馆吗？",
    "study_together": "要不要一起学一会儿？",
    "invite": "这会儿要不要和我一起去别处转转？",
    "date_stroll": "我们随便走走吧。",
    "date_chat": "其实有件事想跟你说说心里话。",
    "date_walk_home": "时间不早了，我送你回去吧。",
}


def interact(*, target_id: str, verb: str, text: str | None = None) -> dict[str, Any]:
    """AA2-style interaction verbs layered on seating + affinity (no intent regex)."""
    v = (verb or "").strip().lower()
    if v not in INTERACT_VERBS:
        raise ValueError(f"invalid_verb:{verb}")
    user_text = (text or "").strip() or _VERB_SEEDS.get(v, "……")

    if v in {"greet", "talk", "note", "date_stroll", "date_chat", "date_walk_home"}:
        return chat_turn(target_id=target_id, text=user_text, verb=v)

    save = store.require_active()
    target = _student_by_id(save, target_id)
    if not target or target_id == "pc":
        raise ValueError("invalid_target")
    if save.locations_now.get(target_id) != save.location_id:
        raise ValueError("target_not_present")

    edge = rel.ensure_edge(
        save.edges,
        "pc",
        target_id,
        gender_a="male",
        gender_b=str(target.get("gender")),
    )
    period = _period_meta(save)
    mind = npc_minds.mind_public(save, target_id)

    if v == "study_together":
        if period.get("kind") not in {"free", "free_day"}:
            raise ValueError("not_study_period")
        if save.chat_actions_left < 1:
            raise ValueError("no_chat_actions")
        save.chat_actions_left -= 1
        pc = save.scores.setdefault("pc", {})
        subject = "math"
        if period.get("subject_id"):
            subject = str(period["subject_id"])
        elif save.day_index % 4 == 1:
            subject = "chinese"
        elif save.day_index % 4 == 2:
            subject = "english"
        elif save.day_index % 4 == 3:
            subject = "science"
        gain = scores_mod.apply_study_gain(
            pc,
            subject_id=subject,
            grade_tier=str(save.protagonist.get("grade_tier") or "mid"),
            at_library=save.location_id == "library",
            study_mult=_study_mult(save) * 0.55,
        )
        delta = 0.8
        stage = str(edge.get("stage") or "stranger")
        if stage in {"friend", "close", "crush", "dating"}:
            delta = 1.2
        rel.apply_affinity_delta(edge, delta)
        emotion = "happy"
        prev = save.npc_minds.get(target_id) or {}
        save.npc_minds[target_id] = {
            **prev,
            "mood": "happy",
            "thought": "一起学的时候意外地安心。",
            "updated_day": save.day_index,
            "updated_period": save.period_id,
        }
        line = run_character(
            student=target,
            edge=edge,
            weather_id=save.weather_id,
            period_label=str(period.get("label")),
            location_name=save.location_id,
            seat_relation=None,
            recent_turns=save.talk_log[-4:],
            active_event=save.active_event,
            user_text=user_text,
            stance_hint="warm",
            mind=mind,
        )
        if line.emotion == "neutral":
            line.emotion = emotion
        save.talk_log.append({"role": "user", "text": user_text, "target": target_id})
        save.talk_log.append({"role": "assistant", "text": line.line, "target": target_id})
        store.persist(save, kind="auto")
        subj_label = next(
            (s["label"] for s in (catalog.subjects_catalog().get("subjects") or []) if s["id"] == subject),
            subject,
        )
        return {
            "line": line.line,
            "emotion": line.emotion,
            "thought": line.thought or (save.npc_minds.get(target_id) or {}).get("thought") or "",
            "judgment": getattr(line, "judgment", "") or "",
            "soft_options": line.soft_options or ["再学一会儿", "聊聊别的"],
            "public_deltas": {
                "affinity_delta": round(delta, 2),
                "stage": edge["stage"],
                "score_gain": round(gain, 2),
                "subject_id": subject,
            },
            "edge": rel.public_edge(edge),
            "sprite": _resolve_sprite(
                target, save, emotion=line.emotion, verb=v, prefer_scene=False
            ),
            "q_sprite": sprites_mod.resolve_q_sprite(target_id, emotion=line.emotion),
            "judge_ok": False,
            "chat_actions_left": save.chat_actions_left,
            "note_actions_left": save.note_actions_left,
            "verb": v,
            "action_blurb": f"一起学习：{subj_label} +{round(gain, 1)}，亲和 +{round(delta, 1)}",
        }

    # invite
    stage = str(edge.get("stage") or "stranger")
    if stage not in {"acquaintance", "friend", "close", "crush", "dating"}:
        raise ValueError("relationship_too_low")
    if save.chat_actions_left < 1:
        raise ValueError("no_chat_actions")
    save.chat_actions_left -= 1
    loc = save.location_id
    save.locations_now[target_id] = loc
    save.invite_stick[target_id] = {"location_id": loc, "ttl": 1}
    rel.apply_affinity_delta(edge, 0.6)
    emotion = "shy" if stage in {"acquaintance", "friend"} else "happy"
    prev = save.npc_minds.get(target_id) or {}
    save.npc_minds[target_id] = {
        **prev,
        "mood": emotion,
        "thought": "被邀请同行，心里有点小雀跃。",
        "updated_day": save.day_index,
        "updated_period": save.period_id,
    }
    line = run_character(
        student=target,
        edge=edge,
        weather_id=save.weather_id,
        period_label=str(period.get("label")),
        location_name=loc,
        seat_relation=None,
        recent_turns=save.talk_log[-4:],
        active_event=save.active_event,
        user_text=user_text,
        stance_hint="warm",
        mind=mind,
    )
    if line.emotion == "neutral":
        line.emotion = emotion
    save.talk_log.append({"role": "user", "text": user_text, "target": target_id})
    save.talk_log.append({"role": "assistant", "text": line.line, "target": target_id})
    store.persist(save, kind="auto")
    loc_label = next(
        (l["name"] for l in catalog.campus_map()["locations"] if l["id"] == loc),
        loc,
    )
    return {
        "line": line.line,
        "emotion": line.emotion,
        "thought": line.thought or (save.npc_minds.get(target_id) or {}).get("thought") or "",
        "judgment": getattr(line, "judgment", "") or "",
        "soft_options": line.soft_options or ["那就一起", "再聊两句"],
        "public_deltas": {"affinity_delta": 0.6, "stage": edge["stage"]},
        "edge": rel.public_edge(edge),
        "sprite": _resolve_sprite(
            target, save, emotion=line.emotion, verb=v, prefer_scene=False
        ),
        "q_sprite": sprites_mod.resolve_q_sprite(target_id, emotion=line.emotion),
        "judge_ok": False,
        "chat_actions_left": save.chat_actions_left,
        "note_actions_left": save.note_actions_left,
        "verb": v,
        "action_blurb": f"已邀请同行：本时段末与下一时段会尽量留在「{loc_label}」",
    }


def club_activity() -> dict[str, Any]:
    """Deterministic club-room activity during free / free_day periods."""
    save = store.require_active()
    if save.location_id != "club_room":
        raise ValueError("not_at_club")
    period = _period_meta(save)
    if period.get("kind") not in {"free", "free_day"}:
        raise ValueError("not_club_period")
    if save.club_action_used:
        raise ValueError("club_already_used")

    save.club_action_used = True
    present_ids = [
        sid
        for sid, loc in save.locations_now.items()
        if loc == "club_room" and sid != "pc"
    ]
    bumped: list[dict[str, Any]] = []
    for sid in present_ids[:8]:
        stu = _student_by_id(save, sid)
        if not stu:
            continue
        edge = rel.ensure_edge(
            save.edges,
            "pc",
            sid,
            gender_a="male",
            gender_b=str(stu.get("gender")),
        )
        delta = 0.45
        rel.apply_affinity_delta(edge, delta)
        prev = save.npc_minds.get(sid) or {}
        save.npc_minds[sid] = {
            **prev,
            "mood": "happy",
            "thought": "社团活动热闹，心情好了一点。",
            "updated_day": save.day_index,
            "updated_period": save.period_id,
        }
        bumped.append({"id": sid, "name": stu.get("name"), "delta": delta})

    # tiny score bump for participation
    pc = save.scores.setdefault("pc", {})
    gain = scores_mod.apply_study_gain(
        pc,
        subject_id="chinese",
        grade_tier=str(save.protagonist.get("grade_tier") or "mid"),
        at_library=False,
        study_mult=0.2,
    )
    store.persist(save, kind="auto")
    hub = hub_public(save)
    names = "、".join(str(b["name"]) for b in bumped[:3]) or "空无的社团室"
    blurb = f"社团活动：与{names}略有交流" if bumped else "社团活动：独自收拾器材，平静收场"
    hub["last_action"] = {"type": "club", "bumped": bumped, "gain": round(gain, 2)}
    hub["period_summary"] = f"{blurb} · 语文 +{round(gain, 1)}"
    return hub


_SPOT_DEFAULT: dict[str, str] = {
    "playground": "exercise",
    "cafeteria": "share_meal",
    "rooftop": "breeze",
    "shop": "snack",
    "hallway": "linger",
}


def _dorm_action_id(location_id: str) -> str | None:
    if location_id.startswith("dorm_") and location_id != "dorm_gate":
        return "idle_chat"
    return None


def spot_activity(*, action_id: str | None = None, focus_id: str | None = None) -> dict[str, Any]:
    """Deterministic location-specific actions (AA2-style spot verbs; zero LLM)."""
    save = store.require_active()
    loc = save.location_id
    period = _period_meta(save)
    kind = period.get("kind")

    resolved = (action_id or "").strip() or _SPOT_DEFAULT.get(loc) or _dorm_action_id(loc)
    if not resolved:
        raise ValueError("no_spot_action_here")
    if loc == "club_room":
        raise ValueError("use_club_endpoint")
    if save.spot_action_used:
        raise ValueError("spot_already_used")

    # meal spots mainly at meal; exercise/rooftop/shop/dorm at free-ish or meal/dorm
    if resolved == "share_meal" and kind not in {"meal", "free_day"}:
        raise ValueError("not_meal_period")
    if resolved == "exercise" and kind not in {"free", "free_day", "meal"}:
        raise ValueError("not_spot_period")
    if resolved in {"breeze", "snack", "linger"} and kind not in {"free", "free_day", "meal", "dorm"}:
        raise ValueError("not_spot_period")
    if resolved == "idle_chat" and kind not in {"dorm", "free_day", "end"}:
        raise ValueError("not_dorm_period")

    present_ids = [sid for sid, l in save.locations_now.items() if l == loc and sid != "pc"]
    focus = focus_id if focus_id and focus_id in present_ids else (present_ids[0] if present_ids else None)

    save.spot_action_used = True
    bumped: list[dict[str, Any]] = []
    mood = "happy"
    thought = ""
    delta = 0.4
    label = "地点活动"

    if resolved == "exercise":
        label = "操场活动"
        thought = "运动完精神了不少。"
        delta = 0.4
        targets = present_ids[:5]
    elif resolved == "share_meal":
        label = "一起吃饭"
        thought = "一起吃饭总是更香一点。"
        delta = 0.7
        targets = [focus] if focus else present_ids[:3]
        targets = [t for t in targets if t]
    elif resolved == "breeze":
        label = "屋顶透气"
        mood = "shy" if focus else "neutral"
        thought = "风有点大，心里却安静下来。" if focus else "一个人吹吹风也好。"
        delta = 0.5 if focus else 0.0
        targets = [focus] if focus else []
    elif resolved == "snack":
        label = "小卖部"
        thought = "零食续命，心情回暖。"
        delta = 0.3
        targets = [focus] if focus else present_ids[:2]
        targets = [t for t in targets if t]
    elif resolved == "linger":
        label = "走廊闲逛"
        thought = "课间走廊人来人往。"
        delta = 0.25
        targets = present_ids[:4]
    elif resolved == "idle_chat":
        label = "宿舍闲聊"
        thought = "同寝八卦让人放松。"
        delta = 0.5
        targets = present_ids[:6]
    else:
        raise ValueError(f"unknown_spot_action:{resolved}")

    for sid in targets:
        stu = _student_by_id(save, sid)
        if not stu:
            continue
        edge = rel.ensure_edge(
            save.edges,
            "pc",
            sid,
            gender_a="male",
            gender_b=str(stu.get("gender")),
        )
        if delta > 0:
            rel.apply_affinity_delta(edge, delta)
        prev = save.npc_minds.get(sid) or {}
        save.npc_minds[sid] = {
            **prev,
            "mood": mood if mood in npc_minds.VALID_MOODS else prev.get("mood", "neutral"),
            "thought": thought or prev.get("thought", ""),
            "updated_day": save.day_index,
            "updated_period": save.period_id,
        }
        bumped.append({"id": sid, "name": stu.get("name"), "delta": delta})

    store.persist(save, kind="auto")
    hub = hub_public(save)
    names = "、".join(str(b["name"]) for b in bumped[:3])
    if bumped:
        summary = f"{label}：与{names}相处（亲和 +{delta}）"
    else:
        summary = f"{label}：独自度过片刻"
    hub["last_action"] = {"type": "spot", "action_id": resolved, "bumped": bumped}
    hub["period_summary"] = summary
    return hub


def ask_out(*, target_id: str, location_id: str) -> dict[str, Any]:
    save = store.require_active()
    if save.day_kind != "weekend":
        raise ValueError("ask_out_weekend_only")
    target = _student_by_id(save, target_id)
    if not target:
        raise ValueError("invalid_target")
    edge = rel.find_edge(save.edges, "pc", target_id)
    if not edge or not rel.dating_allowed(edge):
        raise ValueError("relationship_too_low")
    if location_id not in catalog.location_ids():
        raise ValueError(f"invalid_location:{location_id}")

    mind = npc_minds.mind_public(save, target_id)
    decision = run_date_decision(
        student=target,
        edge=edge,
        weather_id=save.weather_id,
        location_id=location_id,
        mind=mind,
    ) if llm_api_key() else None
    if decision is not None:
        accepted = bool(decision.accepted)
        reply_line = decision.line or ""
        reply_emotion = decision.emotion or "neutral"
    else:
        accepted = npc_intent.evaluate_date_response(
            npc=target, edge=edge, weather_id=save.weather_id
        )
        reply_line = ""
        reply_emotion = "happy" if accepted else "shy"

    if accepted:
        rel.apply_affinity_delta(edge, 3.0)
        save.location_id = location_id
        save.locations_now["pc"] = location_id
        save.locations_now[target_id] = location_id
        save.invite_stick[target_id] = {"location_id": location_id, "ttl": 1}
        save.active_date = {"target_id": target_id, "location_id": location_id}
        save.memories.append(
            {
                "day_index": save.day_index,
                "text": f"与{target.get('name')}在{location_id}约会",
            }
        )
    else:
        rel.apply_affinity_delta(edge, -0.5)
    prev = save.npc_minds.get(target_id) or {}
    save.npc_minds[target_id] = {
        **prev,
        "mood": reply_emotion if reply_emotion in npc_minds.VALID_MOODS else prev.get("mood", "neutral"),
        "thought": reply_line or prev.get("thought") or "",
        "updated_day": save.day_index,
        "updated_period": save.period_id,
    }
    store.persist(save, kind="auto")
    out: dict[str, Any] = {
        "accepted": accepted,
        "line": reply_line,
        "emotion": reply_emotion,
        "edge": rel.public_edge(edge),
        "hub": hub_public(save),
        "judge_ok": decision is not None,
        "talk": None,
    }
    if accepted:
        talk = prepare_talk(target_id)
        loc_label = next(
            (l["name"] for l in catalog.campus_map()["locations"] if l["id"] == location_id),
            location_id,
        )
        opening = reply_line.strip() if reply_line else f"那就在{loc_label}走走吧……"
        talk["opening_line"] = opening
        talk["scene"] = "date"
        talk["soft_options"] = talk.get("soft_options") or [
            "随便走走吧",
            "聊聊最近心里的事",
            "时间不早了，我送你回去",
        ]
        # seed talk log with opening NPC line
        save.talk_log.append({"role": "assistant", "text": opening, "target": target_id})
        if len(save.talk_log) > 40:
            save.talk_log = save.talk_log[-40:]
        store.persist(save, kind="auto")
        out["talk"] = talk
        out["hub"] = hub_public(save)
        out["line"] = opening
    return out


def weekend_roam() -> dict[str, Any]:
    save = store.require_active()
    if save.day_kind != "weekend":
        raise ValueError("not_weekend")
    _refresh_locations(save)
    store.persist(save, kind="auto")
    return hub_public(save)


def run_mock_exam(*, persist: bool = True) -> dict[str, Any]:
    save = store.require_active()
    ranking = scores_mod.mock_exam_snapshot(save.scores)
    save.seating = seating_mod.assign_seating(
        [s["id"] for s in save.students],
        rng=random.Random(f"mock-{save.day_index}-{save.save_id}"),
    )
    save.last_mock = {
        "day_index": save.day_index,
        "ranking": ranking[:10],
        "pc_rank": next((r["rank"] for r in ranking if r["student_id"] == "pc"), None),
    }
    # memory about new deskmate
    for nid, seat_rel in seating_mod.neighbors_of(save.seating, "pc"):
        if seat_rel == "deskmate":
            other = _student_by_id(save, nid)
            save.memories.append(
                {
                    "day_index": save.day_index,
                    "text": f"模考后与{(other or {}).get('name', nid)}成了同桌",
                }
            )
            break
    if persist:
        store.persist(save, kind="auto")
    return {"last_mock": save.last_mock, "hub": hub_public(save)}


def board_public() -> dict[str, Any]:
    save = store.require_active()
    ranking = scores_mod.mock_exam_snapshot(save.scores)
    students = []
    for s in save.students:
        sid = s["id"]
        sc = save.scores.get(sid) or scores_mod.empty_scores()
        seat = seating_mod.find_seat(save.seating, sid)
        seat_rel = seating_mod.relation_between(save.seating, "pc", sid) if sid != "pc" else "none"
        students.append(
            {
                **_student_public(s, save),
                "scores": scores_mod.public_scores(sc),
                "seat": seat,
                "rank": next((r["rank"] for r in ranking if r["student_id"] == sid), None),
                "seat_relation": seat_rel if sid != "pc" else None,
                "seat_label": _SEAT_REL_LABEL.get(seat_rel, seat_rel) if sid != "pc" else None,
                "can_direct_chat": seating_mod.can_direct_chat(seat_rel) if sid != "pc" else False,
            }
        )
    students.sort(key=lambda x: x.get("rank") or 999)
    name_by_id = {s["id"]: s["name"] for s in save.students}
    edges = []
    for e in save.edges:
        if "pc" not in {e.get("a"), e.get("b")}:
            continue
        pe = rel.public_edge(e)
        other = pe["b"] if pe["a"] == "pc" else pe["a"]
        pe["other_id"] = other
        pe["other_name"] = name_by_id.get(other, other)
        other_stu = next((s for s in students if s["id"] == other), None)
        pe["other_sprite"] = (other_stu or {}).get("sprite")
        pe["other_q_sprite"] = (other_stu or {}).get("q_sprite")
        edges.append(pe)
    edges.sort(key=lambda e: e.get("affinity", 0), reverse=True)
    class_gossip = npc_social.class_gossip_public(save)
    pc_seat = seating_mod.find_seat(save.seating, "pc")
    neighbor_tags: list[dict[str, Any]] = []
    if pc_seat:
        for nid, seat_rel in seating_mod.neighbors_of(save.seating, "pc"):
            neighbor_tags.append(
                {
                    "id": nid,
                    "name": name_by_id.get(nid, nid),
                    "seat_relation": seat_rel,
                    "seat_label": _SEAT_REL_LABEL.get(seat_rel, seat_rel),
                }
            )
    return {
        "class_name": catalog.class_roster().get("class_name", ""),
        "calendar": hub_public(save)["calendar"],
        "students": students,
        "pc_edges": edges[:20],
        "class_gossip": class_gossip,
        "world_events": list(save.world_events or [])[:8],
        "seating": save.seating,
        "last_mock": save.last_mock,
        "name_by_id": name_by_id,
        "today": {
            "weather_id": save.weather_id,
            "weather_label": weather_mod.weather_label(save.weather_id),
            "active_event": save.active_event,
            "pending_intents": save.pending_intents or [],
            "pc_neighbors": neighbor_tags,
            "event_reactions": npc_minds.event_reactions_public(save),
            "world_events": list(save.world_events or [])[:6],
        },
    }


def meta_public() -> dict[str, Any]:
    return {
        "map": catalog.campus_map(),
        "personality": {
            "grade_tiers": catalog.personality_catalog().get("grade_tiers"),
            "mbti_types": catalog.personality_catalog().get("mbti_types"),
        },
        "subjects": catalog.subjects_catalog(),
        "weather": catalog.weather_catalog(),
        "class_name": catalog.class_roster().get("class_name", ""),
        "class_id": catalog.class_roster().get("class_id", ""),
        "roster_size": len(catalog.class_roster().get("students", [])),
        "sprite_budget": catalog.sprite_budget(),
    }
