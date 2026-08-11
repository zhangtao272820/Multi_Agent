"""W9 showcase 构图鉴赏：manifest + 磁盘扫描。"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import PROJECT_ROOT


def _manifest_path() -> Path:
    return PROJECT_ROOT / "data" / "character_showcase_manifest.json"


def _showcase_dir(character_id: str) -> Path:
    return PROJECT_ROOT / "data" / "sprites" / "showcase" / character_id


@lru_cache(maxsize=1)
def load_showcase_manifest() -> dict[str, Any]:
    path = _manifest_path()
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def reload_showcase_manifest() -> None:
    load_showcase_manifest.cache_clear()


def resolve_showcase_file(character_id: str, slot: str) -> Path | None:
    cid = (character_id or "").strip()
    slot_id = (slot or "").strip().replace("\\", "").replace("/", "").replace("..", "")
    if not cid or not slot_id:
        return None
    folder = _showcase_dir(cid)
    if not folder.is_dir():
        return None
    # 直接槽名
    for name in (f"{slot_id}.png", f"{slot_id}.jpg", f"{slot_id}.webp"):
        p = folder / name
        if p.is_file():
            return p
    # aliases：kv -> kv_day 等
    man = load_showcase_manifest()
    aliases = man.get("aliases") if isinstance(man.get("aliases"), dict) else {}
    # 若请求旧名
    canon = str(aliases.get(slot_id) or "").strip()
    if canon:
        for name in (f"{canon}.png", f"{canon}.jpg"):
            p = folder / name
            if p.is_file():
                return p
    # 若请求规范名但磁盘只有旧短名
    rev = {str(v): str(k) for k, v in aliases.items()}
    short = rev.get(slot_id)
    if short:
        for name in (f"{short}.png", f"{short}.jpg"):
            p = folder / name
            if p.is_file():
                return p
    return None


def public_showcase_catalog() -> dict[str, Any]:
    man = load_showcase_manifest()
    slots = list(man.get("slots") or [])
    slot_meta = man.get("slot_meta") if isinstance(man.get("slot_meta"), dict) else {}
    chars_meta = man.get("characters") if isinstance(man.get("characters"), dict) else {}
    out_chars: list[dict[str, Any]] = []
    for cid, meta in chars_meta.items():
        if not isinstance(meta, dict):
            continue
        present: list[dict[str, str]] = []
        missing: list[str] = []
        for slot in slots:
            path = resolve_showcase_file(cid, str(slot))
            label = str(slot_meta.get(slot) or slot)
            if path:
                present.append(
                    {
                        "slot": str(slot),
                        "label": label,
                        "url": f"/api/sprites/showcase/{cid}/{slot}.png",
                    }
                )
            else:
                missing.append(str(slot))
        out_chars.append(
            {
                "character_id": cid,
                "theme": str(meta.get("theme") or ""),
                "tier": str(meta.get("tier") or ""),
                "present": present,
                "present_count": len(present),
                "slot_total": len(slots),
                "missing_count": len(missing),
            }
        )
    out_chars.sort(key=lambda r: (-int(r.get("present_count") or 0), r["character_id"]))
    return {
        "slots": slots,
        "slot_meta": slot_meta,
        "characters": out_chars,
    }
