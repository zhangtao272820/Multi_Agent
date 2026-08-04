"""P7/P10 生活摩擦：爽约冷淡、午饭槽、消费/天气、闺蜜局、沉默、穿着、结局软提示（全模板）。"""

from __future__ import annotations

import random
from typing import Any

from .china_calendar import day_info
from .memory import MemoryFact, merge_memories
from .world_store import BondShelf, WorldSave


def weather_kind(day_index: int) -> str:
    """模板天气：rain | fair | hot | cold（不调 LLM）。"""
    info = day_info(day_index)
    note = str(info.get("note") or "")
    if "雨" in note or "rain" in note.lower():
        return "rain"
    season = str(info.get("season") or "")
    # 可复现：同 day 同结果
    roll = (int(day_index) * 17 + int(info.get("weekday") or 1) * 3) % 10
    if roll <= 1:
        return "rain"
    if season == "summer" and roll >= 8:
        return "hot"
    if season == "winter" and roll >= 8:
        return "cold"
    return "fair"


def weather_prompt_line(day_index: int) -> str:
    kind = weather_kind(day_index)
    lines = {
        "rain": "外面在下雨。可用口语提伞、湿鞋、想躲雨，勿念系统字样。",
        "hot": "天气偏热。可用口语提口渴、找阴凉，勿念系统字样。",
        "cold": "天气偏冷。可用口语提围巾、手凉，勿念系统字样。",
        "fair": "",
    }
    text = lines.get(kind) or ""
    if not text:
        return ""
    return f"\n【天气】{text}"


def apply_missed_soft_cold(bond: BondShelf, *, until_day: int) -> BondShelf:
    """爽约后一周 soft cold。"""
    bond.living.soft_cold_until_day = max(int(bond.living.soft_cold_until_day or 0), until_day)
    flags = dict(bond.relationship_state.flags or {})
    flags["recently_stood_up"] = True
    bond.relationship_state = bond.relationship_state.model_copy(update={"flags": flags})
    return bond


def is_soft_cold(bond: BondShelf, day_index: int) -> bool:
    until = int(bond.living.soft_cold_until_day or 0)
    return until >= int(day_index)


def soft_cold_prompt_line(bond: BondShelf, day_index: int) -> str:
    if not is_soft_cold(bond, day_index):
        return ""
    flags = bond.relationship_state.flags or {}
    if flags.get("neglect_cold") and not flags.get("recently_stood_up"):
        return (
            "\n【她这阵子】你最近很少找她，她见你时话会少一点、礼貌一点，"
            "不必兴师问罪，但别装作没事；勿念系统字样。"
        )
    return (
        "\n【她这阵子】你上次放了她鸽子，她这周见你时话会少一点、礼貌一点，"
        "不必兴师问罪，但别装作没事；勿念系统字样。"
    )


def note_date_spend_friction(save: WorldSave, character_id: str, *, money_spent: int) -> WorldSave:
    """连续抠门约会 → 记忆 + 计数（阈值后进议程）。"""
    bond = save.bonds.get(character_id)
    if bond is None:
        return save
    life = save.protagonist
    if money_spent <= 25:
        life.stingy_date_streak = int(life.stingy_date_streak or 0) + 1
    else:
        life.stingy_date_streak = 0
    save.protagonist = life
    if life.stingy_date_streak >= 2 and bond.cast_kind == "romance":
        fact = MemoryFact(
            text="最近几次约会他好像总挑很省钱的方式，她心里有点不是滋味。",
            source="system",
            tags=["spend_friction", "daily_life"],
        )
        bond.memories = merge_memories(bond.memories, [fact])
        flags = dict(bond.relationship_state.flags or {})
        flags["feel_stingy_dates"] = True
        bond.relationship_state = bond.relationship_state.model_copy(update={"flags": flags})
        save.bonds[character_id] = bond
    return save


