"""P7：当日生活简报、今日建议、议程软选项（模板，不调 LLM）。"""

from __future__ import annotations

from typing import Any

from .character_lores import is_romanceable_cast
from .scene_agenda import SceneAgenda
from .world_store import BondShelf, ProtagonistLife, WorldSave


def ensure_day_counters(life: ProtagonistLife, day_index: int) -> ProtagonistLife:
    """跨日重置当日计数。"""
    if int(getattr(life, "brief_day", 0) or 0) != day_index:
        life.brief_day = day_index
        life.travels_today = 0
        life.spent_today = 0
    return life


def note_travel(save: WorldSave) -> None:
    life = ensure_day_counters(save.protagonist, save.calendar.day_index)
    life.travels_today = int(life.travels_today or 0) + 1
    save.protagonist = life


def note_spend(save: WorldSave, amount: int) -> None:
    if amount <= 0:
        return
    life = ensure_day_counters(save.protagonist, save.calendar.day_index)
    life.spent_today = int(life.spent_today or 0) + int(amount)
    save.protagonist = life


def reset_day_brief_on_end_day(save: WorldSave) -> None:
    life = save.protagonist
    # 夜聊够多 → 次日简报「昨晚聊到很晚」
    if int(life.night_chat_turns or 0) >= 3:
        life.late_night_brief_day = save.calendar.day_index
    life.night_chat_turns = 0
    life.travels_today = 0
    life.spent_today = 0
    life.brief_day = save.calendar.day_index
    life.meals_today = 0
    save.protagonist = life


def note_night_chat(save: WorldSave) -> None:
    """夜时段每轮对话 +1（达阈值后日终写入 late_night_brief_day）。"""
    if save.calendar.period != "night":
        return
    life = ensure_day_counters(save.protagonist, save.calendar.day_index)
    life.night_chat_turns = int(life.night_chat_turns or 0) + 1
    save.protagonist = life


def protagonist_day_brief_line(save: WorldSave) -> str:
    """进 prompt 的男主当日事实（短）。"""
    life = ensure_day_counters(save.protagonist, save.calendar.day_index)
    bits: list[str] = []
    if int(life.late_night_brief_day or 0) == save.calendar.day_index:
        bits.append("昨晚好像聊到很晚")
    if life.worked_day_index == save.calendar.day_index:
        bits.append("上过班")
    if int(life.meals_today or 0) <= 0 and save.calendar.period in {"afternoon", "evening", "night"}:
        bits.append("好像还没好好吃饭")
    elif int(life.meals_today or 0) >= 1:
        bits.append("吃过东西")
    if int(life.travels_today or 0) >= 2:
        bits.append("今天跑了好几个地方")
    if int(life.spent_today or 0) >= 80:
        bits.append("手头花得有点猛")
    elif int(life.spent_today or 0) == 0 and life.worked_day_index == save.calendar.day_index:
        bits.append("今天几乎没怎么花钱")
    if not bits:
        return ""
    return (
        f"\n【对方今天】他今天：{'、'.join(bits)}。"
        "可用口语接一句关心或吐槽，勿念系统字段。"
    )


def heroine_situation_card(save: WorldSave, *, character_id: str, bond: BondShelf) -> str:
    """女主处境卡片（短，占预算）。"""
    from .romance_policy import get_romance_policy, list_partners
    from .social_life import long_status_prompt_line

    bits: list[str] = []
    if bond.living.fatigue >= 55:
        bits.append("有点累")
    status = long_status_prompt_line(bond, save.calendar.day_index)
    if status:
        bits.append(status.replace("【这阵子状态】", "").split("（")[0].strip())
    partners = list_partners(save, exclude_id=character_id)
    if partners and bond.cast_kind in {"romance", "linked", "neutral"}:
        who = "、".join(n for _, n in partners[:2])
        pol = get_romance_policy(character_id)
        if pol.rivalry == "withdraw":
            bits.append(f"隐约知道他和{who}走近，想留体面")
        elif pol.rivalry == "interfere":
            bits.append(f"介意他和{who}走得近")
        else:
            bits.append(f"想问清他和{who}的事")
    pending = [
        a
        for a in save.appointments
        if a.status == "pending" and a.character_id == character_id
    ]
    if pending:
        bits.append("心里惦记着和你们的约")
    if not bits:
        return ""
    return (
        f"\n【她此刻】{('；'.join(bits[:3]))}。"
        "用口吻体现，不要罗列条目，勿念系统字样。"
    )


