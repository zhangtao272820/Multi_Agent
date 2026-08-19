from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from app.settings import data_dir


def audit_path():
    return data_dir() / "audit.jsonl"


def write_audit(record: dict[str, Any]) -> None:
    row = dict(record)
    row.setdefault("ts", datetime.now(timezone.utc).isoformat())
    path = audit_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_audit(limit: int = 50) -> list[dict[str, Any]]:
    path = audit_path()
    if not path.is_file():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    out: list[dict[str, Any]] = []
    for line in lines[-max(1, limit) :]:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    out.reverse()
    return out
