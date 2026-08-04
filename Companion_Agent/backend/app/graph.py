"""LangGraph：prepare → event_check → llm → parse → grow → memory → tts → persist。"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from .character import CharacterProfile
from .config import Settings, api_key
from .emotions import parse_character_reply
from .game_judge import judge_turn
from .qwen_character import build_messages, chat_stream
from .session_store import Session, store
from .tts_cache import should_synthesize_tts, synthesize_cached
from .voice_profile import resolve_voice

logger = logging.getLogger(__name__)


class TurnState(TypedDict, total=False):
    session_id: str
    user_text: str
    choice_index: int | None
    profile: dict[str, Any]
    messages: list[dict[str, str]]
    system_prompt: str
    reply_raw: str
    parsed: dict[str, Any]
    tts_audio_b64: str
    tts_mime: str
    tts_voice: str
    tts_source: str
    tts_error: str
    relationship_update: dict[str, Any]
    event_info: dict[str, Any]
    scene_info: dict[str, Any]
    error: str | None


def _prepare(state: TurnState) -> dict[str, Any]:
    if state.get("error"):
        return {}
    sid = state.get("session_id") or ""
    text = (state.get("user_text") or "").strip()
    if not text:
        return {"error": "消息为空"}
    session = store.get(sid)
    if not session:
        return {"error": "会话不存在，请先创建角色"}
    session.messages.append({"role": "user", "content": text})
    prepared = store.prepare_turn(sid, text)
    if not prepared:
        session.messages.pop()
        return {"error": "会话准备失败"}
    if prepared.get("error"):
        session.messages.pop()
        return {"error": str(prepared["error"])}
    return {
        "messages": prepared["messages"],
        "system_prompt": prepared["system_prompt"],
        "profile": session.profile.model_dump(),
        "event_info": prepared.get("event"),
        "scene_info": prepared.get("scene") or {},
    }


def _llm(state: TurnState, *, settings: Settings, on_delta: Callable[[str, str], None] | None) -> dict[str, Any]:
    if state.get("error"):
        return {}
    try:
        msgs = build_messages(state.get("messages") or [], state.get("system_prompt") or "")
        reply = chat_stream(settings, messages=msgs, on_delta=on_delta)
        sid = state.get("session_id") or ""
        session = store.get(sid)
        if session:
            session.messages.append({"role": "assistant", "content": reply})
        return {"reply_raw": reply}
    except Exception as ex:
        logger.exception("LLM failed")
        return {"error": str(ex)}


def _parse(state: TurnState) -> dict[str, Any]:
    if state.get("error"):
        return {}
    raw = state.get("reply_raw") or ""
    parsed = parse_character_reply(raw)
    sid = state.get("session_id") or ""
    session = store.get(sid)
    day_mood: int | None = None
    if session and session.world_save_id:
        from .emotions import apply_mood_arc_to_avatar
        from .world_store import get_world_save

        world = get_world_save(session.world_save_id)
        if world:
            bond = world.bonds.get(session.profile.character_id or "")
            if bond and bond.living.day_mood_day == world.calendar.day_index:
                day_mood = bond.living.day_mood_base
        parsed = apply_mood_arc_to_avatar(parsed, day_mood_base=day_mood)
    if session and session.ensemble and session.ensemble.get("enabled"):
        from .ensemble import apply_speaker_to_parsed

        parsed, ens = apply_speaker_to_parsed(parsed, ens=session.ensemble)
        if ens:
            session.ensemble = ens.model_dump()
    return {"parsed": parsed}


def _grow(state: TurnState, *, settings: Settings) -> dict[str, Any]:
    if state.get("error"):
        return {}
    sid = state.get("session_id") or ""
    user_text = state.get("user_text") or ""
    reply = state.get("reply_raw") or ""
    parsed = state.get("parsed") or {}
    choice_index = state.get("choice_index")

    session = store.get(sid)
    if not session:
        return {}

    agenda_goal = ""
    agenda_source = ""
    if getattr(session, "scene_agenda", None):
        agenda_goal = str(session.scene_agenda.get("goal") or "")
        agenda_source = str(session.scene_agenda.get("source") or "")

    fatigue = 0
    cold_war = False
    if session.world_save_id:
        from .world_store import get_world_save

        world = get_world_save(session.world_save_id)
        if world:
            cid = session.profile.character_id or session.active_character_id
            bond = world.bonds.get(cid)
            if bond:
                fatigue = int(bond.living.fatigue or 0)
                cold_war = bool((bond.relationship_state.flags or {}).get("cold_war_active"))

    from .scene_run import build_judge_scene_ctx

    scene_ctx = build_judge_scene_ctx(
        session.scene_run,
        fatigue=fatigue,
        cold_war=cold_war,
        agenda_source=agenda_source,
        character_id=session.profile.character_id or session.active_character_id,
    )
    verdict = judge_turn(
        settings,
        user_text=user_text,
        assistant_text=reply,
        state=session.relationship_state,
        profile=session.profile,
        mode=settings.companion_judge_mode,
        agenda_goal=agenda_goal,
        scene_ctx=scene_ctx,
    )
    update = store.after_turn(
        sid,
        user_text=user_text,
        assistant_text=reply,
        judge=verdict,
        choice_index=choice_index,
        parsed_choices=parsed.get("choices") or [],
    )
    if not update:
        return {}
    session = store.get(sid)
    out: dict[str, Any] = {"relationship_update": update}
    if session:
        out["profile"] = session.profile.model_dump()
    if state.get("event_info"):
        rel = out.setdefault("relationship_update", {})
        rel["event"] = state["event_info"]
        # 开幕当轮：若 after_turn 尚未带上换装，补当前拍立绘
        if not rel.get("sprite_outfit") and session:
            rel["sprite_outfit"] = session.resolve_sprite_outfit()
    return out


def _memory(state: TurnState) -> dict[str, Any]:
    return {}


def _tts(state: TurnState, *, settings: Settings) -> dict[str, Any]:
    if state.get("error"):
        return {}

    profile_data = state.get("profile") or {}
    parsed = state.get("parsed") or {}
    rel_update = state.get("relationship_update") or {}
    spoken = str(parsed.get("spoken") or state.get("reply_raw") or "").strip()
    if not spoken:
        return {}

    profile = CharacterProfile.model_validate(profile_data)
    voice = resolve_voice(profile)
    stage_changed = bool(rel_update.get("stage_changed"))
    ending_id = rel_update.get("ending_id")
    if not should_synthesize_tts(
        settings,
        spoken=spoken,
        voice=voice,
        stage_changed=stage_changed,
        ending_id=str(ending_id) if ending_id else None,
        event_fired=bool(rel_update.get("event")),
        event_applied=bool(rel_update.get("event_applied")),
        quest_completed=bool(rel_update.get("quest_completed")),
    ):
        if getattr(settings, "companion_tts_fallback", "none") == "browser":
            return {"tts_browser_text": spoken, "tts_voice": voice}
        return {}

    fallback = getattr(settings, "companion_tts_fallback", "none")
    if fallback == "browser":
        return {"tts_browser_text": spoken, "tts_voice": voice}

    try:
        import base64
        from .tts_instruct import instructions_from_turn

        instr = instructions_from_turn(
            parsed=parsed,
            profile=profile,
            relationship_update=rel_update,
        )
        raw, mime, source = synthesize_cached(
            settings, text=spoken, voice=voice, instructions=instr
        )
        b64 = base64.b64encode(raw).decode("ascii")
        return {
            "tts_audio_b64": b64,
            "tts_mime": mime,
            "tts_voice": voice,
            "tts_source": source,
            "tts_instructions": instr,
        }
    except Exception as ex:
        logger.warning("TTS skipped: %s", ex)
        if fallback == "browser":
            profile = CharacterProfile.model_validate(profile_data)
            return {"tts_browser_text": spoken, "tts_voice": resolve_voice(profile)}
        return {"tts_error": str(ex)}


def _persist(state: TurnState) -> dict[str, Any]:
    if state.get("error"):
        return {}
    sid = state.get("session_id") or ""
    session = store.get(sid)
    if session:
        store._persist(session)
    return {}


def build_turn_graph(settings: Settings, on_delta: Callable[[str, str], None] | None = None):
    if not api_key(settings):
        raise RuntimeError("缺少 API Key")

    def prepare(s: TurnState) -> dict[str, Any]:
        return _prepare(s)

    def llm(s: TurnState) -> dict[str, Any]:
        return _llm(s, settings=settings, on_delta=on_delta)

    def parse(s: TurnState) -> dict[str, Any]:
        return _parse(s)

    def grow(s: TurnState) -> dict[str, Any]:
        return _grow(s, settings=settings)

    def memory(s: TurnState) -> dict[str, Any]:
        return _memory(s)

    def persist(s: TurnState) -> dict[str, Any]:
        return _persist(s)

    g = StateGraph(TurnState)
    g.add_node("prepare", prepare)
    g.add_node("llm", llm)
    g.add_node("parse", parse)
    g.add_node("grow", grow)
    g.add_node("memory", memory)
    g.add_node("persist", persist)
    g.set_entry_point("prepare")
    g.add_edge("prepare", "llm")
    g.add_edge("llm", "parse")
    g.add_edge("parse", "grow")
    g.add_edge("grow", "memory")
    g.add_edge("memory", "persist")
    g.add_edge("persist", END)
    return g.compile()


def run_chat_turn(
    settings: Settings,
    *,
    session_id: str,
    user_text: str,
    choice_index: int | None = None,
    on_delta: Callable[[str, str], None] | None = None,
) -> TurnState:
    """跑完对话主路径（不含 TTS）。TTS 由调用方在推送 reply 后异步合成。"""
    graph = build_turn_graph(settings, on_delta=on_delta)
    out = graph.invoke({
        "session_id": session_id,
        "user_text": user_text,
        "choice_index": choice_index,
    })
    return out  # type: ignore[return-value]


def synthesize_turn_tts(settings: Settings, state: TurnState) -> dict[str, Any]:
    """在 reply 已推送后合成语音，避免阻塞对话框。"""
    return _tts(state, settings=settings)


def synthesize_greeting_tts(settings: Settings, profile: CharacterProfile, greeting: str) -> dict[str, str]:
    if not settings.companion_tts_enabled:
        return {}
    parsed = parse_character_reply(greeting)
    spoken = parsed.get("spoken") or greeting
    if not should_synthesize_tts(settings, spoken=str(spoken), is_opening=True):
        if getattr(settings, "companion_tts_fallback", "none") == "browser":
            return {"tts_browser_text": str(spoken), "tts_voice": resolve_voice(profile)}
        return {}
    fallback = getattr(settings, "companion_tts_fallback", "none")
    if fallback == "browser":
        return {"tts_browser_text": str(spoken), "tts_voice": resolve_voice(profile)}
    try:
        import base64

        from .tts_instruct import instructions_from_turn

        voice = resolve_voice(profile)
        instr = instructions_from_turn(parsed=parsed, profile=profile)
        raw, mime, source = synthesize_cached(
            settings, text=str(spoken), voice=voice, instructions=instr
        )
        return {
            "tts_audio_b64": base64.b64encode(raw).decode("ascii"),
            "tts_mime": mime,
            "tts_voice": voice,
            "tts_source": source,
        }
    except Exception as ex:
        logger.warning("greeting TTS failed: %s", ex)
        if fallback == "browser":
            return {"tts_browser_text": str(spoken), "tts_voice": resolve_voice(profile)}
        return {"tts_error": str(ex)}


def create_session(
    profile: CharacterProfile,
    *,
    base_id: str = "",
    save_id: str | None = None,
    user_id: str = "default",
) -> Session:
    return store.create(profile, base_id=base_id, save_id=save_id, user_id=user_id)
