"""阿里云百炼 / DashScope：ASR、流式 LLM、分句/流式 TTS。"""

from __future__ import annotations

import base64
import logging
import re
from collections.abc import Iterator
from typing import Any

import httpx
from openai import OpenAI

from .config import Settings, api_key

logger = logging.getLogger(__name__)

_SENTENCE_END = re.compile(r"[。！？!?；;…\n]")
_PAUSE = re.compile(r"[，,、；;：:]\n?")


def openai_client(settings: Settings) -> OpenAI:
    key = api_key(settings)
    if not key:
        raise RuntimeError("请设置环境变量 DASHSCOPE_API_KEY 或 OPENAI_API_KEY（百炼）")
    return OpenAI(api_key=key, base_url=settings.openai_base_url)


def transcribe_audio(
    settings: Settings,
    *,
    audio_bytes: bytes,
    mime_type: str,
    language: str | None = None,
) -> dict[str, Any]:
    client = openai_client(settings)
    b64 = base64.b64encode(audio_bytes).decode("ascii")
    data_uri = f"data:{mime_type};base64,{b64}"
    extra: dict[str, Any] = {"asr_options": {"enable_itn": True}}
    if language:
        extra["asr_options"]["language"] = language

    completion = client.chat.completions.create(
        model=settings.asr_model,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "input_audio", "input_audio": {"data": data_uri}},
                ],
            }
        ],
        stream=False,
        extra_body=extra,
    )
    text = (completion.choices[0].message.content or "").strip()
    emotion = None
    ann = getattr(completion.choices[0].message, "annotations", None) or []
    for a in ann:
        if isinstance(a, dict) and a.get("type") == "audio_info":
            emotion = a.get("emotion")
            break
    return {"text": text, "emotion": emotion}


def _chat_messages(
    settings: Settings,
    *,
    user_text: str,
    system_prompt: str | None = None,
) -> list[dict[str, str]]:
    sys = (system_prompt if system_prompt is not None else settings.system_prompt) or ""
    return [
        {"role": "system", "content": sys},
        {"role": "user", "content": user_text},
    ]


def chat_reply(
    settings: Settings,
    *,
    user_text: str,
    system_prompt: str | None = None,
    max_tokens: int | None = None,
) -> str:
    client = openai_client(settings)
    completion = client.chat.completions.create(
        model=settings.llm_model,
        messages=_chat_messages(
            settings, user_text=user_text, system_prompt=system_prompt
        ),
        temperature=settings.llm_temperature,
        max_tokens=max_tokens if max_tokens is not None else settings.llm_max_tokens,
    )
    return (completion.choices[0].message.content or "").strip()


def chat_reply_stream(
    settings: Settings,
    *,
    user_text: str,
    system_prompt: str | None = None,
    max_tokens: int | None = None,
) -> Iterator[str]:
    client = openai_client(settings)
    stream = client.chat.completions.create(
        model=settings.llm_model,
        messages=_chat_messages(
            settings, user_text=user_text, system_prompt=system_prompt
        ),
        temperature=settings.llm_temperature,
        max_tokens=max_tokens if max_tokens is not None else settings.llm_max_tokens,
        stream=True,
    )
    for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        part = getattr(delta, "content", None) if delta else None
        if part:
            yield part


def pop_complete_sentences(buffer: str, *, min_chars: int = 2) -> tuple[list[str], str]:
    sentences: list[str] = []
    while True:
        m = _SENTENCE_END.search(buffer)
        if not m:
            break
        end = m.end()
        sent = buffer[:end].strip()
        buffer = buffer[end:].lstrip()
        if sent and len(sent) >= min_chars:
            sentences.append(sent)
    return sentences, buffer


def pop_tts_fragments(
    buffer: str,
    *,
    first_min_chars: int,
    pause_min_chars: int,
    rest_min_chars: int,
    got_first: bool,
) -> tuple[list[str], str, bool]:
    """
    尽早切出可合成的片段：首段可在逗号处切开，后续按句号。
    """
    out: list[str] = []
    while buffer:
        if not got_first and len(buffer) >= first_min_chars:
            m = _PAUSE.search(buffer)
            if m and m.end() >= pause_min_chars:
                frag = buffer[: m.end()].strip()
                buffer = buffer[m.end() :].lstrip()
                if frag:
                    out.append(frag)
                    got_first = True
                continue

        sentences, buffer = pop_complete_sentences(buffer, min_chars=rest_min_chars)
        if not sentences:
            break
        out.extend(sentences)
        got_first = True
    return out, buffer, got_first


def synthesize_tts(settings: Settings, *, text: str) -> tuple[bytes, str]:
    from dashscope.audio.qwen_tts import SpeechSynthesizer as QwenSpeechSynthesizer

    from .text_speech import sanitize_for_speech

    spoken = sanitize_for_speech(text)
    if not spoken:
        raise ValueError("TTS 文本清洗后为空")

    key = api_key(settings)
    rsp = QwenSpeechSynthesizer.call(
        model=settings.tts_model,
        text=spoken,
        api_key=key,
        voice=settings.tts_voice,
    )
    if getattr(rsp, "status_code", 200) != 200:
        raise RuntimeError(getattr(rsp, "message", None) or str(rsp))

    out = getattr(rsp, "output", None)
    if out is None and isinstance(rsp, dict):
        out = rsp.get("output")

    if isinstance(out, dict):
        audio = out.get("audio") or {}
        if isinstance(audio, dict):
            url = audio.get("url")
            data_b64 = audio.get("data")
        else:
            url = getattr(audio, "url", None)
            data_b64 = getattr(audio, "data", None)
    else:
        audio_obj = getattr(out, "audio", None) if out is not None else None
        url = getattr(audio_obj, "url", None) if audio_obj else None
        data_b64 = getattr(audio_obj, "data", None) if audio_obj else None

    if data_b64:
        return base64.b64decode(data_b64), "audio/wav"

    if url:
        with httpx.Client(timeout=60.0) as h:
            r = h.get(str(url))
            r.raise_for_status()
            return r.content, r.headers.get("content-type", "audio/wav")

    raise RuntimeError("TTS 未返回音频 data 或 url")


def synthesize_tts_for_sentence(
    settings: Settings, *, text: str
) -> tuple[bytes, str]:
    """单句 TTS，返回单段音频。"""
    from .text_speech import sanitize_for_speech

    t = sanitize_for_speech(text)
    if not t:
        raise ValueError("empty")
    if settings.stream_tts_api:
        for raw, mime in synthesize_tts_stream_api(settings, text=t):
            return raw, mime
    return synthesize_tts(settings, text=t)


def synthesize_tts_stream_api(
    settings: Settings, *, text: str
) -> Iterator[tuple[bytes, str]]:
    key = api_key(settings)
    try:
        import dashscope
        from dashscope import MultiModalConversation

        response = MultiModalConversation.call(
            api_key=key,
            model=settings.tts_model,
            text=text,
            voice=settings.tts_voice,
            stream=True,
        )
        for chunk in response:
            out = getattr(chunk, "output", None)
            if out is None:
                continue
            audio = getattr(out, "audio", None)
            if audio is None and isinstance(out, dict):
                audio = out.get("audio")
            data_b64 = None
            if isinstance(audio, dict):
                data_b64 = audio.get("data")
            elif audio is not None:
                data_b64 = getattr(audio, "data", None)
            if data_b64:
                yield base64.b64decode(data_b64), "audio/wav"
        return
    except Exception as ex:
        logger.info("流式 TTS API 不可用，改用整段合成: %s", ex)

    yield synthesize_tts(settings, text=text)
