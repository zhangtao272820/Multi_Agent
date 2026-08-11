"""世界日程：出没结算、出行、推进时段/日、约会门槛。"""

from __future__ import annotations

import json
import random
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .config import PROJECT_ROOT
from .scenes import resolve_scene
from .social_graph import load_social_graph, location_index
from .world_store import BondShelf, WorldSave, public_bond_summary, upsert_world_save

_PERIODS = ["morning", "afternoon", "evening", "night"]
_PERIOD_LABELS = {
    "morning": "早晨",
    "afternoon": "下午",
    "evening": "傍晚",
    "night": "夜晚",
}


class DatePage(BaseModel):
    """约会 VN 剧本页（手写；不进 LLM）。"""

    text: str = ""
    voice: str = "narration"  # narration | pc | heroine
    sprite: dict[str, str] = Field(default_factory=dict)
    bg: str = ""


class DateChoice(BaseModel):
    label: str = ""
    goto_page: int | None = None
    flags_set: list[str] = Field(default_factory=list)


class DateDef(BaseModel):
    id: str
    label: str
    location_id: str
    affinity_min: int = 50
    stage_min: str = "friend"
    cast_kinds: list[str] = Field(default_factory=lambda: ["romance"])
    character_ids: list[str] = Field(default_factory=list)
    scene_id: str = ""
    prompt_snippet: str = ""
    """手写剧本页；有则约会走 VN，不再开 LLM 聊天场。"""
    pages: list[DatePage] = Field(default_factory=list)
    choices: list[DateChoice] = Field(default_factory=list)
    rewards: dict[str, Any] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)
    avoid_tags: list[str] = Field(default_factory=list)
    money_cost: int | None = None


class DateCatalog(BaseModel):
    ap_max: int = 5
    travel_cost_default: int = 1
    talk_cost: int = 1
    date_cost: int = 2
    date_money_cost: int = 80
    # 场次边界：每场回合预算 / 每角色每日接触场次 / 离场好感封顶
    scene_talk_turns: int = 6
    scene_date_turns: int = 10
    scene_ping_turns: int = 4
    scene_story_turns: int = 8
    daily_scene_limit: int = 2
    scene_settle_affinity_cap: int = 8
    scene_settle_trust_cap: int = 6
    periods: list[str] = Field(default_factory=lambda: list(_PERIODS))
    period_labels: dict[str, str] = Field(default_factory=lambda: dict(_PERIOD_LABELS))
    dates: list[DateDef] = Field(default_factory=list)


@lru_cache(maxsize=1)
def load_date_catalog() -> DateCatalog:
    path = PROJECT_ROOT / "data" / "date_catalog.json"
    if not path.is_file():
        return DateCatalog()
    return DateCatalog.model_validate(json.loads(path.read_text(encoding="utf-8")))


def period_label(period: str) -> str:
    cat = load_date_catalog()
    return cat.period_labels.get(period) or _PERIOD_LABELS.get(period) or period


def stage_rank(stage_id: str) -> int:
    order = [
        "stranger",
        "acquaintance",
        "friend",
        "close_friend",
        "crush",
        "dating",
        "married",
    ]
    try:
        return order.index(stage_id)
    except ValueError:
        return 0


def sync_weekday_from_china(save: WorldSave) -> WorldSave:
    """以国历 day_info.weekday 为唯一真相。"""
    from .china_calendar import day_info

    info = day_info(save.calendar.day_index)
    save.calendar.weekday = int(info.get("weekday") or save.calendar.weekday or 1)
    return save


def resolve_schedule(social: Any, day_index: int) -> dict[str, list[str]]:
    from .china_calendar import day_info

    info = day_info(day_index)
    if info.get("is_workday"):
        sched = social.schedule_workday or social.schedule or {}
    else:
        sched = social.schedule_rest or social.schedule or {}
    return sched if isinstance(sched, dict) else {}


