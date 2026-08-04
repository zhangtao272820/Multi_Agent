"""流式流水线：ASR → RAG → 流式 LLM(+导演) → 分句 TTS → LiveTalking。"""

from __future__ import annotations

import base64
import logging
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

from . import (
    assets,
    bailian,
    avatar_image,
    director,
    livetalking_client,
    local_lipsync,
    product_rag,
    wan_s2v,
)
from .api_errors import format_dashscope_error
from .config import Settings

logger = logging.getLogger(__name__)

LOCAL_LIP_MODES = frozenset(
    {"local_ultralight", "local_wav2lip", "local_lipsync"}
)
S2V_LIP_MODES = frozenset({"cached_s2v", "wan_s2v"})
# 旧路径：整段生成 MP4（已不推荐）
ALL_DEFER_TTS_MODES = LOCAL_LIP_MODES | S2V_LIP_MODES
LIVETALKING_MODE = "livetalking"

EmitFn = Callable[[str, dict[str, Any]], None]


def _ws_payload(data: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in data.items() if not isinstance(v, (bytes, bytearray))}


class _DeltaThrottler:
    def __init__(self, emit: EmitFn, interval_ms: int) -> None:
        self._emit = emit
        self._interval = max(0.02, interval_ms / 1000.0)
        self._last = 0.0
        self._text = ""

    def push(self, delta: str, full: str) -> None:
        self._text = full
        now = time.monotonic()
        if now - self._last >= self._interval:
            self.flush()

    def flush(self) -> None:
        if not self._text:
            return
        self._emit("reply_delta", {"text": self._text})
        self._last = time.monotonic()


class _OrderedTts:
    """并行合成 TTS；可选同步喂给 LiveTalking。"""

    def __init__(
        self,
        settings: Settings,
        emit: EmitFn,
        workers: int,
        *,
        livetalking_session: str | int | None = None,
        feed_livetalking: bool = False,
    ) -> None:
        self._settings = settings
        self._emit = emit
        self._pool = ThreadPoolExecutor(max_workers=max(1, workers))
        self._futures: list[tuple[int, str, Future]] = []
        self._next_index = 0
        self._chunk_seq = 0
        self._lt_session = livetalking_session
        self._feed_lt = feed_livetalking and livetalking_session is not None

    def submit(self, index: int, sentence: str) -> None:
        fut = self._pool.submit(self._synth, sentence)
        self._futures.append((index, sentence, fut))

    def _synth(self, sentence: str) -> tuple[bytes, str]:
        return bailian.synthesize_tts_for_sentence(self._settings, text=sentence)

    def drain(self) -> None:
        self._futures.sort(key=lambda x: x[0])
        first = True
        for idx, sentence, fut in self._futures:
            if idx != self._next_index:
                logger.warning("TTS 顺序错位 idx=%s expect=%s", idx, self._next_index)
            try:
                raw, mime = fut.result()
            except Exception as ex:
                logger.warning("TTS 失败 [%s]: %s", sentence[:20], ex)
                self._next_index += 1
                continue
            self._emit(
                "tts_chunk",
                {
                    "index": self._chunk_seq,
                    "mime": mime,
                    "base64": base64.b64encode(raw).decode("ascii"),
                    "sentence": sentence,
                },
            )
            if self._feed_lt and self._lt_session is not None:
                try:
                    livetalking_client.speak_audio(
                        self._settings,
                        audio_bytes=raw,
                        audio_mime=mime,
                        session_id=self._lt_session,
                        interrupt=first,
                    )
                except Exception as ex:
                    logger.warning("LiveTalking humanaudio: %s", ex)
                    if first:
                        try:
                            livetalking_client.speak_echo(
                                self._settings,
                                text=sentence,
                                session_id=self._lt_session,
                                interrupt=True,
                            )
                        except Exception as ex2:
                            logger.warning("LiveTalking echo fallback: %s", ex2)
            first = False
            self._chunk_seq += 1
            self._next_index += 1
        self._futures.clear()

    def shutdown(self) -> None:
        self._pool.shutdown(wait=True)


