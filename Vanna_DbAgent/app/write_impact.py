"""Estimate write SQL impact (pure WHERE→COUNT where possible; no execute until decide)."""

from __future__ import annotations

import re
from typing import Any

from app.settings import get_settings

_WHERE_RE = re.compile(r"\bWHERE\b(.+)$", re.I | re.S)
_FROM_UPDATE = re.compile(
    r"^\s*UPDATE\s+(?:`?(\w+)`?\.)?`?(\w+)`?\s+SET\b",
    re.I,
)
_FROM_DELETE = re.compile(
    r"^\s*DELETE\s+FROM\s+(?:`?(\w+)`?\.)?`?(\w+)`?\b",
    re.I,
)
_INSERT_VALUES = re.compile(r"\bVALUES\b", re.I)


def default_impact_threshold() -> int:
    try:
        return int(getattr(get_settings(), "vanna_write_impact_threshold", 500) or 500)
    except Exception:
        return 500


def build_count_sql_for_write(sql: str, write_kind: str) -> str | None:
    """Derive a SELECT COUNT(*) preview for UPDATE/DELETE. Returns None if not applicable."""
    raw = str(sql or "").strip().rstrip(";")
    kind = str(write_kind or "").strip().lower()
    if kind == "update":
        m = _FROM_UPDATE.match(raw)
        if not m:
            return None
        table = m.group(2)
        wm = _WHERE_RE.search(raw)
        if not wm:
            return None
        where = wm.group(1).strip()
        return f"SELECT COUNT(*) AS cnt FROM `{table}` WHERE {where}"
    if kind == "delete":
        m = _FROM_DELETE.match(raw)
        if not m:
            return None
        table = m.group(2)
        wm = _WHERE_RE.search(raw)
        if not wm:
            return None
        where = wm.group(1).strip()
        return f"SELECT COUNT(*) AS cnt FROM `{table}` WHERE {where}"
    return None


def estimate_insert_rows(sql: str) -> int:
    raw = str(sql or "")
    if not _INSERT_VALUES.search(raw):
        return 1
    # rough: count top-level value tuples by '),(' pattern + 1
    body = raw[raw.upper().find("VALUES") + 6 :]
    n = body.count("),(") + 1 if "(" in body else 1
    return max(1, min(n, 10_000))


def impact_requires_ack(estimated_rows: int | None, *, threshold: int | None = None) -> bool:
    thr = int(threshold if threshold is not None else default_impact_threshold())
    if estimated_rows is None:
        return False
    return int(estimated_rows) >= thr


def build_impact_estimate(
    *,
    sql: str,
    write_kind: str,
    estimated_rows: int | None = None,
    count_sql: str | None = None,
    threshold: int | None = None,
    note: str = "",
) -> dict[str, Any]:
    thr = int(threshold if threshold is not None else default_impact_threshold())
    kind = str(write_kind or "").strip().lower()
    rows = estimated_rows
    csql = count_sql
    if rows is None and kind in {"update", "delete"}:
        csql = csql or build_count_sql_for_write(sql, kind)
    if rows is None and kind == "insert":
        rows = estimate_insert_rows(sql)
    if rows is None and kind in {"create_table", "alter_add", "alter_modify"}:
        rows = 0
        note = note or "DDL：无行级影响预估"
    requires = impact_requires_ack(rows, threshold=thr) if rows is not None else False
    # unknown UPDATE/DELETE without WHERE count → force ack as safety
    if rows is None and kind in {"update", "delete"}:
        requires = True
        note = note or "无法预估影响行数，确认前须显式 impact_ack"
    return {
        "write_kind": kind,
        "estimated_rows": rows,
        "count_sql": csql or "",
        "threshold": thr,
        "requires_ack": requires,
        "note": note,
    }


def run_count_estimate(cfg: Any, count_sql: str) -> int | None:
    """Execute COUNT preview on readonly cfg. Returns None on failure."""
    if not count_sql or not cfg:
        return None
    try:
        from app.db import run_select

        rows = run_select(cfg, count_sql, max_rows=1)
        if not rows:
            return 0
        row = rows[0]
        for k in ("cnt", "COUNT(*)", "count(*)", "C"):
            if k in row:
                return int(row[k] or 0)
        # first numeric value
        for v in row.values():
            if isinstance(v, (int, float)):
                return int(v)
        return None
    except Exception:
        return None
