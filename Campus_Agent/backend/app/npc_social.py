"""NPC↔NPC colocated social tick — free campus romance (mf / ff / mm).

PC is one male student among many; everyone else may date anyone.
"""

from __future__ import annotations

import random
from typing import Any

from . import relationship as rel
from .campus_store import CampusSave
from .prompt_budget import clip

MAX_PAIRS_PER_TICK = 12
MAX_WORLD_EVENTS = 8

_ACTION_TEMPLATES = {
    "study_together": "{a}和{b}在{loc}一起对题。",
    "chat": "{a}和{b}在{loc}闲聊了几句。",
    "flirt": "{a}对{b}多看了两眼，气氛微妙。",
    "date_hang": "情侣档：{a}和{b}黏在{loc}，旁人自动绕开。",
    "confess_try": "{a}鼓起勇气向{b}试探心意……",
    "confess_ok": "{a}和{b}确认了心意，成了班里的一对。",
    "confess_fail": "{a}被{b}婉拒了，走廊里气氛尴尬。",
    "break_up": "{a}和{b}分手了，班级见闻里多了一条前任。",
    "rival": "{a}和{b}在{loc}较劲，互不退让。",
    "comfort": "{a}在安慰情绪低落的{b}。",
    "jealous": "{a}看见{b}和别人走得近，脸色不太好看。",
}

_LOC_CN = {
    "classroom": "教室",
    "hallway": "走廊",
    "library": "图书馆",
    "cafeteria": "食堂",
    "playground": "操场",
    "rooftop": "屋顶",
    "shop": "小卖部",
    "club_room": "社团室",
    "dorm_gate": "宿舍门口",
}


def _name(save: CampusSave, sid: str) -> str:
    for s in save.students:
        if s["id"] == sid:
            return str(s.get("name") or sid)
    return sid


def _gender(save: CampusSave, sid: str) -> str:
    for s in save.students:
        if s["id"] == sid:
            return str(s.get("gender") or "female")
    return "female"


def _student(save: CampusSave, sid: str) -> dict[str, Any] | None:
    for s in save.students:
        if s["id"] == sid:
            return s
    return None


def _loc_label(loc: str) -> str:
    if loc.startswith("dorm_"):
        return "宿舍"
    return _LOC_CN.get(loc, loc)


def _pair_seed(save: CampusSave, a: str, b: str) -> random.Random:
    x, y = rel.edge_key(a, b)
    return random.Random(f"{save.save_id}-{save.day_index}-{save.period_id}-{x}-{y}")


def attracted_to(student: dict[str, Any] | None) -> str:
    """who this student will pursue: any | male | female. Default free: any."""
    if not student:
        return "any"
    raw = str(student.get("attracted_to") or student.get("orientation") or "any").lower()
    if raw in {"male", "men", "m"}:
        return "male"
    if raw in {"female", "women", "f"}:
        return "female"
    # soft hint from stance only if explicit bisexual/gay fields absent — stay open
    return "any"


def mutual_romance_ok(save: CampusSave, a: str, b: str) -> bool:
    """Free sandbox: allow unless someone is locked to the opposite gender only."""
    sa, sb = _student(save, a), _student(save, b)
    ga, gb = _gender(save, a), _gender(save, b)
    aa, ab = attracted_to(sa), attracted_to(sb)
    if aa == "male" and gb != "male":
        return False
    if aa == "female" and gb != "female":
        return False
    if ab == "male" and ga != "male":
        return False
    if ab == "female" and ga != "female":
        return False
    return True


def dating_partner_of(save: CampusSave, sid: str) -> str | None:
    for e in save.edges:
        if sid not in {e.get("a"), e.get("b")}:
            continue
        is_dating = e.get("stage") == "dating" or (
            rel.bond_kind_of(e) == "romance" and float(e.get("affinity") or 0) >= 88
        )
        if not is_dating:
            continue
        other = e["b"] if e.get("a") == sid else e["a"]
        if other != "pc" and other != sid:
            return str(other)
    return None


