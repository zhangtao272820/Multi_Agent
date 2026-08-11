"""LLM helpers + Judge / Character (schema JSON; no user-intent regex routing)."""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any

from pydantic import BaseModel, Field

from . import config
from .prompt_budget import (
    CHARACTER_MAX_TOKENS,
    ENDING_VERDICT_MAX_TOKENS,
    JUDGE_MAX_TOKENS,
    MINDS_MAX_TOKENS,
    assemble_character_context,
    clip,
)

logger = logging.getLogger(__name__)


class EndingVerdict(BaseModel):
    verdict: str = "soft"  # true|good|soft|bad
    with_you_ok: bool = False
    epilogue_line: str = ""
    judgment: str = ""


class JudgeResult(BaseModel):
    affinity_delta: float = 0.0
    stance_hint: str = "neutral"
    emotion: str = "neutral"
    want_meet: bool = False
    accept_date_tendency: float = 0.0
    memory_line: str | None = None
    reason: str = ""
    judgment: str = ""


class CharacterLine(BaseModel):
    line: str
    emotion: str = "neutral"
    thought: str = ""
    judgment: str = ""
    soft_options: list[str] = Field(default_factory=list)


class NpcMindItem(BaseModel):
    student_id: str
    mood: str = "neutral"
    thought: str = ""
    intent_type: str = "none"
    blurb: str = ""
    approach_pc: bool = False
    affinity_delta: float = 0.0
    event_take: str | None = None
    focus_id: str | None = None
    judgment: str = ""


class NpcMindsResult(BaseModel):
    minds: list[NpcMindItem] = Field(default_factory=list)


class DateDecision(BaseModel):
    accepted: bool = False
    reason: str = ""
    line: str = ""
    emotion: str = "neutral"


def _chat_completion(
    *,
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    temperature: float = 0.7,
) -> str | None:
    key = config.llm_api_key()
    if not key:
        return None
    url = config.llm_base_url().rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        return body["choices"][0]["message"]["content"]
    except (urllib.error.URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError) as e:
        logger.warning("llm_call_failed: %s", e)
        return None


def _extract_json(text: str) -> dict[str, Any] | None:
    t = (text or "").strip()
    if not t:
        return None
    if t.startswith("```"):
        parts = t.split("```")
        for p in parts:
            p = p.strip()
            if p.startswith("json"):
                p = p[4:].strip()
            if p.startswith("{"):
                t = p
                break
    try:
        start = t.find("{")
        end = t.rfind("}")
        if start < 0 or end <= start:
            return None
        return json.loads(t[start : end + 1])
    except json.JSONDecodeError:
        return None


def run_judge(
    *,
    user_text: str,
    context: str,
) -> JudgeResult | None:
    system = (
        "你是校园恋爱模拟的判定器。只输出 JSON，字段："
        "affinity_delta(-3..5), stance_hint, emotion(neutral|happy|shy|sad|angry),"
        "want_meet(bool), accept_date_tendency(0..1), memory_line(string|null), reason,"
        "judgment(同学内心一句话判断，可空)。"
        "根据双方关系与用户发言裁决数值，不要写台词。"
    )
    user = f"{context}\n\n玩家说：{clip(user_text, 400)}\n请输出 JSON。"
    raw = _chat_completion(
        model=config.aux_model(),
        system=system,
        user=user,
        max_tokens=JUDGE_MAX_TOKENS,
        temperature=0.2,
    )
    if not raw:
        return None
    data = _extract_json(raw)
    if not data:
        return None
    try:
        return JudgeResult.model_validate(data)
    except Exception:
        return None


def run_character(
    *,
    student: dict[str, Any],
    edge: dict[str, Any] | None,
    weather_id: str,
    period_label: str,
    location_name: str,
    seat_relation: str | None,
    recent_turns: list[dict[str, str]],
    active_event: dict[str, Any] | None,
    user_text: str,
    stance_hint: str,
    mind: dict[str, Any] | None = None,
) -> CharacterLine:
    context = assemble_character_context(
        student=student,
        edge=edge,
        weather_id=weather_id,
        period_label=period_label,
        location_name=location_name,
        seat_relation=seat_relation,
        recent_turns=recent_turns,
        active_event=active_event,
        mind=mind,
    )
    system = (
        "你在扮演中国高三同学，写实口语。只输出 JSON："
        '{"line":"台词","emotion":"neutral|happy|shy|sad|angry",'
        '"thought":"一句未说出口的内心","judgment":"对眼前局面的短判断",'
        '"soft_options":["可选提示1","可选提示2"]}'
        " soft_options 2条以内，可空数组。不要替玩家决定。情绪/内心要贴合人格与当前心情。"
    )
    user = f"{context}\n态度提示：{stance_hint}\n玩家说：{clip(user_text, 400)}"
    raw = _chat_completion(
        model=config.character_model(),
        system=system,
        user=user,
        max_tokens=CHARACTER_MAX_TOKENS,
        temperature=0.85,
    )
    if raw:
        data = _extract_json(raw)
        if data and data.get("line"):
            try:
                return CharacterLine.model_validate(data)
            except Exception:
                pass
    # LLM 不可用：模板台词（非意图路由）
    name = student.get("name", "同学")
    style = student.get("speech_style") or ""
    suffix = f"（{style}）" if style else ""
    mood = (mind or {}).get("mood") or "neutral"
    prev_thought = str((mind or {}).get("thought") or "")
    return CharacterLine(
        line=f"{name}看了你一眼。{suffix}「嗯……我在听。」",
        emotion=str(mood) if mood in {"neutral", "happy", "shy", "sad", "angry"} else "neutral",
        thought=prev_thought or "……先听听看。",
        judgment="还不确定你想说什么。",
        soft_options=["问问最近模考", "聊聊天气", "约周末一起"],
    )


