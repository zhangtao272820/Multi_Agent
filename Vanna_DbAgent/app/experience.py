"""Recall db_query_experience from the shared PG table. Never throw if PG is missing."""
from __future__ import annotations

import os
from typing import Any

from app.protocol import normalize_experience_question_key
from app.settings import get_settings


def _database_url() -> str:
    s = get_settings()
    return str(
        s.agent_database_url
        or os.getenv("AGENT_DATABASE_URL")
        or s.clawhive_database_url
        or os.getenv("CLAWHIVE_DATABASE_URL")
        or s.database_url
        or os.getenv("DATABASE_URL")
        or ""
    ).strip()


def pg_configured() -> bool:
    return bool(_database_url())


def _confirmed_only() -> bool:
    raw = str(os.getenv("EXPERIENCE_RECALL_CONFIRMED_ONLY") or "").strip().lower()
    if raw in {"1", "true"}:
        return True
    if raw in {"0", "false"}:
        return False
    # 默认只召回「有用」；与 shared/experienceRecallPolicy 对齐
    return bool(get_settings().experience_recall_confirmed_only)


def _exclude_federated() -> bool:
    raw = str(os.getenv("EXPERIENCE_STANDALONE_EXCLUDE_FEDERATED") or "1").strip().lower()
    if raw in {"0", "false", "off", "no"}:
        return False
    return bool(get_settings().experience_standalone_exclude_federated)


def _plane_of(row: dict[str, Any]) -> str:
    plane = str(row.get("source_plane") or row.get("sourcePlane") or "").strip().lower()
    if plane in {"manager_orchestrated", "orchestrated"}:
        return "manager_orchestrated"
    if plane in {"standalone", "local"}:
        return "standalone"
    src = str(row.get("source") or "").strip().lower()
    if any(x in src for x in ("manager_finalize_sync", "manager_feedback_confirmed", "federation", "mgr_")):
        return "manager_orchestrated"
    if not src:
        return "unknown"
    return "standalone"


def _is_voided(row: dict[str, Any]) -> bool:
    if row.get("voided") is True:
        return True
    src = str(row.get("source") or "").strip().lower()
    return src.startswith("voided") or ":voided" in src or "|voided" in src


def _is_confirmed(row: dict[str, Any]) -> bool:
    """仅用户点「有用」可召回；撤回/无用/自动 finalize/黄金旁路不算。"""
    if _is_voided(row):
        return False
    if row.get("userConfirmed") is True or row.get("user_confirmed") is True:
        return True
    src = str(row.get("source") or "").strip()
    if not src:
        return False
    low = src.lower()
    if "shadow" in low or "useless" in low or "score:-1" in low or "score=-1" in low:
        return False
    if "manager_feedback_confirmed" in low:
        return True
    # UI「有用」写入（record_feedback 仅 score=1 写 experience）
    if "vanna_feedback" in low:
        return True
    if "useful" in low or "score:1" in low or "score=1" in low:
        return True
    status = str(row.get("status") or "").strip()
    if status == "confirmed" and (
        "feedback_confirmed" in low or "useful" in low or "vanna_feedback" in low
    ):
        return True
    return False


def may_recall_row(row: dict[str, Any], *, manager_path: bool) -> bool:
    if _is_voided(row):
        return False
    if not manager_path and _exclude_federated() and _plane_of(row) == "manager_orchestrated":
        return False
    if _confirmed_only() and not _is_confirmed(row):
        return False
    return True


def _source_trust_weight(source: Any) -> float:
    s = str(source or "").strip().lower()
    if "explicit_user_request" in s:
        return 0.95
    if "hitl" in s or "confirmed" in s:
        return 0.88
    if "feedback" in s or "federation" in s or "manager_finalize" in s:
        return 0.85
    if "shadow" in s:
        return 0.4
    return 0.5


def _path_key(row: dict[str, Any]) -> str:
    path = str(row.get("path") or "").strip().lower()
    return path or "—"


