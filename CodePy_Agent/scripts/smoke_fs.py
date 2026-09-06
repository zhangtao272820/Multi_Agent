#!/usr/bin/env python3
"""FS sandbox smoke."""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> int:
    os.environ["PROJECT_DIR"] = str(ROOT)
    os.environ["ALLOWED_ROOTS"] = str(ROOT)
    os.environ["WRITE_TOOL_ENABLED"] = "1"
    from app.config import reload_settings
    from app.tools.fs_sandbox import list_tree, read_file, SandboxError, safe_resolve

    reload_settings()
    tree = list_tree(max_files=50, max_depth=2)
    assert tree, "empty tree"
    print("OK tree", len(tree))

    try:
        safe_resolve("C:/Windows/System32/drivers/etc/hosts")
        print("FAIL expected sandbox block")
        return 1
    except SandboxError:
        print("OK outside root blocked")

    text = read_file("README.md") if (ROOT / "README.md").is_file() else read_file("requirements.txt")
    assert text.get("content")
    print("OK read", text.get("path"))

    # S2.C2：动态工具挂载契约
    from app.runtime.edit_loop import tools_for_task_kind

    inspect_names = [t["function"]["name"] for t in tools_for_task_kind("inspect")]
    edit_names = [t["function"]["name"] for t in tools_for_task_kind("edit")]
    assert "propose_patch" not in inspect_names, inspect_names
    assert "propose_patch" in edit_names, edit_names
    assert "read_file" in inspect_names
    print("OK tools_for_task_kind")

    # compute→diff→confirm→write 契约：preview 产生 unified_diff，apply 需 write_allowed
    from app.protocol.incoming import parse_manager_task, write_apply_allowed
    from app.tools.search_replace import preview_search_replace

    tmp = ROOT / ".data" / "smoke_edit_golden.txt"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text("hello\nworld\n", encoding="utf-8")
    patch = ".data/smoke_edit_golden.txt\n<<<<<<< SEARCH\nworld\n=======\ncodepy\n>>>>>>> REPLACE\n"
    prev = preview_search_replace(patch)
    assert prev.get("ok") and prev.get("unified_diff"), prev
    mgr_deny = parse_manager_task({"source": "manager", "task_kind": "edit", "write_allowed": False})
    assert write_apply_allowed(mgr_deny, task_kind="edit") is False
    mgr_no_token = parse_manager_task({"source": "manager", "task_kind": "edit", "write_allowed": True})
    assert write_apply_allowed(mgr_no_token, task_kind="edit") is False
    mgr_ok = parse_manager_task(
        {"source": "manager", "task_kind": "edit", "write_allowed": True, "confirm_token": "tok"}
    )
    assert write_apply_allowed(mgr_ok, task_kind="edit") is True
    print("OK edit golden path contract")

    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
