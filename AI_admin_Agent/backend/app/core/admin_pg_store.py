"""Admin 短期会话 PG 存储（adm_session_turns / adm_session_task_contexts）。"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row


def admin_storage_backend() -> str:
    return os.getenv("ADMIN_STORAGE_BACKEND", "sqlite").strip().lower()


def is_admin_pg_storage() -> bool:
    return admin_storage_backend() in ("postgres", "pg", "dual")


def is_admin_pg_primary() -> bool:
    return admin_storage_backend() in ("postgres", "pg")


def is_admin_dual_storage() -> bool:
    return admin_storage_backend() == "dual"


def agent_database_url() -> str:
    return (
        os.getenv("AGENT_DATABASE_URL")
        or os.getenv("CLAWHIVE_DATABASE_URL")
        or os.getenv("DATABASE_URL")
        or ""
    ).strip()


def _connect():
    url = agent_database_url()
    if not url:
        raise RuntimeError("AGENT_DATABASE_URL not configured")
    return psycopg.connect(url.replace("postgresql+psycopg2:", "postgresql:"), row_factory=dict_row)


def append_turn_pg(session_id: str, role: str, content: str, user_id: str | None = None) -> None:
    sid = (session_id or "default").strip() or "default"
    text = (content or "").strip()
    if not text:
        return
    uid = (user_id or "").strip() or None
    with _connect() as conn:
        conn.execute(
            "INSERT INTO adm_session_turns (session_id, role, content) VALUES (%s, %s, %s)",
            (sid, role, text),
        )
        conn.execute(
            """
            INSERT INTO adm_sessions (id, user_id, updated_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (id) DO UPDATE SET
              user_id = COALESCE(EXCLUDED.user_id, adm_sessions.user_id),
              updated_at = NOW()
            """,
            (sid, uid),
        )
        conn.commit()


def touch_adm_session_pg(
    session_id: str,
    *,
    user_id: str | None = None,
    title: str | None = None,
    custom_title: bool | None = None,
) -> None:
    sid = (session_id or "default").strip() or "default"
    if not sid:
        return
    uid = (user_id or "").strip() or None
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO adm_sessions (id, user_id, title, custom_title, updated_at)
            VALUES (%s, %s, %s, COALESCE(%s, false), NOW())
            ON CONFLICT (id) DO UPDATE SET
              user_id = COALESCE(EXCLUDED.user_id, adm_sessions.user_id),
              title = COALESCE(EXCLUDED.title, adm_sessions.title),
              custom_title = COALESCE(%s, adm_sessions.custom_title),
              updated_at = NOW()
            """,
            (sid, uid, title, custom_title, custom_title),
        )
        conn.commit()


def list_adm_sessions_pg(user_id: str) -> list[dict[str, Any]]:
    uid = (user_id or "").strip()
    if not uid:
        return []
    with _connect() as conn:
        rows = list(
            conn.execute(
                """
                SELECT s.id, s.title, s.custom_title, s.updated_at,
                       (SELECT COUNT(*)::int FROM adm_session_turns t WHERE t.session_id = s.id) AS message_count,
                       (SELECT COUNT(*)::int FROM adm_session_turns t
                         WHERE t.session_id = s.id AND t.role = 'user') AS user_message_count,
                       (SELECT content FROM adm_session_turns t
                         WHERE t.session_id = s.id AND t.role = 'user'
                         ORDER BY t.id ASC LIMIT 1) AS first_user
                FROM adm_sessions s
                WHERE s.user_id = %s
                ORDER BY s.updated_at DESC
                LIMIT 80
                """,
                (uid,),
            ).fetchall()
        )
    out: list[dict[str, Any]] = []
    for row in rows:
        msg_count = int(row.get("message_count") or 0)
        custom = bool(row.get("custom_title"))
        title = str(row.get("title") or "").strip()
        if not custom or not title:
            first = str(row.get("first_user") or "").replace("\n", " ").strip()
            title = (first[:36] + "…") if len(first) > 36 else (first or "新会话")
        if msg_count <= 0 and not (custom and row.get("title")):
            continue
        updated = row.get("updated_at")
        out.append(
            {
                "id": str(row["id"]),
                "title": title or "新会话",
                "updatedAt": updated.isoformat() if hasattr(updated, "isoformat") else str(updated or ""),
                "messageCount": msg_count,
                "userMessageCount": int(row.get("user_message_count") or 0),
                "customTitle": custom and bool(str(row.get("title") or "").strip()),
            }
        )
    return out


