"""Manager ↔ Vanna protocol adapters (prefetch plan / ephemeral sessions)."""
from __future__ import annotations

from typing import Any


def resolve_manager_session_id(session_id: str, *, manager_path: bool, exists: bool) -> str:
    """Manager dbClient may send mgr-{runId}-{agent} step keys that are not Vanna UI sessions."""
    sid = str(session_id or "").strip()
    if not sid:
        return ""
    if exists:
        return sid
    if manager_path:
        return ""
    return sid


def build_unified_task_plan(
    *,
    question: str,
    tables: list[str],
    hits: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Shape /api/plan output for Manager prefetch (legacy DB_Agent contract)."""
    _ = question
    evidence_lines: list[str] = []
    for h in hits or []:
        doc = str(h.get("document") or "").strip()
        if not doc:
            continue
        first = doc.splitlines()[0].strip()
        if first.startswith("-"):
            first = first.lstrip("- ").strip()
        if first:
            evidence_lines.append(first[:160])
    clean_tables = list(dict.fromkeys(str(t or "").strip() for t in tables if str(t or "").strip()))
    return {
        "intent": "db",
        "entities": {"names": [], "records": [], "locations": [], "dates": []},
        "hints": {
            "suggested_tables": clean_tables,
            "suggested_fields": [],
            "evidence": "\n".join(evidence_lines[:6]),
        },
        "prefetch_ready": bool(clean_tables),
    }
