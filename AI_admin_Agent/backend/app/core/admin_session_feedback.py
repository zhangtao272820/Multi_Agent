"""Admin 会话反馈 PG 存储（agent_session_feedback 表）。"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from app.core.admin_pg_store import _connect, agent_database_url, is_admin_pg_storage


def _pg_ready() -> bool:
    return is_admin_pg_storage() and bool(agent_database_url())


def upsert_session_feedback(
    *,
    session_id: str,
    feedback_key: str,
    score: int,
    turn_id: int | None = None,
    user_message_index: int | None = None,
    run_id: str | None = None,
    question: str | None = None,
    comment: str | None = None,
    artifact: dict[str, Any] | None = None,
) -> bool:
    if not _pg_ready():
        return False
    sid = (session_id or "").strip()[:120]
    key = (feedback_key or "").strip()[:120]
    if not sid or not key or score not in (1, -1):
        return False
    payload = artifact if isinstance(artifact, dict) else {}
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO agent_session_feedback
              (agent, session_id, feedback_key, turn_id, user_message_index, run_id,
               score, question, comment, artifact, updated_at)
            VALUES ('admin', %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
            ON CONFLICT (agent, session_id, feedback_key) DO UPDATE SET
              turn_id = COALESCE(EXCLUDED.turn_id, agent_session_feedback.turn_id),
              user_message_index = COALESCE(EXCLUDED.user_message_index, agent_session_feedback.user_message_index),
              run_id = COALESCE(EXCLUDED.run_id, agent_session_feedback.run_id),
              score = EXCLUDED.score,
              question = COALESCE(EXCLUDED.question, agent_session_feedback.question),
              comment = COALESCE(EXCLUDED.comment, agent_session_feedback.comment),
              artifact = CASE
                WHEN EXCLUDED.artifact = '{}'::jsonb THEN agent_session_feedback.artifact
                ELSE EXCLUDED.artifact
              END,
              updated_at = EXCLUDED.updated_at
            """,
            (
                sid,
                key,
                turn_id,
                user_message_index,
                (run_id or "")[:80] or None,
                score,
                (question or "")[:4000] or None,
                (comment or "")[:2000] or None,
                json.dumps(payload, ensure_ascii=False),
                datetime.now(timezone.utc),
            ),
        )
        conn.commit()
    return True


def list_session_feedback(session_id: str) -> list[dict[str, Any]]:
    if not _pg_ready():
        return []
    sid = (session_id or "").strip()[:120]
    if not sid:
        return []
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT feedback_key, turn_id, user_message_index, run_id, score, question, updated_at
            FROM agent_session_feedback
            WHERE agent = 'admin' AND session_id = %s
            ORDER BY updated_at ASC
            """,
            (sid,),
        ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        updated = r.get("updated_at")
        out.append(
            {
                "feedbackKey": str(r.get("feedback_key") or ""),
                "turnId": r.get("turn_id"),
                "userMessageIndex": r.get("user_message_index"),
                "runId": r.get("run_id"),
                "score": int(r.get("score") or 0),
                "question": r.get("question"),
                "updatedAt": updated.isoformat() if updated else None,
            }
        )
    return out


def delete_feedback_from_user_index(session_id: str, from_user_index: int) -> int:
    if not _pg_ready():
        return 0
    sid = (session_id or "").strip()[:120]
    uidx = int(from_user_index)
    with _connect() as conn:
        cur = conn.execute(
            """
            DELETE FROM agent_session_feedback
            WHERE agent = 'admin' AND session_id = %s
              AND user_message_index IS NOT NULL AND user_message_index >= %s
            """,
            (sid, uidx),
        )
        conn.commit()
        return int(cur.rowcount or 0)


def delete_feedback_from_turn(session_id: str, from_turn_id: int) -> int:
    if not _pg_ready():
        return 0
    sid = (session_id or "").strip()[:120]
    tid = int(from_turn_id)
    with _connect() as conn:
        cur = conn.execute(
            """
            DELETE FROM agent_session_feedback
            WHERE agent = 'admin' AND session_id = %s
              AND (
                (turn_id IS NOT NULL AND turn_id >= %s)
                OR (
                  feedback_key LIKE 'turn:%%'
                  AND substring(feedback_key from 6) ~ '^[0-9]+$'
                  AND CAST(substring(feedback_key from 6) AS INTEGER) >= %s
                )
              )
            """,
            (sid, tid, tid),
        )
        conn.commit()
        return int(cur.rowcount or 0)


def delete_all_session_feedback(session_id: str) -> int:
    if not _pg_ready():
        return 0
    sid = (session_id or "").strip()[:120]
    if not sid:
        return 0
    with _connect() as conn:
        cur = conn.execute(
            "DELETE FROM agent_session_feedback WHERE agent = 'admin' AND session_id = %s",
            (sid,),
        )
        conn.commit()
        return int(cur.rowcount or 0)


def turn_feedback_key(turn_id: int) -> str:
    return f"turn:{int(turn_id)}"


def user_message_feedback_key(user_message_index: int) -> str:
    return f"umidx:{int(user_message_index)}"


def list_run_ids_for_revision(
    session_id: str,
    *,
    user_message_index: int | None = None,
    from_user_index: int | None = None,
    at_index_only: bool = False,
) -> list[str]:
    """撤回/重生前收集 run_id，便于作废工具经验。"""
    items = list_session_feedback(session_id)
    out: list[str] = []
    for it in items:
        um = it.get("userMessageIndex")
        rid = str(it.get("runId") or "").strip()
        if not rid:
            continue
        if at_index_only and user_message_index is not None:
            if um == int(user_message_index):
                out.append(rid)
        elif from_user_index is not None:
            if isinstance(um, int) and um >= int(from_user_index):
                out.append(rid)
        elif user_message_index is not None and um == int(user_message_index):
            out.append(rid)
    return list(dict.fromkeys(out))


def delete_feedback_at_user_index(session_id: str, user_message_index: int) -> int:
    if not _pg_ready():
        return 0
    sid = (session_id or "").strip()[:120]
    uidx = int(user_message_index)
    um_key = user_message_feedback_key(uidx)
    with _connect() as conn:
        cur = conn.execute(
            """
            DELETE FROM agent_session_feedback
            WHERE agent = 'admin' AND session_id = %s
              AND (
                user_message_index = %s
                OR feedback_key = %s
              )
            """,
            (sid, uidx, um_key),
        )
        conn.commit()
        return int(cur.rowcount or 0)
