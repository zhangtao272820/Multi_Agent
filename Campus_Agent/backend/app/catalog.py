from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from .config import data_dir


def _load_json(name: str) -> Any:
    path = data_dir() / name
    with path.open(encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def campus_map() -> dict[str, Any]:
    return _load_json("campus_map.json")


@lru_cache(maxsize=1)
def class_roster() -> dict[str, Any]:
    return _load_json("class_roster.json")


@lru_cache(maxsize=1)
def personality_catalog() -> dict[str, Any]:
    return _load_json("personality_catalog.json")


@lru_cache(maxsize=1)
def subjects_catalog() -> dict[str, Any]:
    return _load_json("subjects_catalog.json")


@lru_cache(maxsize=1)
def dorms() -> dict[str, Any]:
    return _load_json("dorms.json")


@lru_cache(maxsize=1)
def sprite_budget() -> dict[str, Any]:
    return _load_json("sprite_budget.json")


@lru_cache(maxsize=1)
def weather_catalog() -> dict[str, Any]:
    return _load_json("weather_catalog.json")


@lru_cache(maxsize=1)
def weekly_events_catalog() -> dict[str, Any]:
    return _load_json("weekly_events.json")


def periods_for_day_kind(day_kind: str) -> list[dict[str, Any]]:
    cmap = campus_map()
    if day_kind == "weekend":
        return list(cmap.get("weekend_periods") or cmap["periods"])
    return list(cmap.get("weekday_periods") or cmap["periods"])


def period_ids(day_kind: str = "weekday") -> list[str]:
    return [p["id"] for p in periods_for_day_kind(day_kind)]


def period_by_id(period_id: str, day_kind: str = "weekday") -> dict[str, Any] | None:
    for p in periods_for_day_kind(day_kind):
        if p["id"] == period_id:
            return p
    for p in periods_for_day_kind("weekend" if day_kind == "weekday" else "weekday"):
        if p["id"] == period_id:
            return p
    return None


def location_ids() -> set[str]:
    return {loc["id"] for loc in campus_map()["locations"]}


def grade_tier_ids() -> set[str]:
    return {g["id"] for g in personality_catalog()["grade_tiers"]}


def mbti_types() -> set[str]:
    return set(personality_catalog()["mbti_types"])


def reload_catalogs() -> None:
    for fn in (
        campus_map,
        class_roster,
        personality_catalog,
        subjects_catalog,
        dorms,
        sprite_budget,
        weather_catalog,
        weekly_events_catalog,
    ):
        fn.cache_clear()