def _transcribe(settings: Settings, initial: dict[str, Any]) -> dict[str, Any]:
    mode = initial.get("mode")
    if mode == "text":
        t = (initial.get("user_text") or "").strip()
        if not t:
            return {"error": "文本为空"}
        return {"transcript": t, "emotion": None}
    audio = initial.get("audio_bytes")
    if not audio:
        return {"error": "未收到音频数据"}
    mime = (initial.get("audio_mime") or "audio/webm").strip()
    r = bailian.transcribe_audio(settings, audio_bytes=audio, mime_type=mime)
    text = (r.get("text") or "").strip()
    if not text:
        return {"error": "语音识别结果为空，请重试或改用文本输入"}
    return {"transcript": text, "emotion": r.get("emotion")}


def _cache_expected(settings: Settings, user_text: str, reply_text: str) -> bool:
    ukey = assets.normalize_utterance(user_text)
    if not ukey:
        return False
    return assets.lookup_utterance(settings, user_text, reply_text=reply_text) is not None


def _system_prompt(settings: Settings) -> str:
    base = settings.system_prompt or ""
    return base + director.director_system_suffix(settings)


def _run_lip_sync_video(
    settings: Settings,
    *,
    user_text: str,
    full_reply: str,
    api_base: str,
    emit: EmitFn,
    pre_tts: tuple[bytes, str] | None = None,
    cache_expected: bool = False,
) -> None:
    """遗留路径：整段 MP4（local_* / wan_s2v），新项目请用 livetalking。"""
    lip_mode = (settings.lip_sync_mode or "").strip().lower()
    if lip_mode not in ALL_DEFER_TTS_MODES:
        return

    local_mode = lip_mode in LOCAL_LIP_MODES
    ukey = assets.normalize_utterance(user_text)
    hint = (
        "检测到相同问题缓存，正在加载对口型视频…"
        if cache_expected
        else (
            "【遗留】本地对口型生成中…"
            if local_mode
            else "【遗留】万相对口型生成中…"
        )
    )
    emit(
        "lip_sync",
        {
            "status": "generating",
            "cache_expected": cache_expected,
            "hint": hint,
            "local": local_mode,
            "deprecated": True,
        },
    )
    try:
        image_bytes = avatar_image.get_avatar_image_bytes(settings)
        uhit = (
            assets.lookup_utterance(settings, user_text, reply_text=full_reply)
            if ukey
            else None
        )
        if pre_tts:
            raw, mime = pre_tts
        elif uhit and uhit.get("audio_bytes"):
            raw = uhit["audio_bytes"]
            mime = str(uhit.get("audio_mime") or "audio/wav")
        else:
            raw, mime = bailian.synthesize_tts(settings, text=full_reply)

        if local_mode:
            result = local_lipsync.get_or_create_lip_sync_video(
                settings,
                image_bytes=image_bytes,
                audio_bytes=raw,
                audio_mime=mime,
                user_text=user_text,
                reply_text=full_reply,
                emit=emit,
            )
        else:
            result = wan_s2v.get_or_create_lip_sync_video(
                settings,
                image_bytes=image_bytes,
                audio_bytes=raw,
                audio_mime=mime,
                user_text=user_text,
                reply_text=full_reply,
            )
        cached_audio = result.get("tts_audio_bytes")
        if isinstance(cached_audio, (bytes, bytearray)) and len(cached_audio) > 0:
            raw = bytes(cached_audio)
            mime = str(result.get("tts_mime") or mime)
        play_path = result.get("play_path")
        if play_path:
            asset_id = str(result.get("asset_id") or "")
            av_payload: dict[str, Any] = {
                "url": f"{api_base}{play_path}",
                "cache_hit": bool(result.get("cache_hit")),
                "utterance_cache_hit": bool(result.get("utterance_cache_hit")),
                "asset_id": asset_id,
                "sync_mode": "embedded",
            }
            disk_audio = (
                assets.load_audio_cache(settings, asset_id) if asset_id else None
            )
            if disk_audio:
                av_payload["tts_mime"] = disk_audio[1]
                av_payload["tts_base64"] = base64.b64encode(disk_audio[0]).decode(
                    "ascii"
                )
            elif raw:
                av_payload["tts_mime"] = mime
                av_payload["tts_base64"] = base64.b64encode(raw).decode("ascii")
                av_payload["legacy_cache"] = True
                if asset_id:
                    assets.save_audio_cache(settings, asset_id, raw, mime)
            if av_payload.get("tts_base64"):
                av_payload["sync_mode"] = "dual"
            emit("avatar_video", av_payload)
        emit("lip_sync", _ws_payload({**result, "status": "done"}))
    except Exception as ex:
        logger.exception("lip_sync")
        emit(
            "lip_sync",
            {
                "mode": "client_rhythm" if local_mode else lip_mode,
                "status": "done",
                "fallback": True,
                "error": str(ex),
                "hint": f"对口型生成失败: {ex}",
            },
        )