def _ts_ms(row: dict[str, Any]) -> float:
    raw = row.get("ts")
    if raw is None:
        return 0.0
    try:
        from datetime import datetime

        if hasattr(raw, "timestamp"):
            return float(raw.timestamp()) * 1000.0
        s = str(raw).strip()
        if not s:
            return 0.0
        # tolerate trailing Z
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s).timestamp() * 1000.0
    except Exception:
        return 0.0


def _compare_memory_trust(a: dict[str, Any], b: dict[str, Any]) -> float:
    """正值表示 a 比 b 更可信（与 shared/agentMemoryRecall.compareMemoryTrust 对齐）。"""
    wa = _source_trust_weight(a.get("source"))
    wb = _source_trust_weight(b.get("source"))
    if abs(wa - wb) > 0.08:
        return wa - wb
    ta = _ts_ms(a)
    tb = _ts_ms(b)
    if ta != tb:
        return ta - tb
    return 0.0


def resolve_experience_path_conflicts(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    同 question_norm 下不同 path 只保留更可信的一条。
    无新存储；纯召回后处理。与 Manager resolveExperiencePathConflicts 同口径。
    """
    if len(rows) <= 1:
        return list(rows)
    by_q: dict[str, list[dict[str, Any]]] = {}
    no_q: list[dict[str, Any]] = []
    for row in rows:
        qn = str(row.get("question_norm") or "").strip()
        if not qn:
            no_q.append(row)
            continue
        by_q.setdefault(qn, []).append(row)

    out: list[dict[str, Any]] = list(no_q)
    for group in by_q.values():
        if len(group) == 1:
            out.append(group[0])
            continue
        by_path: dict[str, dict[str, Any]] = {}
        for row in group:
            pk = _path_key(row)
            prev = by_path.get(pk)
            if prev is None or _compare_memory_trust(row, prev) > 0:
                by_path[pk] = row
        paths = list(by_path.values())
        if len(paths) == 1:
            out.append(paths[0])
            continue
        paths.sort(key=lambda r: (_source_trust_weight(r.get("source")), _ts_ms(r)), reverse=True)
        out.append(paths[0])
    out.sort(key=lambda r: (_source_trust_weight(r.get("source")), _ts_ms(r)), reverse=True)
    return out


def recall_experience(
    question: str,
    *,
    tenant_id: str = "default",
    manager_path: bool = False,
    limit: int = 3,
) -> list[dict[str, Any]]:
    if not pg_configured():
        return []
    nq = normalize_experience_question_key(question)
    if not nq:
        return []
    url = _database_url()
    try:
        import psycopg2
        import psycopg2.extras
    except Exception:
        return []
    try:
        conn = psycopg2.connect(url, connect_timeout=3)
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT ts, question_norm, hint, path, tables, source, source_plane
                    FROM db_query_experience
                    WHERE tenant_id = %s AND (question_norm = %s OR question_norm ILIKE %s)
                    ORDER BY ts DESC
                    LIMIT %s
                    """,
                    (tenant_id or "default", nq, f"%{nq[:40]}%", max(1, limit * 6)),
                )
                rows = [dict(r) for r in (cur.fetchall() or [])]
        finally:
            conn.close()
    except Exception:
        return []
    candidates: list[dict[str, Any]] = []
    for row in rows:
        if not may_recall_row(row, manager_path=manager_path):
            continue
        candidates.append(row)
    resolved = resolve_experience_path_conflicts(candidates)
    return resolved[: max(1, limit)]


