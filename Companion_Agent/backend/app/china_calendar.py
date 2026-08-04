"""2026 中国公历/节假日数据与世界日锚定（P4 锋利时间）。"""

from __future__ import annotations

import json
from datetime import date, timedelta
from functools import lru_cache
from typing import Any

from .config import PROJECT_ROOT

# 默认开档锚定日（与仓库「今天」对齐）
DEFAULT_ANCHOR = date(2026, 7, 15)

_SEASON_BY_MONTH = {
    1: ("winter", "冬"),
    2: ("winter", "冬"),
    3: ("spring", "春"),
    4: ("spring", "春"),
    5: ("spring", "春"),
    6: ("summer", "夏"),
    7: ("summer", "夏"),
    8: ("summer", "夏"),
    9: ("autumn", "秋"),
    10: ("autumn", "秋"),
    11: ("autumn", "秋"),
    12: ("winter", "冬"),
}


@lru_cache(maxsize=1)
def load_china_calendar_extras() -> dict[str, Any]:
    path = PROJECT_ROOT / "data" / "china_calendar_extras.json"
    if not path.is_file():
        return {"days": {}}
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def load_china_calendar_2026() -> dict[str, Any]:
    path = PROJECT_ROOT / "data" / "china_calendar_2026.json"
    if not path.is_file():
        base: dict[str, Any] = {"anchor": DEFAULT_ANCHOR.isoformat(), "days": {}}
    else:
        base = json.loads(path.read_text(encoding="utf-8"))
    extras = load_china_calendar_extras().get("days") or {}
    days = dict(base.get("days") or {})
    for key, entry in extras.items():
        if key not in days:
            days[key] = entry
        else:
            merged = dict(days[key])
            merged.update(entry or {})
            days[key] = merged
    base = dict(base)
    base["days"] = days
    return base


def reload_china_calendar() -> dict[str, Any]:
    load_china_calendar_extras.cache_clear()
    load_china_calendar_2026.cache_clear()
    return load_china_calendar_2026()


def calendar_anchor() -> date:
    raw = load_china_calendar_2026()
    return date.fromisoformat(raw.get("anchor") or DEFAULT_ANCHOR.isoformat())


def resolve_calendar_date(day_index: int, *, anchor: str | None = None) -> date:
    """day_index 从 1 起：开档日为 1。"""
    a = date.fromisoformat(anchor) if anchor else calendar_anchor()
    idx = max(1, int(day_index or 1))
    return a + timedelta(days=idx - 1)


def season_for_month(month: int) -> tuple[str, str]:
    return _SEASON_BY_MONTH.get(int(month), ("summer", "夏"))