def _candidate_location_for_period(
    save: WorldSave,
    cid: str,
    social: Any,
    *,
    day: int,
    period: str,
    bias: dict[str, float],
    rng: random.Random,
) -> str | None:
    """若本时段可出没，返回其落点；否则 None。掷骰可复现。"""
    from .cast_weights import drama_multiplier, presence_bonus
    from .china_calendar import week_index_for_day
    from .social_life import presence_allowed, prefer_locations_for_status

    bond = save.bonds.get(cid)
    if not presence_allowed(bond, day):
        return None
    if bond:
        from .life_friction import is_busy_tonight, is_soft_cold

        if is_busy_tonight(bond, day, period):
            return None

    def _roll(base: float) -> bool:
        from .cast_weights import cast_tier, pick_weekly_focus_ids

        p = base * (1.0 + presence_bonus(cid))
        # 非本周焦点且戏份低：再压一层，避免全员平行刷脸
        week = week_index_for_day(day)
        romance_ids = [
            x for x, b in save.bonds.items() if b.cast_kind == "romance"
        ]
        focus = set(pick_weekly_focus_ids(romance_ids, week_index=week, count=2))
        if cid not in focus:
            p *= 0.55 + 0.25 * drama_multiplier(cid)
        # T2 轻副本：晚间/夜间再压，少占美德式偶遇档
        if cast_tier(cid) == "T2" and period in {"evening", "night"}:
            p *= 0.45
        if bond and is_soft_cold(bond, day):
            p *= 0.35
        return rng.random() < max(0.06, min(0.95, p))

    prefer = prefer_locations_for_status(bond, day)
    slots = list(resolve_schedule(social, day).get(period) or social.home_locations or [])
    if prefer:
        for ploc in prefer:
            if ploc in slots or ploc in (social.home_locations or []) or ploc in prefer:
                if _roll(0.85):
                    return ploc
        return None
    for sloc in slots:
        weight = float(bias.get(sloc, 1.0))
        base = 1.0 if weight >= 0.95 else max(0.15, min(1.0, weight))
        if _roll(base):
            return sloc
    if bond and bond.relationship_state.affinity >= 70 and period in {"evening", "night"}:
        for hloc in social.home_locations or []:
            home_base = 0.35 * float(bias.get(hloc, 1.0))
            if _roll(home_base):
                return hloc
    return None


def period_presence_map(save: WorldSave) -> dict[str, str]:
    """本时段全镇：角色 → 所在地点。含 intro 门 + presence_cap。"""
    from .cast_weights import (
        drama_multiplier,
        is_cast_introduced,
        pick_period_active_cast,
        presence_bonus,
        presence_cap_for_day,
    )
    from .china_calendar import location_bias_for_day

    period = save.calendar.period
    day = save.calendar.day_index
    graph = load_social_graph()
    bias = location_bias_for_day(day)
    rng = random.Random(f"who-{day}-{period}")

    introduced = [
        cid for cid in graph.characters.keys() if is_cast_introduced(save, cid)
    ]
    # 先按 cap 收紧「今天可能出门」的人，再掷落点
    active_pool = set(pick_period_active_cast(save, introduced))
    raw: dict[str, str] = {}
    for cid in active_pool:
        social = graph.characters.get(cid)
        if not social:
            continue
        at = _candidate_location_for_period(
            save, cid, social, day=day, period=period, bias=bias, rng=rng
        )
        if at:
            raw[cid] = at

    cap = presence_cap_for_day(day)
    if len(raw) <= cap:
        return raw
    ranked = sorted(
        raw.keys(),
        key=lambda cid: (-drama_multiplier(cid), -presence_bonus(cid), cid),
    )
    return {cid: raw[cid] for cid in ranked[:cap]}


def who_is_here(save: WorldSave, location_id: str | None = None) -> list[str]:
    loc = location_id or save.location_id
    return sorted(cid for cid, at in period_presence_map(save).items() if at == loc)


def _absence_reason(social: Any, *, is_workday: bool, expected_elsewhere: list[str], loc_labels: dict[str, str]) -> str:
    occ = (social.occupation or "").strip()
    elsewhere = [loc_labels.get(x, x) for x in expected_elsewhere[:2] if x]
    place = "或".join(elsewhere) if elsewhere else "别处"
    if is_workday and any(k in occ for k in ("工程", "顾问", "讲师", "实习")):
        return f"听说还在上班，大概在{place}"
    if is_workday and any(k in occ for k in ("高中", "大学", "学生", "社团", "练习生")):
        return f"课业还没结束，多半在{place}"
    if not is_workday:
        return f"休息日行踪不定，也许在{place}"
    if any(k in occ for k in ("咖啡", "店", "花艺")):
        return f"班上好像还忙着，估计在{place}"
    return f"这会儿不在这里，或许去了{place}"