def apply_couple_stick(save: CampusSave) -> None:
    """Dating NPCs share a location (AA2-style cling) for this period."""
    stick = dict(save.invite_stick or {})
    seen: set[str] = set()
    for e in save.edges:
        if "pc" in {e.get("a"), e.get("b")}:
            continue
        if e.get("stage") != "dating" and not (
            rel.bond_kind_of(e) == "romance" and float(e.get("affinity") or 0) >= 90
        ):
            continue
        a, b = str(e.get("a")), str(e.get("b"))
        if a in seen or b in seen:
            continue
        loc_a = save.locations_now.get(a)
        loc_b = save.locations_now.get(b)
        # Prefer romantic spots on free periods
        period = None
        try:
            from . import catalog

            period = catalog.period_by_id(save.period_id, save.day_kind) or {}
        except Exception:
            period = {}
        kind = str((period or {}).get("kind") or "")
        meet = loc_a or loc_b or "hallway"
        if kind in {"free", "free_day", "meal"}:
            rng = random.Random(f"{save.save_id}-{save.day_index}-{a}-{b}-date")
            meet = rng.choice(
                [x for x in (loc_a, loc_b, "rooftop", "library", "shop", "cafeteria") if x]
            )
        if a in save.locations_now:
            save.locations_now[a] = meet
        if b in save.locations_now:
            save.locations_now[b] = meet
        stick[a] = {"location_id": meet, "ttl": max(1, int((stick.get(a) or {}).get("ttl") or 1))}
        stick[b] = {"location_id": meet, "ttl": max(1, int((stick.get(b) or {}).get("ttl") or 1))}
        seen.add(a)
        seen.add(b)
    save.invite_stick = stick


def seed_initial_bonds(save: CampusSave) -> None:
    """Deskmates / dorm friends + a few open crush seeds (any gender)."""
    from . import seating as seating_mod

    rng = random.Random(f"{save.save_id}-seed-bonds")
    for s in save.students:
        sid = s["id"]
        if sid == "pc":
            continue
        for nid, seat_rel in seating_mod.neighbors_of(save.seating, sid):
            if nid == "pc" or seat_rel not in {"deskmate", "front_back"}:
                continue
            edge = rel.ensure_edge(
                save.edges,
                sid,
                nid,
                gender_a=_gender(save, sid),
                gender_b=_gender(save, nid),
            )
            if float(edge.get("affinity") or 0) < 8:
                rel.apply_affinity_delta(edge, 8.0)
                rel.set_bond_kind(edge, "friendship")
        dorm = str(s.get("dorm_id") or "")
        if not dorm:
            continue
        for other in save.students:
            oid = other["id"]
            if oid in {sid, "pc"} or sid > oid:
                continue
            if str(other.get("dorm_id") or "") != dorm:
                continue
            edge = rel.ensure_edge(
                save.edges,
                sid,
                oid,
                gender_a=_gender(save, sid),
                gender_b=_gender(save, oid),
            )
            if float(edge.get("affinity") or 0) < 5:
                rel.apply_affinity_delta(edge, 5.0)
                rel.set_bond_kind(edge, "friendship")

    # Open crush seeds: ~6 random mutual-ok pairs start with affinity bump
    pool = [s["id"] for s in save.students if s["id"] != "pc"]
    rng.shuffle(pool)
    seeds = 0
    for i in range(0, len(pool) - 1):
        if seeds >= 6:
            break
        a, b = pool[i], pool[(i * 3 + 5) % len(pool)]
        if a == b or not mutual_romance_ok(save, a, b):
            continue
        if rel.find_edge(save.edges, a, b) and float(
            (rel.find_edge(save.edges, a, b) or {}).get("affinity") or 0
        ) >= 40:
            continue
        edge = rel.ensure_edge(
            save.edges,
            a,
            b,
            gender_a=_gender(save, a),
            gender_b=_gender(save, b),
        )
        rel.apply_affinity_delta(edge, 28.0 + rng.random() * 18)
        rel.set_bond_kind(edge, "friendship")
        if float(edge.get("affinity") or 0) >= 55:
            edge["stage"] = "close"
        seeds += 1


