"""日终旁白 / 主动消息 / 日记与周回顾（P4）。"""

from __future__ import annotations

import random
from typing import Any

from .china_calendar import day_info
from .memory import MemoryFact, merge_memories
from .social_graph import edges_for_character, load_social_graph
from .world_store import BondShelf, WorldSave


_LOC_SOFT = {
    "home": "待在家里歇着",
    "room": "窝在自己房间里",
    "campus": "在校园晃悠",
    "library": "泡在图书馆",
    "cafe": "去了趟咖啡店",
    "office": "被工作缠着",
    "store": "便利店转了一圈",
    "park": "去坡上透气",
    "forest": "在林间待了会儿",
    "street": "在街上走走停停",
}

_PING_TEMPLATES = [
    "在吗？忽然想起你今天好像没怎么出现。",
    "……忙完了。你还没睡吧？",
    "便利店新上了关东煮。不重要，随口说。",
    "今天有点无聊。你干嘛呢？",
    "看到个东西想丢给你——算了，你在再说。",
    "今晚风挺大。你……还好吗？",
]

_SEASON_SOFT = {
    "spring": "春天风有点软",
    "summer": "夏天热得人心浮",
    "autumn": "秋天空气很清",
    "winter": "冬天夜里偏冷",
}


def _pick_place_phrase(social: Any, day_index: int, period: str = "evening") -> str:
    from .world_engine import resolve_schedule

    slots = list(resolve_schedule(social, day_index).get(period) or social.home_locations or ["home"])
    loc = random.choice(slots) if slots else "home"
    return _LOC_SOFT.get(loc, "在外面转了转")


def craft_offscreen_note(save: WorldSave, character_id: str) -> str:
    """为「今天几乎没见玩家」的角色写 1～2 句昨日日志。"""
    bond = save.bonds.get(character_id)
    if not bond:
        return ""
    # day_index already advanced in end_day; note describes the day that just ended
    ended_day = max(1, save.calendar.day_index - 1)
    info = day_info(ended_day)
    graph = load_social_graph()
    social = graph.characters.get(character_id)
    occ = (social.occupation if social else "") or bond.profile.occupation or "日常"
    place = _pick_place_phrase(social, ended_day) if social else "在外面转了转"
    mood = int(bond.relationship_state.mood or 0)
    fest = str(info.get("festival") or "")
    season = str(info.get("season") or "")

    bits: list[str] = []
    if fest:
        bits.append(f"过{fest}，心里有点乱也有点软")
    elif info.get("is_workday"):
        bits.append(f"作为{occ}，今天照常忙碌")
    else:
        bits.append("难得歇一天，作息有点散")

    bits.append(place)
    season_bit = _SEASON_SOFT.get(season)
    if season_bit and random.random() < 0.45:
        bits.append(season_bit)
    if mood <= -20:
        bits.append("情绪不太高，话更少了")
    elif mood >= 25:
        bits.append("心情还行，偶尔会想起你")

    # 1–3 sentences for stronger "time passed" feel
    if len(bits) >= 3 and random.random() < 0.7:
        return f"{bits[0]}；{bits[1]}。{bits[2]}。那天就这样过去了。"
    if len(bits) >= 2:
        return f"{bits[0]}，{bits[1]}。你不在的时候，日子也照样往前走。"
    return f"{bits[0]}。"


def append_diary_line(bond: BondShelf, line: str, *, max_lines: int = 5) -> BondShelf:
    text = (line or "").strip()
    if not text:
        return bond
    lines = list(bond.living.diary_lines or [])
    lines.append(text)
    bond.living.diary_lines = lines[-max_lines:]
    return bond


def craft_week_review(save: WorldSave, character_id: str) -> str:
    """周日软回顾一句（模板，可点名圈子里的人）。"""
    bond = save.bonds.get(character_id)
    if not bond:
        return ""
    name = bond.profile.name or "她"
    edges = edges_for_character(character_id)
    other_name = ""
    if edges:
        e = random.choice(edges)
        oid = e.b if e.a == character_id else e.a
        other = save.bonds.get(oid)
        other_name = (other.profile.name if other else "") or ""
    talked = int(bond.living.talked_day_index or 0)
    cur = save.calendar.day_index
    days_gap = max(0, cur - talked) if talked else 99
    if other_name and random.random() < 0.5:
        return f"这周好像总和{other_name}有点交集；提起你时语气很淡，像把日子过成了旁白。"
    if days_gap >= 4:
        return f"这周你好像很少出现。{name}把日子过得很满，偶尔还是会在夜里想起你一句没说完的话。"
    if days_gap >= 2:
        return f"这周见过一两面。{name}说不上想念，只是日历翻得比预想快。"
    if bond.living.last_offscreen_note:
        return f"回看这一周：{bond.living.last_offscreen_note[:48]}"
    return f"{name}把这一周过得很普通，偶尔会停下来发呆——时间就这样往前走。"


