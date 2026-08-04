"""社会式故事网 SSOT 加载。"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from .config import PROJECT_ROOT


@lru_cache(maxsize=1)
def load_story_web() -> dict[str, Any]:
    path = PROJECT_ROOT / "data" / "story_web.json"
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def reload_story_web() -> dict[str, Any]:
    load_story_web.cache_clear()
    return load_story_web()


def story_web_prompt_line() -> str:
    """短提示：她知道这是共享小镇，但禁止编造未解锁跨线秘密。"""
    return (
        "\n【社会关系｜弱耦合】你生活在同一座小镇；可以记得已见过的人与公开传闻，"
        "但禁止编造未注入的他人秘密或未发生的跨线剧情。本线故事由你独立回应。"
    )
