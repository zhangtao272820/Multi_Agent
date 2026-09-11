"""Admin inflight 闸契约 smoke（无 Redis / 无 LLM）。"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.core.admin_inflight import (  # noqa: E402
    try_acquire_admin_slots,
    release_admin_slots,
    reset_admin_inflight_for_tests,
)


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


reset_admin_inflight_for_tests()
ok, _ = try_acquire_admin_slots(pool="admin", tenant_id="tA", max_global=2, max_per_tenant=1)
assert_true(ok, "a1")
ok2, reason = try_acquire_admin_slots(pool="admin", tenant_id="tA", max_global=2, max_per_tenant=1)
assert_true(not ok2, f"tenant cap: {reason}")
ok3, _ = try_acquire_admin_slots(pool="admin", tenant_id="tB", max_global=2, max_per_tenant=1)
assert_true(ok3, "b1")
ok4, _ = try_acquire_admin_slots(pool="admin", tenant_id="tC", max_global=2, max_per_tenant=1)
assert_true(not ok4, "global cap")
release_admin_slots(pool="admin", tenant_id="tA")
ok5, _ = try_acquire_admin_slots(pool="admin", tenant_id="tC", max_global=2, max_per_tenant=1)
assert_true(ok5, "after release")
release_admin_slots(pool="admin", tenant_id="tB")
release_admin_slots(pool="admin", tenant_id="tC")
reset_admin_inflight_for_tests()
print("smoke_admin_inflight: ok")