def stingy_agenda_bits(bond: BondShelf) -> tuple[str, str] | None:
    if not (bond.relationship_state.flags or {}).get("feel_stingy_dates"):
        return None
    return (
        "旁敲侧击问问他是不是最近手头紧，别直接骂抠门",
        "最近几次见面好像都挺『节俭』",
    )


def friend_settle_eligible(save: WorldSave, character_id: str) -> bool:
    """Hub 可「定在朋友」：未恋爱确认、朋友带好感、阶段未过 close_friend。"""
    from .world_engine import stage_rank

    bond = save.bonds.get(character_id)
    if not bond or bond.cast_kind != "romance":
        return False
    flags = bond.relationship_state.flags or {}
    if flags.get("ending_ready"):
        return False
    if flags.get("partner_confirmed") or save.world_flags.get(f"partner:{character_id}"):
        return False
    if flags.get("confessed"):
        return False
    st = bond.relationship_state.stage_id or ""
    if stage_rank(st) > stage_rank("close_friend"):
        return False
    aff = int(bond.relationship_state.affinity or 0)
    return 45 <= aff <= 75


def settle_friend_ending(save: WorldSave, character_id: str) -> tuple[WorldSave, dict]:
    """写入 ending_ready；条件满足时立刻 check_endings。"""
    from .game_judge import check_endings, load_ending_meta
    from .world_store import upsert_world_save

    cid = (character_id or "").strip()
    bond = save.bonds.get(cid)
    if not bond or bond.cast_kind != "romance":
        return save, {"ok": False, "error": "无法结算这段关系"}
    if not friend_settle_eligible(save, cid):
        flags = bond.relationship_state.flags or {}
        if flags.get("ending_ready"):
            return save, {"ok": False, "error": "已经定过朋友方向了"}
        return save, {"ok": False, "error": "现在还不太适合定在朋友这边"}

    flags = dict(bond.relationship_state.flags or {})
    flags["ending_ready"] = True
    bond.relationship_state = bond.relationship_state.model_copy(update={"flags": flags})
    save.bonds[cid] = bond

    ending_id = check_endings(
        character_id=cid,
        state=bond.relationship_state,
        runtime={
            "flags": flags,
            "trust": int(bond.relationship_state.trust or 0),
            "low_streak": int(bond.relationship_state.low_streak or 0),
            "cast_role": "romance",
        },
    )
    upsert_world_save(save)
    result: dict = {
        "ok": True,
        "character_id": cid,
        "name": bond.profile.name or cid,
        "ending_ready": True,
        "note": f"和{bond.profile.name or cid}的关系，定在了朋友这边",
    }
    if ending_id:
        meta = load_ending_meta(ending_id)
        result["ending_id"] = ending_id
        if meta:
            result["ending"] = meta
    return save, result


def ending_soft_hints(save: WorldSave, *, limit: int = 2) -> list[dict[str, str]]:
    """Hub 软提示：不泄结局名；朋友带可带 settle_friend 动作。"""
    from .world_engine import stage_rank

    rows: list[tuple[int, dict[str, str]]] = []
    for cid, bond in save.bonds.items():
        if bond.cast_kind != "romance":
            continue
        aff = int(bond.relationship_state.affinity or 0)
        st = bond.relationship_state.stage_id or ""
        flags = bond.relationship_state.flags or {}
        name = bond.profile.name or cid
        score = 0
        text = ""
        action = ""
        if friend_settle_eligible(save, cid):
            score = 95 + aff
            text = f"可以把和{name}的关系，定在朋友这边"
            action = "settle_friend"
        elif flags.get("partner_confirmed") or save.world_flags.get(f"partner:{cid}"):
            if aff >= 78 and stage_rank(st) >= stage_rank("dating"):
                score = 90 + aff
                text = f"和{name}之间，好像离某个结局更近了"
            elif aff >= 70:
                score = 70 + aff
                text = f"和{name}的关系，正悄悄往深处走"
        elif aff >= 72 and stage_rank(st) >= stage_rank("crush"):
            score = 50 + aff
            text = f"和{name}之间，气氛有些不一样了"
        elif aff >= 60 and stage_rank(st) >= stage_rank("friend"):
            score = 30 + aff
            text = f"和{name}越来越熟，故事似乎才刚开头"
        if text:
            row: dict[str, str] = {"character_id": cid, "name": name, "text": text}
            if action:
                row["action"] = action
            rows.append((score, row))
    rows.sort(key=lambda x: -x[0])
    return [r[1] for r in rows[:limit]]