def absence_notes(save: WorldSave, location_id: str | None = None) -> list[dict[str, str]]:
    """可能出现在此处、但本次未在场的角色软文案。"""
    from .cast_weights import is_cast_introduced
    from .china_calendar import day_info
    from .social_life import active_long_status

    loc = location_id or save.location_id
    period = save.calendar.period
    day = save.calendar.day_index
    graph = load_social_graph()
    present = set(who_is_here(save, loc))
    info = day_info(day)
    labels = {l.id: l.label for l in graph.locations}
    notes: list[dict[str, str]] = []
    for cid, social in graph.characters.items():
        if cid in present:
            continue
        if not is_cast_introduced(save, cid):
            continue
        bond = save.bonds.get(cid)
        name = (bond.profile.name if bond and bond.profile else "") or cid
        if bond:
            from .life_friction import girls_night_hint

            gn = girls_night_hint(bond, day, period)
            if gn:
                notes.append({"character_id": cid, "name": name, "reason": gn})
                continue
        st = active_long_status(bond, day) if bond else ""
        slots = list(resolve_schedule(social, day).get(period) or [])
        if st == "trip":
            # 出门中：若日程本该在这，给一句软缺席
            if loc in slots or loc in (social.home_locations or []):
                notes.append({"character_id": cid, "name": name, "reason": "听说这几天出门了，暂时见不着"})
            continue
        if st == "sick" and loc not in {"home", "room"} and loc in slots:
            notes.append({"character_id": cid, "name": name, "reason": "好像不太舒服，多半在家歇着"})
            continue
        if loc not in slots:
            continue
        elsewhere = [x for x in slots if x != loc] or list(social.home_locations or [])
        notes.append(
            {
                "character_id": cid,
                "name": name,
                "reason": _absence_reason(
                    social,
                    is_workday=bool(info.get("is_workday")),
                    expected_elsewhere=elsewhere,
                    loc_labels=labels,
                ),
            }
        )
    return notes[:6]


def travel_cost(location_id: str) -> int:
    idx = location_index()
    loc = idx.get(location_id)
    if loc:
        return int(loc.travel_cost)
    return load_date_catalog().travel_cost_default


def can_spend(save: WorldSave, cost: int) -> bool:
    return save.action_points >= cost


def spend_ap(save: WorldSave, cost: int) -> WorldSave:
    save.action_points = max(0, save.action_points - cost)
    return save


def can_afford(save: WorldSave, money: int) -> bool:
    return int(save.protagonist.money) >= int(money)


def spend_money(save: WorldSave, money: int) -> WorldSave:
    amount = max(0, int(money))
    save.protagonist.money = max(0, int(save.protagonist.money) - amount)
    if amount > 0:
        from .life_briefs import note_spend

        note_spend(save, amount)
    return save


def gain_money(save: WorldSave, money: int) -> WorldSave:
    save.protagonist.money = max(0, int(save.protagonist.money) + int(money))
    return save


def adjust_energy(save: WorldSave, delta: int) -> WorldSave:
    save.protagonist.energy = max(0, min(100, int(save.protagonist.energy) + int(delta)))
    return save


def resolve_date_money(date_def: DateDef) -> int:
    from .economy import date_money_cost

    cat = load_date_catalog()
    if date_def.money_cost is not None:
        return date_money_cost(date_def.money_cost)
    return date_money_cost(cat.date_money_cost)


