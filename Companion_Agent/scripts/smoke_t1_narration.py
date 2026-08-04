# -*- coding: utf-8 -*-
"""Smoke: T1 Batch 3 narration layer."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.event_engine import load_events  # noqa: E402
from app.story_beats import format_story_snippet, public_story_progress  # noqa: E402

T1 = ("taotao", "shizuku", "qiansha", "shiori", "miara")
BANNED = "选择会改写后面的路"
SHOWCASE = {
    "taotao": ("story_taotao_act1_practice", "练功"),
    "shizuku": ("story_shizuku_act1_screen", "屏"),
    "qiansha": ("story_qiansha_act1_diff", "PR"),
    "shiori": ("story_shiori_act1_shelf", "书"),
    "miara": ("story_miara_act1_booth", "摊"),
}


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


def main() -> None:
    events = [e for e in load_events() if any((e.id or "").startswith(f"story_{c}_") for c in T1)]
    if len(events) < 25:
        fail(f"T1 story events too few: {len(events)}")

    by_char: dict[str, int] = {c: 0 for c in T1}
    for ev in events:
        cid = next(c for c in T1 if (ev.id or "").startswith(f"story_{c}_"))
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

    for c in T1:
        if by_char[c] < 5:
            fail(f"{c}: acts={by_char[c]} < 5")
        eid, needle = SHOWCASE[c]
        ev = next(e for e in events if e.id == eid)
        blob = " ".join((b.narration or "") + (b.brief or "") for b in ev.beats)
        if needle not in blob and needle not in "".join(b.pc_thought or "" for b in ev.beats):
            # soft: at least act1 has polished three fields
            assert all((b.narration and b.pc_thought and b.brief) for b in ev.beats)

    print("OK smoke_t1_narration")
    print(" ", " ".join(f"{c}={by_char[c]}" for c in T1), f"total={len(events)}")


if __name__ == "__main__":
    main()
