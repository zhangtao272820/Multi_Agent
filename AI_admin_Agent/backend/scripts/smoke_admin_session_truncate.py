"""Smoke: Admin session truncate 命中与计数（sqlite 必跑；PG 可用时再跑 PG 路径）。"""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def _run_sqlite_truncate() -> dict:
    os.environ["ADMIN_STORAGE_BACKEND"] = "sqlite"
    # 重新加载存储开关相关模块状态不需要；函数每次读 env
    from app.core.session_dialogue import (
        SessionTurn,
        SessionLocal,
        append_turn,
        delete_session_dialogue,
        truncate_session_from_user_index,
    )

    sid = f"smoke-trunc-sqlite-{uuid.uuid4().hex[:12]}"
    try:
        append_turn(sid, "user", "第一轮用户")
        append_turn(sid, "assistant", "第一轮助手")
        append_turn(sid, "user", "第二轮用户")
        append_turn(sid, "assistant", "第二轮助手")
        out = truncate_session_from_user_index(sid, 1)
        assert_true(bool(out.get("ok")), f"sqlite truncate must ok: {out}")
        assert_true(int(out.get("user_message_count") or 0) == 1, f"expect 1 user left: {out}")
        assert_true(int(out.get("message_count") or 0) == 2, f"expect 2 turns left: {out}")
        assert_true(int(out.get("resolved_user_index") or -1) == 1, f"resolved idx: {out}")

        miss = truncate_session_from_user_index(sid, 99, fallback_user_text="不存在的锚点")
        assert_true(not bool(miss.get("ok")), f"miss must fail: {miss}")

        by_text = truncate_session_from_user_index(
            sid, -1, fallback_user_text="第一轮用户"
        )
        assert_true(bool(by_text.get("ok")), f"fallback text must hit: {by_text}")
        assert_true(int(by_text.get("user_message_count") or 0) == 0, f"all cut: {by_text}")
        return {"sqlite": "ok", "sid": sid}
    finally:
        delete_session_dialogue(sid)
        db = SessionLocal()
        try:
            db.query(SessionTurn).filter(SessionTurn.session_id == sid).delete()
            db.commit()
        finally:
            db.close()


def _run_pg_truncate() -> dict | None:
    from app.core.admin_pg_store import (
        append_turn_pg,
        delete_session_pg,
        load_turns_pg,
        ping_admin_pg,
        truncate_turns_pg,
        agent_database_url,
    )

    # 先切回 postgres，否则 ping_admin_pg 会因 sqlite 开关短路
    os.environ["ADMIN_STORAGE_BACKEND"] = "postgres"
    if not agent_database_url() or not ping_admin_pg():
        return None
    sid = f"smoke-trunc-pg-{uuid.uuid4().hex[:12]}"
    try:
        append_turn_pg(sid, "user", "PG第一轮", user_id="smoke")
        append_turn_pg(sid, "assistant", "PG助手1", user_id="smoke")
        append_turn_pg(sid, "user", "PG第二轮", user_id="smoke")
        append_turn_pg(sid, "assistant", "PG助手2", user_id="smoke")
        assert_true(len(load_turns_pg(sid)) == 4, "seed 4 turns")

        out = truncate_turns_pg(sid, 1)
        assert_true(bool(out.get("ok")), f"pg truncate must ok: {out}")
        assert_true(int(out.get("user_message_count") or 0) == 1, f"pg user count: {out}")
        assert_true(int(out.get("message_count") or 0) == 2, f"pg msg count: {out}")
        left = load_turns_pg(sid)
        assert_true(len(left) == 2, f"pg left rows: {left}")
        assert_true(str(left[0].get("content") or "") == "PG第一轮", "kept first user")

        from app.core.session_dialogue import truncate_session_from_user_index

        via_api = truncate_session_from_user_index(sid, 0)
        assert_true(bool(via_api.get("ok")), f"session_dialogue pg path: {via_api}")
        assert_true(int(via_api.get("message_count") or 0) == 0, f"all gone: {via_api}")
        return {"pg": "ok", "sid": sid}
    finally:
        delete_session_pg(sid)


def main() -> None:
    sqlite_res = _run_sqlite_truncate()
    pg_res = _run_pg_truncate()
    print(
        "smoke-admin-session-truncate: OK",
        {"sqlite": sqlite_res, "pg": pg_res or "skipped (no AGENT_DATABASE_URL/ping)"},
    )


if __name__ == "__main__":
    main()
