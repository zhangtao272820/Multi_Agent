"""Playbook skill.md section loader (aligned with Extractor_Agent playbook_skills)."""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

SKILLS_ROOT = Path(__file__).resolve().parents[2] / "skills"


@lru_cache(maxsize=32)
def _load_skill_text(skill_id: str) -> str:
    path = SKILLS_ROOT / skill_id / "skill.md"
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8")


def resolve_playbook_section(skill_id: str, heading: str, fallback: str = "") -> str:
    """Parse `## Heading` section from skill.md; fallback if missing."""
    text = _load_skill_text(skill_id)
    if not text:
        return fallback
    # ## Heading ... until next ## or EOF
    pat = re.compile(
        rf"^##\s+{re.escape(heading)}\s*\n(.*?)(?=^##\s+|\Z)",
        re.M | re.S,
    )
    m = pat.search(text)
    if not m:
        return fallback
    body = m.group(1).strip()
    return body if body else fallback


def clear_playbook_cache() -> None:
    _load_skill_text.cache_clear()