def craft_pending_ping(bond: BondShelf) -> tuple[str, str]:
    """返回 (正文, kind)。kind: invite | drama | soft。"""
    from .romance_policy import get_romance_policy

    pol = get_romance_policy(bond.character_id) if bond.cast_kind == "romance" else None
    # P7：会倒追且关系够 → 邀约向 ping
    if (
        pol
        and pol.confess_init
        and pol.pursuit == "pursues"
        and not (bond.relationship_state.flags or {}).get("confessed")
        and bond.relationship_state.affinity >= 65
        and random.random() < 0.45
    ):
        return (
            random.choice(
                [
                    "今晚……有空吗？我想见你一面。",
                    "周末要不要出来走走？就我们。",
                    "有句话想当面说。你方便的时候回我。",
                ]
            ),
            "invite",
        )
    if (
        pol
        and pol.rivalry == "interfere"
        and bond.relationship_state.affinity >= 60
        and random.random() < 0.35
    ):
        return (
            random.choice(
                [
                    "你最近是不是特别忙？总感觉……算了，你回我一下。",
                    "听人说你挺热闹的。真的假的？",
                    "在吗。我想确认一件事。",
                ]
            ),
            "drama",
        )
    name_hint = bond.profile.name or ""
    base = random.choice(_PING_TEMPLATES)
    if bond.social_role_to_pc in {"前女友", "前妻"}:
        return (
            random.choice(
                [
                    "……还是发了。当没看见也行。",
                    "随便问问你还好吗。别多想。",
                ]
            ),
            "soft",
        )
    if bond.cast_kind == "neutral" or bond.cast_kind == "linked":
        sisterish = bond.social_role_to_pc in {"妹妹", "合住义妹", "义妹", "亲妹妹"}
        return (
            random.choice(
                [
                    "哥？冰箱又空了。你什么时候回。",
                    "路过便利店，顺便问你在不在附近。",
                    "今晚节目好无聊。你忙你的。",
                ]
                if sisterish
                else [
                    "哟，还活着吗大忙人。",
                    "路过你家那条路，灯没亮。",
                    "有个无聊事想吐槽，你有空再说。",
                ]
            ),
            "soft",
        )
    if name_hint and random.random() < 0.2:
        return base, "soft"
    return base, "soft"


def _draft_invite_appointment(save: WorldSave, character_id: str) -> None:
    """邀约 ping 时预填一条明日傍晚预约草案（已有 pending 则跳过）。不落库。"""
    import uuid

    from .world_store import WorldAppointment

    pending = [
        a
        for a in save.appointments
        if a.status == "pending" and a.character_id == character_id
    ]
    if pending:
        return
    bond = save.bonds.get(character_id)
    if not bond:
        return
    target_day = save.calendar.day_index + 1
    save.appointments.append(
        WorldAppointment(
            id=uuid.uuid4().hex[:12],
            character_id=character_id,
            day_index=target_day,
            period="evening",
            location_id=save.location_id or "cafe",
            label="她约你见面",
            date_id="",
            status="pending",
        )
    )


