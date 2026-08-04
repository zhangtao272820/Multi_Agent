"""Smoke：关系拉长门槛 + 每角好感缩放 + 故事航点门。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.event_engine import GameEvent, EventTrigger, _matches_trigger, load_events  # noqa: E402
from app.relationship import RelationshipState, list_stages, stage_for_affinity  # noqa: E402
from app.route_difficulty import (  # noqa: E402
    confess_blocked_by_resist,
    effective_story_affinity_min,
    get_route_difficulty,
    reload_route_difficulty,
    scale_positive_affinity,
)
from app.story_web import load_story_web  # noqa: E402


def fail(msg: str) -> None:
    print(f"FAIL {msg}")
    raise SystemExit(1)


def main() -> None:
    stages = {s.id: s.affinity_min for s in list_stages()}
    if stages.get("friend", 0) < 35:
        fail(f"friend threshold not lengthened: {stages}")
    if stages.get("dating", 0) < 85:
        fail(f"dating threshold not lengthened: {stages}")
    if stage_for_affinity(50).id not in {"friend", "close_friend"}:
        fail(f"affinity 50 stage unexpected: {stage_for_affinity(50).id}")

    easy = scale_positive_affinity("xiaoyou", 4)
    hard = scale_positive_affinity("jingliu", 4)
    if easy < hard:
        fail(f"xiaoyou scale should >= jingliu: {easy} vs {hard}")
    if scale_positive_affinity("jingliu", -3) != -3:
        fail("negative affinity must not be weakened")

    if effective_story_affinity_min("jingliu", 55) <= 55:
        fail("jingliu story_unlock_bias should raise gate")

    if not confess_blocked_by_resist("ruolin", affinity=40, stage_id="friend"):
        fail("ruolin early confess should block")
    if confess_blocked_by_resist("xiaoyou", affinity=90, stage_id="dating"):
        fail("xiaoyou late confess should pass")

    d = get_route_difficulty("aili")
    if d.difficulty_band != "hard":
        fail(f"aili band {d.difficulty_band}")

    # waypoint gate
    ev = GameEvent(
        id="story_smoke_winter",
        trigger=EventTrigger(
            character_ids=["xiaoyou"],
            affinity_min=10,
            waypoint_min="q_winter_onset",
            season="winter",
        ),
    )
    state = RelationshipState(affinity=80, stage_id="crush", growth_mode="progressive")
    if _matches_trigger(
        ev,
        state=state,
        character_id="xiaoyou",
        day_index=1,
        waypoint_id="q_summer_start",
        waypoints_reached=["q_summer_start"],
    ):
        fail("summer should not match winter waypoint story")
    if not _matches_trigger(
        ev,
        state=state,
        character_id="xiaoyou",
        day_index=154,
        waypoint_id="q_winter_onset",
        waypoints_reached=["q_summer_start", "q_autumn_midautumn", "q_winter_onset"],
    ):
        fail("winter waypoint story should match")

    web = load_story_web()
    if "independence" not in web:
        fail("story_web missing independence")
    edges = web.get("gate_edges") or []
    if len(edges) < 5:
        fail("story_web gate_edges incomplete")

    # Batch D：每条边 N act1 落 GATE；romance 真结局 flags_all 含同 flag
    reload_route_difficulty()
    for cid in ("xiaoyou", "wanyu"):
        if get_route_difficulty(cid).gate_strictness != "strict":
            fail(f"{cid} gate_strictness should be strict")

    data_root = ROOT / "data"
    events = {e.id: e for e in load_events()}
    endings = json.loads((data_root / "endings.json").read_text(encoding="utf-8")).get(
        "endings"
    ) or []
    for edge in edges:
        n_cid = str(edge.get("neutral") or "")
        r_cid = str(edge.get("romance") or "")
        flag = str(edge.get("flag") or "")
        act1 = next(
            (e for e in events.values() if (e.id or "").startswith(f"story_{n_cid}_act1")),
            None,
        )
        if act1 is None:
            fail(f"missing N act1 for {n_cid}")
        if flag not in (act1.rewards.get("flags_set") or []):
            fail(f"{act1.id} must set {flag}")
        hit = False
        for ending in endings:
            if str(ending.get("type") or "") != "secret":
                continue
            if r_cid not in (ending.get("character_ids") or []):
                continue
            fall = [str(x) for x in ((ending.get("conditions") or {}).get("flags_all") or [])]
            if flag in fall:
                hit = True
                break
        if not hit:
            fail(f"{r_cid} true ending must require {flag}")

    print("OK smoke-route-difficulty-web")


if __name__ == "__main__":
    main()