def do_work(save: WorldSave) -> tuple[WorldSave, dict[str, Any]]:
    """工作日在职场上班：扣心力/体力，发日薪。"""
    from .china_calendar import day_info
    from .economy import get_job

    job = get_job(save.protagonist.job_id)
    day = day_info(save.calendar.day_index)
    is_workday = bool(day.get("is_workday"))
    if save.location_id != job.workplace_id:
        return save, {"ok": False, "error": f"要去「{job.workplace_id}」才能上班"}
    if not is_workday:
        return save, {
            "ok": False,
            "error": job.rest_day_note or "今天不用上班",
        }
    if save.protagonist.worked_day_index == save.calendar.day_index:
        return save, {"ok": False, "error": "今天已经上过班了"}
    if not can_spend(save, job.ap_cost):
        return save, {"ok": False, "error": "心力不够，撑不住一整班"}
    if save.protagonist.energy < job.energy_cost:
        return save, {"ok": False, "error": "太累了，先吃点东西再说"}

    save = spend_ap(save, job.ap_cost)
    save = adjust_energy(save, -job.energy_cost)
    # 上班仍叙事「忙完一班」，不再强调领薪进钱包
    save.protagonist.worked_day_index = save.calendar.day_index
    save.protagonist.job_title = job.title
    save.protagonist.workplace_id = job.workplace_id
    from .life_briefs import ensure_day_counters

    save.protagonist = ensure_day_counters(save.protagonist, save.calendar.day_index)
    if save.onboarding_step == "wake":
        save.onboarding_step = "go_out"
    upsert_world_save(save)
    return save, {
        "ok": True,
        "pay": 0,
        "job_title": job.title,
        "action_points": save.action_points,
        "money": save.protagonist.money,
        "energy": save.protagonist.energy,
        "impression": f"忙完一班（{job.title}），今天又过了一截。",
    }


def eat_meal(save: WorldSave, *, meal_id: str) -> tuple[WorldSave, dict[str, Any]]:
    """在对应地点吃饭：扣心力（不扣钱），回体力。"""
    from .economy import load_economy_catalog, meals_at_location

    cat = load_economy_catalog()
    meals = {m.id: m for m in meals_at_location(save.location_id)}
    meal = meals.get(meal_id)
    if not meal:
        return save, {"ok": False, "error": "这里没有这份餐"}
    if save.protagonist.meals_today >= int(cat.meals_per_day_max):
        return save, {"ok": False, "error": "今天已经吃得够多了"}
    if not can_spend(save, meal.ap_cost):
        return save, {"ok": False, "error": "心力不够"}

    if meal.ap_cost:
        save = spend_ap(save, meal.ap_cost)
    save = adjust_energy(save, meal.energy_gain)
    save.protagonist.meals_today = int(save.protagonist.meals_today) + 1
    save.meal_context_period = save.calendar.period
    upsert_world_save(save)
    return save, {
        "ok": True,
        "meal_id": meal.id,
        "label": meal.label,
        "money_spent": 0,
        "action_points": save.action_points,
        "money": save.protagonist.money,
        "energy": save.protagonist.energy,
        "impression": f"吃了「{meal.label}」，感觉好一点了。",
    }


def travel(save: WorldSave, location_id: str) -> tuple[WorldSave, dict[str, Any]]:
    locs = location_index()
    if location_id not in locs:
        return save, {"ok": False, "error": "未知地点"}
    if save.location_id == location_id:
        return save, {
            "ok": True,
            "location_id": location_id,
            "present": who_is_here(save, location_id),
            "cost": 0,
        }
    cost = travel_cost(location_id)
    if not can_spend(save, cost):
        return save, {"ok": False, "error": "行动力不足"}
    save = spend_ap(save, cost)
    save.location_id = location_id
    from .life_briefs import note_travel

    note_travel(save)
    if save.onboarding_step == "wake":
        save.onboarding_step = "go_out"
    upsert_world_save(save)
    loc = locs[location_id]
    scene = resolve_scene(scene_id=loc.scene_id or location_id)
    return save, {
        "ok": True,
        "location_id": location_id,
        "label": loc.label,
        "cost": cost,
        "action_points": save.action_points,
        "present": who_is_here(save, location_id),
        "scene": scene,
    }


def advance_period(save: WorldSave, *, allow_day_roll: bool = True) -> WorldSave:
    periods = load_date_catalog().periods or _PERIODS
    try:
        i = periods.index(save.calendar.period)
    except ValueError:
        i = 0
    if i + 1 < len(periods):
        save.calendar.period = periods[i + 1]
    elif allow_day_roll:
        save.calendar.period = periods[0]
        save.calendar.day_index += 1
        save = sync_weekday_from_china(save)
        cat = load_date_catalog()
        save.action_points = save.action_points_max or cat.ap_max
        save.location_id = "home"
    # else: stay at last period (night) until end_day
    save.meal_context_period = ""
    if save.calendar.period == "evening":
        from .life_friction import maybe_roll_girls_night

        save = maybe_roll_girls_night(save)
    return save


