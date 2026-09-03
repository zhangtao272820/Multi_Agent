"""Pending SEARCH/REPLACE patches (pre-apply HITL)."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from app.config import get_settings


def _dir() -> Path:
    settings = get_settings()
    base = Path(getattr(settings, "data_dir", "") or Path(settings.project_dir) / ".codepy_data")
    p = base / "pending_patches"
    p.mkdir(parents=True, exist_ok=True)
    return p


def save_pending_patch(payload: dict[str, Any]) -> str:
    pid = str(payload.get("id") or uuid.uuid4())
    payload["id"] = pid
    path = _dir() / f"{pid}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return pid


def load_pending_patch(pid: str) -> dict[str, Any] | None:
    path = _dir() / f"{str(pid).strip()}.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def drop_pending_patch(pid: str) -> None:
    path = _dir() / f"{str(pid).strip()}.json"
    if path.is_file():
        path.unlink()
