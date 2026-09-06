"""Task-scoped path allowlist for write/preview (beyond PROJECT_DIR sandbox)."""

from __future__ import annotations

from pathlib import Path, PurePosixPath


def normalize_rel_path(path: str) -> str:
    raw = str(path or "").strip().replace("\\", "/")
    if not raw or raw in {".", "./"}:
        return ""
    # strip leading ./ 
    while raw.startswith("./"):
        raw = raw[2:]
    p = PurePosixPath(raw)
    parts = [x for x in p.parts if x not in ("", ".")]
    if ".." in parts:
        raise ValueError(f"path traversal not allowed: {path}")
    return "/".join(parts)


def _match_one(rel: str, rule: str) -> bool:
    """rel matches rule if equal, or rel is under rule/ (dir prefix)."""
    if not rule:
        return False
    if rel == rule:
        return True
    # directory rule: "src" or "src/" allows src/foo.ts
    prefix = rule.rstrip("/") + "/"
    return rel.startswith(prefix)


def path_in_allowlist(rel: str, allowed_paths: list[str] | None) -> bool:
    """Empty/None allowlist → only sandbox roots apply (caller still uses assert_allowed)."""
    if not allowed_paths:
        return True
    try:
        n = normalize_rel_path(rel)
    except ValueError:
        return False
    if not n:
        return False
    rules: list[str] = []
    for r in allowed_paths:
        try:
            nr = normalize_rel_path(r)
        except ValueError:
            continue
        if nr:
            rules.append(nr)
    if not rules:
        return True
    return any(_match_one(n, rule) for rule in rules)


def assert_paths_allowed(paths: list[str], allowed_paths: list[str] | None) -> None:
    from app.tools.fs_sandbox import SandboxError

    if not allowed_paths:
        return
    for p in paths:
        if not path_in_allowlist(p, allowed_paths):
            raise SandboxError(f"path outside task allowed_paths: {p}")


def filter_allowed_paths(paths: list[str], allowed_paths: list[str] | None) -> list[str]:
    return [p for p in paths if path_in_allowlist(p, allowed_paths)]
