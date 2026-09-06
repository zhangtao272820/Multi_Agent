#!/usr/bin/env python3
"""Pure-function smoke: write impact estimate, dual-account resolve, batch pending, impact_ack gate."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.scenes import get_scene  # noqa: E402
from app.sql_guard import guard_write_sql  # noqa: E402
from app.tenants import MysqlConf, Tenant  # noqa: E402
from app.write_impact import (  # noqa: E402
    build_count_sql_for_write,
    build_impact_estimate,
    estimate_insert_rows,
    impact_requires_ack,
)
from app.write_sql import decide_write_pending, merge_write_pending  # noqa: E402
from app.pending import drop_pending, save_pending  # noqa: E402


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    # count SQL derivation
    c = build_count_sql_for_write("UPDATE users SET name='b' WHERE id=1", "update")
    assert_true(c is not None and "COUNT(*)" in (c or "") and "WHERE id=1" in (c or ""), "update count")
    c2 = build_count_sql_for_write("DELETE FROM users WHERE id=2", "delete")
    assert_true(c2 is not None and "users" in (c2 or ""), "delete count")
    assert_true(build_count_sql_for_write("INSERT INTO users (name) VALUES ('a')", "insert") is None, "insert no count")

    assert_true(estimate_insert_rows("INSERT INTO t (a) VALUES (1),(2),(3)") == 3, "insert rows")
    assert_true(impact_requires_ack(600, threshold=500), "over threshold")
    assert_true(not impact_requires_ack(10, threshold=500), "under threshold")

    est = build_impact_estimate(sql="UPDATE users SET x=1 WHERE id=1", write_kind="update", estimated_rows=10, threshold=500)
    assert_true(est["requires_ack"] is False and est["estimated_rows"] == 10, "low impact")
    est_hi = build_impact_estimate(
        sql="UPDATE users SET x=1 WHERE id>0", write_kind="update", estimated_rows=900, threshold=500
    )
    assert_true(est_hi["requires_ack"] is True, "high impact ack")
    est_unk = build_impact_estimate(sql="UPDATE users SET x=1 WHERE id=1", write_kind="update", estimated_rows=None)
    assert_true(est_unk["requires_ack"] is True, "unknown requires ack")

    # dual account resolve
    read_cfg = MysqlConf("127.0.0.1", 3306, "readonly", "rp", "db")
    write_cfg = MysqlConf("127.0.0.1", 3306, "writer", "wp", "db")
    t = Tenant(id="smoke", title="s", mysql=read_cfg, mysql_write=write_cfg, table_whitelist=["users"])
    assert_true(t.write_mysql().user == "writer", "write role")
    t2 = Tenant(id="smoke2", title="s", mysql=read_cfg, table_whitelist=["users"])
    assert_true(t2.write_mysql().user == "readonly", "fallback read")

    # impact_ack gate on decide (no DB execute — pending with requires_ack, fake tenant will fail unknown)
    pid = save_pending(
        {
            "kind": "write",
            "tenant": "___missing___",
            "scene": "assistant",
            "sql": "UPDATE users SET name='x' WHERE id=1",
            "sqls": ["UPDATE users SET name='x' WHERE id=1"],
            "write_kind": "update",
            "impact_estimate": {"requires_ack": True, "estimated_rows": 900, "threshold": 500},
        }
    )
    r = decide_write_pending(pending_id=pid, decision="确认", confirm_token="tok", impact_ack=False)
    assert_true(r.get("error_code") == "impact_ack_required", "impact_ack gate")
    r2 = decide_write_pending(pending_id=pid, decision="确认", confirm_token="tok", impact_ack=True)
    assert_true(r2.get("error_code") == "unknown_tenant", "ack passes to tenant check")
    drop_pending(pid)

    # batch merge pending (guard against fake tenant tables)
    class _FakeTenant:
        id = "smoke"
        mysql = read_cfg
        mysql_write = None
        table_whitelist = ["users"]

        def allow_table(self, name: str) -> bool:
            return str(name or "").split(".")[-1].lower() == "users"

        def write_mysql(self):
            return self.mysql

    scene = get_scene("assistant")
    g = guard_write_sql("UPDATE users SET name='a' WHERE id=1", tenant=_FakeTenant(), scene=scene)
    assert_true(g.ok, "guard ok for merge seed")
    pid2 = save_pending(
        {
            "kind": "write",
            "tenant": "smoke",
            "scene": "assistant",
            "sql": g.sql,
            "sqls": [g.sql],
            "write_kind": "update",
            "write_kinds": ["update"],
            "tables": ["users"],
            "impact_estimate": {"items": [], "requires_ack": False, "estimated_rows": 1, "threshold": 500},
        }
    )
    merged = merge_write_pending(
        pid2,
        sql="UPDATE users SET name='b' WHERE id=2",
        tenant=_FakeTenant(),  # type: ignore[arg-type]
        scene=scene,
    )
    assert_true(merged is not None, "merge ok")
    assert_true(len(merged.get("sqls") or []) == 2, "two sqls")  # type: ignore[union-attr]
    assert_true(merged.get("write_kind") == "batch", "batch kind")  # type: ignore[union-attr]
    drop_pending(pid2)

    print("smoke_write_impact: OK")


if __name__ == "__main__":
    main()
