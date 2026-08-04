# -*- coding: utf-8 -*-
"""Smoke: T0 Batch 2 narration layer — every beat has narration/pc_thought/brief."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.event_engine import load_events  # noqa: E402
from app.story_beats import format_story_snippet, public_story_progress  # noqa: E402

T0 = ("xiaoyou", "wanyu", "ruolin", "jingliu", "aili", "linxi")
BANNED = "选择会改写后面的路"


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


def main() -> None:
    events = [e for e in load_events() if any((e.id or "").startswith(f"story_{c}_") for c in T0)]
    if len(events) < 36:
        fail(f"T0 story events too few: {len(events)}")

    by_char: dict[str, int] = {c: 0 for c in T0}
    for ev in events:
        cid = next(c for c in T0 if (ev.id or "").startswith(f"story_{c}_"))
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
            if len(nar) > 120:
                fail(f"{ev.id}/{b.id}: narration len={len(nar)}")
            if len(thought) > 80:
                fail(f"{ev.id}/{b.id}: pc_thought len={len(thought)}")
            if len(brief) > 80:
                fail(f"{ev.id}/{b.id}: brief len={len(brief)}")
            blob = f"{nar}{thought}{brief}{b.summary or ''}"
            if BANNED in blob:
                fail(f"{ev.id}/{b.id}: banned phrase")

        snip = format_story_snippet(ev, beat_index=0)
        b0 = beats[0]
        brief0 = (b0.brief or b0.summary or "").strip()
        if brief0[:12] not in snip:
            fail(f"{ev.id}: snippet missing brief")
        # 仅当旁白前缀不在 brief 内时，才判定「叙事层泄漏进女主 prompt」
        nar_prefix = (b0.narration or "").strip()[:20]
        if nar_prefix and nar_prefix not in brief0 and nar_prefix in snip:
            fail(f"{ev.id}: narration leaked into heroine snippet")
        thought_prefix = (b0.pc_thought or "").strip()[:16]
        if thought_prefix and thought_prefix not in brief0 and thought_prefix in snip:
            fail(f"{ev.id}: pc_thought leaked into heroine snippet")
        prog = public_story_progress(ev, beat_index=0)
        if not prog or not prog.get("narration"):
            fail(f"{ev.id}: public progress missing narration")

    for c in T0:
        if by_char[c] < 6:
            fail(f"{c}: acts={by_char[c]} < 6")

    # showcase: xiaoyou act1 matches plan sample tone
    xy = next(e for e in events if e.id == "story_xiaoyou_act1_threshold")
    assert any("门铃" in (b.narration or "") for b in xy.beats)
    assert any("松节油" in (b.narration or "") or "颜料" in (b.narration or "") for b in xy.beats)

    print("OK smoke_t0_narration")
    print(" ", " ".join(f"{c}={by_char[c]}" for c in T0), f"total={len(events)}")


if __name__ == "__main__":
    main()