# 幕索引 → 接近触发的软门槛（不泄 YAML affinity 数字给玩家）
_ACT_AFFINITY_FLOOR = (48, 55, 62, 70)
_ACT_STAGE_FLOOR = ("friend", "friend", "close_friend", "crush")


def story_soft_hints(save: WorldSave, *, limit: int = 2) -> list[dict[str, str]]:
    """
    Hub 故事幕软线索：按 story_routes 下一未完成幕给一句倾向，
    只用 title/beat 改写，禁止暴露 flag 名。
    """
    from .route_catalog import load_story_route
    from .world_engine import stage_rank

    rows: list[tuple[int, dict[str, str]]] = []
    for cid, bond in save.bonds.items():
        from .character_lores import is_romanceable_cast

        if not is_romanceable_cast(bond.cast_kind):
            continue
        story = load_story_route(cid)
        if not story:
            continue
        acts = story.get("acts") or []
        if not isinstance(acts, list) or not acts:
            continue
        flags = bond.relationship_state.flags or {}
        aff = int(bond.relationship_state.affinity or 0)
        st = bond.relationship_state.stage_id or ""
        next_act: dict[str, Any] | None = None
        act_i = -1
        for i, act in enumerate(acts):
            if not isinstance(act, dict):
                continue
            need = [str(f) for f in (act.get("flags") or []) if f]
            # confessed 等共享旗：缺任意关键幕旗即视为未完（confessed 可后置）
            core = [f for f in need if f != "confessed"]
            check = core or need
            if check and all(flags.get(f) for f in check):
                continue
            next_act = act
            act_i = i
            break
        if not next_act or act_i < 0:
            continue
        floor_aff = _ACT_AFFINITY_FLOOR[min(act_i, len(_ACT_AFFINITY_FLOOR) - 1)]
        floor_st = _ACT_STAGE_FLOOR[min(act_i, len(_ACT_STAGE_FLOOR) - 1)]
        if aff < floor_aff or stage_rank(st) < stage_rank(floor_st):
            continue
        name = bond.profile.name or cid
        title = str(next_act.get("title") or "").strip()
        beat = str(next_act.get("beat") or "").strip()
        if title and "晚饭" in title:
            text = f"{name}好像还想跟你认真谈谈家里的事——晚饭那档"
        elif title:
            soft_beat = beat.split("；")[0].split("→")[0].strip() if beat else ""
            if soft_beat and len(soft_beat) <= 22:
                text = f"{name}那边，关于「{title}」似乎还悬着：{soft_beat}"
            else:
                text = f"{name}好像还有话想说——「{title}」那一幕还没真正落定"
        else:
            continue
        # 截断防 Hub 刷屏
        if len(text) > 48:
            text = text[:46] + "…"
        score = 40 + aff + act_i * 5
        rows.append(
            (
                score,
                {
                    "character_id": cid,
                    "name": name,
                    "text": text,
                    "act_title": title,
                },
            )
        )
    rows.sort(key=lambda x: -x[0])
    return [r[1] for r in rows[:limit]]


def public_weather(save: WorldSave) -> dict[str, Any]:
    kind = weather_kind(save.calendar.day_index)
    labels = {"rain": "有雨", "hot": "偏热", "cold": "偏冷", "fair": "还行"}
    return {"kind": kind, "label": labels.get(kind, "还行")}


