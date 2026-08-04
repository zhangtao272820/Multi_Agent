"""P2：传闻 / 并肩同场 / 长期状态（系统约束，台词交给模型）。"""

from __future__ import annotations

import random
from typing import Any

from .social_graph import SocialEdge, load_social_graph
from .world_store import BondShelf, WorldRumor, WorldSave

_LONG_STATUSES = ("sick", "exam_week", "trip")

_STATUS_SOFT = {
    "sick": "最近身子不太舒服，更想窝着",
    "exam_week": "这阵子考试/DDL 压着，话可能更短",
    "trip": "这几天好像出门去了，不太容易撞见",
}

_STATUS_HUB = {
    "sick": "好像有点不适",
    "exam_week": "最近挺忙",
    "trip": "好像出门了",
}

_TENSION_KEYS = ("警惕", "不自在", "分手", "前司", "微妙", "风声", "吃醋", "竞争")


def active_long_status(bond: BondShelf, day_index: int) -> str:
    st = (bond.living.long_status or "").strip()
    if not st:
        return ""
    until = int(bond.living.long_status_until_day or 0)
    if until and day_index > until:
        return ""
    return st


def soft_status_hint(bond: BondShelf, day_index: int) -> str:
    """看板/Hub 一句近况：长期状态优先，其次疏忽/爽约冷淡。"""
    st = active_long_status(bond, day_index)
    if st:
        return _STATUS_HUB.get(st, "")
    from .life_friction import is_soft_cold

    if is_soft_cold(bond, day_index):
        flags = bond.relationship_state.flags or {}
        if flags.get("neglect_cold") and not flags.get("recently_stood_up"):
            return "近来有些疏远"
        return "这周话少了一点"
    return ""


def long_status_prompt_line(bond: BondShelf, day_index: int) -> str:
    st = active_long_status(bond, day_index)
    if not st:
        return ""
    return _STATUS_SOFT.get(st, "她这阵子状态有点特别")


def expire_long_statuses(save: WorldSave) -> WorldSave:
    day = save.calendar.day_index
    for cid, bond in list(save.bonds.items()):
        st = (bond.living.long_status or "").strip()
        if not st:
            continue
        until = int(bond.living.long_status_until_day or 0)
        if until and day > until:
            bond.living.long_status = ""
            bond.living.long_status_until_day = 0
            save.bonds[cid] = bond
    return save


def _met(bond: BondShelf) -> bool:
    return bond.relationship_state.affinity >= 10 or bond.living.talked_day_index > 0


def roll_long_statuses(save: WorldSave) -> WorldSave:
    """新一天早晨：少量角色进入/刷新长期状态。"""
    save = expire_long_statuses(save)
    day = save.calendar.day_index
    graph = load_social_graph()
    pool = [cid for cid, b in save.bonds.items() if not active_long_status(b, day)]
    random.shuffle(pool)
    assigned = 0
    for cid in pool:
        if assigned >= 2:
            break
        if random.random() > 0.22:
            continue
        bond = save.bonds[cid]
        social = graph.characters.get(cid)
        occ = (social.occupation if social else "") or ""
        # 权重：学生偏 exam，职场偏 trip/sick
        weights: list[tuple[str, float]] = [
            ("sick", 1.0),
            ("trip", 0.7),
            ("exam_week", 0.5),
        ]
        if any(k in occ for k in ("学生", "高中", "大学", "社团", "练习生")):
            weights = [("exam_week", 1.6), ("sick", 1.0), ("trip", 0.5)]
        elif any(k in occ for k in ("工程", "顾问", "讲师", "职场")):
            weights = [("trip", 1.2), ("sick", 1.0), ("exam_week", 0.3)]
        labels = [w[0] for w in weights]
        probs = [w[1] for w in weights]
        total = sum(probs) or 1.0
        r = random.random() * total
        acc = 0.0
        pick = labels[0]
        for lab, p in zip(labels, probs):
            acc += p
            if r <= acc:
                pick = lab
                break
        duration = {"sick": 2, "exam_week": 3, "trip": 2}.get(pick, 2)
        bond.living.long_status = pick
        bond.living.long_status_until_day = day + duration - 1
        if pick == "sick":
            bond.living.fatigue = min(100, int(bond.living.fatigue) + 15)
        elif pick == "exam_week":
            bond.living.fatigue = min(100, int(bond.living.fatigue) + 10)
        save.bonds[cid] = bond
        assigned += 1
    return save


