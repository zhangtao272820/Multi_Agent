"""Aider-style SEARCH/REPLACE parse + apply."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from app.tools.fs_sandbox import SandboxError, read_file, write_file

BLOCK_RE = re.compile(
    r"<<<<<<<\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>>\s*REPLACE",
    re.M,
)


@dataclass
class SearchReplaceBlock:
    path: str | None
    search: str
    replace: str


def parse_search_replace_document(text: str) -> list[SearchReplaceBlock]:
    lines = str(text or "").splitlines()
    blocks: list[SearchReplaceBlock] = []
    current_path: str | None = None
    buf: list[str] = []

    def flush_chunk(chunk: str, path: str | None) -> None:
        for m in BLOCK_RE.finditer(chunk):
            blocks.append(SearchReplaceBlock(path=path, search=m.group(1) or "", replace=m.group(2) or ""))

    for line in lines:
        if re.match(r"^<<<<<<<\s*SEARCH", line):
            if buf:
                flush_chunk("\n".join(buf), current_path)
                buf = []
            buf = [line]
            continue
        if buf:
            buf.append(line)
            if re.match(r"^>>>>>>>\s*REPLACE", line):
                flush_chunk("\n".join(buf), current_path)
                buf = []
            continue
        stripped = line.strip()
        if (
            re.search(
                r"\.(ts|tsx|js|jsx|vue|py|json|md|ya?ml|css|scss|html|toml|txt|sql|sh|ps1)$",
                stripped,
                re.I,
            )
            and " " not in stripped
        ):
            current_path = stripped
        elif re.match(r"^[\w./\\-]+$", stripped) and ("/" in stripped or "\\" in stripped):
            current_path = stripped.replace("\\", "/")
    if buf:
        flush_chunk("\n".join(buf), current_path)
    return blocks


def apply_single(content: str, search: str, replace: str) -> str:
    src = content.replace("\r\n", "\n")
    needle = search.replace("\r\n", "\n")
    repl = replace.replace("\r\n", "\n")
    idx = src.find(needle)
    if idx < 0:
        raise SandboxError("SEARCH block not found in file (context mismatch)")
    second = src.find(needle, idx + len(needle))
    if second >= 0:
        raise SandboxError("SEARCH block is ambiguous (multiple matches)")
    return src[:idx] + repl + src[idx + len(needle) :]


def preview_search_replace(
    text: str,
    *,
    root_override: str | None = None,
) -> dict[str, Any]:
    blocks = parse_search_replace_document(text)
    if not blocks:
        return {"ok": False, "error": "no SEARCH/REPLACE blocks", "files": [], "unified_diff": ""}
    by_file: dict[str, list[SearchReplaceBlock]] = {}
    for b in blocks:
        if not b.path:
            return {"ok": False, "error": "block missing path", "files": [], "unified_diff": ""}
        by_file.setdefault(b.path, []).append(b)

    diffs: list[str] = []
    files: list[str] = []
    for path, file_blocks in by_file.items():
        original = read_file(path, root_override=root_override)["content"]
        updated = original
        for b in file_blocks:
            updated = apply_single(updated, b.search, b.replace)
        files.append(path)
        diffs.append(_unified_diff(path, original, updated))
    return {
        "ok": True,
        "files": files,
        "unified_diff": "\n".join(diffs),
        "block_count": len(blocks),
    }


def apply_search_replace(
    text: str,
    *,
    root_override: str | None = None,
    require_write_enabled: bool = True,
) -> dict[str, Any]:
    preview = preview_search_replace(text, root_override=root_override)
    if not preview.get("ok"):
        return preview
    blocks = parse_search_replace_document(text)
    by_file: dict[str, list[SearchReplaceBlock]] = {}
    for b in blocks:
        assert b.path
        by_file.setdefault(b.path, []).append(b)
    touched: list[str] = []
    for path, file_blocks in by_file.items():
        original = read_file(path, root_override=root_override)["content"]
        updated = original
        for b in file_blocks:
            updated = apply_single(updated, b.search, b.replace)
        write_file(path, updated, root_override=root_override, require_write_enabled=require_write_enabled)
        touched.append(path)
    return {
        "ok": True,
        "files": touched,
        "unified_diff": preview.get("unified_diff") or "",
        "files_touched": touched,
    }


def _unified_diff(path: str, before: str, after: str) -> str:
    import difflib

    a = before.splitlines(keepends=True)
    b = after.splitlines(keepends=True)
    return "".join(difflib.unified_diff(a, b, fromfile=f"a/{path}", tofile=f"b/{path}"))