def _pick_colocated_pairs(save: CampusSave, rng: random.Random) -> list[tuple[str, str, str]]:
    by_loc: dict[str, list[str]] = {}
    for sid, loc in (save.locations_now or {}).items():
        if sid == "pc":
            continue
        by_loc.setdefault(str(loc), []).append(sid)

    scored: list[tuple[float, str, str, str]] = []
    for loc, ids in by_loc.items():
        if len(ids) < 2:
            continue
        for i, a in enumerate(ids):
            for b in ids[i + 1 :]:
                if not mutual_romance_ok(save, a, b):
                    continue
                edge = rel.find_edge(save.edges, a, b)
                aff = float((edge or {}).get("affinity") or 0)
                score = aff + rng.random() * 8
                # Prefer existing bonds & not-yet-dating drama
                if edge and edge.get("stage") == "dating":
                    score += 40
                elif aff >= 50:
                    score += 20
                # Diversity: slight boost for ff / mm so not only mf
                ga, gb = _gender(save, a), _gender(save, b)
                if ga == gb:
                    score += 6
                scored.append((score, a, b, loc))
    scored.sort(key=lambda x: -x[0])
    # Take top pairs without reusing a person too often
    used: dict[str, int] = {}
    pairs: list[tuple[str, str, str]] = []
    for score, a, b, loc in scored:
        if used.get(a, 0) >= 2 or used.get(b, 0) >= 2:
            continue
        pairs.append((a, b, loc))
        used[a] = used.get(a, 0) + 1
        used[b] = used.get(b, 0) + 1
        if len(pairs) >= MAX_PAIRS_PER_TICK:
            break
    return pairs


