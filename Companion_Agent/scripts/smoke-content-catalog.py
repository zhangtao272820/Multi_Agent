#!/usr/bin/env python3
"""Smoke: GAL 内容目录规模（事件/结局/场景/任务）。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from app.event_engine import load_events  # noqa: E402
from app.quest_engine import load_quest_chains  # noqa: E402
from app.scenes import list_scenes  # noqa: E402


def main() -> int:
    errors: list[str] = []
    events = load_events()
    if len(events) < 24:
        errors.append(f"events 至少 24 个，实际 {len(events)}")

    endings = json.loads((DATA / "endings.json").read_text(encoding="utf-8")).get("endings") or []
    if len(endings) < 14:
        errors.append(f"endings 至少 14 个，实际 {len(endings)}")

    scenes = list_scenes()
    if len(scenes) < 10:
        errors.append(f"scenes 至少 10 个，实际 {len(scenes)}")

    quests = load_quest_chains()
    if len(quests) < 5:
        errors.append(f"quests 至少 5 条链，实际 {len(quests)}")

    char_ids = {
        "xiaoyou", "shizuku", "xingnai", "fengyin", "qingcai", "xiaoyang",
        "qiansha", "jingliu", "aili", "miara", "shiori", "taotao",
    }
    covered: set[str] = set()
    for ev in events:
        for cid in ev.trigger.character_ids or []:
            covered.add(cid)
    missing = char_ids - covered
    if missing:
        errors.append(f"缺少角色专属事件: {sorted(missing)}")

    flags = json.loads((DATA / "gal_flags.json").read_text(encoding="utf-8")).get("flags") or {}
    if len(flags) < 28:
        errors.append(f"gal_flags 至少 28 项，实际 {len(flags)}")

    from app.background_extras import load_background_catalog, resolve_background_file  # noqa: E402
    from app.presentation import load_presentation_catalog, resolve_ending_presentation  # noqa: E402
    from app.sprite_catalog import resolve_sprite_file  # noqa: E402

    bg_cat = load_background_catalog()
    bg_ok = 0
    for _loc, rows in (bg_cat.get("locations") or {}).items():
        for row in rows or []:
            rel = str((row or {}).get("file") or "")
            if not rel:
                continue
            if resolve_background_file(rel):
                bg_ok += 1
            else:
                errors.append(f"background_extras 缺文件: {rel}")

    present = load_presentation_catalog()
    present_endings = present.get("endings") or {}
    resolved_ok = 0
    for eid, row in present_endings.items():
        sp = (row or {}).get("sprite") or {}
        cid = str(sp.get("character_id") or "")
        resolved = resolve_ending_presentation(eid, ending_type="good", character_id=cid)
        rsp = resolved.get("sprite") or {}
        outfit = str(rsp.get("outfit") or "")
        emotion = str(rsp.get("emotion") or "neutral")
        name = f"{outfit}_{emotion}.png" if outfit else f"{emotion}.png"
        if resolve_sprite_file(str(rsp.get("character_id") or cid), name):
            resolved_ok += 1
        else:
            errors.append(f"presentation ending 无图: {eid} -> {cid}/{name}")

    if errors:
        print("FAIL smoke-content-catalog")
        for e in errors:
            print(f"  - {e}")
        return 1

    print(
        f"OK smoke-content-catalog: events={len(events)} endings={len(endings)} "
        f"scenes={len(scenes)} quests={len(quests)} flags={len(flags)} "
        f"bg_extras={bg_ok} presentation_sprites={resolved_ok}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
