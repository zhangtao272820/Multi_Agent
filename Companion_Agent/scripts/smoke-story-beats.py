"""Story beats smoke: current-beat injection, advance, story turns, summary clip."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.character import CharacterProfile  # noqa: E402
from app.event_engine import (  # noqa: E402
    GameEvent,
    event_has_branch_choices,
    load_events,
)
from app.prompt_budget import WORLD_EXTRA_BUDGET, PromptBlock, trim_blocks  # noqa: E402
from app.relationship import RelationshipState  # noqa: E402
from app.scene_run import bump_scene_for_story, new_scene_run, scene_turn_budget  # noqa: E402
from app.story_beats import (  # noqa: E402
    STORY_SUMMARY_MAX,
    advance_beat_index,
    append_act_summary,
    beat_brief_text,
    format_story_snippet,
    public_story_progress,
    should_advance_beat,
    soft_options_for_beat,
    story_uses_soft_options,
)
from app.world_engine import load_date_catalog  # noqa: E402
from app.world_store import BondShelf  # noqa: E402


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

    # Batch C：T2 冬/节日加幕带 waypoint_min；专属坏四表对齐
    import json

    data_root = Path(__file__).resolve().parents[1] / "data"
    pres = json.loads((data_root / "presentation_catalog.json").read_text(encoding="utf-8"))
    t2_season = [
        eid
        for eid in events
        if eid.startswith(
            (
                "story_fengyin_act5",
                "story_xingnai_act5",
                "story_luna_act5",
                "story_qingcai_act5",
                "story_xiaoyang_act5",
            )
        )
    ]
    assert len(t2_season) == 10, t2_season
    for eid in t2_season:
        ev = events[eid]
        assert len(ev.beats) >= 3, eid
        assert (ev.trigger.waypoint_min or "").strip(), eid

    t2_bads = {
        "fengyin": "ending_fengyin_no_knock",
        "xingnai": "ending_xingnai_blank_gap",
        "luna": "ending_luna_false_charm",
        "qingcai": "ending_qingcai_empty_stage",
        "xiaoyang": "ending_xiaoyang_poster_torn",
    }
    ending_ids = {
        e.get("id")
        for e in (json.loads((data_root / "endings.json").read_text(encoding="utf-8")).get("endings") or [])
    }
    allowed_by_cid = {
        r.get("character_id"): set(r.get("allowed_endings") or [])
        for r in (
            json.loads((data_root / "route_catalog.json").read_text(encoding="utf-8")).get("routes")
            or []
        )
    }
    for cid, bid in t2_bads.items():
        assert bid in ending_ids, bid
        assert len((pres.get("endings") or {}).get(bid, {}).get("pages") or []) >= 2, bid
        assert bid in allowed_by_cid.get(cid, set()), (bid, cid)

    # opening: 5–7 long-form beats
    slides = (pres.get("opening") or {}).get("slides") or []
    assert 5 <= len(slides) <= 7, len(slides)
    for slide in slides:
        lines = slide.get("lines") or ([slide["caption"]] if slide.get("caption") else [])
        assert lines, slide.get("id")
        assert sum(len(str(x)) for x in lines) >= 80, (slide.get("id"), lines)
    brief = (pres.get("opening") or {}).get("world_brief") or []
    assert any("沈予安" in str(x) for x in brief), brief
    assert any(
        "沈予安" in str(x)
        for x in ((slide.get("lines") or []) + [slide.get("caption") or ""])
        for slide in slides
    ), "opening should name 沈予安"

    # secret/good ending pages
    ends = pres.get("endings") or {}
    with_pages = sum(1 for v in ends.values() if len(v.get("pages") or []) >= 2)
    assert with_pages >= 40, with_pages

    # Ending catalog sprites must resolve to an on-disk file (runtime fallback OK)
    from app.presentation import resolve_ending_sprite
    from app.sprite_catalog import resolve_sprite_file

    t0 = {"xiaoyou", "wanyu", "ruolin", "jingliu", "aili", "linxi"}
    t1 = {"taotao", "shizuku", "qiansha", "shiori", "miara"}
    t2 = {"xingnai", "fengyin", "qingcai", "xiaoyang", "luna"}
    neutrals = {"shuli", "youwei", "yuxi", "jingning", "lingke", "aichen"}
    for eid, ent in ends.items():
        sp = ent.get("sprite") or {}
        cid = sp.get("character_id") or ""
        if cid not in t0 | t1 | t2 | neutrals:
            continue
        outfit = (sp.get("outfit") or "").strip()
        emo = (sp.get("emotion") or "").strip() or "love"
        if cid in neutrals and outfit.startswith("end_"):
            # 中立仅在磁盘确有 end_* 包时可写结局 CG（当前优先 shuli）；否则应写日常档
            from app.sprite_outfit import available_outfits

            assert outfit in available_outfits(cid), (
                eid,
                outfit,
                "neutral end_* missing on disk",
            )
        resolved = resolve_ending_sprite(
            character_id=cid, outfit=outfit, emotion=emo
        )
        ro, re = resolved.get("outfit") or "", resolved.get("emotion") or "neutral"
        fn = f"{ro}_{re}.png" if ro else f"{re}.png"
        path = resolve_sprite_file(cid, fn)
        assert path is not None and path.is_file(), f"missing ending sprite {eid}: {fn}"
        pages = ent.get("pages") or []
        if cid in t0 | t1 | t2:
            assert sum(len(p) for p in pages) >= 100, (eid, sum(len(p) for p in pages))

    # public progress exposes beat_summary for Gal HUD；有 narration 时一并下发
    prog = public_story_progress(events["story_xiaoyou_act1_threshold"], beat_index=0)
    assert prog and prog.get("beat_summary"), prog
    assert len(str(prog["beat_summary"])) >= 40
    assert "narration" in prog and "pc_thought" in prog
    # legacy beats：narration fallback = summary
    assert prog.get("narration"), prog

    # 有 beats 则每拍须有 brief 或 summary
    for ev in events.values():
        if not (ev.id or "").startswith("story_") or not ev.beats:
            continue
        for b in ev.beats:
            assert beat_brief_text(b), f"{ev.id}/{b.id} missing brief|summary"

    # N gate beat mentions bound heroine / flag；gate_edges 契约钉死
    import json as _json

    _data = Path(__file__).resolve().parents[1] / "data"
    web = _json.loads((_data / "story_web.json").read_text(encoding="utf-8"))
    endings_list = _json.loads((_data / "endings.json").read_text(encoding="utf-8")).get(
        "endings"
    ) or []
    # 旁白层后：flag id 只钉在 rewards；文案查角色名（brief/narration/summary）
    gate_checks = {
        "youwei": ("学姐", "小悠", "晚悠"),
        "yuxi": ("晚雨",),
        "jingning": ("堂姐", "静流"),
        "lingke": ("若铃", "顾老师"),
        "aichen": ("艾莉",),
    }
    for edge in web.get("gate_edges") or []:
        n_cid = str(edge.get("neutral") or "")
        r_cid = str(edge.get("romance") or "")
        flag = str(edge.get("flag") or "")
        assert n_cid and r_cid and flag, edge
        act1 = next(
            (
                e
                for e in events.values()
                if (e.id or "").startswith(f"story_{n_cid}_act1")
            ),
            None,
        )
        act2 = next(
            (
                e
                for e in events.values()
                if (e.id or "").startswith(f"story_{n_cid}_act2")
            ),
            None,
        )
        assert act1 is not None, n_cid
        assert act2 is not None, n_cid
        assert flag in (act1.rewards.get("flags_set") or []), (act1.id, flag, act1.rewards)
        needles = gate_checks.get(n_cid) or ()
        for ev in (act1, act2):
            joined = " ".join(
                f"{b.summary or ''}{b.brief or ''}{b.narration or ''}"
                for b in (ev.beats or [])
            )
            assert any(n in joined for n in needles), (ev.id, needles, joined[:120])
        true_hit = False
        for ending in endings_list:
            if str(ending.get("type") or "") != "secret":
                continue
            chars = ending.get("character_ids") or []
            if r_cid not in chars:
                continue
            cond = ending.get("conditions") or {}
            fall = [str(x) for x in (cond.get("flags_all") or [])]
            if flag in fall:
                true_hit = True
                break
        assert true_hit, (r_cid, flag)

    shuli1 = events["story_shuli_act1_dinner"]
    shuli2 = events["story_shuli_act2_ally"]
    assert any(
        "家人" in (b.brief or b.summary or "") or "妹妹" in (b.brief or b.summary or "")
        for b in shuli1.beats
    )
    assert any(
        "同盟" in (b.brief or b.summary or "")
        or "sibling" in (b.brief or b.summary or "")
        or "枫音" in ((b.narration or "") + (b.brief or b.summary or ""))
        for b in shuli2.beats
    )

    # 旁白层：女主 snippet 只含 brief，不含 narration / pc_thought 全文
    shuli_b0 = shuli1.beats[0]
    assert (shuli_b0.narration or "").strip() and (shuli_b0.brief or "").strip()
    snip_shuli = format_story_snippet(shuli1, beat_index=0)
    assert (shuli_b0.brief or "")[:20] in snip_shuli
    assert (shuli_b0.narration or "")[:24] not in snip_shuli
    if (shuli_b0.pc_thought or "").strip():
        assert (shuli_b0.pc_thought or "")[:16] not in snip_shuli
    prog_shuli = public_story_progress(shuli1, beat_index=0)
    assert prog_shuli and prog_shuli.get("narration")
    assert (shuli_b0.narration or "")[:20] in str(prog_shuli["narration"])
    assert prog_shuli.get("pc_thought")

    thin = [
        e.id
        for e in events.values()
        if (e.id or "").startswith("story_") and len(e.beats or []) < 3
    ]
    assert not thin, thin

    # curtain helpers
    from app.session_store import Session  # noqa: F401

    ev = events["story_fengyin_act1_door"]
    pub = {"id": ev.id, "label": ev.label, "curtain": f"—— 专属故事 · {ev.label} · 开幕 ——", "story": True}
    assert "开幕" in pub["curtain"]
    assert "一起做饭或开黑" not in format_story_snippet(ev, beat_index=0)

    ev = events["story_fengyin_act1_door"]
    s0 = format_story_snippet(ev, beat_index=0, act_summary="")
    assert "当前节拍 1/3" in s0
    assert "半掩" in s0  # brief 当前拍
    assert "一起做饭或开黑" not in s0  # later beat must NOT appear
    assert "系统软选项" in s0
    # 旁白可含隔墙，但不得进女主 snippet
    assert "书璃" not in s0 or "书璃" in (ev.beats[0].brief or "")
    opts = soft_options_for_beat(ev, 0)
    assert opts and "再敲一声" in opts

    s1 = format_story_snippet(ev, beat_index=1, act_summary="已敲门")
    assert "当前节拍 2/3" in s1
    assert "半掩门外游戏" not in s1
    assert "私人空间" in s1
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
    assert "半掩" in out

    # legacy snippet-only event still formats
    legacy = GameEvent(
        id="story_legacy_act1",
        label="旧幕",
        prompt_snippet="【专属故事 · 测试 · 第1幕 · 旧幕】\n一整段旧写法。",
        beats=[],
    )
    leg = format_story_snippet(legacy, beat_index=0)
    assert "一整段旧写法" in leg

    # §4.6：有 beats + choice_effects → soft，不走 branch
    xy = events["story_xiaoyou_act1_threshold"]
    assert story_uses_soft_options(xy)
    assert xy.choice_effects, "样例幕应带 choice_effects 以证明解耦"
    assert not event_has_branch_choices(xy)

    # advance: on_player_turn / on_choice
    assert should_advance_beat(xy, chose=False)
    assert should_advance_beat(xy, chose=True)
    on_choice = GameEvent(
        id="story_advance_choice",
        label="点选推进",
        advance="on_choice",
        beats=list(xy.beats),
    )
    assert not should_advance_beat(on_choice, chose=False)
    assert should_advance_beat(on_choice, chose=True)

    # date_snippet 不得遮蔽当前拍
    from app.session_store import Session  # noqa: E402

    sess = Session(
        id="smoke",
        profile=CharacterProfile(character_id="xiaoyou", name="小悠"),
        system_prompt="",
        relationship_state=RelationshipState(),
        active_event=xy,
        story_beat_index=0,
        story_act_summary="",
        date_snippet="【约会脚本】整段约会文案不应进故事拍",
    )
    sess.rebuild_prompt()
    assert "当前节拍 1/" in sess.system_prompt
    assert "整段约会文案不应进故事拍" not in sess.system_prompt

    # BondShelf 节拍字段 roundtrip
    bond = BondShelf(
        character_id="xiaoyou",
        profile=CharacterProfile(character_id="xiaoyou", name="小悠"),
        relationship_state=RelationshipState(),
        story_event_id="story_xiaoyou_act1_threshold",
        story_beat_index=2,
        story_act_summary="已过门槛",
    )
    roundtrip = BondShelf.model_validate(bond.model_dump())
    assert roundtrip.story_event_id == "story_xiaoyou_act1_threshold"
    assert roundtrip.story_beat_index == 2
    assert "门槛" in roundtrip.story_act_summary

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