def end_day(save: WorldSave) -> tuple[WorldSave, dict[str, Any]]:
    """直接跳到下一天早晨并刷新 AP；写离屏日志与主动消息。"""
    from .economy import load_economy_catalog
    from .living_sim import apply_end_day_living, collect_hub_pings

    cat = load_date_catalog()
    eco = load_economy_catalog()
    # 翻日前：若有未读，留给 soft_tip（睡前未回）
    pre_pings = collect_hub_pings(save)
    soft_tip = ""
    if pre_pings:
        soft_tip = f"睡前你好像还没回{pre_pings[0].get('name') or '她'}……新的一天开始了。"

    save.calendar.day_index += 1
    save = sync_weekday_from_china(save)
    save.calendar.period = "morning"
    save.action_points = save.action_points_max or cat.ap_max
    save.location_id = "home"
    save.meal_context_period = ""
    from .life_briefs import reset_day_brief_on_end_day

    reset_day_brief_on_end_day(save)
    save = adjust_energy(save, int(eco.end_day_energy_gain))
    save = apply_end_day_living(save)
    from .calendar_beats import ensure_week_beat

    save = ensure_week_beat(save)
    from .errands import maybe_assign_errand

    save = maybe_assign_errand(save)
    night_event = None
    pings = collect_hub_pings(save)
    from .social_life import public_rumors

    fresh_rumors = public_rumors(save, limit=2)
    if pings:
        night_event = {
            "type": "ping",
            "character_id": pings[0]["character_id"],
            "message": f"{pings[0]['name']} 发来一条消息：「{pings[0]['preview']}」",
        }
    elif soft_tip:
        night_event = {
            "type": "soft_tip",
            "character_id": pre_pings[0].get("character_id") if pre_pings else "",
            "message": soft_tip,
        }
    elif fresh_rumors:
        night_event = {
            "type": "rumor",
            "character_id": fresh_rumors[0].get("about_id") or "",
            "message": f"夜里听来一句闲话：{fresh_rumors[0].get('text') or ''}",
        }
    elif random.random() < 0.25:
        from .character_lores import is_linked_cast

        neutrals = [
            cid
            for cid, b in save.bonds.items()
            if is_linked_cast(b.cast_kind) or b.cast_kind == "npc"
        ]
        if neutrals:
            pick = random.choice(neutrals)
            night_event = {
                "type": "whisper",
                "character_id": pick,
                "message": f"{save.bonds[pick].profile.name} 似乎在夜里想起了你……",
            }
            save.world_flags[f"night_whisper_{pick}"] = True
    if save.onboarding_step in {"talk", "rollback", "go_out", "meet"}:
        save.onboarding_step = "done"
    upsert_world_save(save)
    from .world_store import public_protagonist

    return save, {
        "ok": True,
        "calendar": save.calendar.model_dump(),
        "action_points": save.action_points,
        "location_id": save.location_id,
        "protagonist": public_protagonist(save),
        "night_event": night_event,
        "soft_tip": soft_tip,
        "pings": pings,
        "rumors": public_rumors(save, limit=5),
    }


def _pref_blob(bond: BondShelf) -> str:
    prefs = bond.preferences
    return " ".join([*(prefs.likes or []), *(prefs.dislikes or []), *(prefs.habits or [])])


