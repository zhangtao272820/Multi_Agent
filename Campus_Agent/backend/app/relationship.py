"""N×N relationship edges + campus relation labels (structure + emotion)."""

from __future__ import annotations

from typing import Any, Literal

Track = Literal["mm", "ff", "mf", "none"]
Stage = Literal["stranger", "acquaintance", "friend", "close", "crush", "dating"]
BondKind = Literal["friendship", "romance", "rivalry", "none"]

STAGE_ORDER = ["stranger", "acquaintance", "friend", "close", "crush", "dating"]

STAGE_THRESHOLDS = [
    (0, "stranger"),
    (15, "acquaintance"),
    (35, "friend"),
    (55, "close"),
    (75, "crush"),
    (90, "dating"),
]

VALID_BOND_KINDS = frozenset({"friendship", "romance", "rivalry", "none"})

CLASS_ROLES: dict[str, str] = {
    "monitor": "班长",
    "league_sec": "团支书",
    "study": "学习委员",
    "discipline": "纪律委员",
    "sports": "体育委员",
    "arts": "文艺委员",
    "life": "生活委员",
}

_SEAT_CONTEXT = {
    "deskmate": "同桌",
    "front_back": "前后桌",
    "aisle": "邻座",
    "diagonal": "邻座",
}

# System memory prefixes only (not user utterance routing)
_STUDY_MEM_PREFIXES = ("一起对题", "对题", "自习")
_MEAL_MEM_PREFIXES = ("食堂", "一起吃饭", "饭搭")


def track_for(gender_a: str, gender_b: str) -> Track:
    if gender_a == "male" and gender_b == "male":
        return "mm"
    if gender_a == "female" and gender_b == "female":
        return "ff"
    if gender_a != gender_b:
        return "mf"
    return "none"


def stage_from_affinity(affinity: float) -> Stage:
    stage: Stage = "stranger"
    for thr, name in STAGE_THRESHOLDS:
        if affinity >= thr:
            stage = name  # type: ignore[assignment]
    return stage


