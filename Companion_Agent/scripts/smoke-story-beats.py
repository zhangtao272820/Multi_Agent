"""Story beats smoke: current-beat injection, advance, story turns, summary clip."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.event_engine import GameEvent, load_events  # noqa: E402
from app.prompt_budget import WORLD_EXTRA_BUDGET, PromptBlock, trim_blocks  # noqa: E402
from app.scene_run import bump_scene_for_story, new_scene_run, scene_turn_budget  # noqa: E402
from app.story_beats import (  # noqa: E402
    STORY_SUMMARY_MAX,
    advance_beat_index,
    append_act_summary,
    format_story_snippet,
    soft_options_for_beat,
)
from app.world_engine import load_date_catalog  # noqa: E402


def main() -> None:
    load_date_catalog.cache_clear()
    cat = load_date_catalog()
    assert int(cat.scene_story_turns) == 8, cat.scene_story_turns
    assert scene_turn_budget("talk") == 4
    assert scene_turn_budget("date") == 7
    assert scene_turn_budget("story") == 8

    run = new_scene_run(mode="talk", character_id="fengyin", day_index=1)
    assert run.turns_max == 4
    bumped = bump_scene_for_story(run)
    assert bumped is not None
    assert bumped.turns_max == 8
    assert bumped.turns_left == 8

    # T2 + T0/T1/N enriched events load with ≥3 beats
    events = {e.id: e for e in load_events()}
    t2_ids = [
        "story_fengyin_act1_door",
        "story_fengyin_act2_equal",
        "story_xingnai_act1_bento",
        "story_xingnai_act2_album",
        "story_luna_act1_tarot",
        "story_luna_act2_moon",
        "story_qingcai_act1_mirror",
        "story_qingcai_act2_festival",
        "story_xiaoyang_act1_club",
        "story_xiaoyang_act2_stall",
    ]
    rich = [e for e in events.values() if len(e.beats or []) >= 3]
    assert len(rich) >= 60, f"expected ≥60 enriched story acts, got {len(rich)}"
    for eid in t2_ids:
        ev = events.get(eid)
        assert ev is not None, eid
        assert len(ev.beats) >= 3, (eid, len(ev.beats))

    # opening ~11 pages
    import json
    from pathlib import Path

    pres = json.loads(
        (Path(__file__).resolve().parents[1] / "data" / "presentation_catalog.json").read_text(
            encoding="utf-8"
        )
    )
    slides = (pres.get("opening") or {}).get("slides") or []
    assert len(slides) >= 11, len(slides)

    # secret/good ending pages
    ends = pres.get("endings") or {}
    with_pages = sum(1 for v in ends.values() if len(v.get("pages") or []) >= 2)
    assert with_pages >= 40, with_pages

    # no orphan thin story in live events/
    thin = [
        e.id
        for e in events.values()
        if (e.id or "").startswith("story_") and len(e.beats or []) < 3
    ]
    assert not thin, thin

    # curtain helpers
    from app.session_store import Session  # noqa: F401
    from app.story_beats import format_story_snippet

    ev = events["story_fengyin_act1_door"]
    pub = {"id": ev.id, "label": ev.label, "curtain": f"—— 专属故事 · {ev.label} · 开幕 ——", "story": True}
    assert "开幕" in pub["curtain"]
    assert "一起做饭或开黑" not in format_story_snippet(ev, beat_index=0)

    ev = events["story_fengyin_act1_door"]
    s0 = format_story_snippet(ev, beat_index=0, act_summary="")
    assert "当前节拍 1/3" in s0
    assert "停在她半掩" in s0
    assert "一起做饭或开黑" not in s0  # later beat must NOT appear
    assert "系统软选项" in s0
    opts = soft_options_for_beat(ev, 0)
    assert opts and "再敲一声" in opts

    s1 = format_story_snippet(ev, beat_index=1, act_summary="已敲门")
    assert "当前节拍 2/3" in s1
    assert "停在她半掩" not in s1
    assert "私人空间要被尊重" in s1
    assert "本幕已发生" in s1

    # advance + summary clip
    summary = ""
    idx = 0
    completed = False
    for _ in range(3):
        beat = ev.beats[idx]
        summary = append_act_summary(summary, beat)
        idx, completed = advance_beat_index(ev, idx)
    assert completed
    assert idx == 3
    assert len(summary) <= STORY_SUMMARY_MAX

    # story_beat block survives trim when rumors are huge
    blocks = [
        PromptBlock("agenda", "【议程】短"),
        PromptBlock("story_beat", "\n\n" + s0),
        PromptBlock("rumors", "【传闻】" + ("瓜" * 2000)),
    ]
    out = trim_blocks(blocks, budget=WORLD_EXTRA_BUDGET)
    assert "当前节拍 1/3" in out
    assert "停在她半掩" in out

    # legacy snippet-only event still formats
    legacy = GameEvent(
        id="story_legacy_act1",
        label="旧幕",
        prompt_snippet="【专属故事 · 测试 · 第1幕 · 旧幕】\n一整段旧写法。",
        beats=[],
    )
    leg = format_story_snippet(legacy, beat_index=0)
    assert "一整段旧写法" in leg

    print("smoke-story-beats: OK")
    print(
        f"  rich_story={len(rich)} t2={len(t2_ids)} opening_slides={len(slides)} "
        f"ending_pages={with_pages} story_turns={cat.scene_story_turns}"
    )


if __name__ == "__main__":
    try:
        main()
    except AssertionError as ex:
        print("FAIL:", ex)
        raise SystemExit(1)
