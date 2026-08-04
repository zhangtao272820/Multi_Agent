"""Smoke: character_lores 薄注入 + linked 闸门告白/阶段帽。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.character import build_system_prompt  # noqa: E402
from app.character_lores import (  # noqa: E402
    linked_dating_unlocked,
    load_character_lores,
    normalize_cast_kind,
    prompt_background_block,
    runtime_max_stage_for_linked,
)
from app.relationship import apply_judge_to_state, init_relationship_state  # noqa: E402
from app.romance_policy import apply_relation_move  # noqa: E402
from app.world_store import create_world_save  # noqa: E402


def fail(msg: str) -> None:
    raise SystemExit(f"FAIL: {msg}")


def main() -> None:
    cat = load_character_lores()
    if len(cat.characters) < 22:
        fail(f"lores chars {len(cat.characters)} < 22")
    if "yeyu" in cat.characters:
        fail("yeyu should be removed from lores")
    if not cat.pc or not cat.pc.prompt_seed:
        fail("pc lore missing")

    bg = prompt_background_block("shuli", flags={})
    if len(bg) > 160:
        fail(f"shuli seed too long: {len(bg)}")
    bg2 = prompt_background_block("shuli", flags={"taboo_romance_ok": True})
    if "近况补丁" not in bg2 and "伦理" not in bg2:
        # unlock text should appear
        if "自愿承担" not in bg2:
            fail("unlock not injected")

    save = create_world_save(user_id="smoke-linked-lores", protagonist_name="测")
    shuli = save.bonds.get("shuli")
    if not shuli:
        fail("no shuli bond")
    if normalize_cast_kind(shuli.cast_kind) != "linked":
        fail(f"shuli cast_kind={shuli.cast_kind}")

    # 未破门：告白被拦
    blocked = apply_relation_move(
        save,
        character_id="shuli",
        move="confess",
        state=shuli.relationship_state,
    )
    if blocked.note != "linked_gate_block":
        fail(f"expected gate block, got {blocked.note}")

    # 破门后可告白（需过 confess_resist：拉高好感）
    flags = dict(shuli.relationship_state.flags or {})
    flags["taboo_romance_ok"] = True
    shuli.relationship_state = shuli.relationship_state.model_copy(
        update={
            "flags": flags,
            "affinity": 92,
            "trust": 80,
            "stage_id": "crush",
            "stage_label": "心动",
        }
    )
    if not linked_dating_unlocked("shuli", self_flags=flags):
        fail("dating should unlock")

    ok = apply_relation_move(
        save,
        character_id="shuli",
        move="confess",
        state=shuli.relationship_state,
    )
    if ok.note != "confess":
        fail(f"expected confess, got {ok.note}")

    # 运行时 max：未破门 close_friend
    capped = runtime_max_stage_for_linked("youwei", "married", self_flags={})
    if capped != "close_friend":
        fail(f"youwei cap={capped}")
    opened = runtime_max_stage_for_linked(
        "youwei",
        "married",
        self_flags={"youwei_open_heart": True, "studio_sketch_done": True},
    )
    if opened != "married":
        fail(f"youwei opened max={opened}")

    # progressive stage 不会在未破门时冲到 dating
    rel = init_relationship_state(shuli.profile, character_id="shuli")
    rel = rel.model_copy(update={"affinity": 95, "growth_mode": "progressive", "max_stage_id": "married"})
    updated, _, _ = apply_judge_to_state(
        rel,
        affinity_delta=1,
        trust_delta=0,
        character_id="shuli",
    )
    if updated.stage_id in {"dating", "married"}:
        fail(f"stage leaked to {updated.stage_id} before gate")

    prompt = build_system_prompt(shuli.profile, relationship_state=shuli.relationship_state)
    if "【背景】" not in prompt:
        fail("no background section")
    # 不应整段灌 codex
    if "幼失怙恃" in prompt and prompt.count("幼失怙恃") and len(prompt.split("【背景】")[1][:400]) > 350:
        # soft check: background chunk short
        pass
    after = prompt.split("【背景】", 1)[1].split("【", 1)[0]
    if len(after.strip()) > 220:
        fail(f"background block too long for token budget: {len(after.strip())}")

    print("OK linked lores + gate smoke")


if __name__ == "__main__":
    main()