def soft_choices_for_agenda(agenda: SceneAgenda | dict[str, Any] | None) -> list[str]:
    """系统保证 2～3 条软选项（可点可忽略）；议程弱时仍给通用开场。"""
    _DEFAULT = ["嗯，我在听。", "今天过得怎么样？", "……其实我有点话想说。"]
    if not agenda:
        return list(_DEFAULT)
    if isinstance(agenda, dict):
        source = str(agenda.get("source") or "")
        goal = str(agenda.get("goal") or "")
        hint = bool(agenda.get("soft_choices_hint", True))
    else:
        source = agenda.source or ""
        goal = agenda.goal or ""
        hint = bool(agenda.soft_choices_hint)
    if not hint:
        return list(_DEFAULT)
    by_source: dict[str, list[str]] = {
        "appointment": ["说到我们约好的事……", "最近还顺利吗？", "要不要确认一下时间？"],
        "rivalry": ["你最近是不是很忙？", "……我好像听说了点什么。", "今天只想好好聊聊你。"],
        "date": ["今天这样挺好。", "接下来想去哪儿？", "其实我有件事想说。"],
        "festival": ["要不要一起过节？", "今晚各回各家也行。", "你记得今天是什么日子吗？"],
        "anniversary": ["总觉得今天有点熟悉。", "你还记得以前吗？", "……没什么，当我多想。"],
        "longing": ["这段时间都在忙什么？", "我有点想听你说话。", "下次还能再见吗？"],
        "pursuit": ["我……有句话想说。", "你现在方便听我说吗？", "要不要改天单独见一面？"],
        "quest": ["你最近在忙什么？", "有什么想跟我分享的吗？", "……其实我也有点话想说。"],
        "cold": ["……上次的事，我想说声抱歉。", "这周你还好吗？", "要不我先走？"],
        "spend": ["最近是不是手头紧？", "其实换个地方也行……", "你开心就好。"],
        "silence": ["……我先走了？", "你还想聊吗？", "那就这样吧。"],
        "errand": ["那件小事我办好了。", "你说的事，我记着呢。", "还要我帮什么吗？"],
        "ensemble": ["旁边那位……", "先当没看见吧。", "要不要换个安静点的地方？"],
        "stage_consent": ["……好，我们确认这一步。", "先这样吧，我想再想想。", "你呢，怎么想？"],
        "confession_consent": ["……我也是。", "对不起，我还没准备好。", "让我想想。"],
        "chat": list(_DEFAULT),
    }
    choices = list(by_source.get(source) or [])
    if not choices and goal:
        # 贴议程目标，避免「换话题」主持人口吻
        short = goal.strip()[:18]
        choices = [
            f"关于{short}……",
            "嗯，我在听。",
            "……其实我也想说说近况。",
        ]
    if not choices:
        choices = list(_DEFAULT)
    return choices[:3]