def presence_allowed(bond: BondShelf | None, day_index: int) -> bool:
    """出差/出门中：默认不在任何地点。"""
    if not bond:
        return True
    return active_long_status(bond, day_index) != "trip"


def prefer_locations_for_status(bond: BondShelf | None, day_index: int) -> list[str] | None:
    """返回强制偏好地点；None 表示不干预日程。"""
    if not bond:
        return None
    st = active_long_status(bond, day_index)
    if st == "sick":
        return ["home", "room"]
    if st == "exam_week":
        return ["library", "campus", "home"]
    return None


def _name(save: WorldSave, cid: str) -> str:
    b = save.bonds.get(cid)
    if b and b.profile and b.profile.name:
        return b.profile.name
    return cid


def _edge_visible(edge: SocialEdge, insight: dict[str, bool]) -> bool:
    if not edge.secret:
        return True
    key = edge.flag or f"edge:{edge.a}:{edge.b}"
    return bool(insight.get(key))


def craft_rumor_from_edge(save: WorldSave, edge: SocialEdge) -> WorldRumor | None:
    if not _edge_visible(edge, save.social_insight):
        return None
    a_bond, b_bond = save.bonds.get(edge.a), save.bonds.get(edge.b)
    if not a_bond or not b_bond:
        return None
    # 至少认识其中一方才「听说」
    if not (_met(a_bond) or _met(b_bond)):
        return None
    # 优先以玩家更熟的一方为 about
    if a_bond.relationship_state.affinity >= b_bond.relationship_state.affinity:
        about, other = edge.a, edge.b
    else:
        about, other = edge.b, edge.a
    about_n = _name(save, about)
    other_n = _name(save, other)
    rel = edge.relation or "有点交集"
    tense = any(k in rel for k in _TENSION_KEYS)
    if tense:
        templates = [
            f"有人私下嘀咕：{about_n}和{other_n}之间，{rel}——别当着她们面问。",
            f"路过听见一句：{about_n}提到{other_n}时口气怪怪的。",
            f"小镇闲话：{about_n}跟{other_n}好像有段不好说清的过往。",
        ]
    else:
        templates = [
            f"听说{about_n}和{other_n}走得还算近——{rel}。",
            f"有人看见{about_n}和{other_n}一块出现，像是{rel}。",
            f"闲聊里提到：{about_n}圈子里有{other_n}（{rel}）。",
        ]
    return WorldRumor(
        day=save.calendar.day_index,
        about_id=about,
        text=random.choice(templates),
        source_id=other,
    )


def apply_end_day_rumors(save: WorldSave) -> WorldSave:
    """翻日后采样 0～2 条软传闻；保留最近 8 条。"""
    graph = load_social_graph()
    edges = list(graph.edges)
    random.shuffle(edges)
    added: list[WorldRumor] = []
    for edge in edges:
        if len(added) >= 2:
            break
        if random.random() > 0.45:
            continue
        rumor = craft_rumor_from_edge(save, edge)
        if not rumor:
            continue
        # 避免同一对重复刷屏
        key = frozenset({edge.a, edge.b})
        if any(
            frozenset({r.about_id, r.source_id}) == key for r in (save.rumors or [])[-4:]
        ):
            continue
        added.append(rumor)
    if not added and random.random() < 0.35:
        # 兜底：用 offscreen 角色造一条轻传闻
        cands = [cid for cid, b in save.bonds.items() if _met(b) and b.living.last_offscreen_note]
        if cands:
            cid = random.choice(cands)
            note = save.bonds[cid].living.last_offscreen_note.strip()
            short = note if len(note) <= 28 else note[:28] + "…"
            added.append(
                WorldRumor(
                    day=save.calendar.day_index,
                    about_id=cid,
                    text=f"有人提起{_name(save, cid)}：{short}",
                    source_id="",
                )
            )
    if added:
        save.rumors = list(save.rumors or []) + added
        save.rumors = save.rumors[-8:]
    return save


def public_rumors(save: WorldSave, *, limit: int = 5) -> list[dict[str, Any]]:
    rows = list(save.rumors or [])[-limit:]
    out: list[dict[str, Any]] = []
    for r in reversed(rows):
        about = save.bonds.get(r.about_id)
        out.append(
            {
                "day": r.day,
                "about_id": r.about_id,
                "about_name": (about.profile.name if about else r.about_id),
                "text": r.text,
                "source_id": r.source_id,
            }
        )
    return out


