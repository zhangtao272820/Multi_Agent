"""Pending SEARCH/REPLACE patches (pre-apply HITL). Supports batch merge."""

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
    if "patches" not in payload and payload.get("patch"):
        payload["patches"] = [str(payload.get("patch") or "")]
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


def merge_pending_patch(
    pending_id: str,
    *,
    patch: str,
    files: list[str] | None = None,
    unified_diff: str = "",
    preview: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Append another SEARCH/REPLACE document into an existing pending (plan-level batch)."""
    existing = load_pending_patch(pending_id)
    if not existing:
        return None
    patches = list(existing.get("patches") or [])
    if existing.get("patch") and not patches:
        patches = [str(existing["patch"])]
    patches.append(str(patch or ""))
    file_set = list(existing.get("files") or [])
    for f in files or []:
        s = str(f or "").strip()
        if s and s not in file_set:
            file_set.append(s)
    prev_diff = str(existing.get("unified_diff") or "")
    new_diff = str(unified_diff or "")
    combined_diff = "\n".join(x for x in (prev_diff, new_diff) if x)
    combined_patch = "\n\n".join(p for p in patches if p)
    existing["patches"] = patches
    existing["patch"] = combined_patch
    existing["files"] = file_set
    existing["unified_diff"] = combined_diff
    if preview:
        existing["preview"] = preview
    existing["batch_count"] = len(patches)
    path = _dir() / f"{existing['id']}.json"
    path.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    return existing


def combined_patch_text(pending: dict[str, Any]) -> str:
    patches = pending.get("patches")
    if isinstance(patches, list) and patches:
        return "\n\n".join(str(p) for p in patches if p)
    return str(pending.get("patch") or "")