def today_suggestions(save: WorldSave) -> list[dict[str, str]]:
    """Hub 今日建议 ≤3 条（不泄 flag）。"""
    from .cast_weights import early_meet_ranked, pick_weekly_focus_ids
    from .china_calendar import day_info
    from .economy import get_job
    from .living_sim import collect_hub_pings

    out: list[dict[str, str]] = []
    day = save.calendar.day_index
    info = day_info(day)
    job = get_job(save.protagonist.job_id)
    pings = collect_hub_pings(save)

    # -1) 本周社群节拍（Persona 感硬事件文案）
    from .calendar_beats import week_beat_suggestion

    wb = week_beat_suggestion(save)
    if wb and wb.get("text") and len(out) < 3:
        out.append(
            {
                "kind": str(wb.get("kind") or "guide"),
                "text": str(wb["text"]),
                "target_id": "",
            }
        )

    # -0.5) 关系待确认（阶段递进 / 女主表白）— 不泄 flag 名
    if len(out) < 3:
        for cid, bond in save.bonds.items():
            if bond.cast_kind != "romance":
                continue
            name = bond.profile.name or cid
            pending = (getattr(bond.relationship_state, "pending_stage_id", None) or "").strip()
            flags = bond.relationship_state.flags or {}
            if pending:
                lab = {"crush": "暧昧", "dating": "正式交往", "married": "更进一步"}.get(
                    pending, "下一步"
                )
                out.append(
                    {
                        "kind": "relation",
                        "text": f"和{name}之间，好像可以确认「{lab}」了——见面时表个态",
                        "target_id": cid,
                    }
                )
                break
            if flags.get("pending_confession"):
                out.append(
                    {
                        "kind": "relation",
                        "text": f"{name}好像有话想对你说——见面时听听她",
                        "target_id": cid,
                    }
                )
                break

    # 0) 昨晚聊太晚
    if int(save.protagonist.late_night_brief_day or 0) == day and len(out) < 3:
        out.append(
            {
                "kind": "rest",
                "text": "昨晚聊太晚了，今天心力更紧——先别排太满",
                "target_id": "",
            }
        )

    # 0a) 夜里有未读 → 睡前优先回消息
    if save.calendar.period == "night" and pings:
        p0 = pings[0]
        out.append(
            {
                "kind": "bedtime",
                "text": f"睡前要不要先回一句：{p0.get('name') or '有人'}的消息",
                "target_id": str(p0.get("character_id") or ""),
            }
        )

    # 0b) 共同待办
    from .errands import public_active_errand

    err = public_active_errand(save)
    if err and len(out) < 3:
        out.append(
            {
                "kind": "errand",
                "text": f"待办：{err.get('label')}（去{err.get('location_id')}）",
                "target_id": str(err.get("location_id") or ""),
            }
        )

    # 1) 预约优先
    for a in sorted(
        [x for x in save.appointments if x.status == "pending"],
        key=lambda x: x.day_index,
    ):
        if a.day_index == day:
            bond = save.bonds.get(a.character_id)
            name = bond.profile.name if bond else a.character_id
            out.append(
                {
                    "kind": "appointment",
                    "text": f"今天和{name}有约：{a.label}",
                    "target_id": a.character_id,
                }
            )
            break
        if a.day_index == day + 1 and len(out) == 0:
            bond = save.bonds.get(a.character_id)
            name = bond.profile.name if bond else a.character_id
            out.append(
                {
                    "kind": "appointment",
                    "text": f"明天和{name}有约，记得留心力",
                    "target_id": a.character_id,
                }
            )
            break

    # 2) 上班 / 吃饭
    worked = save.protagonist.worked_day_index == day
    if info.get("is_workday") and not worked and len(out) < 3:
        out.append(
            {
                "kind": "work",
                "text": f"工作日：去「{job.workplace_id}」上个班补钱包",
                "target_id": job.workplace_id,
            }
        )
    if int(save.protagonist.meals_today or 0) <= 0 and save.calendar.period in {
        "afternoon",
        "evening",
        "night",
    }:
        if len(out) < 3:
            out.append({"kind": "meal", "text": "还没吃饭？便利店或咖啡店垫一口", "target_id": "store"})

    # 3) ping / 本周焦点 / 开局推荐
    for cid, bond in save.bonds.items():
        if (bond.living.pending_ping or "").strip() and len(out) < 3:
            # 夜里已有 bedtime 时跳过重复 ping 条
            if not any(r.get("kind") == "bedtime" and r.get("target_id") == cid for r in out):
                out.append(
                    {
                        "kind": "ping",
                        "text": f"{bond.profile.name} 发来消息，要不要回一句",
                        "target_id": cid,
                    }
                )
            break

    if len(out) < 3:
        romance_ids = [cid for cid, b in save.bonds.items() if b.cast_kind == "romance"]
        focus = pick_weekly_focus_ids(
            romance_ids,
            week_index=int(info.get("week_index") or 1),
            count=2,
        )
        for cid in focus:
            if len(out) >= 3:
                break
            bond = save.bonds.get(cid)
            if not bond:
                continue
            out.append(
                {
                    "kind": "focus",
                    "text": f"本周想见到：{bond.profile.name}",
                    "target_id": cid,
                }
            )

    if save.onboarding_step in {"wake", "go_out", "meet", "talk"} and save.calendar.day_index <= 1:
        # Day1 引导优先插入，占一条建议位
        step = save.onboarding_step
        if step == "wake":
            guide = {
                "kind": "guide",
                "text": "先出门：自宅附近、咖啡店，或工作日去公司（心力 1）",
                "target_id": "home",
            }
        elif step == "go_out":
            guide = {
                "kind": "guide",
                "text": "到了。点「进入 · 聊聊」，看看谁在这个时段出现",
                "target_id": save.location_id,
            }
        elif step == "meet":
            ranked = early_meet_ranked(
                [cid for cid, b in save.bonds.items() if is_romanceable_cast(b.cast_kind)],
                limit=1,
            )
            name = ""
            tid = ranked[0] if ranked else ""
            if tid and tid in save.bonds:
                name = save.bonds[tid].profile.name
            guide = {
                "kind": "guide",
                "text": f"选一个人「聊聊」——优先邻居、咖啡店熟人，或回家见妹妹{('：' + name) if name else ''}",
                "target_id": tid,
            }
        else:
            guide = {
                "kind": "guide",
                "text": "聊几句就好。可以继续找人，或点「结束今天」收束第一天",
                "target_id": "",
            }
        out.insert(0, guide)
        # 去掉多余同 kind，保持 ≤3
        out = out[:3]
    elif len(out) < 3 and save.onboarding_step in {"wake", "go_out", "meet"}:
        ranked = early_meet_ranked(
            [cid for cid, b in save.bonds.items() if b.cast_kind == "romance"],
            limit=1,
        )
        if ranked:
            bond = save.bonds.get(ranked[0])
            if bond:
                out.append(
                    {
                        "kind": "guide",
                        "text": f"先去找容易遇见的人：{bond.profile.name}",
                        "target_id": ranked[0],
                    }
                )

    if info.get("festival") and len(out) < 3:
        out.append(
            {
                "kind": "festival",
                "text": f"今天是{info['festival']}，适合出门见人",
                "target_id": "",
            }
        )

    # 线索：按相处进度推一条（不泄 flag / 数字）
    if len(out) < 3:
        from .quest_engine import evaluate_quest_progress
        from .save_store import GameRuntime

        candidates = sorted(
            (
                (cid, b)
                for cid, b in save.bonds.items()
                if b.cast_kind == "romance"
                and (int(b.relationship_state.turns or 0) > 0 or int(getattr(b, "message_count", 0) or 0) > 0
                     or len(b.messages or []) > 0)
            ),
            key=lambda x: int(x[1].relationship_state.affinity or 0),
            reverse=True,
        )
        for cid, bond in candidates[:4]:
            prog = evaluate_quest_progress(
                character_id=cid,
                base_id=bond.base_id or cid,
                growth_mode=bond.relationship_state.growth_mode or "progressive",
                state=bond.relationship_state,
                runtime=GameRuntime(),
            )
            active = prog.get("active")
            if not active:
                continue
            label = str(active.get("label") or "").strip()
            if not label:
                continue
            out.append(
                {
                    "kind": "quest",
                    "text": f"线索：和{bond.profile.name}——{label}",
                    "target_id": cid,
                }
            )
            break

    # 去重 kind 过多时截断
    seen: set[str] = set()
    uniq: list[dict[str, str]] = []
    for row in out:
        key = f"{row['kind']}:{row.get('target_id')}"
        if key in seen:
            continue
        seen.add(key)
        uniq.append(row)
        if len(uniq) >= 3:
            break
    return uniq