def edge_key(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


def find_edge(edges: list[dict[str, Any]], a: str, b: str) -> dict[str, Any] | None:
    for e in edges:
        if {e.get("a"), e.get("b")} == {a, b}:
            return e
    return None


def bond_kind_of(edge: dict[str, Any]) -> BondKind:
    raw = str(edge.get("bond_kind") or "none")
    if raw in VALID_BOND_KINDS:
        return raw  # type: ignore[return-value]
    stage = str(edge.get("stage") or "stranger")
    if stage in {"crush", "dating"}:
        return "romance"
    if float(edge.get("affinity") or 0) >= 35:
        return "friendship"
    return "none"


def set_bond_kind(edge: dict[str, Any], kind: str) -> None:
    k = kind if kind in VALID_BOND_KINDS else "none"
    edge["bond_kind"] = k


def class_role_label(role: str | None) -> str:
    if not role:
        return ""
    return CLASS_ROLES.get(str(role), str(role))


def ensure_edge(
    edges: list[dict[str, Any]],
    a: str,
    b: str,
    *,
    gender_a: str,
    gender_b: str,
) -> dict[str, Any]:
    existing = find_edge(edges, a, b)
    if existing:
        if "bond_kind" not in existing:
            existing["bond_kind"] = bond_kind_of(existing)
        if "was_dating" not in existing:
            existing["was_dating"] = existing.get("stage") == "dating"
        return existing
    e = {
        "a": a,
        "b": b,
        "affinity": 0.0,
        "stage": "stranger",
        "track": track_for(gender_a, gender_b),
        "bond_kind": "none",
        "was_dating": False,
        "broke_up_day": None,
        "memories": [],
    }
    edges.append(e)
    return e


def apply_affinity_delta(edge: dict[str, Any], delta: float) -> dict[str, Any]:
    edge["affinity"] = round(max(0.0, min(100.0, float(edge.get("affinity", 0)) + delta)), 1)
    if edge.get("stage") == "dating" and float(edge["affinity"]) >= 85:
        edge["was_dating"] = True
    else:
        prev = str(edge.get("stage") or "stranger")
        edge["stage"] = stage_from_affinity(edge["affinity"])
        if prev == "dating" and edge["stage"] != "dating":
            edge["was_dating"] = True
    if edge.get("stage") == "dating":
        edge["was_dating"] = True
    if "bond_kind" not in edge:
        edge["bond_kind"] = bond_kind_of(edge)
    return edge


def mark_dating(edge: dict[str, Any]) -> None:
    edge["stage"] = "dating"
    edge["was_dating"] = True
    set_bond_kind(edge, "romance")


def break_up(edge: dict[str, Any], *, day_index: int, affinity_drop: float = 18.0) -> None:
    """Dating → 前任：降亲和、回 close/friend，保留 was_dating。"""
    edge["was_dating"] = True
    edge["broke_up_day"] = int(day_index)
    edge["affinity"] = round(max(20.0, float(edge.get("affinity") or 0) - affinity_drop), 1)
    aff = float(edge["affinity"])
    edge["stage"] = "close" if aff >= 55 else "friend"
    set_bond_kind(edge, "friendship")
    mems = list(edge.get("memories") or [])
    mems.append("分手：确认不再是一对")
    edge["memories"] = mems[-12:]


def dating_allowed(edge: dict[str, Any]) -> bool:
    return STAGE_ORDER.index(edge.get("stage", "stranger")) >= STAGE_ORDER.index("close")


def _memory_buddy_tag(edge: dict[str, Any]) -> str | None:
    for m in edge.get("memories") or []:
        s = str(m)
        if any(s.startswith(p) or p in s[:12] for p in _STUDY_MEM_PREFIXES):
            return "学习搭子"
        if any(s.startswith(p) or p in s[:12] for p in _MEAL_MEM_PREFIXES):
            return "饭搭子"
    return None


def resolve_campus_relation(
    edge: dict[str, Any],
    *,
    gender_a: str,
    gender_b: str,
    seat_relation: str | None = None,
    same_dorm: bool = False,
    class_role_a: str | None = None,
    class_role_b: str | None = None,
    grade_tier_a: str | None = None,
    grade_tier_b: str | None = None,
) -> dict[str, Any]:
    """Deterministic campus labels: primary emotion + structural context tags."""
    aff = float(edge.get("affinity") or 0)
    stage = str(edge.get("stage") or "stranger")
    bond = bond_kind_of(edge)
    track = str(edge.get("track") or track_for(gender_a, gender_b))
    was_dating = bool(edge.get("was_dating")) or stage == "dating"
    if stage == "dating":
        was_dating = True

    context_tags: list[str] = []
    if seat_relation and seat_relation in _SEAT_CONTEXT:
        context_tags.append(_SEAT_CONTEXT[seat_relation])
    if same_dorm:
        context_tags.append("舍友")
    for role in (class_role_a, class_role_b):
        label = class_role_label(role)
        if label and label not in context_tags:
            context_tags.append(label)

    primary = "点头之交"
    if stage == "dating" and bond == "romance":
        primary = "情侣"
    elif was_dating and stage != "dating":
        primary = "前任"
    elif bond == "romance" and stage == "crush":
        primary = "暧昧"
    elif bond == "rivalry":
        if aff >= 55:
            primary = "欢喜冤家"
        elif aff >= 30:
            primary = "对头"
        else:
            primary = "死敌"
    elif (
        bond == "rivalry"
        or (
            grade_tier_a in {"top", "upper"}
            and grade_tier_b in {"top", "upper"}
            and aff >= 25
            and stage in {"acquaintance", "friend"}
            and bond != "romance"
        )
    ) and primary == "点头之交":
        primary = "对头"
    elif aff >= 55 and bond != "romance" and stage in {"close", "friend", "crush"}:
        if track == "ff":
            primary = "闺蜜"
        elif track == "mm":
            primary = "基友"
        elif aff >= 75:
            primary = "死党"
        elif track == "mf":
            primary = "挚友"
        else:
            primary = "挚友"
    elif aff >= 75 and bond not in {"romance", "rivalry"}:
        primary = "死党"
    elif stage in {"friend", "close"} or (bond == "friendship" and aff >= 35):
        buddy = _memory_buddy_tag(edge)
        primary = buddy or "好友"
    elif stage == "acquaintance" or aff >= 15:
        buddy = _memory_buddy_tag(edge)
        primary = buddy or "普通同学"
    else:
        primary = "点头之交"

    # Fix: rivalry branch already set; competitive grade override only if still weak label
    if primary in {"普通同学", "点头之交", "好友"} and bond == "rivalry":
        primary = "对头" if aff >= 30 else "死敌"

    display_parts = [primary] + context_tags
    display = " · ".join(display_parts)
    return {
        "primary_label": primary,
        "context_tags": context_tags,
        "bond_kind": bond,
        "stage": stage,
        "was_dating": was_dating and stage != "dating" or (was_dating and stage == "dating"),
        "display": display,
    }


def enrich_edge_relation(
    edge: dict[str, Any],
    *,
    students_by_id: dict[str, dict[str, Any]],
    seat_relation: str | None = None,
) -> dict[str, Any]:
    a = str(edge.get("a") or "")
    b = str(edge.get("b") or "")
    sa = students_by_id.get(a) or {}
    sb = students_by_id.get(b) or {}
    same_dorm = bool(sa.get("dorm_id") and sa.get("dorm_id") == sb.get("dorm_id"))
    info = resolve_campus_relation(
        edge,
        gender_a=str(sa.get("gender") or "none"),
        gender_b=str(sb.get("gender") or "none"),
        seat_relation=seat_relation,
        same_dorm=same_dorm,
        class_role_a=str(sa.get("class_role") or "") or None,
        class_role_b=str(sb.get("class_role") or "") or None,
        grade_tier_a=str(sa.get("grade_tier") or "") or None,
        grade_tier_b=str(sb.get("grade_tier") or "") or None,
    )
    # was_dating flag for API: True if ever dated (including current dating)
    info["was_dating"] = bool(edge.get("was_dating")) or str(edge.get("stage")) == "dating"
    return info


def public_edge(edge: dict[str, Any], *, relation: dict[str, Any] | None = None) -> dict[str, Any]:
    out = {
        "a": edge["a"],
        "b": edge["b"],
        "affinity": edge.get("affinity", 0),
        "stage": edge.get("stage", "stranger"),
        "track": edge.get("track", "none"),
        "bond_kind": bond_kind_of(edge),
        "was_dating": bool(edge.get("was_dating")) or edge.get("stage") == "dating",
    }
    if relation:
        out["primary_label"] = relation.get("primary_label")
        out["context_tags"] = relation.get("context_tags") or []
        out["relation_display"] = relation.get("display")
        out["display"] = relation.get("display")
    return out


def validate_class_roles(students: list[dict[str, Any]]) -> None:
    """Fail-fast: each class_role at most one person; each person at most one role."""
    seen_roles: dict[str, str] = {}
    for s in students:
        role = str(s.get("class_role") or "").strip()
        if not role:
            continue
        if role not in CLASS_ROLES:
            raise ValueError(f"invalid_class_role:{s.get('id')}:{role}")
        sid = str(s.get("id"))
        if role in seen_roles:
            raise ValueError(f"duplicate_class_role:{role}:{seen_roles[role]}+{sid}")
        seen_roles[role] = sid