def rumors_for_character(save: WorldSave, character_id: str, *, limit: int = 2) -> list[str]:
    texts: list[str] = []
    for r in reversed(list(save.rumors or [])):
        if r.about_id == character_id or r.source_id == character_id:
            texts.append(r.text)
        if len(texts) >= limit:
            break
    return texts


def _edge_between(a: str, b: str) -> SocialEdge | None:
    for e in load_social_graph().edges:
        if {e.a, e.b} == {a, b}:
            return e
    return None


def copresence_prompt_block(
    save: WorldSave,
    *,
    character_id: str,
    present_ids: list[str],
) -> str:
    """同地点第三人在场 + 可选气氛微妙。"""
    others = [cid for cid in present_ids if cid != character_id]
    if not others:
        return ""
    bits: list[str] = []
    names: list[str] = []
    tension_lines: list[str] = []
    for oid in others[:3]:
        names.append(_name(save, oid))
        edge = _edge_between(character_id, oid)
        if not edge:
            continue
        if not _edge_visible(edge, save.social_insight):
            # 秘密边：只给模型「气氛」不揭关系明文
            if any(k in (edge.relation or "") for k in _TENSION_KEYS):
                tension_lines.append(
                    f"对{_name(save, oid)}的态度有点别扭，别主动解释原因。"
                )
            continue
        rel = edge.relation or "认识"
        if any(k in rel for k in _TENSION_KEYS):
            tension_lines.append(
                f"{_name(save, oid)}也在场（你们是{rel}），气氛可能微妙，勿抢戏、勿念设定。"
            )
        else:
            bits.append(f"{_name(save, oid)}（{rel}）")
    loc_label = save.location_id
    for loc in load_social_graph().locations:
        if loc.id == save.location_id:
            loc_label = loc.label
            break
    line = f"\n【同场】此刻在{loc_label}，除你和她以外还有：{'、'.join(names)}。"
    line += "可自然带过一句存在感，不要让她们抢主对话。"
    if bits:
        line += f" 已知关系：{'；'.join(bits[:3])}。"
    if tension_lines:
        line += " " + " ".join(tension_lines[:2])
    return line


def public_copresence_note(save: WorldSave, *, present_ids: list[str] | None = None) -> str:
    """地点 UI 可见的同场氛围（1 句，不调 LLM）。"""
    from .world_engine import who_is_here

    ids = list(present_ids) if present_ids is not None else who_is_here(save)
    ids = [cid for cid in ids if cid in save.bonds]
    if len(ids) < 2:
        return ""
    names = [_name(save, cid) for cid in ids[:3]]
    loc_label = save.location_id
    for loc in load_social_graph().locations:
        if loc.id == save.location_id:
            loc_label = loc.label
            break
    tension = False
    for i, a in enumerate(ids):
        for b in ids[i + 1 :]:
            edge = _edge_between(a, b)
            if not edge:
                continue
            rel = edge.relation or ""
            if any(k in rel for k in _TENSION_KEYS) or (edge.kind or "") in {
                "rival",
                "ex_circle",
                "gate",
            }:
                tension = True
                break
        if tension:
            break
    if tension and len(names) >= 2:
        return f"{names[0]}和{names[1]}都在{loc_label}——气氛有点微妙"
    if len(names) >= 2:
        return f"{'、'.join(names)}都在{loc_label}"
    return ""


_COPRESENCE_OFFSCREEN = (
    "白天在{loc}撞见了{other}，两人点了点头，没多聊。",
    "听说{other}也在{loc}晃，你们隔着人群对上了一眼。",
    "和{other}在{loc}短暂碰上，气氛平常，却像各怀心事。",
)


