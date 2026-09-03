"""Admin 工具经验联邦：从 adm_tool_experience 召回成功路径（lexical + 向量混合）。"""
from __future__ import annotations

import os
import re
from typing import Any

from app.core.admin_embeddings import cosine_similarity, embed_query, is_admin_embedding_enabled

_experience_cache: list[dict[str, Any]] | None = None


def _normalize_question_key(question: str) -> str:
    s = str(question or "").strip().lower()
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"[，,。.;；:：!?？]", "", s)
    return s[:120]


def _tenant_id() -> str:
    return (os.getenv("AGENT_TENANT_ID") or os.getenv("TENANT_ID") or "default").strip() or "default"


def _standalone_exclude_federated() -> bool:
    v = (os.getenv("EXPERIENCE_STANDALONE_EXCLUDE_FEDERATED") or "1").strip().lower()
    return v not in ("0", "false", "off", "no")


def _is_manager_orchestrated_row(row: dict[str, Any]) -> bool:
    plane = str(row.get("source_plane") or "").strip().lower()
    if plane in ("manager_orchestrated", "orchestrated"):
        return True
    src = str(row.get("source") or "").strip().lower()
    return (
        "manager_finalize_sync" in src
        or "manager_feedback_confirmed" in src
        or "federation" in src
        or src.startswith("mgr_")
    )


def _connect():
    import psycopg
    from psycopg.rows import dict_row

    url = (
        os.getenv("AGENT_DATABASE_URL")
        or os.getenv("CLAWHIVE_DATABASE_URL")
        or os.getenv("DATABASE_URL")
        or ""
    ).strip()
    if not url:
        raise RuntimeError("AGENT_DATABASE_URL not configured")
    return psycopg.connect(url.replace("postgresql+psycopg2:", "postgresql:"), row_factory=dict_row)


def _confirmed_only() -> bool:
    raw = str(os.getenv("EXPERIENCE_RECALL_CONFIRMED_ONLY") or "1").strip().lower()
    if raw in {"0", "false", "off", "no"}:
        return False
    return True


def _is_useful_source(row: dict[str, Any]) -> bool:
    """仅用户点「有用」确认的源可召回（对齐 shared/experienceRecallPolicy）。"""
    src = str(row.get("source") or "").strip().lower()
    if not src:
        return False
    if src.startswith("voided") or "shadow" in src or "useless" in src or "score:-1" in src:
        return False
    if "manager_feedback_confirmed" in src:
        return True
    if "feedback_confirmed" in src or "|useful" in src or "useful|" in src:
        return True
    if "vanna_feedback" in src:
        return True
    # status=confirmed 且非 finalize 自动同步
    status = str(row.get("status") or "").strip().lower()
    if status == "confirmed" and "manager_finalize_sync" not in src and "finalize" not in src:
        if "feedback" in src and "confirmed" in src:
            return True
    return False


def hydrate_admin_tool_experience_cache(max_rows: int = 400) -> None:
    global _experience_cache
    backend = os.getenv("ADMIN_STORAGE_BACKEND", "sqlite").strip().lower()
    if backend not in ("postgres", "pg", "dual"):
        _experience_cache = []
        return
    gated = os.getenv("ADM_TOOL_EXPERIENCE_REQUIRE_FEEDBACK", "1").strip().lower() not in ("0", "false", "no")
    status_filter = "AND status = 'confirmed'" if gated else "AND status != 'revoked'"
    tid = _tenant_id()
    try:
        with _connect() as conn:
            rows = conn.execute(
                f"""
                SELECT question_norm, tool_name, scenario, hint, source, source_plane, tenant_id, status
                FROM adm_tool_experience
                WHERE tenant_id = %s {status_filter}
                ORDER BY id DESC
                LIMIT %s
                """,
                (tid, max_rows),
            ).fetchall()
        cached = list(reversed(rows))
        if _standalone_exclude_federated():
            cached = [r for r in cached if not _is_manager_orchestrated_row(r)]
        if _confirmed_only():
            cached = [r for r in cached if _is_useful_source(r)]
        _experience_cache = cached
    except Exception:
        # 兼容未跑 017 迁移（无 tenant_id/source_plane）
        try:
            with _connect() as conn:
                rows = conn.execute(
                    f"""
                    SELECT question_norm, tool_name, scenario, hint, source, status
                    FROM adm_tool_experience
                    WHERE 1=1 {status_filter}
                    ORDER BY id DESC
                    LIMIT %s
                    """,
                    (max_rows,),
                ).fetchall()
            cached = list(reversed(rows))
            if _standalone_exclude_federated():
                cached = [r for r in cached if not _is_manager_orchestrated_row(r)]
            if _confirmed_only():
                cached = [r for r in cached if _is_useful_source(r)]
            _experience_cache = cached
        except Exception:
            _experience_cache = []


