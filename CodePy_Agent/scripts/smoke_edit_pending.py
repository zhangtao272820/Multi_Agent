#!/usr/bin/env python3
"""Contract smoke: pending patch save/load + write_apply_allowed requires token."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.pending_patch import drop_pending_patch, load_pending_patch, save_pending_patch  # noqa: E402
from app.protocol.incoming import ManagerCodeTask, write_apply_allowed  # noqa: E402


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    pid = save_pending_patch({"kind": "edit", "patch": "a.py\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE"})
    loaded = load_pending_patch(pid)
    assert_true(bool(loaded and loaded.get("id") == pid), "pending roundtrip")
    drop_pending_patch(pid)
    assert_true(load_pending_patch(pid) is None, "pending dropped")

    m0 = ManagerCodeTask(write_allowed=True, confirm_token="", task_kind="edit")
    assert_true(not write_apply_allowed(m0, task_kind="edit"), "no token → no apply")
    m1 = ManagerCodeTask(write_allowed=True, confirm_token="tok", task_kind="edit")
    assert_true(write_apply_allowed(m1, task_kind="edit"), "token + write_allowed → apply")
    m2 = ManagerCodeTask(write_allowed=False, confirm_token="tok", task_kind="edit")
    assert_true(not write_apply_allowed(m2, task_kind="edit"), "write_allowed=false blocks")

    print("smoke_edit_pending: OK")


if __name__ == "__main__":
    main()
