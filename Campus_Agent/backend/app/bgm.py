"""BGM catalog + local file resolve for Campus Agent."""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import data_dir

_SAFE = re.compile(r"^[a-z0-9_\-]+$", re.I)
_EXTS = (".ogg", ".mp3", ".wav")


def bgm_dir() -> Path:
    return data_dir() / "bgm"


@lru_cache(maxsize=1)
def load_bgm_catalog() -> dict[str, Any]:
    path = data_dir() / "bgm_catalog.json"
    if not path.is_file():
        return {"tracks": [], "cues": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def reload_bgm_catalog() -> None:
    load_bgm_catalog.cache_clear()


def resolve_bgm_file(track_id: str) -> Path | None:
    tid = (track_id or "").strip()
    if not _SAFE.match(tid):
        return None
    folder = bgm_dir()
    if not folder.is_dir():
        return None
    for ext in _EXTS:
        path = folder / f"{tid}{ext}"
        if path.is_file():
            return path
    return None


def public_bgm_catalog() -> dict[str, Any]:
    data = load_bgm_catalog()
    tracks = []
    for t in data.get("tracks") or []:
        tid = str(t.get("id") or "")
        path = resolve_bgm_file(tid)
        tracks.append(
            {
                **t,
                "available": bool(path),
                "url": f"/api/campus/bgm/{tid}" if path else "",
            }
        )
    return {
        "tracks": tracks,
        "cues": data.get("cues") or {},
        "playlists": data.get("playlists") or {},
        "location_cues": data.get("location_cues") or {},
        "hub_cues": data.get("hub_cues") or {},
        "weather_cues": data.get("weather_cues") or {},
        "ending_type_cues": data.get("ending_type_cues") or {},
        "crossfade_ms": int(data.get("crossfade_ms") or 800),
    }