def date_preference_conflict(bond: BondShelf, date_def: DateDef) -> str:
    """返回软拒理由；空串表示可约。"""
    blob = _pref_blob(bond)
    likes = " ".join(bond.preferences.likes or [])
    dislikes = " ".join(bond.preferences.dislikes or [])
    for tag in date_def.avoid_tags or []:
        # avoid_tags 命中她的 likes？或标签语义撞 dislikes
        if tag in {"noisy", "crowd"} and any(k in dislikes for k in ("吵", "嘈杂", "集会", "热闹")):
            return "她不太想去太吵的地方"
        if tag in {"sweet", "romantic"} and any(k in dislikes for k in ("腻", "肉麻", "公开")):
            return "这种气氛会让她别扭"
        if tag == "overtime" and any(k in dislikes for k in ("加班", "应酬")):
            return "她已经很累，不想把见面也变成加班续集"
    for tag in date_def.tags or []:
        if tag == "quiet" and any(k in likes for k in ("安静", "雨声", "书", "画画")):
            continue
        if tag == "noisy" and any(k in dislikes for k in ("吵", "嘈杂")):
            return "她说太吵了，改天再说吧"
    # mood / fatigue soft gate
    if bond.relationship_state.mood <= -40:
        return "她今天情绪很低，不太想见外人"
    if bond.living.fatigue >= 75 and date_def.location_id in {"office", "street", "campus"}:
        return "她看起来累坏了，更想回家躺着"
    _ = blob
    return ""


def list_available_dates(save: WorldSave, character_id: str) -> list[dict[str, Any]]:
    from .life_friction import is_soft_cold

    bond = save.bonds.get(character_id)
    if not bond:
        return []
    cat = load_date_catalog()
    out: list[dict[str, Any]] = []
    cold = is_soft_cold(bond, save.calendar.day_index)
    for d in cat.dates:
        if d.cast_kinds and bond.cast_kind not in d.cast_kinds:
            continue
        if d.character_ids and character_id not in d.character_ids:
            continue
        if bond.relationship_state.affinity < d.affinity_min:
            continue
        if stage_rank(bond.relationship_state.stage_id) < stage_rank(d.stage_min):
            continue
        reason = date_preference_conflict(bond, d)
        if not reason and cold:
            reason = "这周她好像不太想见你……先缓缓"
        money = 0
        # 午饭短约：仅下午时段可「现在」履约感；目录里 lunch 标签降价
        if "lunch" in (d.tags or []) and save.calendar.period != "afternoon":
            # 仍可预约，但不算 available_here 强推
            pass
        out.append(
            {
                "id": d.id,
                "label": d.label,
                "location_id": d.location_id,
                "cost": max(1, cat.date_cost - 1) if "lunch" in (d.tags or []) else cat.date_cost,
                "money_cost": money,
                "available_here": d.location_id == save.location_id,
                "soft_reject": bool(reason),
                "reject_reason": reason,
                "tags": list(d.tags or []),
            }
        )
    return out

def get_date_def(date_id: str) -> DateDef | None:
    for d in load_date_catalog().dates:
        if d.id == date_id:
            return d
    return None


def public_date_script(
    date_def: DateDef,
    *,
    character_id: str,
    character_name: str = "",
    default_bg: str = "",
) -> dict[str, Any]:
    """约会 VN 剧本（无 LLM）。缺 pages 时用 label/prompt 合成短占位页。"""
    bg_default = (default_bg or date_def.scene_id or date_def.location_id or "").strip()
    pages: list[dict[str, Any]] = []
    for raw in date_def.pages or []:
        text = (raw.text or "").strip()
        if not text:
            continue
        voice = (raw.voice or "narration").strip().lower() or "narration"
        if voice not in {"narration", "pc", "heroine"}:
            voice = "narration"
        sprite = dict(raw.sprite or {})
        if character_id and "character_id" not in sprite:
            sprite = {**sprite, "character_id": character_id}
        item: dict[str, Any] = {"text": text, "voice": voice}
        if sprite:
            item["sprite"] = sprite
        bg = (raw.bg or bg_default).strip()
        if bg:
            item["bg"] = bg
        pages.append(item)
    if not pages:
        label = (date_def.label or "约会").strip()
        name = (character_name or "她").strip() or "她"
        pages = [
            {
                "text": f"你约了{name}来「{label}」。路上风不硬，心里却有点紧。",
                "voice": "narration",
                "sprite": {"character_id": character_id, "outfit": "date", "emotion": "happy"},
                "bg": bg_default or "cafe",
            },
            {
                "text": "先别想结果。把这一小段时间过好就行。",
                "voice": "pc",
                "sprite": {"character_id": character_id, "outfit": "date", "emotion": "shy"},
                "bg": bg_default or "cafe",
            },
            {
                "text": f"{name}看了你一眼，像在等你开口。",
                "voice": "narration",
                "sprite": {"character_id": character_id, "outfit": "date", "emotion": "happy"},
                "bg": bg_default or "cafe",
            },
        ]
    choices: list[dict[str, Any]] = []
    for c in date_def.choices or []:
        label = (c.label or "").strip()
        if not label:
            continue
        choices.append(
            {
                "label": label,
                "goto_page": c.goto_page,
                "flags_set": list(c.flags_set or []),
            }
        )
    return {
        "date_id": date_def.id,
        "label": date_def.label,
        "character_id": character_id,
        "character_name": character_name,
        "pages": pages,
        "choices": choices,
        "location_id": date_def.location_id,
        "scene_id": date_def.scene_id or date_def.location_id,
    }


