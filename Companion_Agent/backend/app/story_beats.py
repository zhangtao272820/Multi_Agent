"""专属故事幕：结构化节拍、当前拍注入、幕摘要（控 Token）。

契约见 doc/故事与立绘拓展计划-剧本感与Token.md §4。
"""

from __future__ import annotations

from typing import Any

from .event_engine import GameEvent, StoryBeat

STORY_SUMMARY_MAX = 120
BEAT_SUMMARY_MAX = 80


def is_story_event(event: GameEvent | None) -> bool:
    if not event:
        return False
    eid = (event.id or "").lower()
    if eid.startswith("story_"):
        return True
    return "【专属故事" in (event.prompt_snippet or "")


def event_beats(event: GameEvent | None) -> list[StoryBeat]:
    if not event:
        return []
    return list(event.beats or [])


def current_beat(event: GameEvent | None, beat_index: int) -> StoryBeat | None:
    beats = event_beats(event)
    if not beats:
        return None
    if beat_index < 0 or beat_index >= len(beats):
        return None
    return beats[beat_index]


def soft_options_for_beat(event: GameEvent | None, beat_index: int) -> list[str]:
    beat = current_beat(event, beat_index)
    if not beat:
        return []
    return [str(x).strip() for x in (beat.soft_options or []) if str(x).strip()][:4]


def _clip(text: str, limit: int) -> str:
    t = (text or "").strip()
    if len(t) <= limit:
        return t
    return t[: max(0, limit - 1)] + "…"


def format_story_snippet(
    event: GameEvent,
    *,
    beat_index: int = 0,
    act_summary: str = "",
) -> str:
    """只拼当前拍；无 beats 时回退整段 prompt_snippet。"""
    beats = event_beats(event)
    if not beats:
        return (event.prompt_snippet or "").strip()

    beat = current_beat(event, beat_index) or beats[0]
    idx = beat_index if current_beat(event, beat_index) else 0
    title_line = ""
    raw = (event.prompt_snippet or "").strip()
    if raw.startswith("【专属故事"):
        title_line = raw.split("\n", 1)[0].strip()
    else:
        title_line = f"【专属故事 · {event.label or event.id} · 节拍{idx + 1}/{len(beats)}】"

    summary = _clip(beat.summary or beat.id, BEAT_SUMMARY_MAX)
    hints = ", ".join(beat.sprite_hint or []) or "日常"
    opts = soft_options_for_beat(event, idx)
    opt_line = ""
    if opts:
        opt_line = f"\n系统软选项（可忽略，玩家可自由打字）：{' / '.join(opts)}"

    summary_block = ""
    clipped = _clip(act_summary, STORY_SUMMARY_MAX)
    if clipped:
        summary_block = f"\n本幕已发生（摘要）：{clipped}"

    return (
        f"{title_line}\n"
        f"当前节拍 {idx + 1}/{len(beats)}：{summary}\n"
        f"立绘气质参考：{hints}。"
        f"{opt_line}"
        f"{summary_block}\n"
        "只演**当前这一拍**；勿剧透后续节拍或结局名；关系阶段由系统判定。"
        "系统已提供软选项时不必再写【选项】行。"
    )


def append_act_summary(existing: str, beat: StoryBeat | None) -> str:
    if not beat:
        return _clip(existing, STORY_SUMMARY_MAX)
    piece = _clip(beat.summary or beat.id, 40)
    if not piece:
        return _clip(existing, STORY_SUMMARY_MAX)
    if not (existing or "").strip():
        return _clip(piece, STORY_SUMMARY_MAX)
    merged = f"{existing.strip()}；{piece}"
    return _clip(merged, STORY_SUMMARY_MAX)


def advance_beat_index(event: GameEvent | None, beat_index: int) -> tuple[int, bool]:
    """推进一拍。返回 (new_index, completed_all)。completed 表示本幕节拍已走完。"""
    beats = event_beats(event)
    if not beats:
        return 0, True
    nxt = int(beat_index) + 1
    if nxt >= len(beats):
        return len(beats), True
    return nxt, False


def public_story_progress(
    event: GameEvent | None,
    *,
    beat_index: int = 0,
    act_summary: str = "",
) -> dict[str, Any] | None:
    if not event or not event_beats(event):
        return None
    beats = event_beats(event)
    beat = current_beat(event, beat_index)
    return {
        "event_id": event.id,
        "beat_index": beat_index,
        "beat_total": len(beats),
        "beat_id": beat.id if beat else "",
        "soft_options": soft_options_for_beat(event, beat_index),
        "act_summary": _clip(act_summary, STORY_SUMMARY_MAX),
        "completed": beat_index >= len(beats),
    }
