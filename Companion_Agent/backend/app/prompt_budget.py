"""P5：无向量三层记忆的 prompt 字符预算（控 token）。"""

from __future__ import annotations

from dataclasses import dataclass


# L1 短期：世界模式默认保留轮数（user+assistant 各算一轮）
KEEP_PAIRS_WORLD = 4
KEEP_PAIRS_LEGACY = 6

# L2 中期摘要上限
SUMMARY_MAX_CHARS = 180

# L3 长期事实进 prompt 条数
MEMORY_IN_PROMPT = 6
MEMORY_STORE_MAX = 24

# 世界模式额外注入块总预算（不含人设本体）
WORLD_EXTRA_BUDGET = 1400

# Judge 辅模型：短 JSON，硬控输出 token；输入截断控上下文
JUDGE_MAX_TOKENS = 240
JUDGE_USER_CHARS = 120
JUDGE_ASSISTANT_CHARS = 160
JUDGE_NOTE_CHARS = 28

# 各块优先级：数字越小越先保留；裁剪时从大到小删
BLOCK_PRIORITY = {
    "agenda": 10,
    "world_facts": 15,
    "story_beat": 12,
    "calendar": 20,
    "pc_status": 30,
    "pc_day": 32,
    "identity": 40,
    "romance_policy": 42,
    "situation": 45,
    "weather": 48,
    "soft_cold": 46,
    "outfit": 49,
    "errand": 47,
    "life_brief": 50,
    "summary_hook": 55,  # 摘要在 memory_prompt_block 里
    "diary": 60,
    "week_review": 65,
    "cross_impression": 70,
    "fatigue": 75,
    "romance_anchor": 80,
    "appointment": 85,
    "copresence": 90,
    "rumors": 95,
    "edges": 100,
    "prefs": 105,
    "boundary": 110,
    "offscreen": 115,
    "free_play": 120,
}


@dataclass
class PromptBlock:
    key: str
    text: str

    @property
    def priority(self) -> int:
        return int(BLOCK_PRIORITY.get(self.key, 200))


def trim_blocks(blocks: list[PromptBlock], *, budget: int = WORLD_EXTRA_BUDGET) -> str:
    """按优先级保留块，超预算时先丢掉低优先级块。永不丢 agenda/world_facts/calendar。"""
    protected = {
        "agenda",
        "world_facts",
        "story_beat",
        "calendar",
        "pc_status",
        "pc_day",
        "identity",
        "romance_policy",
        "life_brief",
        "free_play",
    }
    kept = [b for b in blocks if (b.text or "").strip()]
    total = sum(len(b.text) for b in kept)
    if total <= budget:
        return "".join(b.text for b in kept)

    # 可裁剪：按 priority 降序（先砍高数字）
    droppable = sorted(
        [b for b in kept if b.key not in protected],
        key=lambda b: (-b.priority, -len(b.text)),
    )
    drop_keys: set[str] = set()
    for b in droppable:
        if total <= budget:
            break
        drop_keys.add(b.key)
        total -= len(b.text)
    return "".join(b.text for b in kept if b.key not in drop_keys)


def context_keep_pairs(*, world_mode: bool) -> int:
    return KEEP_PAIRS_WORLD if world_mode else KEEP_PAIRS_LEGACY
