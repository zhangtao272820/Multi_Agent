"""Proactive NPC opening lines (template + optional Character LLM)."""

from __future__ import annotations

from typing import Any

from . import npc_minds
from .campus_store import CampusSave
from .config import llm_api_key
from .llm_chat import run_character
from .prompt_budget import clip


def _memory_hooks(edge: dict[str, Any] | None) -> list[str]:
    if not edge:
        return []
    mems = [str(m).strip() for m in (edge.get("memories") or []) if str(m).strip()]
    return mems[-2:]


def build_opening_line(
    *,
    save: CampusSave,
    target: dict[str, Any],
    edge: dict[str, Any],
    period_label: str,
    location_name: str,
    seat_relation: str | None,
    is_date: bool,
    active_event: dict[str, Any] | None,
) -> str | None:
    """Context-aware greeting when player opens talk. Prefer memory / intent / event."""
    if is_date:
        return None  # date scene sets opening elsewhere

    tid = str(target["id"])
    name = str(target.get("name") or tid)
    mind = npc_minds.mind_public(save, tid)
    mems = _memory_hooks(edge)
    intent = next(
        (i for i in (save.pending_intents or []) if str(i.get("from_id")) == tid),
        None,
    )

    # Template path (always available)
    bits: list[str] = []
    if intent and intent.get("blurb"):
        bits.append(str(intent["blurb"]).rstrip("。.!！") + "。")
    if active_event and str(active_event.get("talk_npc_id") or "") == tid:
        bits.append(f"对了，刚才那个「{active_event.get('label')}」……你也在想吧。")
    elif active_event and active_event.get("label"):
        bits.append(f"今天这事（{active_event.get('label')}）弄得人心神不宁。")
    if mems:
        bits.append(f"还记得吗——{clip(mems[-1], 48)}")
    elif mind and mind.get("thought"):
        bits.append(clip(str(mind["thought"]), 60))

    if not bits:
        stage = str(edge.get("stage") or "stranger")
        mood = (mind or {}).get("mood") or "neutral"
        greetings = {
            "stranger": f"……啊，{period_label}。你也在{location_name}？",
            "acquaintance": f"嗨，正好碰到你。{period_label}还好吗？",
            "friend": f"来得正好。刚才还在想你会不会路过{location_name}。",
            "close": f"等到你了。{period_label}……想跟你说两句。",
            "crush": f"……看到你，心跳有点乱。能聊一会儿吗？",
            "dating": f"终于找到你了。今天想和你待一会儿。",
        }
        line = greetings.get(stage, greetings["acquaintance"])
        if mood in {"shy", "sad", "anxious"}:
            line = "……" + line
        return line

    template = "".join(bits[:2])
    if len(template) < 8:
        template = f"{name}看了你一眼：「{template}」"

    # Optional LLM polish when key present
    if llm_api_key():
        from .prompt_budget import assemble_character_context

        ctx = assemble_character_context(
            student=target,
            edge=edge,
            weather_id=save.weather_id,
            period_label=period_label,
            location_name=location_name,
            seat_relation=seat_relation,
            recent_turns=[],
            active_event=active_event,
            mind=mind,
            verb="greet",
        )
        hint = (
            "请用一两句主动开口（你先找玩家），自然引用记忆或当前事件；"
            f"参考素材：{clip(template, 160)}。不要自我介绍姓名。"
        )
        line = run_character(
            student=target,
            edge=edge,
            weather_id=save.weather_id,
            period_label=period_label,
            location_name=location_name,
            seat_relation=seat_relation,
            recent_turns=[],
            active_event=active_event,
            user_text=hint,
            stance_hint="warm",
            mind=mind,
        )
        if line and line.line:
            return clip(line.line, 160)

    return clip(template, 160)


def consume_intent_for(save: CampusSave, target_id: str) -> None:
    save.pending_intents = [
        i for i in (save.pending_intents or []) if str(i.get("from_id")) != target_id
    ]