def _apply_pair(
    save: CampusSave,
    a: str,
    b: str,
    loc: str,
) -> dict[str, Any] | None:
    rng = _pair_seed(save, a, b)
    if not mutual_romance_ok(save, a, b):
        return None
    edge = rel.ensure_edge(
        save.edges,
        a,
        b,
        gender_a=_gender(save, a),
        gender_b=_gender(save, b),
    )
    aff = float(edge.get("affinity") or 0)
    bond = rel.bond_kind_of(edge)
    stage = str(edge.get("stage") or "stranger")
    stance_a = str((_student(save, a) or {}).get("romance_stance") or "")
    stance_b = str((_student(save, b) or {}).get("romance_stance") or "")
    bold = stance_a in {"bold", "playful", "pursuit"} or stance_b in {
        "bold",
        "playful",
        "pursuit",
    }

    # Already dating → hangout beat, rare breakup
    if stage == "dating" or (bond == "romance" and aff >= 88):
        if stage == "dating" and rng.random() < 0.07:
            rel.break_up(edge, day_index=save.day_index)
            return {
                "type": "break_up",
                "a": a,
                "b": b,
                "a_name": _name(save, a),
                "b_name": _name(save, b),
                "location_id": loc,
                "blurb": clip(
                    _ACTION_TEMPLATES["break_up"].format(a=_name(save, a), b=_name(save, b)),
                    80,
                ),
                "affinity": edge.get("affinity"),
                "bond_kind": rel.bond_kind_of(edge),
                "stage": edge.get("stage"),
                "track": edge.get("track"),
                "was_dating": True,
                "dramatic": True,
            }
        rel.apply_affinity_delta(edge, 0.4 + rng.random() * 0.8)
        if edge.get("stage") == "dating":
            edge["was_dating"] = True
        return {
            "type": "date_hang",
            "a": a,
            "b": b,
            "a_name": _name(save, a),
            "b_name": _name(save, b),
            "location_id": loc,
            "blurb": clip(
                _ACTION_TEMPLATES["date_hang"].format(
                    a=_name(save, a), b=_name(save, b), loc=_loc_label(loc)
                ),
                80,
            ),
            "affinity": edge.get("affinity"),
            "bond_kind": "romance",
            "stage": "dating",
            "track": edge.get("track"),
            "dramatic": True,
        }

    # Jealousy if one is dating someone else — may crack the existing couple
    partner_a, partner_b = dating_partner_of(save, a), dating_partner_of(save, b)
    if partner_a and partner_a != b and aff >= 45 and rng.random() < 0.35:
        couple = rel.find_edge(save.edges, a, partner_a)
        if couple and couple.get("stage") == "dating" and rng.random() < 0.4:
            rel.break_up(couple, day_index=save.day_index)
            return {
                "type": "break_up",
                "a": a,
                "b": partner_a,
                "a_name": _name(save, a),
                "b_name": _name(save, partner_a),
                "location_id": loc,
                "blurb": clip(
                    _ACTION_TEMPLATES["break_up"].format(
                        a=_name(save, a), b=_name(save, partner_a)
                    )
                    + f"（因与{_name(save, b)}走得近）",
                    90,
                ),
                "affinity": couple.get("affinity"),
                "bond_kind": rel.bond_kind_of(couple),
                "stage": couple.get("stage"),
                "track": couple.get("track"),
                "was_dating": True,
                "dramatic": True,
            }
        rel.apply_affinity_delta(edge, -2.0)
        rel.set_bond_kind(edge, "rivalry")
        return {
            "type": "jealous",
            "a": a,
            "b": b,
            "a_name": _name(save, a),
            "b_name": _name(save, b),
            "location_id": loc,
            "blurb": clip(
                _ACTION_TEMPLATES["jealous"].format(a=_name(save, a), b=_name(save, b)),
                80,
            ),
            "affinity": edge.get("affinity"),
            "bond_kind": "rivalry",
            "stage": edge.get("stage"),
            "track": edge.get("track"),
            "dramatic": True,
        }

    roll = rng.random()
    action = "chat"
    delta = 1.2 + rng.random() * 2.5
    kind = "friendship"

    confess_chance = 0.28 if bold else 0.16
    flirt_chance = 0.38 if bold else 0.22
    if aff >= 70 and bond != "romance" and roll < confess_chance:
        if roll < (0.14 if bold else 0.08) and aff >= 78:
            action = "confess_ok"
            delta = 8.0
            kind = "romance"
        else:
            action = "confess_fail"
            delta = -3.5
            kind = "rivalry" if aff < 65 else "friendship"
    elif aff >= 48 and roll < flirt_chance:
        action = "flirt"
        delta = 3.0 + rng.random() * 3
        kind = "romance" if aff + delta >= 70 else "friendship"
    elif loc in {"library", "classroom"} and roll < 0.4:
        action = "study_together"
        delta = 1.8 + rng.random()
        kind = "friendship"
    elif roll < 0.1 and aff >= 35:
        action = "rival"
        delta = -1.8 - rng.random()
        kind = "rivalry"
    elif roll < 0.18:
        action = "comfort"
        delta = 2.2
        kind = "friendship"
    else:
        action = "chat"
        delta = 1.2 + rng.random() * 2.0
        kind = bond if bond != "none" else "friendship"

    rel.apply_affinity_delta(edge, delta)
    if action == "confess_ok":
        rel.mark_dating(edge)
        edge["affinity"] = max(float(edge.get("affinity") or 0), 90.0)
    elif action == "confess_fail":
        rel.set_bond_kind(edge, kind)
    else:
        if float(edge.get("affinity") or 0) >= 75 and kind == "romance":
            rel.set_bond_kind(edge, "romance")
            if float(edge.get("affinity") or 0) >= 88:
                rel.mark_dating(edge)
        elif float(edge.get("affinity") or 0) >= 35:
            rel.set_bond_kind(edge, kind if kind != "none" else "friendship")
        else:
            rel.set_bond_kind(edge, kind)

    tpl = _ACTION_TEMPLATES.get(action, _ACTION_TEMPLATES["chat"])
    text = tpl.format(a=_name(save, a), b=_name(save, b), loc=_loc_label(loc))
    track = edge.get("track") or rel.track_for(_gender(save, a), _gender(save, b))
    dramatic = action in {
        "confess_ok",
        "confess_fail",
        "flirt",
        "rival",
        "date_hang",
        "jealous",
    }
    return {
        "type": action,
        "a": a,
        "b": b,
        "a_name": _name(save, a),
        "b_name": _name(save, b),
        "location_id": loc,
        "blurb": clip(text, 80),
        "affinity": edge.get("affinity"),
        "bond_kind": rel.bond_kind_of(edge),
        "stage": edge.get("stage"),
        "track": track,
        "dramatic": dramatic,
    }


def run_social_tick(save: CampusSave) -> list[dict[str, Any]]:
    """Advance NPC↔NPC bonds for colocated pairs; write save.world_events."""
    apply_couple_stick(save)
    rng = random.Random(f"{save.save_id}-{save.day_index}-{save.period_id}-social")
    events: list[dict[str, Any]] = []
    for a, b, loc in _pick_colocated_pairs(save, rng):
        ev = _apply_pair(save, a, b, loc)
        if ev:
            events.append(ev)
    events.sort(key=lambda e: (0 if e.get("dramatic") else 1, -float(e.get("affinity") or 0)))
    save.world_events = events[:MAX_WORLD_EVENTS]
    return save.world_events


