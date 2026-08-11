"""Context-aware outfit/action selection for campus sprites.

Uses the full budget: school sc_*, core actions, private outfits/actions.
Private outfits (casual/pajama/towel) are female-only.
"""

from __future__ import annotations

from typing import Any

from . import relationship as rel
from . import sprites as sprites_mod

# Location → preferred scene-interaction actions (sc_*)
_LOCATION_SCENE: dict[str, tuple[str, ...]] = {
    "classroom": ("sc_classroom_lean", "sc_classroom_blackboard"),
    "cafeteria": ("sc_cafeteria_seat", "sc_cafeteria_counter"),
    "library": ("sc_library_shelf", "sc_library_read"),
    "hallway": ("sc_hallway_window", "sc_hallway_locker"),
    "rooftop": ("sc_rooftop_rail",),
    "playground": ("sc_playground_fence",),
    "shop": ("sc_shop_browse",),
    "club_room": ("sc_classroom_lean",),
    "dorm_gate": ("sc_hallway_locker",),
    "dorm_m1": ("sc_dorm_bunk", "sc_dorm_desk"),
    "dorm_m2": ("sc_dorm_bunk", "sc_dorm_desk"),
    "dorm_f1": ("sc_dorm_bunk", "sc_dorm_desk"),
    "dorm_f2": ("sc_dorm_bunk", "sc_dorm_desk"),
    "dorm_f3": ("sc_dorm_bunk", "sc_dorm_desk"),
    "dorm_f4": ("sc_dorm_bunk", "sc_dorm_desk"),
}

_OUTDOOR = frozenset({"playground", "rooftop", "hallway", "dorm_gate"})

_VERB_ACTION: dict[str, str] = {
    "study": "study",
    "study_together": "study",
    "greet": "wave",
    "note": "pass_note",
    "talk": "chat",
    # W3：约会专用 pose（缺图时候选链会落到 chat/wave/stand）
    "date_chat": "date_chat",
    "date_stroll": "date_stroll",
    "date_walk_home": "date_walk",
    "date": "date_chat",
    "invite": "wave",
}

_DATE_VERB_FALLBACK: dict[str, tuple[str, ...]] = {
    "date_chat": ("chat", "stand"),
    "date_stroll": ("chat", "wave", "stand"),
    "date_walk": ("wave", "chat", "stand"),
}

_RAINY = frozenset({"rainy", "thunderstorm"})

# Female private-pack actions (budget actions_private)
_PRIVATE_ACTIONS_BY_KIND: dict[str, tuple[str, ...]] = {
    "dorm": (
        "sit_bunk",
        "hug_pillow",
        "bed_edge",
        "yawn",
        "stretch",
        "lean_wall",
        "window_night",
        "dorm",
        "stand",
    ),
    "end": (
        "hug_pillow",
        "bed_edge",
        "yawn",
        "sit_bunk",
        "window_night",
        "dorm",
        "stand",
    ),
    "towel": ("after_bath", "wet_hair", "door", "stand"),
}

_PRIVATE_OUTFITS = frozenset({"casual", "pajama", "towel"})

# W7 intimate selfie slots (binary filename: {outfit}_{emotion}.png; empty action)
_INTIMATE_SELFIE_SLOTS: tuple[str, ...] = (
    "intimate_selfie_slip",
    "intimate_selfie_micro",
    "intimate_selfie_strappy",
    "intimate_selfie_shirt",
    "intimate_selfie_backless",
    "intimate_selfie_sofa",
    "intimate_selfie_kneel",
    "intimate_selfie_garter",
    "intimate_selfie_wet",
    "intimate_selfie_ribbon",
)
_SELFIE_EMOTIONS: tuple[str, ...] = ("love", "shy", "happy", "neutral")


def _is_dorm_room(location_id: str) -> bool:
    return location_id.startswith("dorm_") and location_id != "dorm_gate"


def _is_female(gender: str | None, student_id: str) -> bool:
    if gender:
        return str(gender).lower() == "female"
    return student_id.startswith("f")


def _stage_at_least(stage: str | None, min_stage: str) -> bool:
    if not stage:
        return False
    try:
        return rel.STAGE_ORDER.index(str(stage)) >= rel.STAGE_ORDER.index(min_stage)
    except ValueError:
        return False


def _intimate_selfie_pairs(*, prefer_pr: bool = True) -> list[tuple[str, str]]:
    """(outfit, action) with empty action → binary {outfit}_{emotion}.png."""
    pairs: list[tuple[str, str]] = []
    for slot in _INTIMATE_SELFIE_SLOTS:
        if prefer_pr:
            pairs.append((f"pr_{slot}", ""))
        pairs.append((slot, ""))
    return pairs


