#!/usr/bin/env python3
"""Smoke: world systems — seating, scores, weather, mock, weekend, save."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def main() -> int:
    from app import campus_engine
    from app.campus_store import store
    from app import seating as seating_mod

    hub = campus_engine.create_new(name="测试生", grade_tier="mid", stats={"study": 3, "social": 3, "stamina": 3, "luck": 3})
    assert hub["student_count"] == 35
    assert hub["calendar"]["period_id"] == "morning_study"
    assert hub["calendar"]["weather_id"]
    assert hub["pc_scores"]["total"] > 0

    save = store.require_active()
    assert len(save.seating) == 35
    rel = seating_mod.relation_between(save.seating, "pc", save.seating[1]["student_id"])
    assert rel in {"deskmate", "aisle", "front_back", "diagonal", "note", "none"}

    # AA2: class roles unique + relation labels + verdict + breakup
    from app import relationship as rel_mod
    roles = [s.get("class_role") for s in save.students if s.get("class_role")]
    assert len(roles) == len(set(roles)), roles
    rel_mod.validate_class_roles(save.students)
    edge_ff = {"a": "f01", "b": "f02", "affinity": 60, "stage": "close", "track": "ff", "bond_kind": "friendship", "was_dating": False, "memories": []}
    lab = rel_mod.resolve_campus_relation(edge_ff, gender_a="female", gender_b="female", seat_relation="deskmate", class_role_b="monitor")
    assert lab["primary_label"] == "闺蜜"
    assert "同桌" in lab["context_tags"]
    assert "班长" in lab["context_tags"]
    edge_ex = {"a": "pc", "b": "f01", "affinity": 50, "stage": "friend", "track": "mf", "bond_kind": "friendship", "was_dating": True, "memories": []}
    lab_ex = rel_mod.resolve_campus_relation(edge_ex, gender_a="male", gender_b="female")
    assert lab_ex["primary_label"] == "前任"
    dating = {"a": "pc", "b": "f01", "affinity": 92, "stage": "dating", "track": "mf", "bond_kind": "romance", "was_dating": True, "memories": []}
    rel_mod.break_up(dating, day_index=50)
    assert dating["was_dating"] and dating["stage"] != "dating"
    lab2 = rel_mod.resolve_campus_relation(dating, gender_a="male", gender_b="female")
    assert lab2["primary_label"] == "前任"


    # advance through a class period somehow
    while store.require_active().period_id != "class_am":
        campus_engine.advance_period()
    before = store.require_active().scores["pc"]["math"]
    campus_engine.advance_period()  # leave class_am → applies gain on advance from class
    # gain applied when leaving class_am
    # Actually gain is applied at start of advance when CURRENT period is class
    # So when we were on class_am and advanced, math should rise
    after = store.require_active().scores["pc"]["math"]
    assert after > before, (before, after)

    # study on free period
    while store.require_active().period_id != "evening_study":
        campus_engine.advance_period()
        if store.require_active().day_index > 2:
            break
    if store.require_active().period_id == "evening_study":
        campus_engine.travel("library")
        eng_before = store.require_active().scores["pc"]["english"]
        campus_engine.study(subject_id="english")
        assert store.require_active().scores["pc"]["english"] > eng_before

    mock = campus_engine.run_mock_exam()
    assert mock["last_mock"]["pc_rank"] is not None
    assert len(store.require_active().seating) == 35

    board = campus_engine.board_public()
    assert len(board["students"]) == 35
    assert "event_reactions" in (board.get("today") or {})

    # M10 mind tick: without API key still advances; with mock Aux applies minds
    from app.llm_chat import NpcMindItem, NpcMindsResult
    from app import npc_minds
    from unittest.mock import patch

    save = store.require_active()
    candidates = npc_minds.sample_mind_candidates(save, limit=3)
    assert 1 <= len(candidates) <= 5
    mock_minds = NpcMindsResult(
        minds=[
            NpcMindItem(
                student_id=candidates[0]["id"],
                mood="shy",
                thought="想问问他模考怎么样",
                intent_type="greet",
                blurb=f"{candidates[0].get('name')}想找你说两句。",
                approach_pc=True,
                affinity_delta=0.5,
                event_take="这天气……有点烦。" if save.active_event else None,
            )
        ]
    )
    with patch("app.npc_minds.run_npc_minds", return_value=mock_minds), patch(
        "app.npc_minds.llm_api_key", return_value="test-key"
    ):
        meta = npc_minds.run_mind_tick(save)
    assert meta["used_llm"] is True
    assert candidates[0]["id"] in save.npc_minds
    assert save.npc_minds[candidates[0]["id"]]["mood"] == "shy"
    assert any(i.get("from_id") == candidates[0]["id"] for i in save.pending_intents)

    hub2 = campus_engine.advance_period()
    assert "period_summary" in hub2
    assert "period_recap" in hub2
    assert hub2["period_recap"] is not None
    assert "summary" in hub2["period_recap"]
    assert "pending_intents" in hub2
    assert "event_reactions" in hub2

    # M19+/pace: skip to actionable
    while store.require_active().period_id != "class_am":
        campus_engine.advance_period()
        if store.require_active().day_index > 3:
            break
    if store.require_active().period_id == "class_am":
        skip_hub = campus_engine.advance_until_actionable()
        assert skip_hub.get("period_recap")
        assert (skip_hub["calendar"].get("period_kind") in {"free", "free_day", "meal", "dorm"}) or skip_hub.get(
            "ended"
        )
        assert skip_hub["last_action"]["type"] == "advance_skip"

    # weekly event on day 1
    from app import relationship as rel_mod

    hub_w = campus_engine.create_new(name="事件生", grade_tier="mid", stats={"study": 3, "social": 3, "stamina": 3, "luck": 3})
    ev = hub_w.get("active_event")
    assert ev and ev.get("id") == "week1_roster", ev
    assert ev.get("source") == "weekly"
    assert ev.get("talk_npc_id")

    # opening_line on prepare_talk
    campus_engine.travel("classroom")
    present_w = [p for p in campus_engine.hub_public(store.require_active())["present"] if not p.get("is_pc")]
    assert present_w
    # seed memory for greeting hook
    edge_w = rel_mod.ensure_edge(
        store.require_active().edges,
        "pc",
        present_w[0]["id"],
        gender_a="male",
        gender_b=str(next(s for s in store.require_active().students if s["id"] == present_w[0]["id"])["gender"]),
    )
    edge_w["memories"] = ["昨晚一起在走廊看了倒计时"]
    edge_w["affinity"] = 40
    edge_w["stage"] = "friend"
    prep_w = campus_engine.prepare_talk(present_w[0]["id"])
    assert prep_w.get("opening_line")
    assert "倒计时" in prep_w["opening_line"] or len(prep_w["opening_line"]) > 4

    # push to weekend
    save = store.require_active()
    target_day = save.day_index
    while store.require_active().day_kind != "weekend":
        campus_engine.advance_period()
        if store.require_active().day_index > target_day + 10:
            raise AssertionError("weekend_not_reached")
    campus_engine.weekend_roam()
    assert store.require_active().locations_now

    # manual save + reload preserves npc_minds
    meta = store.persist(store.require_active(), kind="manual", slot=1, title="smoke")
    sid = meta["save_id"]
    store.clear()
    loaded = store.load_save(sid)
    assert loaded.protagonist["name"] == "事件生"
    assert isinstance(getattr(loaded, "npc_minds", None), dict)

    # M12–M14: talk dual-layer + interact verbs + club
    from app import catalog

    hub_m = campus_engine.create_new(name="互动生", grade_tier="mid", stats={"study": 3, "social": 3, "stamina": 3, "luck": 3})
    campus_engine.travel("classroom")
    present = [p for p in campus_engine.hub_public(store.require_active())["present"] if not p.get("is_pc")]
    assert present, "need classmates present"
    tid = present[0]["id"]
    prep = campus_engine.prepare_talk(tid)
    assert prep.get("sprite") is not None
    assert prep.get("q_sprite") is not None
    assert prep["q_sprite"].get("kind") == "q" or prep["q_sprite"].get("path")
    assert prep.get("opening_line")

    chat = campus_engine.chat_turn(target_id=tid, text="早啊，今天天气不错。", verb="greet")
    assert chat.get("line")
    assert "q_sprite" in chat and "sprite" in chat

    # study_together on free period (already morning_study)
    save = store.require_active()
    save.chat_actions_left = 3
    before_aff = float((rel_mod.find_edge(save.edges, "pc", tid) or {}).get("affinity") or 0)

    study_res = campus_engine.interact(target_id=tid, verb="study_together")
    assert study_res.get("verb") == "study_together"
    assert study_res.get("action_blurb")
    assert "q_sprite" in study_res
    after_edge = rel_mod.find_edge(store.require_active().edges, "pc", tid)
    assert after_edge and float(after_edge.get("affinity") or 0) >= before_aff

    # invite requires acquaintance+
    edge = rel_mod.find_edge(store.require_active().edges, "pc", tid)
    assert edge
    edge["affinity"] = 20
    edge["stage"] = "acquaintance"
    store.require_active().chat_actions_left = 2
    inv = campus_engine.interact(target_id=tid, verb="invite")
    assert inv.get("verb") == "invite"
    assert tid in store.require_active().invite_stick

    # club activity on a free period
    while True:
        save = store.require_active()
        pmeta = catalog.period_by_id(save.period_id, save.day_kind) or {}
        if pmeta.get("kind") in {"free", "free_day"}:
            break
        campus_engine.advance_period()
        if store.require_active().day_index > save.day_index + 3:
            break
    campus_engine.travel("club_room")
    pmeta = catalog.period_by_id(store.require_active().period_id, store.require_active().day_kind) or {}
    if pmeta.get("kind") in {"free", "free_day"}:
        club = campus_engine.club_activity()
        assert club.get("club_action_used") is True or club.get("last_action", {}).get("type") == "club"
        assert "period_summary" in club
        try:
            campus_engine.club_activity()
            raise AssertionError("club should be once per period")
        except ValueError as e:
            assert "club_already_used" in str(e)

    # M15 spot action (playground) — may need free/meal period
    while True:
        save = store.require_active()
        pmeta = catalog.period_by_id(save.period_id, save.day_kind) or {}
        if pmeta.get("kind") in {"free", "free_day", "meal"}:
            break
        campus_engine.advance_period()
        if store.require_active().day_index > save.day_index + 2:
            break
    campus_engine.travel("playground")
    store.require_active().spot_action_used = False
    pmeta = catalog.period_by_id(store.require_active().period_id, store.require_active().day_kind) or {}
    if pmeta.get("kind") in {"free", "free_day", "meal"}:
        spot = campus_engine.spot_activity(action_id="exercise")
        assert spot.get("spot_action_used") is True or spot.get("last_action", {}).get("type") == "spot"
        assert "period_summary" in spot
        try:
            campus_engine.spot_activity()
            raise AssertionError("spot should be once per period")
        except ValueError as e:
            assert "spot_already_used" in str(e)

    # coach is frontend-only (localStorage); save fields must still round-trip
    meta2 = store.persist(store.require_active(), kind="manual", slot=2, title="interact-smoke")
    store.clear()
    loaded2 = store.load_save(meta2["save_id"])
    assert hasattr(loaded2, "invite_stick")
    assert hasattr(loaded2, "club_action_used")
    assert hasattr(loaded2, "spot_action_used")

    # M18: ask_out accepted → date talk prep (force accept path)
    from unittest.mock import patch

    hub_d = campus_engine.create_new(name="约会生", grade_tier="mid", stats={"study": 3, "social": 3, "stamina": 3, "luck": 3})
    while store.require_active().day_kind != "weekend":
        campus_engine.advance_period()
        if store.require_active().day_index > 14:
            break
    assert store.require_active().day_kind == "weekend"
    # Find any NPC, then pin both to playground for date scene
    hub_now = campus_engine.hub_public(store.require_active())
    any_npc = next(
        (
            p
            for loc in hub_now["locations"]
            for p in (loc.get("present_preview") or [])
            if not p.get("is_pc")
        ),
        None,
    )
    assert any_npc, "need an NPC somewhere on campus"
    tid_d = any_npc["id"]
    campus_engine.travel("playground")
    store.require_active().locations_now[tid_d] = "playground"
    edge_d = rel_mod.ensure_edge(
        store.require_active().edges,
        "pc",
        tid_d,
        gender_a="male",
        gender_b=str(next(s for s in store.require_active().students if s["id"] == tid_d)["gender"]),
    )
    edge_d["affinity"] = 80
    edge_d["stage"] = "close"
    with patch("app.campus_engine.llm_api_key", return_value=None), patch(
        "app.npc_intent.evaluate_date_response", return_value=True
    ):
        date_res = campus_engine.ask_out(target_id=tid_d, location_id="playground")
    assert date_res["accepted"] is True
    assert date_res.get("talk")
    assert date_res["talk"].get("scene") == "date"
    assert date_res["talk"].get("opening_line")
    assert store.require_active().active_date
    prep_d = campus_engine.prepare_talk(tid_d)
    assert prep_d.get("scene") == "date"
    stroll = campus_engine.interact(target_id=tid_d, verb="date_stroll")
    assert stroll.get("line")
    assert "q_sprite" in stroll

    # M11: q_sprite on public + D-0 ending when day 100 ends
    from app import sprites as sprites_mod

    q = sprites_mod.resolve_q_sprite("f01")
    assert q.get("kind") == "q"
    assert "path" in q

    hub_q = campus_engine.create_new(name="终章生", grade_tier="mid", stats={"study": 3, "social": 3, "stamina": 3, "luck": 3})
    pc_pub = next(p for p in hub_q["present"] if p.get("is_pc"))
    assert "mbti" not in pc_pub or not pc_pub.get("mbti")
    npc_pub = next(p for p in hub_q["present"] if not p.get("is_pc"))
    assert npc_pub.get("mbti")
    present_npc = next(s for s in hub_q["present"] if not s.get("is_pc"))
    assert present_npc.get("q_sprite") is not None
    sample = next(p for loc in hub_q["locations"] for p in (loc.get("present_preview") or []) if not p.get("is_pc"))
    assert "q_sprite" in sample

    save = store.require_active()
    save.day_index = 100
    save.weekday = campus_engine._weekday_from_day(100)
    save.day_kind = campus_engine._day_kind(save.weekday)

    periods = catalog.period_ids(save.day_kind)
    save.period_id = periods[-1]
    save.ended = False
    save.ending = None
    end_hub = campus_engine.advance_period()
    assert end_hub.get("ended") is True
    assert end_hub.get("ending")
    assert end_hub["ending"]["kind"] == "gaokao"
    assert end_hub["ending"]["ending_id"]
    assert end_hub["ending"]["verdict"] in {"true", "good", "soft", "bad"}
    assert end_hub["ending"].get("epilogue_line")
    assert end_hub["ending"]["grade_band"] in {"top", "good", "mid", "low"}
    assert end_hub["ending"]["pc_rank"] >= 1
    assert end_hub["ending"].get("social_epilogue")
    assert "blurb" in end_hub["ending"]["social_epilogue"]
    # second advance stays ended
    again = campus_engine.advance_period()
    assert again.get("ended") is True

    # —— Phase B: schedule + NPC social + world_events ——
    hub_s = campus_engine.create_new(name="社交生", grade_tier="mid", stats={"study": 3, "social": 3, "stamina": 3, "luck": 3})
    save_s = store.require_active()
    assert any(
        "pc" not in {e.get("a"), e.get("b")} for e in save_s.edges
    ), "seed_initial_bonds should create non-PC edges"
    # morning_study should prefer schedule classroom for NPCs with that key
    classroom_npcs = [
        sid
        for sid, loc in save_s.locations_now.items()
        if sid != "pc" and loc == "classroom"
    ]
    assert len(classroom_npcs) >= 5, classroom_npcs

    saw_world = False
    for _ in range(8):
        hub_tick = campus_engine.advance_period()
        recap = hub_tick.get("period_recap") or {}
        we = recap.get("world_events") or hub_tick.get("world_events") or []
        if we:
            saw_world = True
            assert we[0].get("blurb")
            break
        if hub_tick.get("ended"):
            break
    assert saw_world, "expected world_events after social ticks"

    board_s = campus_engine.board_public()
    assert "class_gossip" in board_s
    assert "world_events" in (board_s.get("today") or {})
    hub_live = campus_engine.hub_public(store.require_active())
    assert "world_events" in hub_live

    # Free romance: ff/mf allowed; dating couples stick together
    from app import npc_social as social_mod

    save_r = store.require_active()
    f_ids = [s["id"] for s in save_r.students if s.get("gender") == "female"]
    m_ids = [s["id"] for s in save_r.students if s.get("gender") == "male" and s["id"] != "pc"]
    assert len(f_ids) >= 2 and m_ids
    assert social_mod.mutual_romance_ok(save_r, f_ids[0], f_ids[1])
    assert social_mod.mutual_romance_ok(save_r, f_ids[0], m_ids[0])
    edge_ff = rel_mod.ensure_edge(
        save_r.edges, f_ids[0], f_ids[1], gender_a="female", gender_b="female"
    )
    edge_ff["affinity"] = 92
    edge_ff["stage"] = "dating"
    rel_mod.set_bond_kind(edge_ff, "romance")
    save_r.locations_now[f_ids[0]] = "library"
    save_r.locations_now[f_ids[1]] = "rooftop"
    social_mod.apply_couple_stick(save_r)
    assert save_r.locations_now[f_ids[0]] == save_r.locations_now[f_ids[1]]
    gossip = social_mod.class_gossip_public(save_r)
    assert any(g.get("track") == "ff" or "女女" in str(g.get("label") or "") for g in gossip)

    # Sprite utilization: meal→sc/eat, dorm→private, talk→chat
    from app import sprite_context as sprite_ctx

    cafe = sprite_ctx.resolve_contextual_sprite(
        "f01",
        emotion="happy",
        location_id="cafeteria",
        period_kind="meal",
        weather_id="sunny",
        gender="female",
        prefer_scene=True,
    )
    assert cafe.get("path")
    assert any(k in str(cafe.get("file") or "") for k in ("sc_cafeteria", "eat", "chat", "stand")), cafe.get(
        "file"
    )
    dorm_sp = sprite_ctx.resolve_contextual_sprite(
        "f01",
        emotion="shy",
        location_id="dorm_f1",
        period_kind="dorm",
        weather_id="sunny",
        gender="female",
        prefer_scene=True,
    )
    assert dorm_sp.get("path")
    assert str(dorm_sp.get("file") or "").startswith(
        ("casual_", "pajama_", "towel_", "summer_sc_dorm")
    ), dorm_sp.get("file")
    talk_sp = sprite_ctx.resolve_contextual_sprite(
        "f01",
        emotion="happy",
        location_id="hallway",
        period_kind="free",
        weather_id="sunny",
        verb="talk",
        gender="female",
        prefer_scene=False,
    )
    assert talk_sp.get("path")

    # skip merges world_events into final recap when any fired
    day0 = store.require_active().day_index
    while store.require_active().period_id != "class_am":
        campus_engine.advance_period()
        if store.require_active().day_index > day0 + 2:
            break
    save_skip = store.require_active()
    periods = catalog.period_ids(save_skip.day_kind)
    if "class_am" in periods:
        save_skip.period_id = "class_am"
    skip_hub2 = campus_engine.advance_until_actionable()
    assert skip_hub2["last_action"]["type"] == "advance_skip"
    skip_recap = skip_hub2.get("period_recap") or {}
    assert isinstance(skip_recap.get("world_events", []), list)

    # prepare_talk seeds mind thought for bubble
    campus_engine.travel("classroom")
    # refresh locations for current period
    from app.campus_engine import _refresh_locations

    _refresh_locations(store.require_active())
    present_m = [p for p in campus_engine.hub_public(store.require_active())["present"] if not p.get("is_pc")]
    if not present_m:
        # pin someone to classroom
        sid0 = next(s["id"] for s in store.require_active().students if s["id"] != "pc")
        store.require_active().locations_now[sid0] = "classroom"
        present_m = [{"id": sid0}]
    prep_m = campus_engine.prepare_talk(present_m[0]["id"])
    mind_m = (prep_m.get("target") or {}).get("mind") or {}
    assert mind_m.get("thought"), mind_m

    non_pc = [e for e in store.require_active().edges if "pc" not in {e.get("a"), e.get("b")}]
    assert non_pc, "NPC↔NPC edges must exist after social tick"
    assert any(e.get("bond_kind") for e in non_pc)

    # weather BG resolution
    rainy = sprites_mod.resolve_bg("classroom", "rainy")
    assert rainy.get("file") == "classroom_rainy.png", rainy
    map_bg = (ROOT / "data" / "bgs" / "campus_map.png").is_file()
    assert map_bg
    for mood in ("happy", "shy"):
        qmood = sprites_mod.resolve_q_sprite("f01", emotion=mood)
        assert qmood.get("path"), mood

    # T0 summer_stand RGBA hard gate
    from PIL import Image

    for sid in ("f21", "f22", "f23", "f24"):
        p = ROOT / "data" / "sprites" / "students" / sid / "summer_stand_neutral.png"
        assert p.is_file(), sid
        with Image.open(p) as im:
            assert im.mode == "RGBA", (sid, im.mode)

    # male baseline sprites resolve
    for mid in ("pc", "m01", "m09"):
        sp = sprites_mod.resolve_student_sprite(mid)
        assert sp.get("path"), mid
        qsp = sprites_mod.resolve_q_sprite(mid)
        assert qsp.get("path"), mid

    # M25: context-aware outfit/action (assert only when disk has the preferred file)
    from app import sprite_context as sprite_ctx
    from pathlib import Path as _Path

    sprites_root = _Path(ROOT) / "data" / "sprites" / "students"

    def _has(sid: str, name: str) -> bool:
        return (sprites_root / sid / name).is_file()

    # Female dorm → private outfit when casual/pajama stand exists
    if _has("f01", "casual_stand_happy.png"):
        r = sprite_ctx.resolve_contextual_sprite(
            "f01",
            emotion="happy",
            location_id="dorm_f1",
            period_kind="dorm",
            weather_id="sunny",
            gender="female",
            prefer_scene=True,
        )
        assert str(r.get("file", "")).startswith("casual_") or str(r.get("file", "")).startswith(
            "pajama_"
        ), r.get("file")
    if _has("f01", "pajama_stand_neutral.png"):
        r = sprite_ctx.resolve_contextual_sprite(
            "f01",
            emotion="neutral",
            location_id="dorm_f1",
            period_kind="end",
            weather_id="sunny",
            gender="female",
        )
        assert str(r.get("file", "")).startswith("pajama_"), r.get("file")

    # Classroom hub prefers sc_* when present
    if _has("f01", "summer_sc_classroom_lean_neutral.png"):
        r = sprite_ctx.resolve_contextual_sprite(
            "f01",
            emotion="neutral",
            location_id="classroom",
            period_kind="free",
            weather_id="sunny",
            gender="female",
            prefer_scene=True,
        )
        assert "sc_classroom" in str(r.get("file", "")), r.get("file")

    # Verb study_together → study
    if _has("f01", "summer_study_neutral.png"):
        r = sprite_ctx.resolve_contextual_sprite(
            "f01",
            emotion="neutral",
            location_id="classroom",
            period_kind="free",
            weather_id="sunny",
            verb="study_together",
            gender="female",
            prefer_scene=False,
        )
        assert "study" in str(r.get("file", "")), r.get("file")

    # Cold → winter when winter sc/stand exists
    if _has("f01", "winter_sc_hallway_window_neutral.png") or _has("f01", "winter_stand_neutral.png"):
        r = sprite_ctx.resolve_contextual_sprite(
            "f01",
            emotion="neutral",
            location_id="hallway",
            period_kind="free",
            weather_id="cold",
            gender="female",
            prefer_scene=True,
        )
        assert str(r.get("file", "")).startswith("winter_"), r.get("file")

    # Male: never private outfit; missing pack falls back to summer_stand
    r = sprite_ctx.resolve_contextual_sprite(
        "m01",
        emotion="happy",
        location_id="dorm_m1",
        period_kind="dorm",
        weather_id="sunny",
        gender="male",
    )
    assert not str(r.get("file", "")).startswith(("casual_", "pajama_", "towel_")), r.get("file")
    assert r.get("path"), "male fallback must resolve"

    # Missing preferred action still falls back (never blocks)
    r = sprite_ctx.resolve_contextual_sprite(
        "m01",
        emotion="angry",
        location_id="classroom",
        period_kind="free",
        weather_id="sunny",
        verb="study_together",
        gender="male",
        prefer_scene=False,
    )
    assert r.get("path") or r.get("fallback") is True

    print("OK world smoke")
    print(" weather:", hub["calendar"]["weather_id"])
    print(" pc_rank:", mock["last_mock"]["pc_rank"])
    print(" weekend day:", loaded.day_index, loaded.day_kind)
    print(" minds:", len(loaded.npc_minds))
    print(" ending:", end_hub["ending"]["ending_id"], end_hub["ending"]["tone"], "rank", end_hub["ending"]["pc_rank"])
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print("FAIL:", e, file=sys.stderr)
        raise SystemExit(1)