def experience_prompt_block(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return ""
    lines = ["相似经验（只作参考，表列仍以元数据为准）："]
    for row in rows[:3]:
        hint = str(row.get("hint") or "").strip()
        qn = str(row.get("question_norm") or "").strip()
        lines.append(f"- {qn}: {hint[:180]}")
    return "\n".join(lines)


def write_standalone_experience(
    *,
    question: str,
    sql: str,
    tables: list[str],
    tenant_id: str,
    data_domain: str = "",
    source: str = "vanna_golden_promote",
    session_id: str = "",
    message_id: str = "",
) -> dict[str, Any]:
    if not pg_configured():
        return {"synced": False, "reason": "pg_not_configured"}
    nq = normalize_experience_question_key(question)
    if not nq:
        return {"synced": False, "reason": "empty_question"}
    url = _database_url()
    try:
        import psycopg2
        import json as _json
        from datetime import datetime, timezone
    except Exception as exc:
        return {"synced": False, "reason": str(exc)}
    src = str(source or "vanna_golden_promote").strip() or "vanna_golden_promote"
    sid = str(session_id or "").strip()
    mid = str(message_id or "").strip()
    # 把 session/message 编进 source，便于撤回时按轮作废（不改 PG schema）
    if sid or mid:
        src = f"{src}|sid:{sid}|mid:{mid}"
    path_label = "feedback" if "feedback" in src else "golden_promote"
    hint = f"数据域={data_domain or tenant_id}；成功路径={path_label}；SQL={sql[:160]}"
    try:
        conn = psycopg2.connect(url, connect_timeout=3)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO db_query_experience
                      (ts, question_norm, path, data_domain, tables, hint, tenant_id, source, source_plane)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (
                        datetime.now(timezone.utc).isoformat(),
                        nq,
                        path_label,
                        data_domain or tenant_id,
                        _json.dumps(tables or []),
                        hint,
                        tenant_id or "default",
                        src,
                        "standalone",
                    ),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        return {"synced": False, "reason": str(exc)}
    return {"synced": True, "source": src}


def void_standalone_experience(
    *,
    session_id: str = "",
    message_ids: list[str] | None = None,
    questions: list[str] | None = None,
) -> dict[str, Any]:
    """撤回/重新生成：把对应反馈经验标为 voided，recall 不再命中。"""
    if not pg_configured():
        return {"voided": 0, "reason": "pg_not_configured"}
    sid = str(session_id or "").strip()
    mids = [str(x or "").strip() for x in (message_ids or []) if str(x or "").strip()]
    qnorms = [normalize_experience_question_key(q) for q in (questions or [])]
    qnorms = [q for q in qnorms if q]
    if not sid and not mids and not qnorms:
        return {"voided": 0}
    url = _database_url()
    try:
        import psycopg2
        import psycopg2.extras
        from datetime import datetime, timezone
    except Exception as exc:
        return {"voided": 0, "reason": str(exc)}
    try:
        conn = psycopg2.connect(url, connect_timeout=3)
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT ctid, source, question_norm
                    FROM db_query_experience
                    WHERE source ILIKE %s OR source ILIKE %s
                    ORDER BY ts DESC
                    LIMIT 200
                    """,
                    ("%vanna_feedback%", "%|sid:%"),
                )
                rows = [dict(r) for r in (cur.fetchall() or [])]
            voided = 0
            now = datetime.now(timezone.utc).isoformat()
            with conn.cursor() as cur:
                for row in rows:
                    src = str(row.get("source") or "")
                    if src.lower().startswith("voided"):
                        continue
                    hit = False
                    if any(f"|mid:{m}" in src for m in mids):
                        hit = True
                    elif sid and f"|sid:{sid}|" in src and (
                        any(f"|mid:{m}" in src for m in mids) or not mids
                    ):
                        # 有 session 且（命中 mid 或仅按 session+问句）
                        if mids:
                            hit = any(f"|mid:{m}" in src for m in mids)
                        else:
                            hit = True
                    elif qnorms and str(row.get("question_norm") or "") in qnorms and "vanna_feedback" in src:
                        hit = True
                    if not hit:
                        continue
                    cur.execute(
                        "UPDATE db_query_experience SET source = %s WHERE ctid = %s",
                        (f"voided|{src}"[:480], row["ctid"]),
                    )
                    voided += 1
                if voided:
                    # touch hint so audits can see void time without schema migrate
                    _ = now
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        return {"voided": 0, "reason": str(exc)}
    return {"voided": voided}