def apply_end_day_living(save: WorldSave) -> WorldSave:
    """
    在日历已翻到新一天后调用：
    - 为未在「刚结束那一天」交谈的角色写 offscreen + 日记 + 记忆
    - 高好感 romance/neutral 掷骰 pending_ping（思念加权）
    - 若刚结束的是周日：写周回顾
    """
    from .appointments import mark_missed_appointments

    ended_day = max(1, save.calendar.day_index - 1)
    ended_info = day_info(ended_day)
    info = day_info(save.calendar.day_index)  # 新一天（早晨）
    save = mark_missed_appointments(save)

    candidates = [
        cid
        for cid, b in save.bonds.items()
        if b.living.talked_day_index != ended_day
    ]
    from .cast_weights import pick_weighted_ids

    for cid in pick_weighted_ids(candidates, count=6, weight_attr="weekly_focus"):
        bond = save.bonds[cid]
        note = craft_offscreen_note(save, cid)
        if not note:
            continue
        bond.living.last_offscreen_note = note
        bond = append_diary_line(bond, note)
        bond.living.fatigue = min(100, int(bond.living.fatigue) + (8 if info.get("is_workday") else 3))
        fact = MemoryFact(text=f"昨天她：{note}", source="system", tags=["daily_life"])
        bond.memories = merge_memories(bond.memories, [fact])
        save.bonds[cid] = bond

    # 周日刚结束 → 周回顾
    if int(ended_info.get("weekday") or 0) == 7:
        for cid, bond in list(save.bonds.items()):
            if bond.relationship_state.affinity < 40:
                continue
            if bond.cast_kind == "npc":
                continue
            review = craft_week_review(save, cid)
            if review:
                bond.living.last_week_review = review
                save.bonds[cid] = bond

    # clear stale pings then roll new ones
    for cid, bond in list(save.bonds.items()):
        if bond.living.pending_ping and bond.living.talked_day_index == ended_day:
            bond.living.pending_ping = ""
            bond.living.pending_ping_kind = ""
            save.bonds[cid] = bond

    from .cast_weights import drama_multiplier, longing_multiplier, presence_bonus
    from .romance_policy import list_partners

    partners = list_partners(save)
    multi = len(partners) >= 1

    from .character_lores import is_romanceable_cast, normalize_cast_kind

    ping_pool = [
        cid
        for cid, b in save.bonds.items()
        if is_romanceable_cast(b.cast_kind)
        and b.relationship_state.affinity
        >= (55 if normalize_cast_kind(b.cast_kind) == "romance" else 48)
        and b.relationship_state.mood > -35
        and not b.living.pending_ping
    ]
    # presence / drama 高者优先进入掷骰
    ping_pool.sort(
        key=lambda cid: (
            -(
                presence_bonus(cid)
                + (0.15 * drama_multiplier(cid) if multi else 0.0)
            ),
            cid,
        )
    )
    max_pings = 2 if not info.get("is_workday") else 1
    chance = 0.55 if not info.get("is_workday") else 0.32
    n = 0
    for cid in ping_pool:
        if n >= max_pings:
            break
        bond = save.bonds[cid]
        talked = int(bond.living.talked_day_index or 0)
        days_since = (save.calendar.day_index - talked) if talked else 5
        longing = min(0.35, max(0.0, (days_since - 1) * 0.08))
        roll_chance = chance if bond.cast_kind == "romance" else chance * 0.65
        roll_chance = min(0.92, roll_chance + longing + presence_bonus(cid) * 0.25)
        if bond.cast_kind == "romance":
            roll_chance = min(0.95, roll_chance * longing_multiplier(cid))
            if multi:
                roll_chance = min(0.96, roll_chance * (0.85 + 0.15 * drama_multiplier(cid)))
        if random.random() > roll_chance:
            continue
        text, kind = craft_pending_ping(bond)
        bond.living.pending_ping = text
        bond.living.pending_ping_kind = kind
        save.bonds[cid] = bond
        if kind == "invite":
            _draft_invite_appointment(save, cid)
        n += 1

    # light fatigue recovery morning
    for cid, bond in list(save.bonds.items()):
        bond.living.fatigue = max(0, int(bond.living.fatigue) - 12)
        save.bonds[cid] = bond

    from .neglect import apply_end_day_neglect
    from .social_life import apply_end_day_copresence_notes, apply_end_day_rumors, roll_long_statuses

    save = apply_end_day_neglect(save)
    save = roll_long_statuses(save)
    save = apply_end_day_copresence_notes(save)
    save = apply_end_day_rumors(save)
    return save


def collect_hub_pings(save: WorldSave) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for cid, bond in save.bonds.items():
        text = (bond.living.pending_ping or "").strip()
        if not text:
            continue
        preview = text if len(text) <= 14 else text[:14] + "…"
        kind = (bond.living.pending_ping_kind or "soft").strip() or "soft"
        out.append(
            {
                "character_id": cid,
                "name": bond.profile.name or cid,
                "preview": preview,
                "text": text,
                "kind": kind,
            }
        )
    return out[:5]


def collect_hub_week_reviews(save: WorldSave, *, limit: int = 3) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for cid, bond in save.bonds.items():
        text = (bond.living.last_week_review or "").strip()
        if not text:
            continue
        rows.append({"character_id": cid, "name": bond.profile.name or cid, "text": text})
    rows.sort(key=lambda r: save.bonds[r["character_id"]].relationship_state.affinity, reverse=True)
    return rows[:limit]


def lock_day_mood(bond: BondShelf, day_index: int) -> BondShelf:
    if bond.living.day_mood_day != day_index:
        bond.living.day_mood_base = int(bond.relationship_state.mood or 0)
        bond.living.day_mood_day = day_index
    return bond


def mark_talked(bond: BondShelf, day_index: int) -> BondShelf:
    bond.living.talked_day_index = day_index
    bond.living.pending_ping = ""
    bond.living.pending_ping_kind = ""
    if not bond.living.first_met_day:
        bond.living.first_met_day = day_index
    # 见面后清冷落 cold 旗（soft_cold_until 仍可自然到期）
    flags = dict(bond.relationship_state.flags or {})
    if flags.pop("neglect_cold", None) is not None:
        bond.relationship_state = bond.relationship_state.model_copy(update={"flags": flags})
    return bond


def mark_first_date(bond: BondShelf, day_index: int) -> BondShelf:
    if not bond.living.first_date_day:
        bond.living.first_date_day = day_index
    if not bond.living.first_met_day:
        bond.living.first_met_day = day_index
    return bond
