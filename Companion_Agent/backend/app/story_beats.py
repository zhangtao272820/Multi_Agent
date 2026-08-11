"""专属故事幕：结构化节拍、当前拍注入、幕摘要（控 Token）。

契约见 doc/故事与立绘拓展计划-剧本感与Token.md §4
与 doc/故事旁白与女主演绎升级计划.md §3
与 doc/galgame美德演绎升级计划.md §2。
"""

from __future__ import annotations

from typing import Any

from .event_engine import GameEvent, StoryBeat, StoryBeatPage

STORY_SUMMARY_MAX = 120
BEAT_SUMMARY_MAX = 80
BEAT_NARRATION_MAX = 120
BEAT_THOUGHT_MAX = 80
BEAT_PAGE_TEXT_MAX = 120


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


def story_uses_soft_options(event: GameEvent | None) -> bool:
    """有结构化 beats 的专属幕：系统 soft_options，不走 choice_effects 分支。"""
    return bool(event_beats(event))


def should_advance_beat(event: GameEvent | None, *, chose: bool) -> bool:
    """是否在本轮 after_turn 推进节拍。

    - on_player_turn（默认）：每玩家一轮推进
    - on_choice：仅点了系统选项才推进
    """
    if not event_beats(event):
        return False
    mode = (getattr(event, "advance", None) or "on_player_turn").strip().lower()
    if mode == "on_choice":
        return bool(chose)
    return True


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


def story_outfit_hints_for_beat(event: GameEvent | None, beat_index: int) -> list[str]:
    """当前拍 sprite_hint（供 resolve_outfit 强制换装）。"""
    if not is_story_event(event):
        return []
    beat = current_beat(event, beat_index)
    if not beat:
        return []
    return [str(x).strip() for x in (beat.sprite_hint or []) if str(x).strip()]


def _clip(text: str, limit: int) -> str:
    t = (text or "").strip()
    if len(t) <= limit:
        return t
    return t[: max(0, limit - 1)] + "…"


def beat_brief_text(beat: StoryBeat | None) -> str:
    """女主 prompt 用：brief 优先，回退 summary。"""
    if not beat:
        return ""
    return (beat.brief or beat.summary or beat.id or "").strip()


def beat_narration_text(beat: StoryBeat | None) -> str:
    """UI 旁白：narration 优先，回退 summary。"""
    if not beat:
        return ""
    return (beat.narration or beat.summary or "").strip()


def _page_sprite_dict(beat: StoryBeat | None, raw: dict[str, Any] | None = None) -> dict[str, str]:
    out: dict[str, str] = {}
    src = raw if isinstance(raw, dict) else {}
    outfit = str(src.get("outfit") or "").strip()
    emotion = str(src.get("emotion") or "").strip()
    if not outfit and beat and beat.sprite_hint:
        outfit = str(beat.sprite_hint[0] or "").strip()
    if outfit:
        out["outfit"] = outfit
    if emotion:
        out["emotion"] = emotion
    return out


def beat_vn_pages(beat: StoryBeat | None) -> list[dict[str, Any]]:
    """拍前 VN 页：优先手写 pages；否则由 narration + pc_thought 合成。"""
    if not beat:
        return []
    pages: list[dict[str, Any]] = []
    for raw in beat.pages or []:
        if isinstance(raw, StoryBeatPage):
            text = (raw.text or "").strip()
            voice = (raw.voice or "narration").strip().lower() or "narration"
            sprite = _page_sprite_dict(beat, raw.sprite)
            bg = (raw.bg or "").strip()
        elif isinstance(raw, dict):
            text = str(raw.get("text") or "").strip()
            voice = str(raw.get("voice") or "narration").strip().lower() or "narration"
            sprite = _page_sprite_dict(beat, raw.get("sprite") if isinstance(raw.get("sprite"), dict) else None)
            bg = str(raw.get("bg") or "").strip()
        else:
            continue
        if not text:
            continue
        if voice not in {"narration", "pc", "heroine"}:
            voice = "narration"
        item: dict[str, Any] = {"text": _clip(text, BEAT_PAGE_TEXT_MAX), "voice": voice}
        if sprite:
            item["sprite"] = sprite
        if bg:
            item["bg"] = bg
        pages.append(item)
    if pages:
        return pages
    narration = beat_narration_text(beat)
    thought = (beat.pc_thought or "").strip()
    hint_sprite = _page_sprite_dict(beat)
    if narration:
        item = {"text": _clip(narration, BEAT_PAGE_TEXT_MAX), "voice": "narration"}
        if hint_sprite:
            item["sprite"] = hint_sprite
        pages.append(item)
    if thought:
        item = {"text": _clip(thought, BEAT_THOUGHT_MAX), "voice": "pc"}
        if hint_sprite:
            item["sprite"] = hint_sprite
        pages.append(item)
    return pages


def beat_fact_piece(beat: StoryBeat | None, *, limit: int = 40) -> str:
    """幕滚动摘要用事实句：brief → narration → summary；不含男主思考。"""
    if not beat:
        return ""
    for raw in (beat.brief, beat.narration, beat.summary, beat.id):
        piece = _clip(raw or "", limit)
        if piece:
            return piece
    return ""


def format_story_snippet(
    event: GameEvent,
    *,
    beat_index: int = 0,
    act_summary: str = "",
) -> str:
    """只拼当前拍演职员简报；无 beats 时回退整段 prompt_snippet。

    不注入 narration / pc_thought（玩家叙事层，0 Token 给女主）。
    """
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

    brief = _clip(beat_brief_text(beat), BEAT_SUMMARY_MAX)
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
        f"当前节拍 {idx + 1}/{len(beats)}：{brief}\n"
        f"立绘气质参考：{hints}。"
        f"{opt_line}"
        f"{summary_block}\n"
        "只演**当前这一拍**；勿剧透后续节拍或结局名；关系阶段由系统判定。"
        "系统已提供软选项时不必再写【选项】行。"
    )


def append_act_summary(existing: str, beat: StoryBeat | None) -> str:
    if not beat:
        return _clip(existing, STORY_SUMMARY_MAX)
    piece = beat_fact_piece(beat, limit=40)
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
    brief = beat_brief_text(beat) if beat else ""
    narration = beat_narration_text(beat) if beat else ""
    thought = (beat.pc_thought or "").strip() if beat else ""
    pages = beat_vn_pages(beat) if beat and beat_index < len(beats) else []
    return {
        "event_id": event.id,
        "beat_index": beat_index,
        "beat_total": len(beats),
        "beat_id": beat.id if beat else "",
        "beat_summary": _clip(brief, BEAT_SUMMARY_MAX),
        "beat_brief": _clip(brief, BEAT_SUMMARY_MAX),
        "narration": _clip(narration, BEAT_NARRATION_MAX),
        "pc_thought": _clip(thought, BEAT_THOUGHT_MAX),
        "pages": pages,
        "soft_options": soft_options_for_beat(event, beat_index),
        "act_summary": _clip(act_summary, STORY_SUMMARY_MAX),
        "completed": beat_index >= len(beats),
    }
