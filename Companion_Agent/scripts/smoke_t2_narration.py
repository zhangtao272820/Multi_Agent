# -*- coding: utf-8 -*-
"""Smoke: T2 Batch 5 light narration layer."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.event_engine import load_events  # noqa: E402
from app.story_beats import format_story_snippet, public_story_progress  # noqa: E402

T2 = ("xingnai", "fengyin", "qingcai", "xiaoyang", "luna")
BANNED = "选择会改写后面的路"
WALL = ("隔墙", "薄墙", "书璃", "门轴", "夜灯")


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


def main() -> None:
    events = [e for e in load_events() if any((e.id or "").startswith(f"story_{c}_") for c in T2)]
    if len(events) < 15:
        fail(f"T2 story events too few: {len(events)}")

    by_char: dict[str, int] = {c: 0 for c in T2}
    for ev in events:
        cid = next(c for c in T2 if (ev.id or "").startswith(f"story_{c}_"))
        by_char[cid] += 1
        beats = ev.beats or []
        if len(beats) < 3:
            fail(f"{ev.id}: beats={len(beats)} < 3")
        for b in beats:
            nar = (b.narration or "").strip()
            thought = (b.pc_thought or "").strip()
            brief = (b.brief or "").strip()
            if not nar or not thought or not brief:
                fail(f"{ev.id}/{b.id}: missing fields")
            if len(nar) > 120 or len(thought) > 80 or len(brief) > 80:
                fail(f"{ev.id}/{b.id}: length")
            if BANNED in f"{nar}{thought}{brief}":
                fail(f"{ev.id}/{b.id}: banned")

        snip = format_story_snippet(ev, beat_index=0)
        b0 = beats[0]
        brief0 = (b0.brief or "").strip()
        if brief0[:8] not in snip:
            fail(f"{ev.id}: snippet missing brief")
        nar_prefix = (b0.narration or "")[:20]
        if nar_prefix and nar_prefix not in brief0 and nar_prefix in snip:
            fail(f"{ev.id}: narration leaked")
        if not public_story_progress(ev, beat_index=0):
            fail(f"{ev.id}: no public progress")

    for c in T2:
        if by_char[c] < 3:
            fail(f"{c}: acts={by_char[c]} < 3")

    fy = next(e for e in events if e.id == "story_fengyin_act1_door")
    joined = " ".join((b.narration or "") + (b.pc_thought or "") for b in fy.beats)
    if not any(w in joined for w in WALL):
        fail("fengyin act1 missing 隔墙/书璃旁观悬念")
    if "停在她半掩" not in (fy.beats[0].narration or "") and "半掩" not in (fy.beats[0].narration or ""):
        fail("fengyin act1 b1 must keep door beat")

    print("OK smoke_t2_narration")
    print(" ", " ".join(f"{c}={by_char[c]}" for c in T2), f"total={len(events)}")


if __name__ == "__main__":
    main()