def apply_date_rewards(bond: BondShelf, date_def: DateDef) -> BondShelf:
    rewards = date_def.rewards or {}
    rel = bond.relationship_state
    flags = dict(rel.flags or {})
    for f in rewards.get("flags_set") or []:
        flags[str(f)] = True
    affinity = min(100, rel.affinity + int(rewards.get("affinity_delta") or 0))
    trust = min(100, max(0, rel.trust + int(rewards.get("trust_delta") or 0)))
    bond.relationship_state = rel.model_copy(
        update={"affinity": affinity, "trust": trust, "flags": flags}
    )
    return bond


def apply_date_rewards_for_day(bond: BondShelf, date_def: DateDef, day_index: int) -> BondShelf:
    from .living_sim import mark_first_date

    bond = apply_date_rewards(bond, date_def)
    return mark_first_date(bond, day_index)


def advance_period_action(save: WorldSave) -> tuple[WorldSave, dict[str, Any]]:
    """玩家主动度过当前时段（不滚到新一天）。"""
    if save.calendar.period == "night":
        return save, {"ok": False, "error": "已经是夜里，请结束今天"}
    prev = save.calendar.period
    save = advance_period(save, allow_day_roll=False)
    upsert_world_save(save)
    return save, {
        "ok": True,
        "from_period": prev,
        "period": save.calendar.period,
        "period_label": period_label(save.calendar.period),
        "action_points": save.action_points,
    }


