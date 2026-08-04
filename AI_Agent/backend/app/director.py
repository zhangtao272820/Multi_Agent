"""情绪/动作导演：LLM 结构化输出，禁止关键词路由。"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from .config import Settings, resolve_proj_path

logger = logging.getLogger(__name__)

EMOTIONS = ("neutral", "smile", "serious", "surprised")
ACTIONS = ("idle_loop", "nod", "wave", "present", "think")

_DIRECTOR_SCHEMA_HINT = """
你同时是数字人表演导演。在回答用户后，必须额外输出一行 JSON（单独一行，以 DIRECTOR: 开头），格式严格为：
DIRECTOR:{"emotion":"neutral|smile|serious|surprised","action":"idle_loop|nod|wave|present|think","confidence":0.0到1.0}
规则：
- emotion/action 只能取给定枚举；
- 介绍产品或展示时用 present + smile；思考不确定用 think + serious；打招呼用 wave + smile；默认 nod + neutral；
- confidence < 0.5 时前端可忽略动作；
- JSON 之外的正文仍要短句口语，遵守系统其它硬性规则。
""".strip()

_DIRECTOR_LINE = re.compile(
    r"DIRECTOR:\s*(\{.*\})\s*$",
    re.IGNORECASE | re.MULTILINE,
)


def director_system_suffix(settings: Settings) -> str:
    if not settings.director_enabled:
        return ""
    return "\n\n" + _DIRECTOR_SCHEMA_HINT


def parse_director_block(reply: str) -> tuple[str, dict[str, Any] | None]:
    """从回复中剥离 DIRECTOR JSON，返回 (speak_text, director|None)。"""
    m = _DIRECTOR_LINE.search(reply or "")
    if not m:
        return (reply or "").strip(), None
    speak = (reply[: m.start()] + reply[m.end() :]).strip()
    speak = re.sub(r"\n{3,}", "\n\n", speak).strip()
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        logger.warning("director JSON 解析失败: %s", m.group(1)[:120])
        return speak, None
    emotion = str(data.get("emotion") or "neutral").strip().lower()
    action = str(data.get("action") or "idle_loop").strip().lower()
    try:
        conf = float(data.get("confidence", 0.0))
    except (TypeError, ValueError):
        conf = 0.0
    if emotion not in EMOTIONS:
        emotion = "neutral"
    if action not in ACTIONS:
        action = "idle_loop"
    return speak, {
        "emotion": emotion,
        "action": action,
        "confidence": max(0.0, min(1.0, conf)),
    }


def load_audiotype_map(settings: Settings) -> dict[str, int]:
    path = resolve_proj_path(settings.avatar_actions_dir) / "action_audiotype_map.json"
    if not path.is_file():
        return {
            "nod": 2,
            "wave": 2,
            "present": 2,
            "think": 3,
            "idle_loop": 1,
            "smile": 2,
            "serious": 3,
            "surprised": 2,
            "neutral": 1,
        }
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {str(k): int(v) for k, v in data.items()}
    except Exception as ex:
        logger.warning("audiotype map: %s", ex)
        return {}


def apply_director_to_avatar(
    settings: Settings,
    director: dict[str, Any] | None,
    *,
    session_id: int | str,
) -> dict[str, Any]:
    """把 emotion/action 映射为 LiveTalking audiotype 并下发。"""
    from . import livetalking_client

    if not director or float(director.get("confidence") or 0) < 0.5:
        return {"applied": False, "reason": "low_confidence_or_empty"}
    action = str(director.get("action") or "")
    emotion = str(director.get("emotion") or "neutral")
    amap = load_audiotype_map(settings)
    audiotype = amap.get(action) or amap.get(emotion)
    if audiotype is None:
        return {
            "applied": False,
            "reason": "no_audiotype",
            "emotion": emotion,
            "action": action,
        }
    result = livetalking_client.set_custom_state(
        settings, session_id=session_id, audiotype=int(audiotype)
    )
    return {
        "applied": bool(result.get("ok")),
        "audiotype": audiotype,
        "emotion": emotion,
        "action": action,
        "runtime": result,
    }
