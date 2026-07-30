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
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
