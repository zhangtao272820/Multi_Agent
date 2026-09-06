"""Content snapshots for apply rollback (no git required)."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.tools.fs_sandbox import SandboxError, get_root, read_file, safe_resolve, write_file


def _rollback_dir() -> Path:
    settings = get_settings()
    base = Path(getattr(settings, "data_dir", "") or Path(settings.project_dir) / ".codepy_data")
    p = base / "rollbacks"
    p.mkdir(parents=True, exist_ok=True)
    return p


def create_rollback_snapshot(
    paths: list[str],
    *,
    root_override: str | None = None,
) -> str:
    """Snapshot current file contents before apply. Returns rollback_ref id."""
    files: dict[str, Any] = {}
    for rel in paths:
        r = str(rel or "").strip().replace("\\", "/")
        if not r:
            continue
        try:
            path = safe_resolve(r, root_override=root_override)
            if path.is_file():
                data = read_file(r, root_override=root_override)
                files[r] = {"exists": True, "content": data["content"]}
            else:
                files[r] = {"exists": False, "content": ""}
        except SandboxError:
            files[r] = {"exists": False, "content": ""}
    rid = str(uuid.uuid4())
    payload = {
        "id": rid,
        "root": str(get_root(root_override)),
        "files": files,
    }
    (_rollback_dir() / f"{rid}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return rid


def load_rollback(rollback_ref: str) -> dict[str, Any] | None:
    path = _rollback_dir() / f"{str(rollback_ref or '').strip()}.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def restore_rollback(
    rollback_ref: str,
    *,
    root_override: str | None = None,
    require_write_enabled: bool = True,
) -> dict[str, Any]:
    snap = load_rollback(rollback_ref)
    if not snap:
        return {"ok": False, "error": "rollback_not_found", "restored": []}
    root = root_override or str(snap.get("root") or "") or None
    restored: list[str] = []
    errors: list[str] = []
    files = snap.get("files") if isinstance(snap.get("files"), dict) else {}
    for rel, meta in files.items():
        if not isinstance(meta, dict):
            continue
        try:
            if meta.get("exists"):
                write_file(
                    str(rel),
                    str(meta.get("content") or ""),
                    root_override=root,
                    require_write_enabled=require_write_enabled,
                )
                restored.append(str(rel))
            else:
                # created by apply → delete if now exists
                path = safe_resolve(str(rel), root_override=root)
                if path.is_file():
                    path.unlink()
                    restored.append(str(rel))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{rel}: {exc}"[:200])
    return {
        "ok": not errors,
        "restored": restored,
        "errors": errors,
        "rollback_ref": str(rollback_ref),
    }


def drop_rollback(rollback_ref: str) -> None:
    path = _rollback_dir() / f"{str(rollback_ref or '').strip()}.json"
    if path.is_file():
        path.unlink()