def outfit_candidates(
    *,
    location_id: str,
    period_kind: str,
    weather_id: str | None,
    gender: str | None,
    student_id: str,
) -> list[str]:
    """Ordered outfit ids to try (first = preferred)."""
    female = _is_female(gender, student_id)
    out: list[str] = []
    if female and _is_dorm_room(location_id) and period_kind in {"dorm", "end"}:
        if period_kind == "end":
            out.extend(["pajama", "casual", "towel"])
        else:
            out.extend(["casual", "pajama", "towel"])
    elif female and period_kind in {"free_day", "free"} and location_id in {
        "shop",
        "playground",
        "rooftop",
        "dorm_gate",
    }:
        # Weekend / free roam: show casual pack when present
        out.append("casual")
    if weather_id == "cold":
        out.append("winter")
    out.append("summer")
    seen: set[str] = set()
    ordered: list[str] = []
    for o in out:
        if o not in seen:
            seen.add(o)
            ordered.append(o)
    return ordered


def _signature_actions_for_location(
    student: dict[str, Any] | None,
    location_id: str,
) -> list[tuple[str, str]]:
    """Return (outfit, action) pairs from roster signature_plan matching location.

    Only location-matched hooks are returned (no unrelated signature force-in).
    """
    if not student:
        return []
    plan = student.get("signature_plan")
    if not isinstance(plan, list):
        return []
    loc = location_id or ""
    matched: list[tuple[str, str]] = []
    for entry in plan:
        if not isinstance(entry, dict):
            continue
        action = str(entry.get("action") or "").strip()
        if not action:
            continue
        outfit = str(entry.get("outfit") or "summer").strip() or "summer"
        locs = [str(x) for x in (entry.get("locations") or [])]
        if not locs:
            matched.append((outfit, action))
            continue
        loc_set = set(locs)
        dorm_ok = (
            loc.startswith("dorm_")
            and loc != "dorm_gate"
            and any(x.startswith("dorm_") and x != "dorm_gate" for x in loc_set)
        )
        if loc in loc_set or dorm_ok:
            matched.append((outfit, action))
    return matched


def _student_from_roster(student_id: str) -> dict[str, Any] | None:
    try:
        from . import catalog

        for s in catalog.class_roster().get("students") or []:
            if isinstance(s, dict) and str(s.get("id")) == student_id:
                return s
    except Exception:
        return None
    return None


def action_candidates(
    *,
    location_id: str,
    period_kind: str,
    weather_id: str | None,
    verb: str | None,
    prefer_scene: bool,
    mood: str | None = None,
) -> list[str]:
    """Ordered action ids to try (first = preferred)."""
    actions: list[str] = []
    v = (verb or "").strip().lower() or None
    if v and v in _VERB_ACTION:
        mapped = _VERB_ACTION[v]
        actions.append(mapped)
        for fb in _DATE_VERB_FALLBACK.get(mapped, ()):
            actions.append(fb)
    # Location stage: prefer sc_* so scene packs get used
    if prefer_scene:
        for sc in _LOCATION_SCENE.get(location_id, ()):
            actions.append(sc)
    if period_kind == "meal" and location_id == "cafeteria":
        actions.extend(["eat", "sc_cafeteria_seat", "sc_cafeteria_counter"])
    if period_kind == "class":
        actions.extend(["listen", "sc_classroom_lean", "sc_classroom_blackboard"])
    if period_kind in {"free", "free_day"} and location_id == "library":
        actions.extend(["study", "sc_library_read", "sc_library_shelf"])
    if period_kind in {"free", "free_day"} and location_id == "classroom":
        actions.extend(["study", "think", "sc_classroom_lean"])
    if weather_id in _RAINY and location_id in _OUTDOOR:
        actions.append("rain")
    if period_kind in {"dorm", "end"} and _is_dorm_room(location_id):
        actions.append("dorm")
        for a in _PRIVATE_ACTIONS_BY_KIND.get(period_kind, ()):
            actions.append(a)
    if mood in {"anxious", "sad", "shy"} and "think" not in actions:
        actions.append("think")
    if mood in {"happy", "excited"} and "wave" not in actions and not v:
        actions.append("wave")
    if v in {"talk", "date_chat", None} and "chat" not in actions:
        if v or period_kind in {"free", "free_day", "meal", "dorm"}:
            actions.append("chat")
    actions.append("stand")
    seen: set[str] = set()
    ordered: list[str] = []
    for a in actions:
        if a not in seen:
            seen.add(a)
            ordered.append(a)
    return ordered


