"""Smoke：冷落衰减 / 阶段同意 / 女主表白挂起 / 朋友结局误触 / gate_strictness。"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.game_judge import check_endings  # noqa: E402
from app.life_friction import ending_soft_hints, settle_friend_ending  # noqa: E402
from app.neglect import (  # noqa: E402
    apply_neglect_to_bond,
    days_since_talk,
    load_neglect_decay,
    reset_neglect_anchors_on_waypoint_jump,
)
from app.relationship import (  # noqa: E402
    RelationshipState,
    accept_pending_confession,
    accept_pending_stage,
    apply_judge_to_state,
    defer_pending_stage,
    reject_pending_confession,
)
from app.romance_policy import (  # noqa: E402
    apply_heroine_initiative,
    apply_stage_offer,
    hang_pursuit_confession_if_needed,
)
from app.route_difficulty import secret_gate_blocks  # noqa: E402
from app.world_store import BondLiving, BondShelf, CalendarState, WorldSave  # noqa: E402
from app.character import CharacterProfile  # noqa: E402


def fail(msg: str) -> None:
    print(f"FAIL {msg}")
    raise SystemExit(1)


def _bond(*, stage: str, aff: int, talked: int, cid: str = "xiaoyou") -> BondShelf:
    return BondShelf(
        character_id=cid,
        cast_kind="romance",
        profile=CharacterProfile(name="测", character_id=cid),
        relationship_state=RelationshipState(
            stage_id=stage,
            stage_label=stage,
            affinity=aff,
            trust=50,
            growth_mode="progressive",
            target_stage_id="married",
            max_stage_id="married",
        ),
        living=BondLiving(talked_day_index=talked),
    )


def main() -> None:
    cat = load_neglect_decay()
    if int(cat.get("grace_days") or 0) < 1:
        fail("neglect grace_days missing")

    # 宽限内不扣
    b = _bond(stage="dating", aff=90, talked=10)
    b2 = apply_neglect_to_bond(b, day_index=11, character_id="xiaoyou")
    if b2.relationship_state.affinity != 90:
        fail("grace should not decay")

    # 超宽限约会阶段应扣
    b = _bond(stage="dating", aff=90, talked=5)
    b2 = apply_neglect_to_bond(b, day_index=10, character_id="xiaoyou")
    if b2.relationship_state.affinity >= 90:
        fail("dating neglect should lower affinity")
    if days_since_talk(b, 10) < 4:
        fail("days_since calc")

    # 航点重置锚点
    save = WorldSave(
        save_id="smoke",
        user_id="smoke",
        calendar=CalendarState(day_index=100),
        bonds={"xiaoyou": _bond(stage="crush", aff=75, talked=10)},
    )
    save = reset_neglect_anchors_on_waypoint_jump(save)
    if save.bonds["xiaoyou"].living.talked_day_index != 100:
        fail("waypoint jump should reset talk anchor")

    # 阶段同意：好感够暧昧不自动变 crush
    st = RelationshipState(
        stage_id="close_friend",
        stage_label="知己",
        affinity=70,
        trust=60,
        growth_mode="progressive",
        target_stage_id="married",
        max_stage_id="married",
    )
    st2, _, changed = apply_judge_to_state(
        st, affinity_delta=5, trust_delta=0, character_id="xiaoyou"
    )
    if st2.stage_id == "crush":
        fail("crush must not auto-apply without consent")
    if st2.pending_stage_id != "crush":
        fail(f"expected pending crush, got {st2.pending_stage_id!r} stage={st2.stage_id}")

    st3 = accept_pending_stage(st2)
    if st3.stage_id != "crush":
        fail(f"accept should promote to crush, got {st3.stage_id}")
    if not (st3.flags or {}).get("stage_crush_accepted"):
        fail("stage_crush_accepted flag missing")

    st4 = defer_pending_stage(st2)
    if st4.pending_stage_id:
        fail("defer should clear pending")

    # 女主表白挂起
    hi = apply_heroine_initiative(
        character_id="xiaoyou",
        initiative="confess",
        state=RelationshipState(
            stage_id="crush",
            affinity=80,
            trust=70,
            growth_mode="progressive",
            max_stage_id="married",
            target_stage_id="married",
            flags={"stage_crush_accepted": True},
        ),
    )
    if not hi.new_flags.get("pending_confession"):
        fail("xiaoyou confess_init should set pending_confession")

    stc = RelationshipState(
        stage_id="crush",
        affinity=80,
        flags={"pending_confession": True, "stage_crush_accepted": True},
        growth_mode="progressive",
        max_stage_id="married",
        target_stage_id="married",
    )
    if not (accept_pending_confession(stc).flags or {}).get("confessed"):
        fail("accept confession should set confessed")
    if (reject_pending_confession(stc).flags or {}).get("pending_confession"):
        fail("reject should clear pending_confession")

    # stage_offer
    offered = apply_stage_offer(
        offer="dating",
        state=RelationshipState(
            stage_id="crush",
            affinity=90,
            flags={"stage_crush_accepted": True},
            growth_mode="progressive",
            max_stage_id="married",
            target_stage_id="married",
        ),
    )
    if offered != "dating":
        fail(f"stage_offer dating expected, got {offered!r}")

    # 朋友结局误触
    friend_hit = check_endings(
        character_id="xiaoyou",
        state=RelationshipState(
            stage_id="friend",
            affinity=55,
            trust=50,
            growth_mode="progressive",
            max_stage_id="married",
            target_stage_id="married",
        ),
        runtime={"flags": {}, "trust": 50, "low_streak": 0, "cast_role": "romance"},
    )
    if friend_hit == "ending_friend":
        fail("ending_friend must not fire mid-route without ending_ready")

    ready_hit = check_endings(
        character_id="xiaoyou",
        state=RelationshipState(
            stage_id="friend",
            affinity=55,
            trust=50,
            growth_mode="progressive",
            max_stage_id="married",
            target_stage_id="married",
        ),
        runtime={
            "flags": {"ending_ready": True},
            "trust": 50,
            "low_streak": 0,
            "cast_role": "romance",
        },
    )
    if ready_hit not in {"ending_friend", "ending_best_friend"}:
        fail(f"ending_ready should allow friend-class ending, got {ready_hit!r}")

    # Hub settle_friend_ending 写入路径
    settle_save = WorldSave(
        save_id="smoke-settle",
        user_id="smoke",
        calendar=CalendarState(day_index=20),
        bonds={
            "xiaoyou": BondShelf(
                character_id="xiaoyou",
                cast_kind="romance",
                profile=CharacterProfile(name="沈小悠", character_id="xiaoyou"),
                relationship_state=RelationshipState(
                    stage_id="friend",
                    stage_label="朋友",
                    affinity=55,
                    trust=50,
                    growth_mode="progressive",
                    max_stage_id="married",
                    target_stage_id="married",
                ),
            )
        },
    )
    hints = ending_soft_hints(settle_save)
    if not any(h.get("action") == "settle_friend" for h in hints):
        fail("ending_soft_hints should offer settle_friend in friend band")
    settle_save, settled = settle_friend_ending(settle_save, "xiaoyou")
    if not settled.get("ok"):
        fail(f"settle_friend_ending failed: {settled}")
    if not (settle_save.bonds["xiaoyou"].relationship_state.flags or {}).get("ending_ready"):
        fail("settle should set ending_ready")
    if settled.get("ending_id") not in {"ending_friend", "ending_best_friend"}:
        fail(f"settle should unlock friend ending, got {settled.get('ending_id')!r}")

    # pursuit 议程 → 直接挂 pending_confession
    hung = hang_pursuit_confession_if_needed(
        character_id="xiaoyou",
        state=RelationshipState(
            stage_id="crush",
            affinity=80,
            trust=70,
            growth_mode="progressive",
            max_stage_id="married",
            target_stage_id="married",
            flags={"stage_crush_accepted": True},
        ),
        agenda_source="pursuit",
    )
    if not (hung.flags or {}).get("pending_confession"):
        fail("pursuit agenda should hang pending_confession")
    hung_noop = hang_pursuit_confession_if_needed(
        character_id="xiaoyou",
        state=hung,
        agenda_source="chat",
    )
    if hung_noop is not hung and (hung_noop.flags or {}).get("pending_confession") is False:
        fail("non-pursuit should not clear confession")

    # gate_strictness strict blocks secret without gate flag
    if not secret_gate_blocks(
        "jingliu",
        flags={},
        ending_type="secret",
    ):
        fail("jingliu strict secret should block without cousin_watch_done")
    if secret_gate_blocks(
        "jingliu",
        flags={"cousin_watch_done": True},
        ending_type="secret",
    ):
        fail("jingliu with gate flag should not block")
    if secret_gate_blocks("linxi", flags={}, ending_type="secret"):
        fail("linxi gate_strictness none should not extra-block")

    # Batch D：xiaoyou / wanyu 与 hard 线一致走 strict
    if not secret_gate_blocks("xiaoyou", flags={}, ending_type="secret"):
        fail("xiaoyou strict secret should block without studio_sketch_done")
    if secret_gate_blocks(
        "xiaoyou",
        flags={"studio_sketch_done": True},
        ending_type="secret",
    ):
        fail("xiaoyou with gate flag should not block")
    if not secret_gate_blocks("wanyu", flags={}, ending_type="secret"):
        fail("wanyu strict secret should block without shift_cover_done")
    if secret_gate_blocks(
        "wanyu",
        flags={"shift_cover_done": True},
        ending_type="secret",
    ):
        fail("wanyu with gate flag should not block")

    print("OK smoke-romance-consent-neglect")


if __name__ == "__main__":
    main()