def day1_guidance(save: WorldSave) -> dict[str, Any]:
    """Day1 软引导：推荐地点/角色 + onboarding_gate 开关。"""
    from .cast_weights import early_meet_ranked
    from .china_calendar import day_info
    from .economy import get_job

    gate = save.calendar.day_index <= 1 and save.onboarding_step not in {"done", ""}
    if not gate:
        return {
            "onboarding_gate": False,
            "day1_recommended_locations": [],
            "day1_recommended_chars": [],
        }

    info = day_info(save.calendar.day_index)
    is_workday = bool(info.get("is_workday"))
    job = get_job(save.protagonist.job_id)
    locs = ["home", "cafe"]
    if is_workday:
        locs.append(job.workplace_id or "office")
    else:
        locs.append("campus")
    # 去重保序
    seen_l: set[str] = set()
    loc_out: list[str] = []
    for lid in locs:
        if lid and lid not in seen_l:
            seen_l.add(lid)
            loc_out.append(lid)

    pool = [cid for cid, b in save.bonds.items() if is_romanceable_cast(b.cast_kind)]
    ranked = early_meet_ranked(pool, limit=4)
    # 确保家人进推荐（书璃）
    for cid in ("shuli", "xiaoyou", "wanyu"):
        if cid in save.bonds and cid not in ranked:
            ranked.append(cid)
    ranked = ranked[:5]
    chars = [
        {
            "id": cid,
            "name": save.bonds[cid].profile.name if cid in save.bonds else cid,
            "role": save.bonds[cid].social_role_to_pc if cid in save.bonds else "",
        }
        for cid in ranked
        if cid in save.bonds
    ]
    return {
        "onboarding_gate": True,
        "day1_recommended_locations": loc_out,
        "day1_recommended_chars": chars,
    }