def build_oa_candidates(
    *,
    location_id: str,
    period_kind: str,
    weather_id: str | None,
    verb: str | None,
    gender: str | None,
    student_id: str,
    prefer_scene: bool = True,
    mood: str | None = None,
    student: dict[str, Any] | None = None,
    sprite_hint: dict[str, Any] | None = None,
    stage: str | None = None,
) -> list[tuple[str, str]]:
    """Ordered (outfit, action) pairs — hint/signature first, then private/school."""
    outfits = outfit_candidates(
        location_id=location_id,
        period_kind=period_kind,
        weather_id=weather_id,
        gender=gender,
        student_id=student_id,
    )
    private = [o for o in outfits if o in _PRIVATE_OUTFITS]
    school = [o for o in outfits if o not in _PRIVATE_OUTFITS]

    private_actions: list[str] = []
    kind_key = "end" if period_kind == "end" else "dorm"
    for a in _PRIVATE_ACTIONS_BY_KIND.get(kind_key, ("stand", "dorm")):
        if a not in private_actions:
            private_actions.append(a)
    for a in ("stand", "dorm", "chat", "think"):
        if a not in private_actions:
            private_actions.append(a)
    # towel outfit prefers bath actions first
    towel_actions = list(_PRIVATE_ACTIONS_BY_KIND["towel"]) + ["stand"]

    school_actions = action_candidates(
        location_id=location_id,
        period_kind=period_kind,
        weather_id=weather_id,
        verb=verb,
        prefer_scene=prefer_scene,
        mood=mood,
    )

    pairs: list[tuple[str, str]] = []
    # W6 weekly / explicit hint — highest priority
    if isinstance(sprite_hint, dict):
        h_outfit = str(sprite_hint.get("outfit") or "summer").strip() or "summer"
        h_action = str(sprite_hint.get("action") or "").strip()
        if h_action:
            pairs.append((h_outfit, h_action))
        elif "intimate_selfie" in h_outfit:
            pairs.append((h_outfit, ""))
    # W1 signature: location-matched hooks before generic sc_*
    if prefer_scene:
        roster_student = student if isinstance(student, dict) else None
        if not roster_student or not roster_student.get("signature_plan"):
            roster_student = _student_from_roster(student_id) or roster_student
        for pair in _signature_actions_for_location(roster_student, location_id):
            pairs.append(pair)
    # W3 date poses — before private pack so weekend dates don't fall into bunk poses
    v = (verb or "").strip().lower() or None
    if v and v in _VERB_ACTION:
        mapped = _VERB_ACTION[v]
        if mapped.startswith("date_") or v.startswith("date"):
            date_outfits = [o for o in outfits if o not in {"pajama", "towel"}] or ["summer"]
            date_actions = [mapped, *_DATE_VERB_FALLBACK.get(mapped, ())]
            for outfit in date_outfits:
                for action in date_actions:
                    pairs.append((outfit, action))
    # W7 intimate selfie — female dorm evening + crush/dating+; pr_* before photoreal; then private pack
    female = _is_female(gender, student_id)
    if (
        female
        and _is_dorm_room(location_id)
        and period_kind in {"dorm", "end"}
        and _stage_at_least(stage, "crush")
    ):
        pairs.extend(_intimate_selfie_pairs(prefer_pr=True))
    for outfit in private:
        acts = towel_actions if outfit == "towel" else private_actions
        for action in acts:
            pairs.append((outfit, action))
    for outfit in school:
        for action in school_actions:
            pairs.append((outfit, action))

    seen: set[tuple[str, str]] = set()
    out: list[tuple[str, str]] = []
    for p in pairs:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _resolve_exact(
    student_id: str,
    outfit: str,
    action: str,
    emotion: str,
) -> dict[str, Any] | None:
    """Return asset ref if ternary or W7 binary `{outfit}_{emotion}.png` exists."""
    root = sprites_mod.sprites_root() / student_id
    if not action:
        binary = root / f"{outfit}_{emotion}.png"
        if binary.is_file():
            return sprites_mod._asset_ref(student_id, binary, primary=binary, kind="sprite")
        return None
    primary = root / f"{outfit}_{action}_{emotion}.png"
    if primary.is_file():
        return sprites_mod._asset_ref(student_id, primary, primary=primary, kind="sprite")
    if action.startswith("sc_"):
        bare = root / f"{action}_{emotion}.png"
        if bare.is_file():
            return sprites_mod._asset_ref(student_id, bare, primary=primary, kind="sprite")
    return None


