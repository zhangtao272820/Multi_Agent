"""Schema-driven SQL match normalize: rewrite equality on substring columns to LIKE.

Operates on generated SQL (not user utterance). Columns come from tenant column_match.json.
"""
from __future__ import annotations

import re
from typing import Any

# col = 'lit' | alias.col = "lit" | `col` = 'lit'
_EQ_LIT = re.compile(
    r"(?P<left>(?:`?[A-Za-z_][\w]*`?\s*\.\s*)?`?[A-Za-z_][\w]*`?)\s*=\s*"
    r"(?P<q>['\"])(?P<lit>(?:(?!\2).)*)(?P=q)",
    re.I,
)


def _bare_col(token: str) -> str:
    parts = [p for p in re.split(r"\s*\.\s*", str(token or "").strip()) if p]
    if not parts:
        return ""
    return parts[-1].strip("`").lower()


def substring_columns(match_map: dict[str, str] | None) -> set[str]:
    out: set[str] = set()
    for key, mode in (match_map or {}).items():
        if str(mode or "").strip().lower() != "substring":
            continue
        col = str(key or "").strip()
        if "." in col:
            col = col.rsplit(".", 1)[-1]
        col = col.strip("`").lower()
        if col:
            out.add(col)
    return out


def normalize_substring_equality(sql: str, match_map: dict[str, str] | None) -> str:
    """Rewrite col = 'short' → col LIKE '%short%' for substring-mode columns."""
    text = str(sql or "")
    if not text.strip() or not match_map:
        return text
    cols = substring_columns(match_map)
    if not cols:
        return text

    def _repl(m: re.Match[str]) -> str:
        left = m.group("left")
        lit = m.group("lit")
        if _bare_col(left) not in cols:
            return m.group(0)
        if not lit or "%" in lit or "_" in lit:
            return m.group(0)
        # Escape LIKE wildcards already handled; escape single quotes for SQL literal
        safe = lit.replace("'", "''")
        return f"{left} LIKE '%{safe}%'"

    return _EQ_LIT.sub(_repl, text)


def load_column_match(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in raw.items():
        key = str(k or "").strip()
        mode = str(v or "").strip().lower()
        if key and mode in {"substring", "exact", "prefix"}:
            out[key] = mode
    return out
