from __future__ import annotations

import json
import uuid
from typing import Any

from app.settings import data_dir


def _dir():
    p = data_dir() / "pending"
    p.mkdir(parents=True, exist_ok=True)
    return p


def save_pending(payload: dict[str, Any]) -> str:
    pid = str(payload.get("id") or uuid.uuid4())
    payload["id"] = pid
    path = _dir() / f"{pid}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return pid


def load_pending(pid: str) -> dict[str, Any] | None:
    path = _dir() / f"{str(pid).strip()}.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def drop_pending(pid: str) -> None:
    path = _dir() / f"{str(pid).strip()}.json"
    if path.is_file():
        path.unlink()