def apply_end_day_copresence_notes(save: WorldSave) -> WorldSave:
    """
    日终：若刚结束那天两人同日程地点且有边，追加 offscreen / 传闻（模板）。
    日历已翻到新一天后调用。
    """
    from .memory import MemoryFact, merge_memories
    from .world_engine import resolve_schedule

    ended_day = max(1, save.calendar.day_index - 1)
    graph = load_social_graph()
    loc_to_ids: dict[str, list[str]] = {}
    for cid, bond in save.bonds.items():
        from .character_lores import is_romanceable_cast

        if not is_romanceable_cast(bond.cast_kind):
            continue
        social = graph.characters.get(cid)
        if not social:
            continue
        slots = list(resolve_schedule(social, ended_day).get("evening") or [])
        if not slots:
            slots = list(resolve_schedule(social, ended_day).get("afternoon") or [])
        if not slots:
            continue
        loc = str(slots[0]).strip()
        if not loc:
            continue
        loc_to_ids.setdefault(loc, []).append(cid)

    added_rumor = False
    for loc, cids in loc_to_ids.items():
        if len(cids) < 2:
            continue
        pair: tuple[str, str] | None = None
        for i, a in enumerate(cids):
            for b in cids[i + 1 :]:
                if _edge_between(a, b):
                    pair = (a, b)
                    break
            if pair:
                break
        if not pair:
            continue
        a, b = pair
        loc_label = loc
        for L in graph.locations:
            if L.id == loc:
                loc_label = L.label
                break
        for cid, other in ((a, b), (b, a)):
            bond = save.bonds.get(cid)
            if not bond:
                continue
            if bond.living.talked_day_index == ended_day:
                continue
            other_name = _name(save, other)
            note = random.choice(_COPRESENCE_OFFSCREEN).format(loc=loc_label, other=other_name)
            if not (bond.living.last_offscreen_note or "").strip():
                bond.living.last_offscreen_note = note
            fact = MemoryFact(
                text=f"昨天：{note}",
                source="system",
                tags=["daily_life", "copresence"],
            )
            bond.memories = merge_memories(bond.memories, [fact])
            save.bonds[cid] = bond
        if not added_rumor:
            save.rumors = list(save.rumors or [])
            save.rumors.append(
                WorldRumor(
                    day=save.calendar.day_index,
                    about_id=a,
                    text=f"有人说{_name(save, a)}和{_name(save, b)}白天都在{loc_label}晃。",
                    source_id=b,
                )
            )
            save.rumors = save.rumors[-8:]
            added_rumor = True
        break
    return save


def apply_witness_memories(
    save: WorldSave,
    *,
    talking_id: str,
    present_ids: list[str] | None = None,
) -> WorldSave:
    """
    同场第三人见证：给有边的旁观者写 1 条模板记忆（每日每角色最多 1 条）。
    """
    from .memory import MemoryFact, merge_memories
    from .world_engine import who_is_here

    ids = list(present_ids) if present_ids is not None else who_is_here(save)
    others = [cid for cid in ids if cid != talking_id and cid in save.bonds]
    if not others:
        return save
    talk_bond = save.bonds.get(talking_id)
    talk_name = talk_bond.profile.name if talk_bond else talking_id
    loc_label = save.location_id
    for loc in load_social_graph().locations:
        if loc.id == save.location_id:
            loc_label = loc.label
            break
    day = save.calendar.day_index
    for oid in others[:3]:
        edge = _edge_between(talking_id, oid)
        if not edge:
            continue
        witness = save.bonds.get(oid)
        if not witness:
            continue
        # 每日每角色最多 1 条 witness
        already = any(
            "witness" in (m.tags or [])
            and f"d{day}" in (m.tags or [])
            for m in (witness.memories or [])
        )
        if already:
            continue
        fact = MemoryFact(
            text=f"看见你和{talk_name}在{loc_label}聊了一会儿。",
            source="system",
            tags=["copresence", "witness", f"d{day}"],
        )
        witness.memories = merge_memories(witness.memories, [fact])
        save.bonds[oid] = witness
    return save


def ensemble_tension_present(
    save: WorldSave,
    *,
    character_id: str,
    present_ids: list[str],
) -> bool:
    """当前对话角色与同场他人是否有张力边。"""
    for oid in present_ids:
        if oid == character_id:
            continue
        edge = _edge_between(character_id, oid)
        if not edge:
            continue
        rel = edge.relation or ""
        if any(k in rel for k in _TENSION_KEYS) or (edge.kind or "") in {
            "rival",
            "ex_circle",
            "gate",
        }:
            return True
    return len([c for c in present_ids if c != character_id]) >= 1 and any(
        _edge_between(character_id, oid) for oid in present_ids if oid != character_id
    )


def collect_hub_status_notes(save: WorldSave) -> list[dict[str, str]]:
    """Hub 软展示：谁最近状态不对劲（神秘文案）。"""
    from .life_friction import girls_night_hint

    day = save.calendar.day_index
    period = save.calendar.period
    out: list[dict[str, str]] = []
    for cid, bond in save.bonds.items():
        if not _met(bond):
            continue
        gn = girls_night_hint(bond, day, period)
        hint = gn or soft_status_hint(bond, day)
        if not hint:
            continue
        out.append(
            {
                "character_id": cid,
                "name": bond.profile.name or cid,
                "hint": hint,
            }
        )
    return out[:6]
