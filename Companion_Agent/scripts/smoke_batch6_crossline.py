# -*- coding: utf-8 -*-
"""Smoke: Batch 6 cross-line weak coupling narration hooks."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.event_engine import load_events  # noqa: E402
from app.story_beats import format_story_snippet  # noqa: E402


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


def main() -> None:
    web = json.loads((ROOT / "data" / "story_web.json").read_text(encoding="utf-8"))
    hooks = web.get("batch6_narration_hooks") or []
    if len(hooks) < 6:
        fail(f"hooks too few: {len(hooks)}")

    events = {e.id: e for e in load_events()}
    for h in hooks:
        eid = str(h.get("event_id") or "")
        bid = str(h.get("beat_id") or "")
        ev = events.get(eid)
        if not ev:
            fail(f"missing event {eid}")
        beat = next((b for b in (ev.beats or []) if b.id == bid), None)
        if not beat:
            fail(f"missing beat {eid}/{bid}")
        nar = (beat.narration or "").strip()
        if len(nar) < 12:
            fail(f"{eid}/{bid}: narration too thin")

    # concrete needles
    checks = [
        ("story_shuli_act4_jealous", "b1", ("松节油", "画室")),
        ("story_xiaoyou_act5_winter_frame", "b2", ("日程", "家里")),
        ("story_wanyu_act5_winter_steam", "b2", ("妹妹", "晚归")),
        ("story_qiansha_act5_winter_diff", "b2", ("艾莉",)),
        ("story_shizuku_act5_winter_stack", "b2", ("若铃",)),
        ("story_fengyin_act1_door", "b1", ("书璃", "薄墙", "隔墙", "夜灯")),
        ("story_fengyin_act5_winter_door", "b1", ("书璃", "薄墙", "暖光")),
    ]
    for eid, bid, needles in checks:
        ev = events[eid]
        beat = next(b for b in ev.beats if b.id == bid)
        blob = f"{beat.narration or ''}{beat.pc_thought or ''}{beat.brief or ''}"
        if not any(n in blob for n in needles):
            fail(f"{eid}/{bid}: missing needles {needles}")
        # cross-line flavor must not flood heroine prompt as full narration
        snip = format_story_snippet(ev, beat_index=next(i for i, b in enumerate(ev.beats) if b.id == bid))
        if (beat.narration or "")[:24] in snip and (beat.narration or "")[:24] not in (beat.brief or ""):
            fail(f"{eid}/{bid}: narration leaked into snippet")

    print("OK smoke_batch6_crossline")
    print(f"  hooks={len(hooks)}")


if __name__ == "__main__":
    main()