def _token_overlap(a: str, b: str) -> float:
    ta = set(re.findall(r"[\u4e00-\u9fff]{2,}|[a-z0-9]{2,}", _normalize_question_key(a)))
    tb = set(re.findall(r"[\u4e00-\u9fff]{2,}|[a-z0-9]{2,}", _normalize_question_key(b)))
    if not ta or not tb:
        return 0.0
    hit = sum(1 for t in ta if t in tb)
    return hit / max(len(ta), len(tb))


def _blend_score(lexical: float, vector: float) -> float:
    if vector > 0:
        vw = 0.58
        return vw * vector + (1 - vw) * lexical
    return lexical


def get_admin_tool_experience_recall(question: str, limit: int = 3) -> list[dict[str, Any]]:
    """返回带 score 的历史经验行，供意图 RAG 与 planning 注入。"""
    global _experience_cache
    if _experience_cache is None:
        hydrate_admin_tool_experience_cache()
    rows = _experience_cache or []
    if not rows:
        return []

    q = str(question or "").strip()
    qnorm = _normalize_question_key(q)
    qvec = embed_query(q) if is_admin_embedding_enabled() else []

    scored: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        norm = str(row.get("question_norm") or "")
        hint = str(row.get("hint") or "").strip()
        if not hint and not norm:
            continue
        lex = 1.0 if norm and norm == qnorm else _token_overlap(q, norm)
        vec = 0.0
        if qvec and norm:
            nvec = embed_query(norm)
            vec = cosine_similarity(qvec, nvec) if nvec else 0.0
        sim = _blend_score(lex, vec)
        if sim >= 0.28:
            scored.append(
                (
                    sim,
                    {
                        "question_norm": norm,
                        "tool_name": str(row.get("tool_name") or ""),
                        "scenario": str(row.get("scenario") or ""),
                        "hint": hint,
                        "tool_hint": str(row.get("tool_name") or ""),
                        "intent_hint": "",
                        "score": sim,
                    },
                )
            )

    scored.sort(key=lambda x: x[0], reverse=True)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for _, row in scored:
        key = row.get("hint") or row.get("question_norm")
        if key in seen:
            continue
        seen.add(str(key))
        out.append(row)
        if len(out) >= limit:
            break
    return out


def get_admin_tool_experience_hints(question: str, limit: int = 2) -> list[str]:
    """返回与当前问句相似的历史 Admin 成功经验 hint。"""
    return [str(r.get("hint") or "").strip() for r in get_admin_tool_experience_recall(question, limit) if r.get("hint")]


def format_admin_experience_block(question: str) -> str:
    hints = get_admin_tool_experience_hints(question)
    if not hints:
        return ""
    lines = [
        "## 历史 Admin 成功经验",
        "（仅供参考；与当前用户输入不一致时必须忽略，以当前输入为准）",
        "",
    ]
    for h in hints:
        lines.append(f"- {h}")
    return "\n".join(lines)