def is_busy_tonight(bond: BondShelf, day_index: int, period: str) -> bool:
    if period not in {"evening", "night"}:
        return False
    return int(bond.living.busy_tonight_day or 0) == int(day_index)


def girls_night_hint(bond: BondShelf, day_index: int, period: str) -> str:
    if not is_busy_tonight(bond, day_index, period):
        return ""
    return "今晚好像和朋友有约"


def maybe_roll_girls_night(save: WorldSave) -> WorldSave:
    """进入 evening 时：对本周焦点 romance 掷骰，至多一人闺蜜局。"""
    if save.calendar.period != "evening":
        return save
    day = save.calendar.day_index
    if any(int(b.living.busy_tonight_day or 0) == day for b in save.bonds.values()):
        return save
    from .cast_weights import drama_multiplier, longing_multiplier, pick_weekly_focus_ids

    info = day_info(day)
    romance_ids = [cid for cid, b in save.bonds.items() if b.cast_kind == "romance"]
    focus = pick_weekly_focus_ids(
        romance_ids,
        week_index=int(info.get("week_index") or 1),
        count=2,
    )
    for cid in focus:
        bond = save.bonds.get(cid)
        if not bond:
            continue
        rng = random.Random(f"girls-night-{day}-{cid}")
        p = 0.18 * drama_multiplier(cid) * (0.85 + 0.15 * longing_multiplier(cid))
        if rng.random() >= min(0.45, p):
            continue
        bond.living.busy_tonight_day = day
        fact = MemoryFact(
            text="今晚她和朋友有约，没空见面。",
            source="system",
            tags=["girls_night", "daily_life"],
        )
        bond.memories = merge_memories(bond.memories, [fact])
        save.bonds[cid] = bond
        break
    return save


def outfit_prompt_line(outfit_id: str) -> str:
    oid = (outfit_id or "").strip()
    lines = {
        "rain": "她穿着方便挡雨的衣服，可口语提伞、湿意，勿念系统字样。",
        "date": "她今天打扮得像有点赴约感，可用口语夸一句，勿念系统字样。",
        "festival_spring": "她穿着偏节日的春装，可用口语提气氛，勿念系统字样。",
        "festival_midautumn": "她穿着偏节日的装扮，可用口语提过节，勿念系统字样。",
        "work": "她穿着偏上班/正式的衣服，可用口语提一句，勿念系统字样。",
        "school": "她穿着偏校园的衣服，可用口语提一句，勿念系统字样。",
        "home": "她穿着居家便装，可用口语提一句，勿念系统字样。",
        "casual": "",
        "bridal": "她穿着婚纱，可用口语轻提仪式感，勿念系统字样。",
        "maternity": "她穿着柔软孕妇装，可用口语温柔关心，勿念系统字样。",
        "intimate_lounge": "她穿着偏私密的居家软装，可用口语害羞亲昵，勿念系统字样。",
        "intimate_lingerie": "她穿着更私密的内衣风居家装，可用口语害羞亲昵，勿念系统字样。",
        "intimate_implied": "她此刻很私密、遮掩着，可用口语害羞亲昵，勿念系统字样。",
    }
    text = lines.get(oid, "")
    if not text and oid.startswith("festival"):
        text = "她穿着偏节日的装扮，可用口语提气氛，勿念系统字样。"
    if not text:
        return ""
    return f"\n【穿着】{text}"


def is_structurally_cold_input(user_text: str) -> bool:
    """仅用长度等结构信号，禁止关键词意图表。"""
    t = (user_text or "").strip()
    if not t:
        return True
    return len(t) <= 4


def silence_agenda() -> tuple[str, str]:
    return (
        "她话变少了，可以短答或慢慢结束话题，别硬找话；勿念系统字样",
        "对方好像有点心不在焉",
    )