def class_gossip_public(save: CampusSave, *, limit: int = 16) -> list[dict[str, Any]]:
    """Non-PC edges worth showing on the board (friend+ / romance / rivalry / ex)."""
    from . import seating as seating_mod

    students_by_id = {s["id"]: s for s in save.students}
    name_by_id = {s["id"]: s["name"] for s in save.students}
    out: list[dict[str, Any]] = []
    for e in save.edges:
        if "pc" in {e.get("a"), e.get("b")}:
            continue
        aff = float(e.get("affinity") or 0)
        bond = rel.bond_kind_of(e)
        was_ex = bool(e.get("was_dating")) and e.get("stage") != "dating"
        if aff < 35 and bond == "friendship" and not was_ex:
            continue
        if aff < 20 and bond not in {"romance", "rivalry"} and not was_ex:
            continue
        a, b = str(e.get("a")), str(e.get("b"))
        seat_rel = seating_mod.relation_between(save.seating, a, b)
        relation = rel.enrich_edge_relation(
            e, students_by_id=students_by_id, seat_relation=seat_rel if seat_rel != "none" else None
        )
        track = e.get("track") or rel.track_for(_gender(save, a), _gender(save, b))
        label = f"{name_by_id.get(a, a)} × {name_by_id.get(b, b)} · {relation.get('display')}"
        out.append(
            {
                **rel.public_edge(e, relation=relation),
                "a_name": name_by_id.get(a, a),
                "b_name": name_by_id.get(b, b),
                "label": label,
                "track": track,
            }
        )
    out.sort(
        key=lambda x: (
            (
                0
                if x.get("bond_kind") == "romance" or x.get("stage") == "dating"
                else 1
                if x.get("primary_label") == "前任"
                else 2
                if x.get("bond_kind") == "rivalry"
                else 3
            ),
            -float(x.get("affinity") or 0),
        )
    )
    return out[:limit]


def build_social_epilogue(save: CampusSave) -> dict[str, Any]:
    """Summary of class couples / rivals / exes / missed bonds for gaokao ending."""
    couples: list[dict[str, Any]] = []
    rivals: list[dict[str, Any]] = []
    exes: list[dict[str, Any]] = []
    for g in class_gossip_public(save, limit=40):
        if g.get("primary_label") == "前任" or (
            g.get("was_dating") and g.get("stage") != "dating"
        ):
            exes.append({"label": g["label"], "affinity": g.get("affinity")})
        elif g.get("bond_kind") == "romance" or g.get("stage") == "dating":
            couples.append(
                {
                    "label": g["label"],
                    "affinity": g.get("affinity"),
                    "stage": g.get("stage"),
                    "track": g.get("track"),
                }
            )
        elif g.get("bond_kind") == "rivalry":
            rivals.append({"label": g["label"], "affinity": g.get("affinity")})

    near_miss: list[str] = []
    pc_edges = [e for e in save.edges if "pc" in {e.get("a"), e.get("b")}]
    pc_edges.sort(key=lambda e: float(e.get("affinity") or 0), reverse=True)
    for e in pc_edges[:5]:
        other = e["b"] if e.get("a") == "pc" else e["a"]
        if float(e.get("affinity") or 0) < 55:
            continue
        for g in couples:
            if _name(save, str(other)) in str(g.get("label") or ""):
                near_miss.append(
                    f"你和{_name(save, str(other))}很近，但班级见闻里已有「{g['label']}」。"
                )
                break

    bits: list[str] = []
    if couples:
        bits.append(f"班级成对 {len(couples)} 组：" + "；".join(c["label"] for c in couples[:5]))
    else:
        bits.append("班级里还没有公开的成对恋情。")
    if exes:
        bits.append("前任：" + "；".join(x["label"] for x in exes[:3]))
    if rivals:
        bits.append("暗流：" + "；".join(r["label"] for r in rivals[:3]))
    if near_miss:
        bits.extend(near_miss[:2])

    return {
        "couples": couples[:10],
        "rivals": rivals[:6],
        "exes": exes[:6],
        "near_miss": near_miss[:3],
        "blurb": clip(" ".join(bits), 320),
        "couple_count": len(couples),
        "ex_count": len(exes),
    }
