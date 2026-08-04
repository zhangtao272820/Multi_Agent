"""美德式世界事实 → 女主 prompt 只读注入（系统写事实、模型演反应）。"""

from __future__ import annotations

from typing import Any


def build_world_facts_block(
    *,
    day_index: int,
    period_label: str,
    season_label: str,
    location_label: str,
    weather_line: str = "",
    stage_label: str = "",
    is_weekly_focus: bool = False,
    cast_kind: str = "",
    partner_hint: str = "",
) -> str:
    """组装【世界事实｜只读】；禁止模型编造未写入的行踪/日历。"""
    season = (season_label or "").strip() or "—"
    period = (period_label or "").strip() or "—"
    place = (location_label or "").strip() or "—"
    stage = (stage_label or "").strip() or "相识不久"
    weather = (weather_line or "").strip()
    weather_bit = f"；天气印象：{weather}" if weather else ""
    focus_bit = (
        "本周她是恋爱线焦点之一，可稍积极些。"
        if is_weekly_focus and (cast_kind or "") == "romance"
        else "本周她不是恋爱线焦点；勿自己加戏成全镇中心。"
    )
    cast_bit = ""
    kind = (cast_kind or "").strip().lower()
    if kind in {"linked", "neutral"}:
        cast_bit = "阵营：关系向难攻略（可亲可闹；未过闸门前禁止公开恋人/改称呼）。"
    elif kind == "romance":
        cast_bit = "阵营：可恋爱线（节奏仍由关系与立场决定）。"

    partner = (partner_hint or "").strip()
    partner_bit = f"他身边近况：{partner}" if partner else ""

    from .story_web import story_web_prompt_line

    return (
        f"\n【世界事实｜只读】开档第 {max(1, int(day_index))} 天；"
        f"时段：{period}；季节：{season}季；此刻地点：{place}{weather_bit}。"
        f"关系印象：{stage}。{cast_bit}{focus_bit}{partner_bit}"
        "同场他人、闲话、昨日行踪：仅以本提示中系统已写条目为准；"
        "**禁止编造**未写入的他人行踪、未到的季节/节日、或改写今日是否上班。"
        "独立思考只限在这些事实内用性格回应；禁止念系统字段与精确数值。"
        + story_web_prompt_line()
    )


def short_partner_hint(save: Any, character_id: str) -> str:
    """多伴侣张力短句（控 token，≤40字）。"""
    try:
        from .romance_policy import get_romance_policy, list_partners
    except Exception:
        return ""
    others = list_partners(save, exclude_id=character_id)
    if not others:
        return ""
    names = "、".join(n for _, n in others[:2])
    pol = get_romance_policy(character_id)
    if pol.exclusivity == "exclusive":
        return f"你隐约知道他和{names}走得近，心里不舒服。"
    if pol.rivalry == "interfere":
        return f"他和{names}好像很近，你不想轻易放手。"
    return f"他和{names}走得不远。"


def weekly_focus_for_character(save: Any, character_id: str) -> bool:
    """她是否在本周恋爱焦点（系统算定，供事实块）。"""
    if not save or not character_id:
        return False
    from .cast_weights import pick_weekly_focus_ids
    from .china_calendar import week_index_for_day

    day = int(getattr(getattr(save, "calendar", None), "day_index", 1) or 1)
    week = week_index_for_day(day)
    romance_ids = [
        cid
        for cid, b in (getattr(save, "bonds", None) or {}).items()
        if getattr(b, "cast_kind", "") == "romance"
    ]
    if not romance_ids:
        return False
    return character_id in set(pick_weekly_focus_ids(romance_ids, week_index=week, count=2))