def delete_session_pg(session_id: str) -> dict[str, int]:
    sid = (session_id or "default").strip() or "default"
    with _connect() as conn:
        turns = conn.execute(
            "DELETE FROM adm_session_turns WHERE session_id = %s",
            (sid,),
        ).rowcount
        ctx = conn.execute(
            "DELETE FROM adm_session_task_contexts WHERE session_id = %s",
            (sid,),
        ).rowcount
        meta = conn.execute(
            "DELETE FROM adm_sessions WHERE id = %s",
            (sid,),
        ).rowcount
        conn.commit()
    return {"turns": int(turns or 0), "contexts": int(ctx or 0), "sessions": int(meta or 0)}


def ping_admin_pg() -> bool:
    if not is_admin_pg_storage() or not agent_database_url():
        return False
    try:
        with _connect() as conn:
            conn.execute("SELECT 1")
        return True
    except Exception:
        return False


def count_turns_pg(session_id: str) -> int:
    sid = (session_id or "default").strip() or "default"
    with _connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM adm_session_turns WHERE session_id = %s",
            (sid,),
        ).fetchone()
        return int(row["cnt"] if row else 0)


def load_turns_pg(session_id: str, limit: int | None = None, offset: int = 0) -> list[dict[str, Any]]:
    sid = (session_id or "default").strip() or "default"
    sql = "SELECT id, session_id, role, content, created_at FROM adm_session_turns WHERE session_id = %s ORDER BY id ASC"
    params: list[Any] = [sid]
    if limit is not None:
        sql += " LIMIT %s OFFSET %s"
        params.extend([limit, offset])
    with _connect() as conn:
        return list(conn.execute(sql, params).fetchall())


def load_task_context_pg(session_id: str) -> dict[str, Any]:
    sid = (session_id or "default").strip() or "default"
    with _connect() as conn:
        row = conn.execute(
            "SELECT context_json FROM adm_session_task_contexts WHERE session_id = %s",
            (sid,),
        ).fetchone()
        if not row:
            return {}
        payload = row.get("context_json") or {}
        return payload if isinstance(payload, dict) else {}


def save_task_context_pg(session_id: str, ctx: dict[str, Any]) -> None:
    sid = (session_id or "default").strip() or "default"
    now = datetime.now(timezone.utc)
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO adm_session_task_contexts (session_id, context_json, updated_at)
            VALUES (%s, %s::jsonb, %s)
            ON CONFLICT (session_id) DO UPDATE SET context_json = EXCLUDED.context_json, updated_at = EXCLUDED.updated_at
            """,
            (sid, json.dumps(ctx, ensure_ascii=False), now),
        )
        conn.commit()


def load_recent_turns_pg(session_id: str, limit: int) -> list[dict[str, Any]]:
    sid = (session_id or "default").strip() or "default"
    sql = (
        "SELECT id, session_id, role, content, created_at FROM adm_session_turns "
        "WHERE session_id = %s ORDER BY id DESC LIMIT %s"
    )
    with _connect() as conn:
        rows = list(conn.execute(sql, (sid, limit)).fetchall())
    return list(reversed(rows))


def replace_last_assistant_turn_pg(session_id: str, content: str) -> bool:
    sid = (session_id or "default").strip() or "default"
    text = (content or "").strip()
    if not text:
        return False
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT id FROM adm_session_turns
            WHERE session_id = %s AND role = 'assistant'
            ORDER BY id DESC LIMIT 1
            """,
            (sid,),
        ).fetchone()
        if not row:
            conn.execute(
                "INSERT INTO adm_session_turns (session_id, role, content) VALUES (%s, %s, %s)",
                (sid, "assistant", text),
            )
        else:
            conn.execute(
                "UPDATE adm_session_turns SET content = %s WHERE id = %s",
                (text, row["id"]),
            )
        conn.commit()
    return True


def trim_turns_pg(session_id: str, keep_last: int) -> bool:
    sid = (session_id or "default").strip() or "default"
    keep = max(1, int(keep_last))
    with _connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM adm_session_turns WHERE session_id = %s",
            (sid,),
        ).fetchone()
        total = int(row["cnt"] if row else 0)
        if total <= keep:
            return False
        conn.execute(
            """
            DELETE FROM adm_session_turns
            WHERE session_id = %s
              AND id IN (
                SELECT id FROM adm_session_turns
                WHERE session_id = %s
                ORDER BY id ASC
                LIMIT %s
              )
            """,
            (sid, sid, total - keep),
        )
        conn.commit()
    return True
