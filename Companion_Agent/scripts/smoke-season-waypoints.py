"""Smoke：季度航点跳过 + 中秋/入冬/春节立绘必现（有图角色）。"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.china_calendar import day_info  # noqa: E402
from app.season_waypoints import (  # noqa: E402
    jump_to_next_waypoint,
    jump_to_waypoint,
    list_waypoints,
    public_waypoints,
)
from app.sprite_outfit import available_outfits, festival_outfit_for, resolve_outfit  # noqa: E402
from app.world_store import create_world_save  # noqa: E402


def fail(msg: str) -> None:
    print(f"FAIL {msg}")
    raise SystemExit(1)


def main() -> None:
    wps = list_waypoints()
    if len(wps) < 5:
        fail(f"expected >=5 waypoints, got {len(wps)}")

    save = create_world_save(user_id="smoke-waypoint", protagonist_name="测")
    pub = public_waypoints(save)
    if not pub.get("can_jump_next"):
        fail("fresh save should allow jump to next season")
    if (pub.get("current") or {}).get("id") != "q_summer_start":
        fail(f"start waypoint wrong: {pub.get('current')}")

    # 跳到中秋
    save, res = jump_to_waypoint(save, "q_autumn_midautumn")
    if not res.get("ok"):
        fail(f"jump midautumn: {res}")
    info = day_info(save.calendar.day_index)
    if "中秋" not in str(info.get("festival") or ""):
        fail(f"midautumn day festival={info.get('festival')} date={info.get('date')}")
    if festival_outfit_for(str(info.get("festival") or "")) != "festival_midautumn":
        fail("festival_outfit_for midautumn")

    cid = "xiaoyou"
    have = available_outfits(cid)
    if "festival_midautumn" in have:
        o = resolve_outfit(
            day_index=save.calendar.day_index,
            period="afternoon",
            location_id="street",
            character_id=cid,
        )
        if o != "festival_midautumn":
            fail(f"xiaoyou midautumn outfit got {o}")

    # 入冬
    save, res = jump_to_waypoint(save, "q_winter_onset")
    if not res.get("ok"):
        fail(f"jump winter: {res}")
    info = day_info(save.calendar.day_index)
    if info.get("season") != "winter":
        fail(f"winter season={info.get('season')}")
    if "season_winter" in have:
        o = resolve_outfit(
            day_index=save.calendar.day_index,
            period="afternoon",
            location_id="street",
            character_id=cid,
        )
        if o != "season_winter":
            fail(f"xiaoyou winter outfit got {o}")

    # 除夕
    save, res = jump_to_waypoint(save, "q_spring_festival")
    if not res.get("ok"):
        fail(f"jump spring: {res}")
    info = day_info(save.calendar.day_index)
    fest = str(info.get("festival") or "")
    if fest not in {"除夕", "春节"} and "除夕" not in fest and "春节" not in fest:
        fail(f"spring festival got festival={fest} date={info.get('date')}")
    if festival_outfit_for(fest) != "festival_spring":
        fail(f"festival_outfit_for spring got {festival_outfit_for(fest)}")
    if "festival_spring" in have:
        o = resolve_outfit(
            day_index=save.calendar.day_index,
            period="evening",
            location_id="home",
            character_id=cid,
            affinity=50,
        )
        if o != "festival_spring":
            fail(f"xiaoyou spring festival outfit got {o}")

    # 端午不得挂中秋装
    if festival_outfit_for("端午") != "":
        fail("端午 should not map to midautumn outfit")

    # next after last fails
    save2 = create_world_save(user_id="smoke-waypoint-2", protagonist_name="测")
    save2, _ = jump_to_waypoint(save2, "q_spring_festival")
    save2, res = jump_to_next_waypoint(save2)
    if res.get("ok"):
        fail("jump past last waypoint should fail")

    print("OK smoke-season-waypoints")


if __name__ == "__main__":
    main()
