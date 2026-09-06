#!/usr/bin/env python3
"""Pure-function smoke: path allowlist, rollback snapshot, verify shell, batch pending."""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    from app.tools.path_allowlist import assert_paths_allowed, normalize_rel_path, path_in_allowlist
    from app.tools.shell_sandbox import validate_shell_command
    from app.pending_patch import (
        combined_patch_text,
        drop_pending_patch,
        load_pending_patch,
        merge_pending_patch,
        save_pending_patch,
    )
    from app.tools.rollback import create_rollback_snapshot, drop_rollback, load_rollback, restore_rollback
    from app.tools.fs_sandbox import SandboxError
    from app.config import reload_settings

    # path allowlist
    assert_true(normalize_rel_path("src/foo.ts") == "src/foo.ts", "normalize")
    assert_true(path_in_allowlist("src/a.py", None), "empty allowlist allows")
    assert_true(path_in_allowlist("src/a.py", ["src"]), "dir prefix")
    assert_true(not path_in_allowlist("other/a.py", ["src"]), "outside blocked")
    try:
        assert_paths_allowed(["lib/x.py"], ["src"])
        raise AssertionError("expected SandboxError")
    except SandboxError:
        pass

    # verify profile
    ok, _ = validate_shell_command("pytest -q", profile="verify")
    assert_true(ok, "pytest verify ok")
    ok, _ = validate_shell_command("python -m pytest", profile="verify")
    assert_true(ok, "python -m pytest verify ok")
    ok, _ = validate_shell_command("npm test", profile="verify")
    assert_true(ok, "npm test verify ok")
    ok, reason = validate_shell_command("ls", profile="verify")
    assert_true(not ok, f"ls blocked in verify: {reason}")
    ok, _ = validate_shell_command("git status", profile="default")
    assert_true(ok, "git status default ok")
    ok, _ = validate_shell_command("git status", profile="verify")
    assert_true(not ok, "git blocked in verify")

    # batch pending merge
    pid = save_pending_patch(
        {
            "kind": "edit",
            "patch": "a.py\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE",
            "files": ["a.py"],
            "unified_diff": "diff a",
        }
    )
    merged = merge_pending_patch(
        pid,
        patch="b.py\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE",
        files=["b.py"],
        unified_diff="diff b",
    )
    assert_true(merged is not None and int(merged.get("batch_count") or 0) == 2, "batch_count=2")
    assert_true(set(merged.get("files") or []) == {"a.py", "b.py"}, "files merged")
    text = combined_patch_text(merged or {})
    assert_true("a.py" in text and "b.py" in text, "combined patch")
    drop_pending_patch(pid)
    assert_true(load_pending_patch(pid) is None, "dropped")

    # rollback snapshot roundtrip (temp project)
    with tempfile.TemporaryDirectory() as td:
        os.environ["PROJECT_DIR"] = td
        os.environ["ALLOWED_ROOTS"] = td
        os.environ["WRITE_TOOL_ENABLED"] = "1"
        os.environ["CODE_DATA_DIR"] = str(Path(td) / ".data")
        reload_settings()
        f = Path(td) / "note.txt"
        f.write_text("hello", encoding="utf-8")
        rid = create_rollback_snapshot(["note.txt"], root_override=td)
        snap = load_rollback(rid)
        assert_true(bool(snap and snap.get("files", {}).get("note.txt", {}).get("exists")), "snapshot")
        f.write_text("changed", encoding="utf-8")
        restored = restore_rollback(rid, root_override=td, require_write_enabled=True)
        assert_true(restored.get("ok") is True, "restore ok")
        assert_true(f.read_text(encoding="utf-8") == "hello", "content restored")
        drop_rollback(rid)

    print("smoke_hands_safety: OK")


if __name__ == "__main__":
    main()
