"""Hub 故事钩子短 VN 文案。"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import PROJECT_ROOT


def _path() -> Path:
    return PROJECT_ROOT / "data" / "story_hint_pages.json"


@lru_cache(maxsize=1)
def load_story_hint_pages() -> dict[str, Any]:
    path = _path()
    if not path.is_file():
        return {"characters": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def public_hint_pages(
    character_id: str,
    *,
    hint_text: str = "",
    character_name: str = "",
    act_title: str = "",
) -> dict[str, Any]:
    cid = (character_id or "").strip()
    name = (character_name or "她").strip() or "她"
    man = load_story_hint_pages()
    chars = man.get("characters") if isinstance(man.get("characters"), dict) else {}
    block = chars.get(cid) if isinstance(chars.get(cid), dict) else None
    pages: list[dict[str, Any]] = []
    if block and isinstance(block.get("pages"), list):
        for raw in block["pages"]:
            if not isinstance(raw, dict):
                continue
            text = str(raw.get("text") or "").strip()
            if not text:
                continue
            voice = str(raw.get("voice") or "narration").strip() or "narration"
            sprite = raw.get("sprite") if isinstance(raw.get("sprite"), dict) else {}
            item: dict[str, Any] = {
                "text": text,
                "voice": voice,
                "sprite": {**sprite, "character_id": cid},
            }
            pages.append(item)
    if not pages:
        soft = (hint_text or "").strip() or (
            f"{name}那边好像还有一幕没落定" + (f"——「{act_title}」" if act_title else "")
        )
        pages = [
            {
                "text": soft if len(soft) > 12 else f"{name}好像还想跟你说点什么。",
                "voice": "narration",
                "sprite": {"character_id": cid, "outfit": "casual", "emotion": "shy"},
            },
            {
                "text": "去见一面也好。装不知道，回头会后悔。",
                "voice": "pc",
                "sprite": {"character_id": cid, "outfit": "casual", "emotion": "neutral"},
            },
        ]
    return {
        "character_id": cid,
        "character_name": name,
        "act_title": act_title,
        "pages": pages,
    }