def hub_public(save: WorldSave) -> dict[str, Any]:
    from .appointments import date_slots_public, public_appointments
    from .calendar_beats import ensure_week_beat, public_week_beat
    from .china_calendar import day_info, week_strip
    from .economy import get_job, meals_at_location
    from .living_sim import collect_hub_week_reviews
    from .world_store import public_protagonist

    save = ensure_week_beat(save)
    graph = load_social_graph()
    cal_day = day_info(save.calendar.day_index)
    is_workday = bool(cal_day.get("is_workday"))
    job = get_job(save.protagonist.job_id)
    locations = []
    for loc in graph.locations:
        present_ids_at = who_is_here(save, loc.id)
        present_preview = []
        for cid in present_ids_at[:5]:
            bond = save.bonds.get(cid)
            if not bond:
                continue
            present_preview.append(
                {
                    "character_id": cid,
                    "name": bond.profile.name,
                    "theme_color": bond.profile.theme_color or "",
                }
            )
        locations.append(
            {
                **loc.model_dump(),
                "present_count": len(present_ids_at),
                "present": present_preview,
                "travel_cost": travel_cost(loc.id) if loc.id != save.location_id else 0,
            }
        )
    worked_today = save.protagonist.worked_day_index == save.calendar.day_index
    life_actions = {
        "work": {
            "available": save.location_id == job.workplace_id,
            "is_workday": is_workday,
            "already_worked": worked_today,
            "can_work": (
                save.location_id == job.workplace_id
                and is_workday
                and not worked_today
                and save.action_points >= job.ap_cost
                and save.protagonist.energy >= job.energy_cost
            ),
            "job_title": job.title,
            "workplace_id": job.workplace_id,
            "pay": 0,
            "ap_cost": job.ap_cost,
            "energy_cost": job.energy_cost,
            "rest_day_note": job.rest_day_note,
        },
        "meals": [
            {
                "id": m.id,
                "label": m.label,
                "money_cost": 0,
                "ap_cost": m.ap_cost,
                "energy_gain": m.energy_gain,
            }
            for m in meals_at_location(save.location_id)
        ],
        "date_slots": date_slots_public(save),
        "can_advance_period": save.calendar.period != "night",
        "errand": None,
    }
    from .errands import public_active_errand

    life_actions["errand"] = public_active_errand(save)
    from .romance_policy import public_romance_snapshot
    from .cast_weights import pick_weekly_focus_ids, get_cast_weight
    from .life_briefs import today_suggestions, day1_guidance
    from .life_friction import ending_soft_hints, public_weather, story_soft_hints
    from .social_life import public_copresence_note

    romance_ids = [cid for cid, b in save.bonds.items() if b.cast_kind == "romance"]
    focus_ids = pick_weekly_focus_ids(
        romance_ids,
        week_index=int(cal_day.get("week_index") or 1),
        count=2,
    )
    weekly_focus = [
        {
            "id": cid,
            "name": save.bonds[cid].profile.name if cid in save.bonds else cid,
            "label": get_cast_weight(cid).label,
            "tier": get_cast_weight(cid).tier,
        }
        for cid in focus_ids
        if cid in save.bonds
    ]

    from .background_extras import pick_background_extras

    present_ids = who_is_here(save)
    day1 = day1_guidance(save)
    return {
        "save_id": save.save_id,
        "protagonist_name": save.protagonist_name,
        "protagonist": public_protagonist(save),
        "romance": public_romance_snapshot(save),
        "weekly_focus": weekly_focus,
        "today_suggestions": today_suggestions(save),
        "week_beat": public_week_beat(save),
        "ending_hints": ending_soft_hints(save),
        "story_hints": story_soft_hints(save),
        "weather": public_weather(save),
        "calendar": {
            **save.calendar.model_dump(),
            "period_label": period_label(save.calendar.period),
            "china": cal_day,
            "date_label": cal_day.get("label") or "",
            "season_label": cal_day.get("season_label") or "",
            "week_index": cal_day.get("week_index") or 1,
            "next_festival": cal_day.get("next_festival") or "",
            "days_to_next_festival": cal_day.get("days_to_next_festival"),
        },
        "action_points": save.action_points,
        "action_points_max": save.action_points_max,
        "location_id": save.location_id,
        "onboarding_step": save.onboarding_step,
        "onboarding_gate": day1["onboarding_gate"],
        "day1_recommended_locations": day1["day1_recommended_locations"],
        "day1_recommended_chars": day1["day1_recommended_chars"],
        "locations": locations,
        "present_here": [
            public_bond_summary(save.bonds[cid], day_index=save.calendar.day_index, save=save)
            for cid in present_ids
            if cid in save.bonds
        ],
        "copresence_note": public_copresence_note(save, present_ids=present_ids),
        "background_extras": pick_background_extras(
            save.location_id,
            day_index=save.calendar.day_index,
            seed=save.save_id,
            limit=3,
        ),
        "absence_notes": absence_notes(save),
        "pings": _hub_pings(save),
        "gift_shop": _gift_shop(save),
        "rumors": _hub_rumors(save),
        "status_notes": _hub_status_notes(save),
        "life_actions": life_actions,
        "week_strip": week_strip(save.calendar.day_index),
        "appointments_upcoming": public_appointments(save, limit=6),
        "week_reviews": collect_hub_week_reviews(save, limit=3),
        "waypoints": _hub_waypoints(save),
    }


def _hub_waypoints(save: WorldSave) -> dict[str, Any]:
    from .season_waypoints import public_waypoints

    return public_waypoints(save)


def _hub_rumors(save: WorldSave) -> list[dict[str, Any]]:
    from .social_life import public_rumors

    return public_rumors(save, limit=5)


def _hub_status_notes(save: WorldSave) -> list[dict[str, str]]:
    from .social_life import collect_hub_status_notes

    return collect_hub_status_notes(save)


def _gift_shop(save: WorldSave) -> dict[str, Any]:
    from .gifts import public_store_shop

    return public_store_shop(save)


def _hub_pings(save: WorldSave) -> list[dict[str, str]]:
    from .living_sim import collect_hub_pings

    return collect_hub_pings(save)
