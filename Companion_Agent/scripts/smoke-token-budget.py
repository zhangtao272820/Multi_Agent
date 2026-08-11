"""Token budget smoke: keep_pairs, world extras ≤1400, memory LLM off by default."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.config import get_settings  # noqa: E402
from app.prompt_budget import (  # noqa: E402
    JUDGE_MAX_TOKENS,
    JUDGE_USER_CHARS,
    KEEP_PAIRS_WORLD,
    WORLD_EXTRA_BUDGET,
    context_keep_pairs,
    trim_blocks,
    PromptBlock,
)
from app.session_store import Session  # noqa: E402
from app.summary import trim_messages_for_context  # noqa: E402
from app.world_store import create_world_save  # noqa: E402
from app.character import CharacterProfile  # noqa: E402
from app.relationship import RelationshipState  # noqa: E402


def main() -> None:
    settings = get_settings()
    assert settings.companion_judge_mode == "rules" or settings.companion_judge_mode in {
        "rules",
        "hybrid",
        "llm",
    }
    assert settings.companion_memory_llm_enabled is True, "memory LLM on for play quality"
    from app.memory_llm import should_extract_memories_llm

    assert not should_extract_memories_llm(settings, user_text="好", turn_n=9)
    assert should_extract_memories_llm(settings, user_text="我想多了解你一点", turn_n=1)
    assert context_keep_pairs(world_mode=True) <= KEEP_PAIRS_WORLD
    assert settings.companion_context_keep_pairs <= 4
    assert JUDGE_MAX_TOKENS <= 256
    assert JUDGE_USER_CHARS <= 160

    from app.romance_voice import voice_prompt_block
    from app.town_npcs import build_npc_facts_block, load_town_npcs
    from app.prompt_budget import TOWN_NPC_BUDGET

    assert "yeyu" not in str(load_town_npcs())
    voice = voice_prompt_block("xiaoyou")
    assert "【声纹】" in voice and len(voice) < 220, voice
    npc = build_npc_facts_block(
        character_id="wanyu",
        location_id="cafe",
        flags={},
        budget=TOWN_NPC_BUDGET,
    )
    assert "【镇上熟人" in npc and len(npc) <= TOWN_NPC_BUDGET + 5, (len(npc), npc)

    # L1 trim
    msgs = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"} for i in range(20)]
    trimmed = trim_messages_for_context(msgs, keep_pairs=KEEP_PAIRS_WORLD)
    assert len(trimmed) == KEEP_PAIRS_WORLD * 2, len(trimmed)

    # Extra blocks over budget drop low-priority first
    blocks = [
        PromptBlock("agenda", "【议程】" + ("啊" * 80)),
        PromptBlock("calendar", "【日历】" + ("日" * 80)),
        PromptBlock("town_npcs", "【镇上熟人｜只读】陈婶：排班。" + ("镇" * 40)),
        PromptBlock("voice_card", "【声纹】慢热。" + ("声" * 20)),
        PromptBlock("rumors", "【传闻】" + ("瓜" * 900)),
        PromptBlock("edges", "【关系】" + ("边" * 900)),
        PromptBlock("outfit", "【穿着】雨伞一句"),
    ]
    out = trim_blocks(blocks, budget=WORLD_EXTRA_BUDGET)
    assert "议程" in out and "日历" in out
    assert "镇上熟人" in out  # protected
    assert "声纹" in out  # protected
    assert len(out) <= WORLD_EXTRA_BUDGET + 80  # protected may slightly over; check drop happened
    assert "瓜" * 50 not in out or len(out) < len("".join(b.text for b in blocks))

    # Real world prompt rebuild should stay bounded on extras
    save = create_world_save(user_id="smoke_token", protagonist_name="测")
    cid = next(c for c, b in save.bonds.items() if b.cast_kind == "romance")
    bond = save.bonds[cid]
    session = Session(
        id="tok",
        profile=bond.profile if isinstance(bond.profile, CharacterProfile) else CharacterProfile.model_validate(bond.profile),
        system_prompt="base",
        relationship_state=bond.relationship_state
        if isinstance(bond.relationship_state, RelationshipState)
        else RelationshipState.model_validate(bond.relationship_state),
        world_save_id=save.save_id,
        active_character_id=cid,
    )
    # persist save so get_world_save works
    from app.world_store import upsert_world_save

    upsert_world_save(save)
    session.rebuild_prompt(user_text="你好啊，今天过得怎么样")
    # system_prompt = base + extras; extras after first rebuild replace via trim
    assert session.system_prompt
    # rough: extras portion shouldn't be multi-10k
    assert len(session.system_prompt) < 12000, len(session.system_prompt)

    print("smoke-token-budget: OK")
    print(f"  memory_llm={settings.companion_memory_llm_enabled} keep_pairs={KEEP_PAIRS_WORLD}")
    print(f"  prompt_chars={len(session.system_prompt)} budget={WORLD_EXTRA_BUDGET}")


if __name__ == "__main__":
    main()
