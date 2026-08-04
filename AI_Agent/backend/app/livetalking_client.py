"""LiveTalking HTTP 客户端：把 TTS/文本/动作推给 Avatar Runtime。"""

from __future__ import annotations

import logging
import uuid
from typing import Any

import httpx

from .config import Settings

logger = logging.getLogger(__name__)


def _base(settings: Settings) -> str:
    return (settings.livetalking_url or "http://127.0.0.1:8010").rstrip("/")


def health(settings: Settings) -> dict[str, Any]:
    url = f"{_base(settings)}/"
    try:
        with httpx.Client(timeout=5.0) as client:
            rsp = client.get(url)
        return {
            "ok": rsp.status_code < 500,
            "status_code": rsp.status_code,
            "url": _base(settings),
        }
    except Exception as ex:
        return {"ok": False, "error": str(ex), "url": _base(settings)}


def new_session_id() -> int:
    return uuid.uuid4().int % 1_000_000_000


def speak_echo(
    settings: Settings,
    *,
    text: str,
    session_id: int | str,
    interrupt: bool = True,
) -> dict[str, Any]:
    """type=echo：LiveTalking 自带 TTS；优先用 humanaudio 推我们的 TTS。"""
    payload = {
        "text": text,
        "type": "echo",
        "interrupt": interrupt,
        "sessionid": session_id,
    }
    url = f"{_base(settings)}/human"
    with httpx.Client(timeout=settings.livetalking_timeout_sec) as client:
        rsp = client.post(url, json=payload)
        rsp.raise_for_status()
        try:
            return rsp.json()
        except Exception:
            return {"ok": True, "status_code": rsp.status_code}


def speak_audio(
    settings: Settings,
    *,
    audio_bytes: bytes,
    audio_mime: str,
    session_id: int | str,
    interrupt: bool = True,
    filename: str = "speech.wav",
) -> dict[str, Any]:
    """推送合成语音，驱动 FeatherTalk 口型。"""
    url = f"{_base(settings)}/humanaudio"
    files = {
        "file": (filename, audio_bytes, audio_mime or "audio/wav"),
    }
    data = {
        "sessionid": str(session_id),
    }
    with httpx.Client(timeout=settings.livetalking_timeout_sec) as client:
        rsp = client.post(url, data=data, files=files)
        if rsp.status_code >= 400:
            logger.warning(
                "humanaudio failed %s: %s",
                rsp.status_code,
                rsp.text[:200],
            )
            rsp.raise_for_status()
        try:
            return rsp.json()
        except Exception:
            return {"ok": True, "status_code": rsp.status_code}


def interrupt(settings: Settings, *, session_id: int | str) -> dict[str, Any]:
    url = f"{_base(settings)}/interrupt_talk"
    payload = {"sessionid": session_id}
    try:
        with httpx.Client(timeout=10.0) as client:
            rsp = client.post(url, json=payload)
        return {"ok": rsp.status_code < 400, "status_code": rsp.status_code}
    except Exception:
        return speak_echo(
            settings, text="", session_id=session_id, interrupt=True
        )


def set_custom_state(
    settings: Settings,
    *,
    session_id: int | str,
    audiotype: int,
) -> dict[str, Any]:
    """切换 LiveTalking 自定义动作状态（audiotype 见 custom_config.json）。"""
    url = f"{_base(settings)}/set_audiotype"
    payload = {"sessionid": session_id, "audiotype": audiotype}
    try:
        with httpx.Client(timeout=10.0) as client:
            rsp = client.post(url, json=payload)
        return {"ok": rsp.status_code < 400, "status_code": rsp.status_code}
    except Exception as ex:
        logger.warning("set_custom_state: %s", ex)
        return {"ok": False, "error": str(ex)}


# 兼容旧名
def set_custom_video(
    settings: Settings,
    *,
    session_id: int | str,
    video_path: str = "",
    audiotype: int = 2,
) -> dict[str, Any]:
    _ = video_path
    return set_custom_state(settings, session_id=session_id, audiotype=audiotype)


def webrtc_offer_url(settings: Settings) -> str:
    base = (settings.livetalking_webrtc_url or settings.livetalking_url or "").rstrip(
        "/"
    )
    return f"{base}/offer"
