"""Context-aware outfit/action selection for campus sprites.

Deterministic candidate chain from location / period / weather / verb.
Only returns disk-backed files; never blocks on missing art.
Private outfits (casual/pajama/towel) are female-only.
"""

from __future__ import annotations

from typing import Any

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
    "date_chat": "chat",
    "date_stroll": "chat",
    "date_walk_home": "wave",
    "date": "chat",
    "invite": "wave",
}

_RAINY = frozenset({"rainy", "thunderstorm"})


def _is_dorm_room(location_id: str) -> bool:
    return location_id.startswith("dorm_") and location_id != "dorm_gate"


def _is_female(gender: str | None, student_id: str) -> bool:
    if gender:
        return str(gender).lower() == "female"
    return student_id.startswith("f")


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
            out.extend(["pajama", "casual"])
        else:
            out.extend(["casual", "pajama"])
        # towel is optional private pack; keep late in chain
        out.append("towel")
    if weather_id == "cold":
        out.append("winter")
    out.append("summer")
    # cold already added winter; still allow winter as soft preference after summer? no
    # de-dupe preserving order
    seen: set[str] = set()
    ordered: list[str] = []
    for o in out:
        if o not in seen:
            seen.add(o)
            ordered.append(o)
    return ordered


def action_candidates(
    *,
    location_id: str,
    period_kind: str,
    weather_id: str | None,
    verb: str | None,
    prefer_scene: bool,
) -> list[str]:
    """Ordered action ids to try (first = preferred)."""
    actions: list[str] = []
    v = (verb or "").strip().lower() or None
    if v and v in _VERB_ACTION:
        actions.append(_VERB_ACTION[v])
    if prefer_scene and not v:
        for sc in _LOCATION_SCENE.get(location_id, ()):
            actions.append(sc)
    if period_kind == "meal" and location_id == "cafeteria":
        actions.append("eat")
    if period_kind == "class":
        actions.append("listen")
    if period_kind in {"free", "free_day"} and location_id == "library":
        actions.append("study")
    if weather_id in _RAINY and location_id in _OUTDOOR:
        actions.append("rain")
    if period_kind in {"dorm", "end"} and _is_dorm_room(location_id):
        actions.append("dorm")
    if v in {"talk", "date_chat", None} and "chat" not in actions:
        if v:
            actions.append("chat")
    actions.append("stand")
    seen: set[str] = set()
    ordered: list[str] = []
    for a in actions:
        if a not in seen:
            seen.add(a)
            ordered.append(a)
    return ordered


_PRIVATE_OUTFITS = frozenset({"casual", "pajama", "towel"})


def build_oa_candidates(
    *,
    location_id: str,
    period_kind: str,
    weather_id: str | None,
    verb: str | None,
    gender: str | None,
    student_id: str,
    prefer_scene: bool = True,
) -> list[tuple[str, str]]:
    """Ordered (outfit, action) pairs.

    Private dorm outfits win over summer sc_*: try casual/pajama stand|dorm first,
    then school outfits with scene/core actions.
    """
    outfits = outfit_candidates(
        location_id=location_id,
        period_kind=period_kind,
        weather_id=weather_id,
        gender=gender,
        student_id=student_id,
    )
    private = [o for o in outfits if o in _PRIVATE_OUTFITS]
    school = [o for o in outfits if o not in _PRIVATE_OUTFITS]

    private_core = action_candidates(
        location_id=location_id,
        period_kind=period_kind,
        weather_id=weather_id,
        verb=verb,
        prefer_scene=False,
    )
    private_actions: list[str] = []
    for a in ("stand", "dorm", *private_core):
        if a not in private_actions and not str(a).startswith("sc_"):
            private_actions.append(a)

    school_actions = action_candidates(
        location_id=location_id,
        period_kind=period_kind,
        weather_id=weather_id,
        verb=verb,
        prefer_scene=prefer_scene,
    )

    pairs: list[tuple[str, str]] = []
    for outfit in private:
        for action in private_actions:
            pairs.append((outfit, action))
    # Outfit-major for school: winter_stand beats summer_sc_* when cold
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
    """Return asset ref if `{outfit}_{action}_{emotion}.png` exists (incl. sc_*)."""
    root = sprites_mod.sprites_root() / student_id
    primary = root / f"{outfit}_{action}_{emotion}.png"
    if primary.is_file():
        return sprites_mod._asset_ref(student_id, primary, primary=primary, kind="sprite")
    # Legacy bare sc_* (no outfit prefix)
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
) -> dict[str, Any]:
    """Pick best available sprite for world context; soft-fallback to summer_stand chain."""
    emo = emotion if emotion in sprites_mod.Q_EMOTIONS else "neutral"
    emos = [emo] if emo == "neutral" else [emo, "neutral"]
    pairs = build_oa_candidates(
        location_id=location_id or "classroom",
        period_kind=period_kind or "free",
        weather_id=weather_id,
        verb=verb,
        gender=gender,
        student_id=student_id,
        prefer_scene=prefer_scene,
    )
    # Pass 1: exact outfit_action_emotion (or sc_action_emotion)
    for outfit, action in pairs:
        for e in emos:
            hit = _resolve_exact(student_id, outfit, action, e)
            if hit:
                hit["outfit"] = outfit
                hit["action"] = action
                hit["emotion"] = e
                return hit
    # Pass 2: allow resolve_student_sprite soft chain per preferred pair (stand within outfit)
    for outfit, action in pairs:
        for e in emos:
            if action.startswith("sc_"):
                continue
            ref = sprites_mod.resolve_student_sprite(
                student_id, outfit=outfit, action=action, emotion=e
            )
            if ref.get("path"):
                ref["outfit"] = outfit
                ref["action"] = action
                ref["emotion"] = e
                return ref
    # Final
    ref = sprites_mod.resolve_student_sprite(student_id, emotion=emo)
    ref["outfit"] = "summer"
    ref["action"] = "stand"
    ref["emotion"] = emo
    return ref


def resolve_for_student(
    student: dict[str, Any],
    save: Any,
    *,
    emotion: str | None = None,
    verb: str | None = None,
    location_id: str | None = None,
    prefer_scene: bool = True,
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
    return resolve_contextual_sprite(
        sid,
        emotion=str(mood),
        location_id=str(loc),
        period_kind=kind,
        weather_id=getattr(save, "weather_id", None),
        verb=verb,
        gender=str(student.get("gender") or ""),
        prefer_scene=prefer_scene,
    )

