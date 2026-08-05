"""N×N relationship edges: affinity + stage + track + bond_kind (friendship/romance/rivalry)."""

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
    # legacy: infer from stage
    stage = str(edge.get("stage") or "stranger")
    if stage in {"crush", "dating"}:
        return "romance"
    if float(edge.get("affinity") or 0) >= 35:
        return "friendship"
    return "none"


def set_bond_kind(edge: dict[str, Any], kind: str) -> None:
    k = kind if kind in VALID_BOND_KINDS else "none"
    edge["bond_kind"] = k


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
        return existing
    e = {
        "a": a,
        "b": b,
        "affinity": 0.0,
        "stage": "stranger",
        "track": track_for(gender_a, gender_b),
        "bond_kind": "none",
        "memories": [],
    }
    edges.append(e)
    return e


def apply_affinity_delta(edge: dict[str, Any], delta: float) -> dict[str, Any]:
    edge["affinity"] = round(max(0.0, min(100.0, float(edge.get("affinity", 0)) + delta)), 1)
    # Keep dating stage sticky once reached via social confess
    if edge.get("stage") == "dating" and float(edge["affinity"]) >= 85:
        pass
    else:
        edge["stage"] = stage_from_affinity(edge["affinity"])
    if "bond_kind" not in edge:
        edge["bond_kind"] = bond_kind_of(edge)
    return edge


def public_edge(edge: dict[str, Any]) -> dict[str, Any]:
    return {
        "a": edge["a"],
        "b": edge["b"],
        "affinity": edge.get("affinity", 0),
        "stage": edge.get("stage", "stranger"),
        "track": edge.get("track", "none"),
        "bond_kind": bond_kind_of(edge),
    }


def dating_allowed(edge: dict[str, Any]) -> bool:
    return STAGE_ORDER.index(edge.get("stage", "stranger")) >= STAGE_ORDER.index("close")
