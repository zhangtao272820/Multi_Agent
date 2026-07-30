"""Path sandbox: list / read / write under PROJECT_DIR + ALLOWED_ROOTS."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from app.config import get_settings

SKIP_DIR_NAMES = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".nuxt",
    ".output",
    "dist",
    ".data",
    ".cursor",
}


class SandboxError(Exception):
    pass


def get_root(override: str | None = None) -> Path:
    settings = get_settings()
    if override and str(override).strip():
        return Path(override).expanduser().resolve()
    return Path(settings.project_dir).resolve()


def _is_under(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def assert_allowed(path: Path, *, root: Path | None = None) -> Path:
    settings = get_settings()
    resolved = path.expanduser().resolve()
    roots = [Path(r).resolve() for r in settings.allowed_roots]
    if root is not None:
        roots = [root.resolve(), *roots]
    if not any(_is_under(resolved, r) or resolved == r for r in roots):
        raise SandboxError(f"path outside allowed roots: {resolved}")
    return resolved


def safe_resolve(rel_or_abs: str, *, root_override: str | None = None) -> Path:
    root = get_root(root_override)
    raw = Path(rel_or_abs)
    if raw.is_absolute():
        return assert_allowed(raw, root=root)
    return assert_allowed(root / raw, root=root)


def list_dir(rel: str = "", *, root_override: str | None = None, max_entries: int = 500) -> list[dict[str, Any]]:
    root = get_root(root_override)
    target = safe_resolve(rel or ".", root_override=root_override) if rel else assert_allowed(root, root=root)
    if not target.is_dir():
        raise SandboxError(f"not a directory: {rel}")
    entries: list[dict[str, Any]] = []
    try:
        children = sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except OSError as e:
        raise SandboxError(str(e)) from e
    for child in children:
        if child.name in SKIP_DIR_NAMES or child.name.startswith("."):
            continue
        try:
            st = child.stat()
        except OSError:
            continue
        rel_path = str(child.relative_to(root)).replace("\\", "/")
        entries.append(
            {
                "name": child.name,
                "path": rel_path,
                "type": "dir" if child.is_dir() else "file",
                "size": st.st_size if child.is_file() else 0,
            }
        )
        if len(entries) >= max_entries:
            break
    return entries


def list_tree(
    *,
    root_override: str | None = None,
    max_files: int = 400,
    max_depth: int = 4,
) -> list[dict[str, Any]]:
    root = get_root(root_override)
    out: list[dict[str, Any]] = []

    def walk(dir_path: Path, depth: int) -> None:
        if len(out) >= max_files or depth > max_depth:
            return
        try:
            children = sorted(dir_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return
        for child in children:
            if len(out) >= max_files:
                return
            if child.name in SKIP_DIR_NAMES or child.name.startswith("."):
                continue
            rel_path = str(child.relative_to(root)).replace("\\", "/")
            if child.is_dir():
                out.append({"name": child.name, "path": rel_path, "type": "dir"})
                walk(child, depth + 1)
            else:
                try:
                    size = child.stat().st_size
                except OSError:
                    size = 0
                out.append({"name": child.name, "path": rel_path, "type": "file", "size": size})

    walk(root, 0)
    return out


def read_file(rel: str, *, root_override: str | None = None, max_chars: int | None = None) -> dict[str, Any]:
    settings = get_settings()
    path = safe_resolve(rel, root_override=root_override)
    if not path.is_file():
        raise SandboxError(f"not a file: {rel}")
    limit = max_chars if max_chars is not None else settings.max_file_chars
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        raise SandboxError(str(e)) from e
    truncated = len(text) > limit
    if truncated:
        text = text[:limit]
    root = get_root(root_override)
    return {
        "path": str(path.relative_to(root)).replace("\\", "/"),
        "content": text,
        "truncated": truncated,
        "bytes": path.stat().st_size,
    }


def write_file(
    rel: str,
    content: str,
    *,
    root_override: str | None = None,
    require_write_enabled: bool = True,
) -> dict[str, Any]:
    settings = get_settings()
    if require_write_enabled and not settings.write_tool_enabled:
        raise SandboxError("WRITE_TOOL_ENABLED is off")
    path = safe_resolve(rel, root_override=root_override)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")
    root = get_root(root_override)
    return {
        "ok": True,
        "path": str(path.relative_to(root)).replace("\\", "/"),
        "bytes": path.stat().st_size,
    }


def search_in_files(
    query: str,
    *,
    root_override: str | None = None,
    max_hits: int = 30,
    max_file_bytes: int = 200_000,
) -> list[dict[str, Any]]:
    q = (query or "").strip()
    if not q:
        return []
    root = get_root(root_override)
    hits: list[dict[str, Any]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_NAMES and not d.startswith(".")]
        for name in filenames:
            if len(hits) >= max_hits:
                return hits
            if name.startswith("."):
                continue
            fp = Path(dirpath) / name
            try:
                if fp.stat().st_size > max_file_bytes:
                    continue
                text = fp.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if q not in text and q.lower() not in text.lower():
                continue
            rel = str(fp.relative_to(root)).replace("\\", "/")
            # first matching line preview
            preview = ""
            for i, line in enumerate(text.splitlines(), 1):
                if q.lower() in line.lower():
                    preview = f"L{i}: {line.strip()[:200]}"
                    break
            hits.append({"path": rel, "preview": preview or rel})
    return hits
