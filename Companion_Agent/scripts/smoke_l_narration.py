# -*- coding: utf-8 -*-
"""Smoke: L-tier Batch 4 narration layer."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.event_engine import load_events  # noqa: E402
from app.story_beats import format_story_snippet, public_story_progress  # noqa: E402

L = ("youwei", "yuxi", "jingning", "lingke", "aichen")
BANNED = "选择会改写后面的路"


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


def main() -> None:
    events = [e for e in load_events() if any((e.id or "").startswith(f"story_{c}_") for c in L)]
    if len(events) < 18:
        fail(f"L story events too few: {len(events)}")

    by_char: dict[str, int] = {c: 0 for c in L}
    for ev in events:
        cid = next(c for c in L if (ev.id or "").startswith(f"story_{c}_"))
        by_char[cid] += 1
        beats = ev.beats or []
        if len(beats) < 3:
            fail(f"{ev.id}: beats={len(beats)} < 3")
        for b in beats:
            nar = (b.narration or "").strip()
            thought = (b.pc_thought or "").strip()
            brief = (b.brief or "").strip()
            if not nar or not thought or not brief:
                fail(f"{ev.id}/{b.id}: missing narration/pc_thought/brief")
            if len(nar) > 120 or len(thought) > 80 or len(brief) > 80:
                fail(f"{ev.id}/{b.id}: length overflow")
            if BANNED in f"{nar}{thought}{brief}{b.summary or ''}":
                fail(f"{ev.id}/{b.id}: banned phrase")
            # enrichment artifact: flag stripped leaving empty clause
            blob = f"{nar}{brief}"
            if "落章——" in blob or "勾上 ：" in blob or "： 落章" in blob:
                fail(f"{ev.id}/{b.id}: flag-strip artifact")

        snip = format_story_snippet(ev, beat_index=0)
        b0 = beats[0]
        brief0 = (b0.brief or b0.summary or "").strip()
        if brief0[:10] not in snip:
            fail(f"{ev.id}: snippet missing brief")
        nar_prefix = (b0.narration or "").strip()[:20]
        if nar_prefix and nar_prefix not in brief0 and nar_prefix in snip:
            fail(f"{ev.id}: narration leaked")
        thought_prefix = (b0.pc_thought or "").strip()[:16]
        if thought_prefix and thought_prefix not in brief0 and thought_prefix in snip:
            fail(f"{ev.id}: pc_thought leaked")
        prog = public_story_progress(ev, beat_index=0)
        if not prog or not prog.get("narration"):
            fail(f"{ev.id}: public progress missing narration")

    for c in L:
        if by_char[c] < 4:
            fail(f"{c}: acts={by_char[c]} < 4")

    # open-heart / gate flags still on rewards
    yw = next(e for e in events if e.id == "story_youwei_act4_open")
    if "youwei_open_heart" not in (yw.rewards.get("flags_set") or []):
        fail("youwei act4 missing youwei_open_heart")

    print("OK smoke_l_narration")
    print(" ", " ".join(f"{c}={by_char[c]}" for c in L), f"total={len(events)}")


if __name__ == "__main__":
    main()