def week_index_for_day(day_index: int) -> int:
    """相对开档第几周（day 1–7 → 1）。"""
    return max(1, (max(1, int(day_index)) - 1) // 7 + 1)


def find_next_festival(day_index: int, *, horizon: int = 45) -> dict[str, Any]:
    """扫描近期日历表，返回最近节日（不含今天已在过的可仍返回今天）。"""
    catalog = load_china_calendar_2026()
    days = catalog.get("days") or {}
    for offset in range(0, max(1, horizon) + 1):
        di = int(day_index) + offset
        d = resolve_calendar_date(di)
        entry = days.get(d.isoformat()) or {}
        fest = (entry.get("festival") or "").strip()
        if fest:
            return {
                "festival": fest,
                "day_index": di,
                "date": d.isoformat(),
                "days_to": offset,
            }
    return {"festival": "", "day_index": 0, "date": "", "days_to": -1}


def day_info(day_index: int, *, anchor: str | None = None) -> dict[str, Any]:
    d = resolve_calendar_date(day_index, anchor=anchor)
    key = d.isoformat()
    catalog = load_china_calendar_2026()
    entry = (catalog.get("days") or {}).get(key) or {}
    weekday = d.isoweekday()  # 1=Mon
    is_weekend = weekday >= 6
    is_holiday = bool(entry.get("is_holiday"))
    is_workday = entry.get("is_workday")
    if is_workday is None:
        # 默认：周末休息；工作日上班；法定节假日休息；调休上班日显式写 is_workday=true
        is_workday = (not is_weekend) and (not is_holiday)
    festival = entry.get("festival") or ""
    lunar = entry.get("lunar") or ""
    note = entry.get("note") or ""
    season, season_label = season_for_month(d.month)
    widx = week_index_for_day(day_index)
    nxt = find_next_festival(day_index)
    # 若今天就是节日，next 指向今天；否则指向未来
    if festival:
        days_to_next = 0
        next_festival = festival
    else:
        days_to_next = int(nxt.get("days_to") if nxt.get("days_to") is not None else -1)
        next_festival = str(nxt.get("festival") or "")
    iso = d.isocalendar()
    return {
        "date": key,
        "year": d.year,
        "month": d.month,
        "day": d.day,
        "weekday": weekday,
        "weekday_label": "一二三四五六日"[weekday - 1],
        "is_weekend": is_weekend,
        "is_workday": bool(is_workday),
        "is_holiday": is_holiday or (is_weekend and not bool(entry.get("is_workday"))),
        "festival": festival,
        "lunar": lunar,
        "note": note,
        "label": _public_label(d, festival, bool(is_workday), note),
        "season": season,
        "season_label": season_label,
        "week_index": widx,
        "iso_week": int(iso.week),
        "next_festival": next_festival,
        "days_to_next_festival": days_to_next,
    }


def week_strip(day_index: int) -> list[dict[str, Any]]:
    """今天所在自然周（周一～周日）的 7 天摘要；开档前日期占位。"""
    info = day_info(day_index)
    weekday = int(info["weekday"])  # 1=Mon … 7=Sun
    monday_index = int(day_index) - (weekday - 1)
    out: list[dict[str, Any]] = []
    for i in range(7):
        di = monday_index + i
        if di < 1:
            out.append(
                {
                    "day_index": di,
                    "weekday": i + 1,
                    "weekday_label": "一二三四五六日"[i],
                    "date": "",
                    "month": 0,
                    "day": 0,
                    "is_today": False,
                    "is_padded": True,
                    "festival": "",
                    "is_workday": False,
                    "season_label": "",
                }
            )
            continue
        di_info = day_info(di)
        out.append(
            {
                "day_index": di,
                "weekday": di_info["weekday"],
                "weekday_label": di_info["weekday_label"],
                "date": di_info["date"],
                "month": di_info["month"],
                "day": di_info["day"],
                "is_today": di == int(day_index),
                "is_padded": False,
                "festival": di_info.get("festival") or "",
                "is_workday": bool(di_info.get("is_workday")),
                "season_label": di_info.get("season_label") or "",
            }
        )
    return out


def _public_label(d: date, festival: str, is_workday: bool, note: str) -> str:
    rest = "上班" if is_workday else "休息"
    fest = f" · {festival}" if festival else ""
    extra = f" · {note}" if note and note != festival else ""
    return f"{d.year}年{d.month}月{d.day}日{fest} · {rest}{extra}"


def prompt_calendar_block(day_index: int, *, cast_kind: str = "", occupation: str = "") -> str:
    info = day_info(day_index)
    work_line = "今天要上班/上学" if info["is_workday"] else "今天放假或休息"
    if cast_kind == "npc" and info["is_workday"]:
        work_line = "今天仍在各自生活轨道上忙碌"
    fest = info["festival"] or "无特别节日"
    lunar = info["lunar"] or "—"
    season_label = info.get("season_label") or ""
    fest_extra = ""
    if info.get("festival"):
        fest_extra = "今日有节庆气氛，可自然提到团圆、礼物或放假安排，勿念字段名。"
    next_line = ""
    nxt = info.get("next_festival") or ""
    dto = info.get("days_to_next_festival")
    if nxt and isinstance(dto, int) and dto > 0:
        next_line = f"距「{nxt}」还有约 {dto} 天；"
    elif nxt and dto == 0:
        next_line = f"正赶上「{nxt}」；"
    return (
        f"【今日现实日历】{info['label']}；星期{info['weekday_label']}；"
        f"{season_label}季；农历：{lunar}；节日：{fest}；{work_line}。"
        f"{next_line}"
        f"职业上下文：{occupation or '日常'}。{fest_extra}"
        "请在对话中自然体现精确日期感、季节与忙碌/放假/过节气氛，不要念出系统字段。"
    )


def location_bias_for_day(day_index: int) -> dict[str, float]:
    """地点权重修正：>1 更容易出现。"""
    info = day_info(day_index)
    bias: dict[str, float] = {}
    if info["is_workday"]:
        bias.update({"office": 1.6, "campus": 1.5, "library": 1.2, "home": 0.7})
    else:
        bias.update({"office": 0.35, "campus": 0.6, "home": 1.3, "cafe": 1.4, "street": 1.2, "park": 1.3})
    fest = info.get("festival") or ""
    season = info.get("season") or ""
    if season == "summer":
        bias["park"] = bias.get("park", 1.0) * 1.15
        bias["cafe"] = bias.get("cafe", 1.0) * 1.1
    elif season == "winter":
        bias["home"] = bias.get("home", 1.0) * 1.2
        bias["cafe"] = bias.get("cafe", 1.0) * 1.15
        bias["park"] = bias.get("park", 1.0) * 0.75
    elif season == "spring":
        bias["campus"] = bias.get("campus", 1.0) * 1.1
        bias["park"] = bias.get("park", 1.0) * 1.2
    elif season == "autumn":
        bias["street"] = bias.get("street", 1.0) * 1.1
        bias["park"] = bias.get("park", 1.0) * 1.15
    if "春" in fest or "元旦" in fest or "年" in fest:
        bias["home"] = bias.get("home", 1.0) * 1.7
        bias["cafe"] = bias.get("cafe", 1.0) * 1.15
        bias["office"] = bias.get("office", 1.0) * 0.45
        bias["campus"] = bias.get("campus", 1.0) * 0.55
    if "中秋" in fest or "端午" in fest:
        bias["park"] = bias.get("park", 1.0) * 1.5
        bias["home"] = bias.get("home", 1.0) * 1.45
        bias["office"] = bias.get("office", 1.0) * 0.6
    if "国庆" in fest or "劳动" in fest:
        bias["street"] = bias.get("street", 1.0) * 1.45
        bias["cafe"] = bias.get("cafe", 1.0) * 1.35
        bias["park"] = bias.get("park", 1.0) * 1.25
    if fest:
        for k in ("office", "library"):
            bias[k] = bias.get(k, 1.0) * 0.75
    return bias


def anniversary_match(day_index: int, anchor_day_index: int) -> bool:
    """公历月日匹配：纪念日钩子（同年或跨年同月日）。"""
    if not anchor_day_index or anchor_day_index < 1:
        return False
    if int(day_index) == int(anchor_day_index):
        return False  # 当天发生不算「纪念日」
    a = resolve_calendar_date(anchor_day_index)
    b = resolve_calendar_date(day_index)
    return a.month == b.month and a.day == b.day