def run_turn_stream(
    settings: Settings,
    initial: dict[str, Any],
    emit: EmitFn,
    *,
    api_base: str = "",
) -> None:
    try:
        tr = _transcribe(settings, initial)
    except Exception as ex:
        logger.exception("ASR")
        emit("error", {"message": f"ASR: {ex}"})
        return

    if tr.get("error"):
        emit("error", {"message": tr["error"]})
        return

    emit(
        "transcript",
        {"text": tr.get("transcript", ""), "emotion": tr.get("emotion")},
    )
    user_text = (tr.get("transcript") or "").strip()

    llm_user, rag_hits = product_rag.build_user_message(settings, user_text)
    if rag_hits:
        emit(
            "rag_hits",
            {
                "count": len(rag_hits),
                "paths": [h.get("path") for h in rag_hits],
                "scores": [h.get("score") for h in rag_hits],
            },
        )

    lip_mode = (settings.lip_sync_mode or "client_rhythm").strip().lower()
    defer_tts_for_s2v = lip_mode in ALL_DEFER_TTS_MODES
    use_livetalking = lip_mode == LIVETALKING_MODE
    lt_session = initial.get("livetalking_sessionid")
    if lt_session is not None and lt_session != "":
        try:
            lt_session = int(lt_session)
        except (TypeError, ValueError):
            lt_session = str(lt_session)
    else:
        lt_session = None

    emit("reply_start", {})
    throttler = _DeltaThrottler(emit, settings.stream_delta_throttle_ms)
    sys_prompt = _system_prompt(settings)
    # livetalking 时仍流式 TTS，并喂给 runtime；前端可静音本地 TTS 只听 WebRTC
    tts: _OrderedTts | None = None
    if settings.stream_tts and not defer_tts_for_s2v:
        tts = _OrderedTts(
            settings,
            emit,
            settings.tts_parallel_workers,
            livetalking_session=lt_session,
            feed_livetalking=use_livetalking and settings.livetalking_feed_audio,
        )

    full_reply = ""
    buf = ""
    got_first_tts = False
    tts_sentence_idx = 0
    # 流式时先不把 DIRECTOR 行送进 TTS：缓冲尾部直到完整
    speak_for_tts_done = False

    try:
        max_tokens = settings.llm_max_tokens
        if settings.director_enabled:
            max_tokens = max(max_tokens, 128)

        if settings.stream_llm:
            stream = bailian.chat_reply_stream(
                settings,
                user_text=llm_user,
                system_prompt=sys_prompt,
                max_tokens=max_tokens,
            )
        else:
            text = bailian.chat_reply(
                settings,
                user_text=llm_user,
                system_prompt=sys_prompt,
                max_tokens=max_tokens,
            )
            stream = [text] if text else []

        for delta in stream:
            if not settings.stream_llm:
                full_reply = delta
                throttler.push(delta, full_reply)
                break

            full_reply += delta
            buf += delta
            # 展示用：尽量隐藏未完成的 DIRECTOR 行
            display, _ = director.parse_director_block(full_reply)
            if "DIRECTOR:" in full_reply and not display:
                display = full_reply.split("DIRECTOR:")[0].strip()
            throttler.push(delta, display or full_reply)

            if not settings.stream_tts or not tts:
                continue

            # 若已出现 DIRECTOR 前缀，停止把后续导演 JSON 送入 TTS
            if "DIRECTOR:" in buf:
                before, _, after = buf.partition("DIRECTOR:")
                if before.strip():
                    tts.submit(tts_sentence_idx, before.strip())
                    tts_sentence_idx += 1
                buf = "DIRECTOR:" + after
                speak_for_tts_done = True
                continue
            if speak_for_tts_done:
                continue

            frags, buf, got_first_tts = bailian.pop_tts_fragments(
                buf,
                first_min_chars=settings.tts_first_chunk_chars,
                pause_min_chars=settings.tts_pause_min_chars,
                rest_min_chars=2,
                got_first=got_first_tts,
            )
            for sent in frags:
                tts.submit(tts_sentence_idx, sent)
                tts_sentence_idx += 1

        throttler.flush()

        if not full_reply.strip():
            emit("error", {"message": "模型未返回内容"})
            return

        speak_text, director_payload = director.parse_director_block(full_reply)
        emit("reply", {"text": speak_text or full_reply})
        if director_payload:
            emit("avatar_director", director_payload)
            if use_livetalking and lt_session is not None:
                applied = director.apply_director_to_avatar(
                    settings, director_payload, session_id=lt_session
                )
                emit("avatar_action", applied)

        if settings.stream_tts and tts:
            if not speak_for_tts_done:
                tail = buf.strip()
                if tail and not tail.startswith("DIRECTOR:"):
                    # 去掉可能混入的导演行
                    clean, _ = director.parse_director_block(tail)
                    if clean:
                        tts.submit(tts_sentence_idx, clean)
                        tts_sentence_idx += 1
            tts.drain()
            tts.shutdown()
        elif not settings.stream_tts:
            to_speak = speak_text or full_reply
            raw, mime = bailian.synthesize_tts(settings, text=to_speak)
            emit(
                "tts_audio",
                {
                    "mime": mime,
                    "base64": base64.b64encode(raw).decode("ascii"),
                },
            )
            if use_livetalking and lt_session is not None and settings.livetalking_feed_audio:
                try:
                    livetalking_client.speak_audio(
                        settings,
                        audio_bytes=raw,
                        audio_mime=mime,
                        session_id=lt_session,
                        interrupt=True,
                    )
                except Exception as ex:
                    logger.warning("LiveTalking humanaudio (full): %s", ex)

        if lip_mode == "client_rhythm":
            emit(
                "lip_sync",
                {
                    "mode": "client_rhythm",
                    "status": "done",
                    "streaming": True,
                    "hint": "流式对话；假口型随 TTS 播放",
                },
            )
        elif use_livetalking:
            emit(
                "lip_sync",
                {
                    "mode": LIVETALKING_MODE,
                    "status": "done",
                    "streaming": True,
                    "sessionid": lt_session,
                    "hint": (
                        "已推送至 LiveTalking（FeatherTalk 口型）"
                        if lt_session is not None
                        else "livetalking 模式但未提供 sessionid：请先连接 WebRTC"
                    ),
                    "webrtc_url": settings.livetalking_webrtc_url
                    or settings.livetalking_url,
                },
            )

        emit("stream_done", {"tts_sentences": tts_sentence_idx})

        if lip_mode in ALL_DEFER_TTS_MODES:
            cache_hit = _cache_expected(settings, user_text, speak_text or full_reply)
            pre_tts: tuple[bytes, str] | None = None
            if not cache_hit:
                pre_tts = bailian.synthesize_tts(
                    settings, text=speak_text or full_reply
                )
                emit(
                    "tts_while_waiting",
                    {
                        "mime": pre_tts[1],
                        "base64": base64.b64encode(pre_tts[0]).decode("ascii"),
                    },
                )
            _run_lip_sync_video(
                settings,
                user_text=user_text,
                full_reply=speak_text or full_reply,
                api_base=api_base,
                emit=emit,
                pre_tts=pre_tts,
                cache_expected=cache_hit,
            )

        emit("done", {})

    except Exception as ex:
        logger.exception("流式流水线")
        if tts:
            tts.shutdown()
        emit("error", {"message": format_dashscope_error(ex)})
