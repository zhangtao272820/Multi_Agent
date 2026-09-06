"""Sandbox terminal: allowlisted commands under PROJECT_DIR / ALLOWED_ROOTS."""

from __future__ import annotations

import os
import re
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.tools.fs_sandbox import SandboxError, get_root


# Deterministic allowlist (not user-intent). First token / known prefixes.
_ALLOWED_PREFIXES = (
    "python",
    "python3",
    "py",
    "pytest",
    "npm",
    "npx",
    "node",
    "ls",
    "dir",
    "git",
)

# verify profile: only test runners (still denied: network / destructive tokens)
_VERIFY_PREFIXES = frozenset({"python", "python3", "py", "pytest", "npm", "npx"})

_GIT_SUB = frozenset({"status", "diff", "log", "show", "branch", "rev-parse"})

_DENIED = re.compile(
    r"\b(rm|del|rmdir|curl|wget|chmod|chown|mkfs|dd|shutdown|reboot|format)\b|"
    r"[|&;`$<>]|\b(sudo|su)\b",
    re.I,
)

ShellProfile = str  # "default" | "verify"


def _normalize_profile(profile: str | None) -> str:
    p = str(profile or "default").strip().lower()
    if p in {"verify", "test", "ci"}:
        return "verify"
    return "default"


def _is_verify_command(parts: list[str], base: str) -> bool:
    """Allow pytest / python -m pytest / npm test|run test|run test:* only."""
    if base not in _VERIFY_PREFIXES:
        return False
    if base == "pytest":
        return True
    if base in {"python", "python3", "py"}:
        # python -m pytest ...
        return len(parts) >= 3 and parts[1] == "-m" and parts[2].lower() == "pytest"
    if base in {"npm", "npx"}:
        if len(parts) < 2:
            return False
        sub = parts[1].lower()
        if sub == "test":
            return True
        if sub == "run" and len(parts) >= 3:
            script = parts[2].lower()
            return script == "test" or script.startswith("test:")
        return False
    return False


@dataclass
class ShellResult:
    ok: bool
    exit_code: int
    stdout: str
    stderr: str
    command: str
    cwd: str
    error: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "command": self.command,
            "cwd": self.cwd,
            "error": self.error,
        }


def _resolve_cwd(cwd: str | None, root_override: str | None = None) -> Path:
    root = Path(get_root(root_override)).resolve()
    if not cwd or not str(cwd).strip() or str(cwd).strip() in {".", "./"}:
        return root
    cand = (root / str(cwd).strip()).resolve()
    try:
        cand.relative_to(root)
    except ValueError as exc:
        raise SandboxError(f"cwd outside sandbox: {cwd}") from exc
    if not cand.is_dir():
        raise SandboxError(f"cwd not a directory: {cwd}")
    return cand


def validate_shell_command(command: str, *, profile: str | None = None) -> tuple[bool, str]:
    raw = str(command or "").strip()
    if not raw:
        return False, "empty command"
    if len(raw) > 2000:
        return False, "command too long"
    if _DENIED.search(raw):
        return False, "command contains denied tokens or shell operators"
    try:
        parts = shlex.split(raw, posix=os.name != "nt")
    except ValueError as exc:
        return False, f"parse error: {exc}"
    if not parts:
        return False, "empty command"
    head = parts[0].lower()
    # Windows: strip .exe / path basename
    base = Path(head).name
    base = re.sub(r"\.(exe|cmd|bat)$", "", base, flags=re.I).lower()
    prof = _normalize_profile(profile)
    if prof == "verify":
        if not _is_verify_command(parts, base):
            return False, "verify profile only allows pytest / python -m pytest / npm test"
        return True, "ok"
    if base not in _ALLOWED_PREFIXES and head not in _ALLOWED_PREFIXES:
        return False, f"command not allowlisted: {base or head}"
    if base == "git" or head == "git":
        if len(parts) < 2 or parts[1].lower() not in _GIT_SUB:
            return False, "git subcommand not allowlisted (status|diff|log|show|branch|rev-parse)"
    return True, "ok"


def run_terminal(
    command: str,
    *,
    cwd: str | None = None,
    root_override: str | None = None,
    timeout_s: float | None = None,
    max_output: int = 12_000,
    profile: str | None = None,
) -> dict[str, Any]:
    ok, reason = validate_shell_command(command, profile=profile)
    if not ok:
        return ShellResult(
            ok=False,
            exit_code=126,
            stdout="",
            stderr="",
            command=str(command or ""),
            cwd="",
            error=reason,
        ).as_dict()
    work = _resolve_cwd(cwd, root_override)
    settings = get_settings()
    timeout = float(timeout_s if timeout_s is not None else getattr(settings, "shell_timeout_s", 60) or 60)
    timeout = max(1.0, min(timeout, 180.0))
    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=str(work),
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        out = (proc.stdout or "")[:max_output]
        err = (proc.stderr or "")[:max_output]
        return ShellResult(
            ok=proc.returncode == 0,
            exit_code=int(proc.returncode),
            stdout=out,
            stderr=err,
            command=command,
            cwd=str(work),
        ).as_dict()
    except subprocess.TimeoutExpired:
        return ShellResult(
            ok=False,
            exit_code=124,
            stdout="",
            stderr="",
            command=command,
            cwd=str(work),
            error=f"timeout after {timeout}s",
        ).as_dict()
    except Exception as exc:  # noqa: BLE001
        return ShellResult(
            ok=False,
            exit_code=1,
            stdout="",
            stderr="",
            command=command,
            cwd=str(work),
            error=str(exc)[:400],
        ).as_dict()