def resolve_contextual_sprite(
    student_id: str,
    *,
    emotion: str = "neutral",
    location_id: str = "classroom",
    period_kind: str = "free",
    weather_id: str | None = None,
    verb: str | None = None,
    gender: str | None = None,
    prefer_scene: bool = True,
    student: dict[str, Any] | None = None,
    sprite_hint: dict[str, Any] | None = None,
    stage: str | None = None,
) -> dict[str, Any]:
    """Pick best available sprite for world context; soft-fallback to summer_stand chain."""
    emo = emotion if emotion in sprites_mod.Q_EMOTIONS or emotion == "love" else "neutral"
    # Try mood emotion, then nearby palette, then neutral — burn more of the emotion pack
    emos = [emo]
    if emo != "neutral":
        emos.append("neutral")
    if emo == "anxious":
        emos = ["sad", "shy", "neutral"]
    elif emo == "excited":
        emos = ["happy", "shy", "neutral"]
    # Explicit hint emotion (weekly events)
    if isinstance(sprite_hint, dict) and sprite_hint.get("emotion"):
        he = str(sprite_hint["emotion"])
        if (he in sprites_mod.Q_EMOTIONS or he == "love") and he not in emos:
            emos.insert(0, he)
    pairs = build_oa_candidates(
        location_id=location_id or "classroom",
        period_kind=period_kind or "free",
        weather_id=weather_id,
        verb=verb,
        gender=gender,
        student_id=student_id,
        prefer_scene=prefer_scene,
        mood=emo,
        student=student,
        sprite_hint=sprite_hint,
        stage=stage,
    )
    for outfit, action in pairs:
        try_emos = list(emos)
        if not action and "intimate_selfie" in outfit:
            for extra in _SELFIE_EMOTIONS:
                if extra not in try_emos:
                    try_emos.append(extra)
        for e in try_emos:
            hit = _resolve_exact(student_id, outfit, action, e)
            if hit:
                hit["outfit"] = outfit
                hit["action"] = action or "selfie"
                hit["emotion"] = e
                return hit
    for outfit, action in pairs:
        if not action:
            continue
        for e in emos:
            if action.startswith("sc_") or action.startswith("sig_") or action.startswith("date_"):
                continue
            if action.startswith("end_"):
                continue
            ref = sprites_mod.resolve_student_sprite(
                student_id, outfit=outfit, action=action, emotion=e
            )
            if ref.get("path"):
                ref["outfit"] = outfit
                ref["action"] = action
                ref["emotion"] = e
                return ref
    ref = sprites_mod.resolve_student_sprite(student_id, emotion=emo if emo in sprites_mod.Q_EMOTIONS else "neutral")
    ref["outfit"] = "summer"
    ref["action"] = "stand"
    ref["emotion"] = emo if emo in sprites_mod.Q_EMOTIONS else "neutral"
    return ref


def resolve_for_student(
    student: dict[str, Any],
    save: Any,
    *,
    emotion: str | None = None,
    verb: str | None = None,
    location_id: str | None = None,
    prefer_scene: bool = True,
    sprite_hint: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve using CampusSave calendar + student gender/location."""
    sid = str(student["id"])
    loc = location_id
    if loc is None:
        loc = (save.locations_now or {}).get(sid) or getattr(save, "location_id", None) or "classroom"
    period = None
    try:
        from . import catalog

        period = catalog.period_by_id(save.period_id, save.day_kind)
    except Exception:
        period = None
    kind = str((period or {}).get("kind") or "free")
    mood = emotion
    if not mood:
        mind = (getattr(save, "npc_minds", None) or {}).get(sid) or {}
        mood = str(mind.get("mood") or "neutral")
    hint = sprite_hint
    if hint is None:
        ev = getattr(save, "active_event", None) or {}
        if isinstance(ev, dict) and str(ev.get("talk_npc_id") or "") == sid:
            raw = ev.get("sprite_hint")
            if isinstance(raw, dict):
                hint = raw
    stage = "stranger"
    try:
        edge = rel.find_edge(list(getattr(save, "edges", None) or []), "pc", sid)
        if edge:
            stage = str(edge.get("stage") or "stranger")
    except Exception:
        stage = "stranger"
    return resolve_contextual_sprite(
        sid,
        emotion=str(mood),
        location_id=str(loc),
        period_kind=kind,
        weather_id=getattr(save, "weather_id", None),
        verb=verb,
        gender=str(student.get("gender") or ""),
        prefer_scene=prefer_scene,
        student=student,
        sprite_hint=hint,
        stage=stage,
    )
