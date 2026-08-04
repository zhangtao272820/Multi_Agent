"""季度/节日航点：跳过中间空日，落到真实中国日历日。"""

from __future__ import annotations

import json
from datetime import date
from functools import lru_cache
from typing import Any

from .china_calendar import calendar_anchor, day_info, resolve_calendar_date
from .config import PROJECT_ROOT
from .world_store import WorldSave, upsert_world_save


@lru_cache(maxsize=1)
def load_season_waypoints() -> dict[str, Any]:
    path = PROJECT_ROOT / "data" / "season_waypoints.json"
    if not path.is_file():
        return {"waypoints": []}
    return json.loads(path.read_text(encoding="utf-8"))


def reload_season_waypoints() -> dict[str, Any]:
    load_season_waypoints.cache_clear()
    return load_season_waypoints()


def list_waypoints() -> list[dict[str, Any]]:
    rows = list(load_season_waypoints().get("waypoints") or [])
    rows.sort(key=lambda r: int(r.get("order") or 0))
    return rows


def waypoint_by_id(waypoint_id: str) -> dict[str, Any] | None:
    wid = (waypoint_id or "").strip()
    for row in list_waypoints():
        if str(row.get("id") or "") == wid:
            return row
    return None


def day_index_for_date(iso_date: str) -> int:
    """相对日历锚点的 day_index（开档日=1）。"""
    a = calendar_anchor()
    d = date.fromisoformat(str(iso_date).strip())
    return (d - a).days + 1


def enrich_waypoint(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    iso = str(row.get("date") or "")
    di = day_index_for_date(iso) if iso else 1
    out["day_index"] = di
    try:
        info = day_info(di)
        out["date_label"] = info.get("label") or iso
        out["season_label"] = info.get("season_label") or row.get("season") or ""
    except Exception:
        out["date_label"] = iso
        out["season_label"] = str(row.get("season") or "")
    return out


def current_waypoint(save: WorldSave) -> dict[str, Any]:
    wid = (save.waypoint_id or "").strip() or "q_summer_start"
    row = waypoint_by_id(wid) or list_waypoints()[0]
    return enrich_waypoint(row)


def next_waypoint(save: WorldSave) -> dict[str, Any] | None:
    cur = current_waypoint(save)
    order = int(cur.get("order") or 0)
    for row in list_waypoints():
        if int(row.get("order") or 0) == order + 1:
            return enrich_waypoint(row)
    return None


def waypoint_order(waypoint_id: str) -> int:
    row = waypoint_by_id(waypoint_id)
    if not row:
        return -1
    return int(row.get("order") or 0)


def has_reached_ids(
    *,
    waypoint_id: str,
    waypoints_reached: list[str] | None,
    target_id: str,
) -> bool:
    wid = (target_id or "").strip()
    if not wid:
        return True
    reached = set(waypoints_reached or [])
    cur = (waypoint_id or "").strip() or "q_summer_start"
    if wid in reached or cur == wid:
        return True
    return waypoint_order(cur) >= waypoint_order(wid)


def has_reached_waypoint(save: WorldSave, waypoint_id: str) -> bool:
    """当前航点顺序 >= 目标航点顺序，或已记入 reached。"""
    return has_reached_ids(
        waypoint_id=save.waypoint_id or "q_summer_start",
        waypoints_reached=list(save.waypoints_reached or []),
        target_id=waypoint_id,
    )


def public_waypoints(save: WorldSave) -> dict[str, Any]:
    cur = current_waypoint(save)
    nxt = next_waypoint(save)
    return {
        "current": cur,
        "next": nxt,
        "reached": list(save.waypoints_reached or []),
        "can_jump_next": bool(nxt),
        "all": [enrich_waypoint(r) for r in list_waypoints()],
    }


def jump_to_waypoint(
    save: WorldSave,
    waypoint_id: str,
    *,
    allow_backward: bool = False,
) -> tuple[WorldSave, dict[str, Any]]:
    """跳到指定航点：设置 day_index/period，记录 reached，返回过场文案。"""
    target = waypoint_by_id(waypoint_id)
    if not target:
        return save, {"ok": False, "error": "未知航点"}
    enriched = enrich_waypoint(target)
    cur = current_waypoint(save)
    if not allow_backward and int(enriched.get("order") or 0) < int(cur.get("order") or 0):
        return save, {"ok": False, "error": "不能跳回更早的季节"}
    if not allow_backward and int(enriched.get("order") or 0) == int(cur.get("order") or 0):
        return save, {"ok": False, "error": "已在当前季节"}

    di = int(enriched.get("day_index") or 1)
    if di < 1:
        return save, {"ok": False, "error": "航点日期无效"}

    reached = list(save.waypoints_reached or [])
    for row in list_waypoints():
        rid = str(row.get("id") or "")
        if int(row.get("order") or 0) <= int(enriched.get("order") or 0) and rid not in reached:
            reached.append(rid)

    save.waypoint_id = str(target.get("id") or "")
    save.waypoints_reached = reached
    save.calendar.day_index = di
    save.calendar.period = "morning"
    save.location_id = "home"
    save.meal_context_period = ""
    try:
        info = day_info(di)
        save.calendar.weekday = int(info.get("weekday") or save.calendar.weekday or 1)
    except Exception:
        pass

    # 跳过的空日不刷冷落；从新航点日起算
    from .neglect import reset_neglect_anchors_on_waypoint_jump

    save = reset_neglect_anchors_on_waypoint_jump(save)

    upsert_world_save(save)
    return save, {
        "ok": True,
        "waypoint": enriched,
        "transition": list(target.get("transition") or []),
        "outfit_hint": str(target.get("outfit_hint") or ""),
        "calendar": save.calendar.model_dump(),
        "day_info": day_info(di),
    }


def jump_to_next_waypoint(save: WorldSave) -> tuple[WorldSave, dict[str, Any]]:
    nxt = next_waypoint(save)
    if not nxt:
        return save, {"ok": False, "error": "已经是最后一季"}
    return jump_to_waypoint(save, str(nxt.get("id") or ""))
