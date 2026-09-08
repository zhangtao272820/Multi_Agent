#!/usr/bin/env python3
"""Pure-function smoke: guard_write_sql allow/deny (no DB)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.scenes import get_scene  # noqa: E402
from app.sql_guard import guard_write_sql  # noqa: E402


class _FakeTenant:
    id = "smoke"
    table_whitelist = ["users", "orders"]

    def allow_table(self, name: str) -> bool:
        n = str(name or "").split(".")[-1].lower()
        return n in {t.lower() for t in self.table_whitelist}


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    tenant = _FakeTenant()
    scene = get_scene("assistant")

    ok_cases = [
        ("INSERT INTO users (name) VALUES ('a')", "insert"),
        ("UPDATE users SET name='b' WHERE id=1", "update"),
        ("DELETE FROM users WHERE id=1", "delete"),
        ("CREATE TABLE IF NOT EXISTS tmp_x (id INT PRIMARY KEY)", "create_table"),
        ("ALTER TABLE users ADD COLUMN note VARCHAR(64)", "alter_add"),
        ("ALTER TABLE users MODIFY COLUMN note VARCHAR(128)", "alter_modify"),
    ]
    for sql, kind in ok_cases:
        g = guard_write_sql(sql, tenant=tenant, scene=scene)
        assert_true(g.ok, f"expected ok for {kind}: {g.reason} sql={sql}")
        assert_true(g.write_kind == kind, f"kind want {kind} got {g.write_kind}")

    deny_cases = [
        "DROP TABLE users",
        "TRUNCATE TABLE users",
        "ALTER TABLE users DROP COLUMN note",
        "DROP DATABASE foo",
        "GRANT ALL ON *.* TO 'x'",
        "REPLACE INTO users (id) VALUES (1)",
        "SELECT * FROM users",
        "INSERT INTO users (name) VALUES ('a'); DROP TABLE users",
    ]
    for sql in deny_cases:
        g = guard_write_sql(sql, tenant=tenant, scene=scene)
        assert_true(not g.ok, f"expected deny for: {sql} (got {g.reason})")

    # chat_json returns str JSON — classify / plan must parse, not call .get on str
    from unittest.mock import patch

    from app.llm import LlmMeter
    from app.write_sql import classify_read_or_write, parse_llm_json, plan_write_sql

    assert_true(parse_llm_json('{"mode":"read","confidence":0.9}')["mode"] == "read", "parse str json")
    assert_true(parse_llm_json({"mode": "write"})["mode"] == "write", "parse dict passthrough")
    assert_true(parse_llm_json("not-json") == {}, "bad json empty")
    with patch("app.write_sql.chat_json", return_value='{"mode":"write","confidence":0.9,"reason":"建表"}'):
        assert_true(classify_read_or_write(question="新建一张演示表", meter=LlmMeter()) == "write", "classify write from str")
    with patch("app.write_sql.chat_json", return_value='{"mode":"read","confidence":0.95,"reason":"查数"}'):
        assert_true(
            classify_read_or_write(question="河西区70到79岁老人男女各多少人", meter=LlmMeter()) == "read",
            "classify read from str",
        )
    with patch("app.write_sql.link_tables", return_value=[]), patch(
        "app.write_sql.cards_for", return_value=""
    ), patch(
        "app.write_sql.chat_json",
        return_value='{"intent":"create_table","need_clarify":false,"clarify":"","reason":"ok","sql":"CREATE TABLE t (id INT)"}',
    ):
        planned = plan_write_sql(tenant=tenant, scene=scene, question="建表", meter=LlmMeter())
        assert_true(planned.get("intent") == "create_table" and "CREATE TABLE" in planned.get("sql", ""), "plan_write parses str")

    # pending decide without token
    from app.write_sql import decide_write_pending
    from app.pending import save_pending, drop_pending

    pid = save_pending(
        {
            "kind": "write",
            "tenant": "smoke",
            "scene": "assistant",
            "sql": "UPDATE users SET name='x' WHERE id=1",
            "write_kind": "update",
        }
    )
    r = decide_write_pending(pending_id=pid, decision="确认", confirm_token="")
    assert_true(r.get("error_code") == "blast_radius_confirm_required", "no token must block")
    r2 = decide_write_pending(pending_id=pid, decision="取消", confirm_token="")
    assert_true(r2.get("ok") is True and r2.get("executed") is False, "cancel drops pending")
    drop_pending(pid)

    print("smoke_write_guard: OK")


if __name__ == "__main__":
    main()
