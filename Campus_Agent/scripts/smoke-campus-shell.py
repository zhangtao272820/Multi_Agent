#!/usr/bin/env python3
"""Smoke: new → classroom present → advance → present changes."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

BASE = "http://127.0.0.1:13116"


def call(method: str, path: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=5) as res:
        return json.loads(res.read().decode("utf-8"))


def main() -> int:
    try:
        health = call("GET", "/api/health")
        use_http = True
        print("health:", health)
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        use_http = False
        print("server offline — running in-process smoke")

    if use_http:
        hub = call(
            "POST",
            "/api/campus/new",
            {"name": "测试生", "grade_tier": "mid", "stats": {"study": 3, "social": 3, "stamina": 3, "luck": 3}},
        )
        assert hub["student_count"] == 35, hub["student_count"]
        pc = next(p for p in hub["present"] if p.get("is_pc"))
        assert "mbti" not in pc or not pc.get("mbti")
        assert hub["protagonist"].get("stats")
        assert hub["calendar"]["period_id"] == "morning_study"
        classroom = call("POST", "/api/campus/travel", {"location_id": "classroom"})
        morning_names = {p["name"] for p in classroom["present"]}
        assert "测试生" in morning_names, morning_names
        assert len(morning_names) >= 5, morning_names
        advanced = call("POST", "/api/campus/advance")
        assert advanced["calendar"]["period_id"] == "breakfast"
        cafe = call("POST", "/api/campus/travel", {"location_id": "cafeteria"})
        cafe_names = {p["name"] for p in cafe["present"]}
        assert "测试生" in cafe_names
        # advance back toward a free period for talk dual-layer check
        # breakfast is meal — still can talk if present
        present = [p for p in cafe["present"] if not p.get("is_pc")]
        if present:
            tid = present[0]["id"]
            prep = call("POST", "/api/campus/talk/prepare", {"target_id": tid})
            assert prep.get("q_sprite") is not None and prep.get("sprite") is not None
            chat = call(
                "POST",
                "/api/campus/chat",
                {"target_id": tid, "text": "食堂见。", "verb": "greet"},
            )
            assert chat.get("q_sprite") is not None
        print("OK http smoke")
        print(" morning classroom:", sorted(morning_names)[:8], "...")
        print(" breakfast cafeteria count:", len(cafe_names))
        return 0

    from app import campus_engine  # type: ignore

    hub = campus_engine.create_new(name="测试生", grade_tier="mid", stats={"study": 3, "social": 3, "stamina": 3, "luck": 3})
    assert hub["student_count"] == 35
    classroom = campus_engine.travel("classroom")
    morning = {p["name"] for p in classroom["present"]}
    assert "测试生" in morning
    advanced = campus_engine.advance_period()
    assert advanced["calendar"]["period_id"] == "breakfast"
    cafe = campus_engine.travel("cafeteria")
    cafe_names = {p["name"] for p in cafe["present"]}
    assert "测试生" in cafe_names
    print("OK in-process smoke")
    print(" morning classroom:", sorted(morning)[:8], "...")
    print(" breakfast cafeteria count:", len(cafe_names))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print("FAIL:", e, file=sys.stderr)
        raise SystemExit(1)