def run_npc_minds(*, user_prompt: str) -> NpcMindsResult | None:
    system = (
        "你是校园模拟的 NPC 内心调度器。只输出 JSON："
        '{"minds":[{"student_id":"","mood":"neutral|happy|shy|sad|angry|anxious|excited",'
        '"thought":"短句内心","intent_type":"none|greet|pursuit|comfort|study_buddy|avoid",'
        '"blurb":"给玩家看的主动来信文案可空","approach_pc":false,'
        '"affinity_delta":0,"event_take":"对突发的一句态度或null",'
        '"focus_id":"关注对象id可为pc或其他同学或null","judgment":"短判断"}]}'
        "每人一条；affinity_delta 范围 -1..2；无突发时 event_take 为 null；"
        "只有真正想主动找玩家时 approach_pc=true 且 intent_type 非 none/avoid。"
    )
    raw = _chat_completion(
        model=config.aux_model(),
        system=system,
        user=user_prompt,
        max_tokens=MINDS_MAX_TOKENS,
        temperature=0.55,
    )
    if not raw:
        return None
    data = _extract_json(raw)
    if not data:
        return None
    try:
        return NpcMindsResult.model_validate(data)
    except Exception:
        return None


def run_date_decision(
    *,
    student: dict[str, Any],
    edge: dict[str, Any],
    weather_id: str,
    location_id: str,
    mind: dict[str, Any] | None,
) -> DateDecision | None:
    brief = clip(str(student.get("persona_brief") or student.get("model_prompt_zh") or ""), 200)
    mood = (mind or {}).get("mood") or "neutral"
    thought = (mind or {}).get("thought") or ""
    mbti = str(student.get("mbti") or "").strip()
    mbti_line = f"MBTI={mbti}（必须体现该类型决策与语气）\n" if mbti and mbti.lower() != "player" else ""
    system = (
        "你判定同学是否答应周末约会。只输出 JSON："
        '{"accepted":bool,"reason":"短理由","line":"口头回应一句","emotion":"neutral|happy|shy|sad|angry"}'
        "依据人格、MBTI、亲和、心情、天气；不要替玩家说话。"
    )
    user = (
        f"角色：{student.get('name')} {brief}\n"
        f"{mbti_line}"
        f"romance_stance={student.get('romance_stance')} speech={student.get('speech_style')}\n"
        f"affinity={edge.get('affinity')} stage={edge.get('stage')} track={edge.get('track')}\n"
        f"mood={mood} thought={thought}\n"
        f"weather={weather_id} 约会地点={location_id}\n"
        "请输出 JSON。"
    )
    raw = _chat_completion(
        model=config.aux_model(),
        system=system,
        user=user,
        max_tokens=220,
        temperature=0.35,
    )
    if not raw:
        return None
    data = _extract_json(raw)
    if not data:
        return None
    try:
        return DateDecision.model_validate(data)
    except Exception:
        return None


def run_ending_verdict(*, summary: str) -> EndingVerdict | None:
    """Short D-0 LLM: whether this counts as a good ending with the player."""
    system = (
        "你是高考百日校园模拟的终章裁决器。只输出 JSON："
        '{"verdict":"true|good|soft|bad","with_you_ok":bool,'
        '"epilogue_line":"≤80字中文，评价是否与玩家算好结局","judgment":"短判断"}'
        "true=成绩与感情双高；good=整体向好；soft=有遗憾但温柔；bad=疏离或双低。"
        "只依据给定摘要，不要编造摘要外的人名与分数。"
    )
    user = f"百日摘要：\n{clip(summary, 900)}\n请输出 JSON。"
    raw = _chat_completion(
        model=config.aux_model(),
        system=system,
        user=user,
        max_tokens=ENDING_VERDICT_MAX_TOKENS,
        temperature=0.25,
    )
    if not raw:
        return None
    data = _extract_json(raw)
    if not data:
        return None
    try:
        v = EndingVerdict.model_validate(data)
        if v.verdict not in {"true", "good", "soft", "bad"}:
            v.verdict = "soft"
        v.epilogue_line = clip(v.epilogue_line or "", 80)
        return v
    except Exception:
        return None
