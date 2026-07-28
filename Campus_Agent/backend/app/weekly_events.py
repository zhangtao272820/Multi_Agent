"""Weekly scripted events (template, zero LLM) that can open into dialogue."""

from __future__ import annotations

import random
from typing import Any

from . import catalog
from . import relationship as rel
from . import seating as seating_mod
from .campus_store import CampusSave


def week_index(day_index: int) -> int:
    return max(1, min(15, (int(day_index) - 1) // 7 + 1))


def day_in_week(day_index: int) -> int:
    return ((int(day_index) - 1) % 7) + 1


def _resolve_talk_npc(save: CampusSave, talk_npc: str, rng: random.Random) -> str | None:
    kind = (talk_npc or "").strip()
    if not kind:
        return None
    if kind.startswith("f") or kind.startswith("m") or kind == "pc":
        if any(s["id"] == kind and kind != "pc" for s in save.students):
            return kind
        return None

    if kind == "neighbor":
        neigh = seating_mod.neighbors_of(save.seating, "pc")
        if neigh:
            return neigh[0][0]
        return None

    if kind == "affinity":
        pc_edges = [e for e in save.edges if "pc" in {e.get("a"), e.get("b")}]
        pc_edges.sort(key=lambda e: float(e.get("affinity") or 0), reverse=True)
        for e in pc_edges:
            other = e["b"] if e.get("a") == "pc" else e["a"]
            if other != "pc":
                return str(other)
        # fallback first female/male npc
        for s in save.students:
            if s["id"] != "pc":
                return str(s["id"])
        return None

    if kind == "random_present":
        ids = [sid for sid, loc in (save.locations_now or {}).items() if sid != "pc"]
        if not ids:
            ids = [s["id"] for s in save.students if s["id"] != "pc"]
        if ids:
            return str(rng.choice(ids))
        return None

    return None


def pick_weekly_event(save: CampusSave, rng: random.Random | None = None) -> dict[str, Any] | None:
    """Pick a weekly event for today's calendar if it matches week/day_in_week."""
    r = rng or random.Random(f"{save.save_id}-week-{save.day_index}")
    wi = week_index(save.day_index)
    diw = day_in_week(save.day_index)
    pool = [
        e
        for e in (catalog.weekly_events_catalog().get("events") or [])
        if int(e.get("week_index") or 0) == wi and int(e.get("day_in_week") or 0) == diw
    ]
    if not pool:
        return None
    # already fired this event id this run?
    fired = {str(x.get("id")) for x in (save.events or []) if x.get("source") == "weekly"}
    pool = [e for e in pool if str(e.get("id")) not in fired]
    if not pool:
        return None
    cand = pool[0]
    chance = float(cand.get("chance", 1.0))
    if r.random() > chance:
        return None

    talk_id = _resolve_talk_npc(save, str(cand.get("talk_npc") or ""), r)
    # ensure edge exists for talk target
    if talk_id:
        other = next((s for s in save.students if s["id"] == talk_id), None)
        if other:
            rel.ensure_edge(
                save.edges,
                "pc",
                talk_id,
                gender_a="male",
                gender_b=str(other.get("gender")),
            )
        loc = str(cand.get("location_id") or "")
        if loc:
            stick = dict(save.invite_stick or {})
            stick[talk_id] = {"location_id": loc, "ttl": 2}
            save.invite_stick = stick

    out = {
        "id": cand["id"],
        "label": cand.get("label") or cand["id"],
        "blurb": cand.get("blurb") or "",
        "effects": dict(cand.get("effects") or {}),
        "location_id": cand.get("location_id"),
        "talk_npc_id": talk_id,
        "source": "weekly",
        "week_index": wi,
    }
    return out
