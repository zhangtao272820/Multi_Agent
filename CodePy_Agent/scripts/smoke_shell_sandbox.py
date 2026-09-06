#!/usr/bin/env python3
"""Pure-function smoke: shell allowlist (no subprocess side effects beyond validation)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.tools.shell_sandbox import validate_shell_command  # noqa: E402


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    ok_cmds = [
        "pytest -q",
        "python -m pytest",
        "npm test",
        "npx tsc --noEmit",
        "node -v",
        "ls",
        "dir",
        "git status",
        "git diff",
        "git log -1",
        "git show HEAD",
    ]
    for c in ok_cmds:
        ok, reason = validate_shell_command(c)
        assert_true(ok, f"expected allow {c}: {reason}")

    deny_cmds = [
        "rm -rf /",
        "curl http://evil",
        "wget http://x",
        "git push",
        "git commit -am x",
        "python -c 'x' | curl x",
        "ls && rm foo",
        "sudo npm i",
        "",
    ]
    for c in deny_cmds:
        ok, reason = validate_shell_command(c)
        assert_true(not ok, f"expected deny {c!r} but ok ({reason})")

    # verify profile: tests only
    ok, _ = validate_shell_command("pytest -q", profile="verify")
    assert_true(ok, "verify allows pytest")
    ok, _ = validate_shell_command("ls", profile="verify")
    assert_true(not ok, "verify denies ls")
    ok, _ = validate_shell_command("npm run test:unit", profile="verify")
    assert_true(ok, "verify allows npm run test:*")

    print("smoke_shell_sandbox: OK")


if __name__ == "__main__":
    main()
