"""Prompt token budget guards."""

from __future__ import annotations

from typing import Any

MAX_RECENT_TURNS = 8
MAX_MEMORIES_IN_PROMPT = 4
MAX_PERSONA_CHARS = 420
JUDGE_MAX_TOKENS = 256
CHARACTER_MAX_TOKENS = 320
ENDING_VERDICT_MAX_TOKENS = 180
MINDS_MAX_TOKENS = 480


def clip(text: str, n: int) -> str:
    t = (text or "").strip()
    if len(t) <= n:
        return t
    return t[: max(0, n - 1)] + "…"


def assemble_character_context(
    *,
    student: dict[str, Any],
    edge: dict[str, Any] | None,
    weather_id: str,
    period_label: str,
    location_name: str,
    seat_relation: str | None,
    recent_turns: list[dict[str, str]],
    active_event: dict[str, Any] | None,
    mind: dict[str, Any] | None = None,
    verb: str | None = None,
    scene: str | None = None,
) -> str:
    brief = clip(str(student.get("model_prompt_zh") or student.get("persona_brief") or ""), MAX_PERSONA_CHARS)
    mems = []
    if edge:
        for m in (edge.get("memories") or [])[-MAX_MEMORIES_IN_PROMPT:]:
            mems.append(str(m))
    turns = recent_turns[-MAX_RECENT_TURNS:]
    sid = str(student.get("id") or "")
    is_pc = bool(student.get("is_pc_slot")) or sid == "pc"
    mbti = str(student.get("mbti") or "").strip()
    lines = [
        f"角色：{student.get('name')}（{sid}）",
        brief,
        f"场景：{location_name} · {period_label} · 天气:{weather_id}",
        f"关系：affinity={edge.get('affinity') if edge else 0} stage={edge.get('stage') if edge else 'stranger'} track={edge.get('track') if edge else 'none'}",
    ]
    if not is_pc and mbti and mbti.lower() not in {"player", "none", ""}:
        lines.insert(1, f"MBTI={mbti}（必须体现该类型决策与语气）")
    if edge and edge.get("relation_display"):
        lines.append(f"校园关系标签：{edge.get('relation_display')}")
    role = str(student.get("class_role") or "").strip()
    if role:
        from . import relationship as rel

        lines.append(f"班干部职务：{rel.class_role_label(role)}")
    if scene == "date":
        lines.append("当前是两人约会短场景：语气更私密、自然，不要突然跑题到考试清单。")
    if verb:
        lines.append(f"互动类型：{verb}（寒暄/认真聊/纸条/约会等，按类型调节语气）")
    if mind:
        lines.append(
            f"当前心情：{mind.get('mood') or 'neutral'}；内心：{clip(str(mind.get('thought') or ''), 80)}"
        )
        if mind.get("event_take"):
            lines.append(f"对突发的态度：{clip(str(mind.get('event_take')), 60)}")
    if seat_relation:
        lines.append(f"座位关系标签：{seat_relation}")
    if active_event:
        lines.append(f"当前事件：{active_event.get('label')} — {active_event.get('blurb')}")
    if mems:
        lines.append("记忆：" + "；".join(mems))
    if turns:
        lines.append("近期对话：")
        for t in turns:
            lines.append(f"  {t.get('role')}: {clip(t.get('text', ''), 120)}")
    return "\n".join(lines)
