import asyncio
import json
import logging
import queue
import threading
import mimetypes
import re
import shutil
import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect

from .httpx_compat import async_client as httpx_async_client
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings, resolve_proj_path
from .intent_enrich import compose_seed_for_attempt
from .agent_result import finalize_music_ws_done
from .trace_log import append_agent_trace_log
from .browser_auth import ClawhiveBrowserAuthMiddleware, install_auth_config_route, auth_from_websocket, ClawhiveAuthError
from .export_score import export_notation
from .llm import (
    annotate_lyrics_language,
    infer_listening_captions,
    infer_poetic_lyrics_with_song_context,
    infer_playback_omni_timeline,
    infer_playback_visual_intent,
    stream_listening_captions_events,
    judge_composition,
    parse_music_intent,
    patch_intent_from_judge,
    refine_music_intent,
    transcribe_audio_lyrics,
)
from .music_orchestrator import build_remix_plan, infer_style_profile, patch_remix_plan_with_judge
from .music_theory import (
    analyze_midi_file,
    export_abc_from_midi,
    harmonize_midi_file,
    theory_catalog,
)
from .remix_intent import (
    parse_remix_intent,
    parse_remix_intent_from_selection,
    patch_remix_plan_from_judge,
)
from .remix_presets import (
    REMIX_STYLE_PRESETS,
    band_parts_to_track_mappings,
    build_band_parts,
    infer_style_hint,
    list_remix_presets_payload,
    selection_brief,
    style_label,
)
from .remix_pipeline import run_remix_stages, technical_summary_for_remix
from .remix_instrumental import apply_instrumental_remix_plan, is_instrumental_audio
from .remix_timbral import apply_timbral_remix_defaults
from .remix_vocal_pop import apply_vocal_pop_plan, is_vocal_pop_analysis
from .midi_engine import compose_midi
from .midi_analyze import build_track_mappings_from_roles, enrich_analysis_with_midi
from .midi_render import render_midi_to_wav, resolve_soundfont_sf2, wav_to_mp3
from .music_job_queue import enqueue_music_job, read_job
from .music21_validate import validate_and_repair
from .neural_audio import (
    build_neural_prompt,
    generate_neural_wav,
    neural_status,
    resolve_compose_backend,
    should_use_neural_generation,
    warmup_neural_model,
)
from .demucs_stems import demucs_available, separate_stems_demucs
from .soundfont_upstream import resolve_soundfont_base


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    try:
        await resolve_soundfont_base()
    except Exception:
        logger.exception("SoundFont 启动探测失败，将在首次试听时重试")
    if getattr(settings, "neural_preload", True) and getattr(settings, "neural_music_enabled", False) and resolve_compose_backend(settings) == "neural":
        try:
            info = await asyncio.to_thread(warmup_neural_model, settings)
            logger.info("MusicGen 预加载: %s", info)
        except Exception:
            logger.exception("MusicGen 预加载失败")
    yield


app = FastAPI(title="Music Agent API", version="0.3.0", lifespan=_lifespan)
settings = get_settings()

MEDIA_ROOT = resolve_proj_path(".data/music/uploads")
MEDIA_ROOT.mkdir(parents=True, exist_ok=True)

_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["http://localhost:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(ClawhiveBrowserAuthMiddleware, extra_public=("/api/probe",))
install_auth_config_route(app)

out_dir = resolve_proj_path(settings.output_dir)
out_dir.mkdir(parents=True, exist_ok=True)


@dataclass
class ComposeSessionRecord:
    """文本创作会话：支持增量修订 intent。"""
    created: float
    original_prompt: str
    last_intent: dict[str, Any]


_COMPOSE_SESSIONS: dict[str, ComposeSessionRecord] = {}


def _prune_compose_sessions() -> None:
    ttl = max(60, int(getattr(settings, "compose_session_ttl_seconds", 86400)))
    cap = max(16, int(getattr(settings, "compose_session_max_entries", 500)))
    now = time.time()
    dead = [k for k, rec in _COMPOSE_SESSIONS.items() if now - rec.created > ttl]
    for k in dead:
        del _COMPOSE_SESSIONS[k]
    while len(_COMPOSE_SESSIONS) > cap:
        oldest = min(_COMPOSE_SESSIONS.items(), key=lambda kv: kv[1].created)[0]
        del _COMPOSE_SESSIONS[oldest]


def _form_bool_loose(v: str) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _payload_truthy(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    return _form_bool_loose(str(v or ""))


_MEDIA = {
    ".wav": "audio/wav",
    ".mid": "audio/midi",
    ".midi": "audio/midi",
    ".musicxml": "application/vnd.recordare.musicxml+xml",
    ".mxl": "application/vnd.recordare.musicxml+xml",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".abc": "text/vnd.abc",
    ".json": "application/json; charset=utf-8",
}


def _safe_soundfont_subpath(path: str) -> str:
    p = path.replace("\\", "/").strip().lstrip("/")
    if not p or ".." in p.split("/"):
        raise HTTPException(400, "invalid soundfont path")
    return p


def _media_for_soundfont(path: str) -> str:
    pl = path.lower()
    if pl.endswith(".json"):
        return "application/json; charset=utf-8"
    if pl.endswith(".mp3"):
        return "audio/mpeg"
    return "application/octet-stream"


def _safe_upload_subdir(name: str) -> str:
    safe = Path(name).name.strip()
    if not safe:
        raise HTTPException(400, "invalid upload name")
    return safe


def _audio_mime(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or _MEDIA.get(path.suffix.lower(), "application/octet-stream")


def _upload_basename_from_source_url(source_url: str) -> str:
    """从 `/api/music/uploads/xxx` 或完整 URL 解析上传文件名。"""
    s = (source_url or "").strip()
    if not s:
        raise HTTPException(400, "source_url 不能为空")
    if "://" in s:
        path = urlparse(s).path
        name = unquote(Path(path).name)
    else:
        name = Path(s.replace("\\", "/")).name
    if not name or name in (".", ".."):
        raise HTTPException(400, "无法从 source_url 解析文件名")
    return name


def _ffprobe_duration_seconds(path: Path) -> float | None:
    """用 ffprobe 读音频时长（秒）；失败返回 None。"""
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=90,
        )
        if r.returncode != 0:
            return None
        v = float(r.stdout.strip())
        return v if v > 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def _trim_audio_to_seconds(
    src: Path,
    dest: Path,
    target_seconds: float,
    *,
    ffmpeg_bin: str = "ffmpeg",
) -> bool:
    """将音频裁到目标时长（仅当源文件更长时）。"""
    if target_seconds <= 0 or not src.is_file():
        return False
    ff = shutil.which(ffmpeg_bin.strip() or "ffmpeg") or ffmpeg_bin
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(
            [
                ff,
                "-y",
                "-i",
                str(src),
                "-t",
                f"{float(target_seconds):.3f}",
                "-c:a",
                "pcm_s16le" if dest.suffix.lower() == ".wav" else "copy",
                str(dest),
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        return r.returncode == 0 and dest.is_file() and dest.stat().st_size > 2000
    except (OSError, subprocess.TimeoutExpired):
        return False


def _music21_upload_midi_hint(path: Path) -> str:
    """为质检拼接可读摘要（失败时不阻断）。"""
    try:
        from music21 import converter

        score = converter.parse(str(path))
        parts = list(score.parts) if getattr(score, "parts", None) else []
        n_parts = len(parts) if parts else 1
        ql = float(score.duration.quarterLength or 0)
        try:
            k = score.analyze("key")
            key_line = f"{k.tonic.name} {k.mode}"
        except Exception:
            key_line = "未知"
        return f"music21：估计调性 {key_line}；声部数 {n_parts}；总时值约 {ql:.0f} 四分音符"
    except Exception as ex:
        return f"music21 摘要不可用：{ex}"


_VOCAL_NAME_KEYS = (
    "vocal",
    "song",
    "lyric",
    "lyrics",
    "sing",
    "chorus",
    "verse",
    "voice",
    "人声",
    "歌曲",
)
_INST_NAME_KEYS = (
    "inst",
    "instrumental",
    "backing",
    "karaoke",
    "minus",
    "伴奏",
    "纯音乐",
    "器乐",
    "无人声",
    "off-vocal",
    "offvocal",
    "bgm",
    "piano",
    "钢琴",
    "配乐",
    "背景",
    "氛围",
    "轻音乐",
    "原声",
    "soundtrack",
    "ambient",
)
_SONG_WHISPER_LANGS = frozenset(
    {
        "ja",
        "japanese",
        "zh",
        "zh-cn",
        "chinese",
        "cmn",
        "ko",
        "korean",
        "yue",
        "en",
        "english",
    }
)
_CJK_IN_NAME_RE = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")


def _upload_display_stem(filename: str) -> str:
    """去掉 uuid 前缀，保留用户可见曲名片段。"""
    stem = Path(filename).stem
    if re.match(r"^[a-f0-9]{12}_", stem, re.I):
        return stem[13:]
    return stem


def _filename_suggests_instrumental(filename: str) -> bool:
    low = filename.lower()
    return any(k in low for k in _INST_NAME_KEYS)


def _filename_suggests_vocal_song(filename: str) -> bool:
    if _filename_suggests_instrumental(filename):
        return False
    low = filename.lower()
    if any(k in low for k in _VOCAL_NAME_KEYS):
        return True
    if re.search(r"m[0-9]{5,}", low):
        return True
    # 中文曲名不再默认当人声歌；须文件名含明确人声关键词，或后续歌词转写确认
    return False


def _segments_to_lyrics_text(segments: Any) -> str:
    if not isinstance(segments, list):
        return ""
    parts: list[str] = []
    for s in segments:
        if isinstance(s, dict):
            t = str(s.get("text") or "").strip()
        else:
            t = str(getattr(s, "text", "") or "").strip()
        if t:
            parts.append(t)
    return "\n".join(parts).strip()


def _refine_upload_vocal_flags(
    analysis: dict[str, Any],
    src: Path,
    tx: dict[str, Any] | None = None,
) -> bool:
    """
    校正 has_vocal：转写为空 ≠ 无人声。返回 analysis 是否被修改。
    """
    if analysis.get("analysis_mode") != "audio":
        return False

    before = (analysis.get("has_vocal"), analysis.get("vocal_label"), analysis.get("lyrics_text"))

    if _filename_suggests_instrumental(src.name):
        analysis["has_vocal"] = False
        analysis["vocal_label"] = "instrumental"
        return (analysis.get("has_vocal"), analysis.get("vocal_label"), analysis.get("lyrics_text")) != before

    tx = tx or {}
    segs = analysis.get("lyrics_timeline")
    if not isinstance(segs, list) or not segs:
        raw_segs = tx.get("segments")
        if isinstance(raw_segs, list):
            segs = raw_segs

    lyrics = str(analysis.get("lyrics_text") or tx.get("text") or "").strip()
    if not lyrics:
        lyrics = _segments_to_lyrics_text(segs)
        if lyrics:
            analysis["lyrics_text"] = lyrics
            if not analysis.get("lyrics_source") or analysis.get("lyrics_source") == "none":
                analysis["lyrics_source"] = "transcription"

    wl = str(
        analysis.get("transcription_whisper_language") or tx.get("language") or ""
    ).strip().lower()

    if lyrics:
        analysis["has_vocal"] = True
        analysis["vocal_label"] = "song"
        analysis.pop("lyrics_transcription_status", None)
        return (analysis.get("has_vocal"), analysis.get("vocal_label"), analysis.get("lyrics_text")) != before

    reasons: list[str] = []
    if _filename_suggests_vocal_song(src.name):
        analysis["has_vocal"] = True
        analysis["vocal_label"] = "song"
        reasons.append("曲名/文件名含人声曲目线索")
    else:
        analysis["has_vocal"] = False
        analysis["vocal_label"] = "instrumental"
        analysis["lyrics_transcription_status"] = analysis.get("lyrics_transcription_status") or "empty"
        if not reasons:
            return (analysis.get("has_vocal"), analysis.get("vocal_label"), analysis.get("lyrics_text")) != before

    analysis["lyrics_transcription_status"] = "empty"
    analysis["lyrics_note"] = (
        "自动歌词转写未得到有效文本；"
        f"依据「{'；'.join(reasons)}」按含人声处理。"
        if reasons
        else "未识别歌词，按纯器乐/BGM 处理。"
    )
    return (analysis.get("has_vocal"), analysis.get("vocal_label"), analysis.get("lyrics_text")) != before


def _load_upload_analysis(path: Path, *, persist: bool = True) -> dict[str, Any]:
    """读取侧车 analysis.json，并对旧结果补做人声标签校正。"""
    analysis_path = path.with_suffix(path.suffix + ".analysis.json")
    if analysis_path.is_file():
        try:
            analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
        except Exception:
            analysis = _analyze_uploaded_music(path)
    else:
        analysis = _analyze_uploaded_music(path)

    if analysis.get("analysis_mode") == "audio" and _refine_upload_vocal_flags(analysis, path):
        if persist:
            analysis_path.write_text(
                json.dumps(analysis, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
    if analysis.get("analysis_mode") == "midi" and not analysis.get("midi_tracks"):
        analysis = enrich_analysis_with_midi(analysis, path)
        if persist:
            analysis_path = path.with_suffix(path.suffix + ".analysis.json")
            analysis_path.write_text(
                json.dumps(analysis, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
    return analysis


def _persist_upload_analysis(path: Path, analysis: dict[str, Any]) -> None:
    analysis_path = path.with_suffix(path.suffix + ".analysis.json")
    analysis_path.write_text(
        json.dumps(analysis, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _ensure_upload_lyrics_analysis(path: Path, analysis: dict[str, Any]) -> dict[str, Any]:
    """音频侧车分析缺歌词时补做 Whisper 转写并写回。"""
    if analysis.get("analysis_mode") != "audio":
        return analysis
    if str(analysis.get("lyrics_text") or "").strip():
        return analysis
    if path.suffix.lower() not in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"):
        return analysis
    try:
        tx = transcribe_audio_lyrics(settings, path)
    except Exception as ex:
        logger.warning("remix lyrics transcription failed: %s", ex)
        analysis["lyrics_transcription_status"] = "error"
        analysis["lyrics_note"] = f"重演绎前歌词补识别失败：{ex}"
        _persist_upload_analysis(path, analysis)
        return analysis
    if not tx:
        _refine_upload_vocal_flags(analysis, path, None)
        analysis["lyrics_transcription_status"] = analysis.get("lyrics_transcription_status") or "empty"
        _persist_upload_analysis(path, analysis)
        return analysis
    lyrics = str((tx.get("text") or "")).strip()
    whisper_lang = str((tx.get("language") or "")).strip().lower()
    raw_segs = tx.get("segments")
    if isinstance(raw_segs, list) and raw_segs:
        analysis["lyrics_timeline"] = raw_segs
        if not lyrics:
            lyrics = _segments_to_lyrics_text(raw_segs)
    if whisper_lang:
        analysis["transcription_whisper_language"] = whisper_lang
    if lyrics:
        try:
            annotated = annotate_lyrics_language(
                settings,
                lyrics,
                whisper_lang_hint=whisper_lang or None,
            )
            analysis["lyrics_text"] = annotated["lyrics"]
            analysis["lyrics_source"] = "transcription"
            analysis["lyrics_language"] = annotated["language"]
            analysis["lyrics_translation_zh"] = annotated.get("translation_zh") or ""
            analysis["lyrics_confidence"] = annotated.get("confidence")
        except Exception as ex:
            logger.warning("remix lyrics annotate skipped: %s", ex)
            analysis["lyrics_text"] = lyrics
            analysis["lyrics_source"] = "transcription"
        analysis.pop("lyrics_transcription_status", None)
    _refine_upload_vocal_flags(analysis, path, tx)
    if not str(analysis.get("lyrics_text") or "").strip():
        analysis["lyrics_transcription_status"] = "empty"
    _persist_upload_analysis(path, analysis)
    return analysis


def _technical_summary_upload_midi(path: Path, analysis: dict[str, Any]) -> str:
    base = (
        f"用户上传 MIDI：{analysis.get('filename')}; "
        f"tracks={analysis.get('tracks')}; notes≈{analysis.get('notes_estimate')}; "
        f"duration_sec≈{analysis.get('duration_seconds')}; "
        f"tpb={analysis.get('ticks_per_beat')}; tempo_events={analysis.get('tempo_events')}"
    )
    return f"{base}。{_music21_upload_midi_hint(path)}"


def _analyze_uploaded_music(src: Path) -> dict:
    info = {
        "filename": src.name,
        "size_bytes": src.stat().st_size,
        "suffix": src.suffix.lower(),
        "analysis_mode": "unknown",
        "suggested_workflow": "upload_only",
        "visualizable": False,
        "has_vocal": False,
        "vocal_label": "unknown",
        "lyrics_text": "",
        "lyrics_source": "none",
    }
    if src.suffix.lower() in (".mid", ".midi"):
        info.update(
            {
                "analysis_mode": "midi",
                "suggested_workflow": "midi-instrument-swap",
                "compatible_for_same_score": True,
                # 浏览器 <audio> 不能直播 MIDI；统一试听需服务端 FluidSynth 预渲染 WAV
                "visualizable": False,
                "has_vocal": False,
                "vocal_label": "instrumental",
            }
        )
        try:
            import mido

            mid = mido.MidiFile(src)
            tracks = len(mid.tracks)
            notes = 0
            tempos = 0
            for track in mid.tracks:
                for msg in track:
                    if getattr(msg, "type", None) == "note_on" and getattr(msg, "velocity", 0) > 0:
                        notes += 1
                    if getattr(msg, "type", None) == "set_tempo":
                        tempos += 1
            info.update(
                {
                    "tracks": tracks,
                    "notes_estimate": notes,
                    "tempo_events": tempos,
                    "ticks_per_beat": getattr(mid, "ticks_per_beat", None),
                    "duration_seconds": round(mid.length, 2),
                }
            )
        except Exception as ex:
            info["warning"] = f"midi parse failed: {ex}"
        info = enrich_analysis_with_midi(info, src)
    elif src.suffix.lower() in (".musicxml", ".xml", ".mxl"):
        info.update(
            {
                "analysis_mode": "musicxml",
                "suggested_workflow": "exact-score-rearrangement",
                "compatible_for_same_score": True,
                "visualizable": False,
                "vocal_label": "score",
            }
        )
    else:
        if _filename_suggests_instrumental(src.name):
            has_v, v_lab = False, "instrumental"
        elif _filename_suggests_vocal_song(src.name):
            has_v, v_lab = True, "song"
        else:
            has_v, v_lab = False, "instrumental"
        info.update(
            {
                "analysis_mode": "audio",
                "suggested_workflow": "audio-visual-analysis",
                "compatible_for_same_score": False,
                "visualizable": True,
                "remix_available": bool(getattr(settings, "enable_audio_remix", False)),
                "has_vocal": has_v,
                "vocal_label": v_lab,
                "note": (
                    "音频会按节奏、时长、结构与整体情绪做可视化分析；"
                    "如果是带歌词的人声歌曲，当前流程仍可做可视化，"
                    "但不保证自动识别或逐字展示歌词。"
                ),
            }
        )
    return info


@app.get("/api/soundfont/sgm_plus/{path:path}")
async def soundfont_sgm_plus_proxy(path: str):
    """浏览器经本站拉取 Magenta sgm_plus（上游由 soundfont_upstream 探测，默认国内镜像优先）。"""
    sub = _safe_soundfont_subpath(path)
    base = await resolve_soundfont_base()
    url = f"{base}/{sub}"
    timeout = httpx.Timeout(120.0, connect=25.0)
    client = httpx_async_client(timeout=timeout)
    try:
        request = client.build_request("GET", url)
        response = await client.send(request, stream=True)
    except Exception as e:
        await client.aclose()
        logger.warning("SoundFont 代理连接失败 %s: %s", url, e)
        raise HTTPException(502, detail=f"soundfont upstream: {e}") from e

    if response.status_code != 200:
        await response.aread()
        await response.aclose()
        await client.aclose()
        raise HTTPException(
            response.status_code,
            detail="soundfont upstream returned non-200",
        )

    media = _media_for_soundfont(sub)

    async def stream_body():
        try:
            async for chunk in response.aiter_bytes(65536):
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(
        stream_body(),
        media_type=media,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "openai_model": settings.openai_model,
        "qwen3_vl_model": settings.qwen3_vl_model,
        "use_qwen3_vl_for_intent": settings.use_qwen3_vl_for_intent,
        "use_qwen3_vl_for_judge": settings.use_qwen3_vl_for_judge,
        "qwen_omni_model": settings.qwen_omni_model,
        "judge_audio_with_omni": settings.judge_audio_with_omni,
        "enable_playback_omni_insight": settings.enable_playback_omni_insight,
        "base_url": settings.openai_base_url,
        "output": str(out_dir),
        "compose_max_attempts": settings.compose_max_attempts,
        "quality_score_threshold": settings.quality_score_threshold,
        "enable_llm_judge": settings.enable_llm_judge,
        "enable_judge_intent_patch": settings.enable_judge_intent_patch,
        "enable_playback_visual_llm": settings.enable_playback_visual_llm,
        "enable_listening_caption_llm": settings.enable_listening_caption_llm,
        "enable_remix_ws": bool(getattr(settings, "enable_midi_swap", True)),
        "enable_audio_remix": bool(getattr(settings, "enable_audio_remix", False)),
        "enable_midi_swap": bool(getattr(settings, "enable_midi_swap", True)),
        "remix_max_attempts": settings.remix_max_attempts,
        "judge_omni_once_after_compose": settings.judge_omni_once_after_compose,
        "intent_max_tokens": settings.intent_max_tokens,
        "judge_max_tokens": settings.judge_max_tokens,
        "stream_model_thinking": settings.stream_model_thinking,
        "midi_render_wav": settings.midi_render_wav,
        "midi_render_mp3": settings.midi_render_mp3,
        "soundfont_sf2_configured": bool(resolve_soundfont_sf2(settings.soundfont_sf2_path)),
        "compose_backend": resolve_compose_backend(settings),
        "neural_music": neural_status(settings),
        "enable_music_theory": getattr(settings, "enable_music_theory", True),
        "enable_demucs_stems": getattr(settings, "enable_demucs_stems", True),
        "demucs_available": demucs_available(),
        "theory_tools": len(theory_catalog().get("tools", [])),
    }


@app.get("/api/music/neural-status")
def music_neural_status():
    """MusicGen 依赖与 GPU 摘要（GTX 1050 2GB 等低显存自检）。"""
    return {"ok": True, **neural_status(settings)}


@app.post("/api/music/compose/async")
async def music_compose_async(body: dict):
    """P2-5：异步创作任务，返回 job_id 供轮询。"""
    prompt = str((body or {}).get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(400, "prompt required")
    trace_id = str((body or {}).get("trace_id") or "").strip() or None
    payload = {"type": "compose", "prompt": prompt, **({"trace_id": trace_id} if trace_id else {})}

    async def runner(sink, pl):
        await _run_compose(sink, pl)

    job_id = enqueue_music_job(task=prompt, action="compose", payload=payload, runner=runner)
    return {"ok": True, "job_id": job_id, "status": "queued", "poll": f"/api/jobs/{job_id}"}


@app.get("/api/jobs/{job_id}")
def music_job_status(job_id: str):
    job = read_job(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return {
        "ok": True,
        "job_id": job.id,
        "status": job.status,
        "stage": job.stage,
        "pct": job.pct,
        "error": job.error,
        "result": job.result,
        "events": job.events[-20:],
    }


@app.get("/api/files/{name}")
def get_file(name: str):
    safe = Path(name).name
    path = out_dir / safe
    if not path.is_file() or path.resolve().parent != out_dir.resolve():
        raise HTTPException(404, "not found")
    media = _MEDIA.get(path.suffix.lower(), "application/octet-stream")
    # 媒体文件需要浏览器直接预览；若强制 attachment，会导致 audio/video 被当成下载文件。
    return FileResponse(path, media_type=media)


@app.get("/api/music/uploads")
def list_music_uploads():
    """列出已保存在服务器上的上传文件（含侧车 analysis.json），按修改时间倒序。"""
    items: list[dict] = []
    if not MEDIA_ROOT.is_dir():
        return {"ok": True, "items": []}
    for p in sorted(MEDIA_ROOT.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        if not p.is_file():
            continue
        if p.name.endswith(".analysis.json"):
            continue
        analysis_path = p.with_suffix(p.suffix + ".analysis.json")
        analysis: dict | None = None
        if analysis_path.is_file():
            try:
                analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
                if isinstance(analysis, dict) and analysis.get("analysis_mode") == "audio":
                    if _refine_upload_vocal_flags(analysis, p):
                        analysis_path.write_text(
                            json.dumps(analysis, ensure_ascii=False, indent=2),
                            encoding="utf-8",
                        )
            except Exception:
                analysis = None
        st = p.stat()
        items.append(
            {
                "saved_filename": p.name,
                "file_url": f"/api/music/uploads/{p.name}",
                "analysis_url": f"/api/music/uploads/{analysis_path.name}" if analysis_path.is_file() else None,
                "size_bytes": st.st_size,
                "suffix": p.suffix.lower(),
                "mtime": int(st.st_mtime),
                "analysis": analysis,
            }
        )
    return {"ok": True, "items": items}


@app.get("/api/music/remix-presets")
def remix_presets():
    """重演绎曲风 / 目标乐器下拉选项。"""
    return list_remix_presets_payload()


@app.get("/api/music/theory/catalog")
def music_theory_catalog():
    """内置乐理工具清单（Phase 2）。"""
    return {"ok": True, **theory_catalog()}


def _resolve_upload_or_output_path(body: dict[str, Any]) -> tuple[Path, str]:
    """从 saved_filename（uploads）或 output 文件名解析可读路径。"""
    raw = str(body.get("saved_filename") or body.get("filename") or "").strip()
    safe = Path(raw).name
    if not safe:
        raise HTTPException(400, detail="missing saved_filename")
    up = MEDIA_ROOT / safe
    if up.is_file() and up.resolve().parent == MEDIA_ROOT.resolve():
        return up, safe
    out = out_dir / safe
    if out.is_file() and out.resolve().parent == out_dir.resolve():
        return out, safe
    raise HTTPException(404, detail="file not found in uploads or output")


@app.post("/api/music/analyze")
async def music_analyze(body: dict[str, Any]):
    """MIDI 深度乐理分析（music21 + 结构摘要）。"""
    if not getattr(settings, "enable_music_theory", True):
        raise HTTPException(503, detail="music theory tools disabled")
    try:
        path, _ = _resolve_upload_or_output_path(body or {})
    except HTTPException:
        raise
    if path.suffix.lower() not in (".mid", ".midi"):
        raise HTTPException(422, detail="analyze requires .mid / .midi")
    result = await asyncio.to_thread(analyze_midi_file, path)
    payload = result.to_dict()
    payload["ok"] = result.ok
    if not result.ok:
        raise HTTPException(422, detail="; ".join(result.issues) or "analyze failed")
    return payload


@app.post("/api/music/harmonize")
async def music_harmonize(body: dict[str, Any]):
    """为 MIDI 主旋律自动配和声，输出新 MIDI + 可选 WAV 试听。"""
    if not getattr(settings, "enable_music_theory", True):
        raise HTTPException(503, detail="music theory tools disabled")
    try:
        path, _ = _resolve_upload_or_output_path(body or {})
    except HTTPException:
        raise
    if path.suffix.lower() not in (".mid", ".midi"):
        raise HTTPException(422, detail="harmonize requires .mid / .midi")

    harmony_style = str(body.get("harmony_style") or body.get("style") or "pop").strip() or "pop"
    key_override = str(body.get("key") or "").strip() or None
    tempo_raw = body.get("tempo_bpm")
    tempo_bpm: float | None = None
    if tempo_raw is not None:
        try:
            tempo_bpm = float(tempo_raw)
        except (TypeError, ValueError):
            tempo_bpm = None

    stem = f"harm_{uuid.uuid4().hex[:10]}"
    midi_out = out_dir / f"{stem}.mid"
    wav_out = out_dir / f"{stem}.wav"

    result = await asyncio.to_thread(
        harmonize_midi_file,
        path,
        midi_out,
        harmony_style=harmony_style,
        key_override=key_override,
        tempo_bpm=tempo_bpm,
    )
    if not result.ok or not midi_out.is_file():
        raise HTTPException(500, detail="; ".join(result.issues) or "harmonize failed")

    midi_url = f"/api/files/{midi_out.name}"
    wav_url: str | None = None
    sf2 = resolve_soundfont_sf2(settings.soundfont_sf2_path)
    if settings.midi_render_wav and sf2:
        ok_wav = await asyncio.to_thread(
            render_midi_to_wav,
            midi_out,
            wav_out,
            soundfont_path=sf2,
            fluidsynth_bin=settings.fluidsynth_path,
            sample_rate=int(settings.midi_render_sample_rate),
            gain=float(settings.midi_render_gain),
            ffmpeg_bin=settings.ffmpeg_path,
        )
        if ok_wav and wav_out.is_file():
            wav_url = f"/api/files/{wav_out.name}"

    roman = " ".join(result.chord_roman[:16])
    summary = f"{result.key} · {harmony_style} · {result.bars} 小节 · {roman}"
    return {
        "ok": True,
        "midi_url": midi_url,
        "wav_url": wav_url,
        "summary_zh": summary,
        **result.to_dict(),
    }


@app.post("/api/music/export-score")
async def music_export_score(body: dict[str, Any]):
    """对已上传或 output 目录中的 MIDI 导出 MusicXML / PDF / ABC。"""
    try:
        path, stem = _resolve_upload_or_output_path(body or {})
    except HTTPException:
        raise
    if path.suffix.lower() not in (".mid", ".midi"):
        raise HTTPException(422, detail="export requires .mid / .midi")
    export_stem = f"export_{uuid.uuid4().hex[:8]}_{Path(stem).stem}"
    exports = await asyncio.to_thread(export_notation, path, export_stem, out_dir)
    abc_path = out_dir / f"{export_stem}.abc"
    abc_ok = await asyncio.to_thread(export_abc_from_midi, path, abc_path)
    urls: dict[str, str | None] = {}
    if exports.get("musicxml"):
        urls["musicxml"] = f"/api/files/{exports['musicxml']}"
    if exports.get("pdf"):
        urls["pdf"] = f"/api/files/{exports['pdf']}"
    if abc_ok:
        urls["abc"] = f"/api/files/{abc_path.name}"
    if not any(urls.values()):
        raise HTTPException(500, detail="export failed (music21 / LilyPond)")
    return {"ok": True, "urls": urls, "stem": export_stem}


@app.post("/api/music/stems")
async def music_stems(body: dict[str, Any]):
    """Demucs 分轨导出（vocals/drums/bass/other），仅下载 stems，不做重编配。"""
    if not getattr(settings, "enable_demucs_stems", True):
        raise HTTPException(503, detail="demucs stems disabled")
    if not demucs_available():
        raise HTTPException(
            503,
            detail="未安装 demucs（Docker 构建 INSTALL_DEMUCS=1 或 pip install demucs）",
        )
    try:
        path, _ = _resolve_upload_or_output_path(body or {})
    except HTTPException:
        raise
    if path.suffix.lower() not in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"):
        raise HTTPException(422, detail="stems requires audio upload")

    model = str(body.get("model") or getattr(settings, "demucs_model", "htdemucs")).strip() or "htdemucs"
    two = body.get("two_stems")
    two_stems = str(two).strip() if two else None
    max_sec = float(getattr(settings, "demucs_stems_max_seconds", 300) or 0)
    if body.get("max_seconds") is not None:
        try:
            max_sec = float(body["max_seconds"])
        except (TypeError, ValueError):
            pass

    work = out_dir / f"stem_job_{uuid.uuid4().hex[:10]}"
    result = await asyncio.to_thread(
        separate_stems_demucs,
        path,
        work,
        model=model,
        ffmpeg_bin=settings.ffmpeg_path,
        max_seconds=max_sec if max_sec > 0 else None,
        two_stems=two_stems,
    )
    if not result.ok:
        raise HTTPException(500, detail=result.error or "demucs failed")

    urls: dict[str, str] = {}
    for key, p in result.stems.items():
        # 复制到 out_dir 根便于 /api/files 访问
        dest = out_dir / f"{work.name}_{key}.wav"
        shutil.copy2(p, dest)
        urls[key] = f"/api/files/{dest.name}"

    return {
        "ok": True,
        "model": result.model,
        "stem_urls": urls,
        "warnings": result.warnings,
        "summary_zh": f"Demucs {model} 分轨完成：{', '.join(urls.keys())}",
    }


@app.get("/api/music/stems/status")
def music_stems_status():
    return {
        "ok": True,
        "enabled": bool(getattr(settings, "enable_demucs_stems", True)),
        "available": demucs_available(),
        "default_model": getattr(settings, "demucs_model", "htdemucs"),
        "max_seconds": float(getattr(settings, "demucs_stems_max_seconds", 300)),
    }


@app.get("/api/music/uploads/{name}")
def get_music_upload(name: str):
    """用户上传的原始文件保存在 MEDIA_ROOT，与生成产物目录 out_dir 分离。"""
    safe = Path(name).name
    path = MEDIA_ROOT / safe
    if not path.is_file() or path.resolve().parent != MEDIA_ROOT.resolve():
        raise HTTPException(404, "not found")
    media = _audio_mime(path)
    return FileResponse(path, media_type=media, filename=safe)


@app.post("/api/music/upload")
async def upload_music(file: UploadFile = File(...)):
    original_name = Path(file.filename or "upload").name
    safe_name = f"{uuid.uuid4().hex[:12]}_{original_name}"
    dest = MEDIA_ROOT / safe_name
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    analysis = _analyze_uploaded_music(dest)
    if analysis.get("analysis_mode") == "audio":
        dur_ff = _ffprobe_duration_seconds(dest)
        if dur_ff is not None:
            analysis["duration_seconds"] = round(dur_ff, 2)
    analysis["recommended_remix_style"] = infer_style_hint(analysis, dest.name)
    tx: dict[str, Any] | None = None
    if analysis.get("analysis_mode") == "audio" and dest.suffix.lower() in (
        ".wav",
        ".mp3",
        ".flac",
        ".ogg",
        ".m4a",
        ".aac",
    ):
        try:
            tx = transcribe_audio_lyrics(settings, dest)
        except Exception as ex:
            logger.warning("upload transcription skipped: %s", ex)
            analysis["lyrics_transcription_status"] = "error"
            analysis["lyrics_note"] = (
                f"歌词自动转写失败（{ex}）；已保存文件并完成基础分析，可照常试听与分析。"
            )
        if tx:
            lyrics = str((tx.get("text") or "")).strip()
            whisper_lang = str((tx.get("language") or "")).strip().lower()
            raw_segs = tx.get("segments")
            if isinstance(raw_segs, list) and raw_segs:
                analysis["lyrics_timeline"] = raw_segs
                if not lyrics:
                    lyrics = _segments_to_lyrics_text(raw_segs)
            if whisper_lang:
                analysis["transcription_whisper_language"] = whisper_lang
            if lyrics:
                try:
                    annotated = annotate_lyrics_language(
                        settings,
                        lyrics,
                        whisper_lang_hint=whisper_lang or None,
                    )
                    analysis["lyrics_text"] = annotated["lyrics"]
                    analysis["lyrics_source"] = "transcription"
                    analysis["lyrics_language"] = annotated["language"]
                    analysis["lyrics_translation_zh"] = annotated.get("translation_zh") or ""
                    analysis["lyrics_confidence"] = annotated.get("confidence")
                except Exception as ex:
                    logger.warning("lyrics annotate skipped: %s", ex)
                    analysis["lyrics_text"] = lyrics
                    analysis["lyrics_source"] = "transcription"
            _refine_upload_vocal_flags(analysis, dest, tx)
        else:
            _refine_upload_vocal_flags(analysis, dest, None)
    analysis_path = dest.with_suffix(dest.suffix + ".analysis.json")
    analysis_path.write_text(json.dumps(analysis, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "ok": True,
        "file_url": f"/api/music/uploads/{dest.name}",
        "analysis_url": f"/api/music/uploads/{analysis_path.name}",
        "saved_filename": dest.name,
        "analysis": analysis,
    }


@app.post("/api/music/poetic-lyrics")
async def poetic_lyrics_from_upload(body: dict[str, Any]):
    """
    对已上传音频：根据用户填写的曲名、歌手（可选）由模型概括背景与情绪，
    并与侧车 analysis（含自动转写摘要等）融合，生成原创中文诗意歌词。
    """
    raw_name = str(body.get("saved_filename") or body.get("filename") or "").strip()
    safe = Path(raw_name).name
    if not safe:
        raise HTTPException(400, detail="missing saved_filename")
    song_title = str(body.get("song_title") or body.get("songTitle") or "").strip()
    if not song_title:
        raise HTTPException(400, detail="missing song_title")
    artist_raw = body.get("artist")
    artist = str(artist_raw).strip() if artist_raw is not None else ""

    path = MEDIA_ROOT / safe
    if not path.is_file() or path.resolve().parent != MEDIA_ROOT.resolve():
        raise HTTPException(404, detail="upload not found")

    analysis = _load_upload_analysis(path)

    try:
        poetic = await asyncio.to_thread(
            infer_poetic_lyrics_with_song_context,
            settings,
            song_title=song_title,
            artist=artist or None,
            analysis=analysis,
            saved_filename=safe,
        )
    except ValueError as e:
        raise HTTPException(400, detail=str(e)) from e
    except Exception as e:
        logger.exception("poetic-lyrics")
        raise HTTPException(500, detail=str(e)) from e

    return {
        "ok": True,
        "saved_filename": safe,
        "song_title": song_title,
        "artist": artist or None,
        "poetic": poetic,
    }


@app.post("/api/music/upload-midi-preview-wav")
async def upload_midi_preview_wav(body: dict[str, Any]):
    """
    将已保存在 MEDIA_ROOT 的上传 MIDI 渲染为 WAV（写入 output_dir），供页面「统一试听」播放。
    依赖本机 fluidsynth 与 soundfont_sf2_path；与 compose 流程的 MIDI_RENDER_WAV 无关。
    """
    raw = body.get("saved_filename") or body.get("name") or ""
    safe = Path(str(raw).strip()).name
    if not safe:
        raise HTTPException(400, detail="missing saved_filename")
    src = MEDIA_ROOT / safe
    if not src.is_file() or src.resolve().parent != MEDIA_ROOT.resolve():
        raise HTTPException(404, detail="upload not found")
    if src.suffix.lower() not in (".mid", ".midi"):
        raise HTTPException(400, detail="not a MIDI file")
    sf2 = resolve_soundfont_sf2(settings.soundfont_sf2_path)
    if not sf2.is_file():
        raise HTTPException(
            503,
            detail="soundfont not configured (set soundfont_sf2_path in .env)",
        )
    out_name = f"upload_preview_{uuid.uuid4().hex[:10]}_{src.stem}.wav"
    dest = out_dir / out_name

    def _render() -> bool:
        return render_midi_to_wav(
            src,
            dest,
            soundfont_path=sf2,
            fluidsynth_bin=settings.fluidsynth_path,
            sample_rate=int(settings.midi_render_sample_rate),
            gain=float(settings.midi_render_gain),
            ffmpeg_bin=settings.ffmpeg_path,
        )

    ok = await asyncio.to_thread(_render)
    if not ok or not dest.is_file():
        raise HTTPException(
            500,
            detail="FluidSynth render failed (check fluidsynth in PATH and MIDI validity)",
        )
    return {
        "ok": True,
        "wav_url": f"/api/files/{dest.name}",
        "saved_filename": safe,
    }


@app.post("/api/music/playback-visual-intent")
async def playback_visual_intent(body: dict[str, Any]):
    """
    统一播放器开始试听前调用：生成曲目可带上 intent 快速对齐可视化；
    上传音频根据 analysis + 文件名由 LLM 推断情绪/速度等（听不见真实波形）。
    """
    source = str(body.get("source") or "upload")
    filename = str(body.get("filename") or "audio.wav")
    raw_intent = body.get("intent")
    intent_d: dict[str, Any] | None = raw_intent if isinstance(raw_intent, dict) else None
    raw_analysis = body.get("analysis")
    analysis_d: dict[str, Any] | None = raw_analysis if isinstance(raw_analysis, dict) else None
    dur_raw = body.get("duration_seconds")
    try:
        dur = int(float(dur_raw)) if dur_raw is not None else None
    except (TypeError, ValueError):
        dur = None
    try:
        out = await asyncio.to_thread(
            infer_playback_visual_intent,
            settings,
            source=source,
            filename=filename,
            analysis=analysis_d,
            intent=intent_d,
            duration_seconds=dur,
        )
        return {"ok": True, "intent": out}
    except Exception as e:
        logger.exception("playback-visual-intent")
        raise HTTPException(500, detail=str(e)) from e


@app.post("/api/music/visual-intent")
async def visual_intent_compat(body: dict[str, Any]):
    """与 playback-visual-intent 相同（短路径，兼容网关或旧前端）。"""
    return await playback_visual_intent(body)


@app.post("/api/music/listening-captions")
async def listening_captions(body: dict[str, Any]):
    """
    根据 analysis（上传）或创作 intent（生成）由 LLM 写四边听感短句；与 playback-visual-intent 同源信号，
    不直接听音频波形（与现有可视化推断一致）。
    """
    source = str(body.get("source") or "upload")
    filename = str(body.get("filename") or "audio.wav")
    raw_intent = body.get("intent")
    intent_d: dict[str, Any] | None = raw_intent if isinstance(raw_intent, dict) else None
    raw_analysis = body.get("analysis")
    analysis_d: dict[str, Any] | None = raw_analysis if isinstance(raw_analysis, dict) else None
    dur_raw = body.get("duration_seconds")
    try:
        dur = int(float(dur_raw)) if dur_raw is not None else None
    except (TypeError, ValueError):
        dur = None
    try:
        out = await asyncio.to_thread(
            infer_listening_captions,
            settings,
            source=source,
            filename=filename,
            analysis=analysis_d,
            intent=intent_d,
            duration_seconds=dur,
        )
        return {"ok": True, "captions": out}
    except Exception as e:
        logger.exception("listening-captions")
        raise HTTPException(500, detail=str(e)) from e


@app.post("/api/music/generate-bgm")
async def generate_bgm(body: dict[str, Any]):
    """
    生成带节奏、无歌词的短 BGM，供外部 Video_Agent 调用。
    支持接收 music_brief 以便按视频语义自动映射音乐意图。
    """
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(400, detail="missing prompt")

    brief = body.get("music_brief") if isinstance(body.get("music_brief"), dict) else {}
    brief_mood = str(brief.get("mood") or body.get("emotion") or "energetic").strip() or "energetic"
    brief_energy = str(brief.get("energy") or "medium").strip() or "medium"
    brief_tempo = str(brief.get("tempo") or "medium").strip() or "medium"
    brief_instr = brief.get("instrumentation") if isinstance(brief.get("instrumentation"), list) else []
    brief_lyrics = bool(brief.get("lyrics") is False)
    brief_style = str(brief.get("style_hint") or body.get("style") or "pop").strip() or "pop"

    try:
        dur = int(float(body.get("duration_seconds") or brief.get("duration_seconds") or 10))
    except (TypeError, ValueError):
        dur = 10
    dur = max(5, min(30, dur))

    key = str(body.get("key") or brief.get("key") or "C").strip() or "C"
    try:
        tempo = int(float(body.get("tempo_bpm") or brief.get("tempo_bpm") or 96))
    except (TypeError, ValueError):
        tempo = 96

    emotion = brief_mood
    style = brief_style
    stem = f"bgm_{uuid.uuid4().hex[:10]}"
    midi_path = out_dir / f"{stem}.mid"
    wav_path = out_dir / f"{stem}.wav"
    mp3_path = out_dir / f"{stem}.mp3"

    # 自动把 brief 中的节奏/配器偏好映射到 compose_midi 的参数
    instruments = ["drums", "bass", "synth"]
    if any("piano" in str(x).lower() or "钢琴" in str(x) for x in brief_instr):
        instruments = ["piano", "drums", "bass"]
    elif any("ambient" in str(x).lower() or "pad" in str(x).lower() for x in brief_instr):
        instruments = ["synth", "bass", "drums"]
    elif any("guitar" in str(x).lower() or "吉他" in str(x) for x in brief_instr):
        instruments = ["guitar", "bass", "drums"]

    if brief_energy == "low":
        tempo = min(tempo, 88)
    elif brief_energy == "high":
        tempo = max(tempo, 112)

    if brief_tempo == "slow":
        tempo = min(tempo, 84)
    elif brief_tempo == "fast":
        tempo = max(tempo, 118)

    from .compose_instruments import extract_instruments_from_text
    from .intent_enrich import enrich_intent_from_user_text

    mini_intent = enrich_intent_from_user_text(
        prompt,
        {
            "instruments": instruments,
            "style": style,
            "emotion": emotion,
            "structure": "intro-verse-chorus-outro",
        },
    )
    instruments = list(mini_intent.get("instruments") or instruments)
    style = str(mini_intent.get("style") or style)
    emotion = str(mini_intent.get("emotion") or emotion)
    structure = str(mini_intent.get("structure") or "intro-verse-chorus-outro")
    if mini_intent.get("tempo"):
        try:
            tempo = int(mini_intent["tempo"])
        except (TypeError, ValueError):
            pass

    compose_backend = resolve_compose_backend(settings)
    audio_backend = "rule"
    neural_info: dict[str, Any] = {}
    intent = None
    neural_ok, _neural_reason = should_use_neural_generation(settings)

    if compose_backend == "neural" and neural_ok:
        mg_prompt = build_neural_prompt(
            emotion=emotion,
            style=style,
            instruments=instruments,
            tempo_bpm=tempo,
            harmony_style=style,
            user_prompt=prompt,
            instrumental=True,
        )
        neural_result = await asyncio.to_thread(
            generate_neural_wav,
            settings,
            output_path=wav_path,
            prompt=mg_prompt,
            duration_seconds=dur,
        )
        neural_info = {
            "device": neural_result.device,
            "prompt": neural_result.prompt,
            "error": neural_result.error,
        }
        if neural_result.ok:
            audio_backend = "neural"
            dur = int(neural_result.duration_seconds or dur)
        else:
            logger.warning("BGM neural failed (%s), fallback compose_midi", neural_result.error)
            compose_backend = "rule"

    if audio_backend != "neural":
        intent = await asyncio.to_thread(
            compose_midi,
            output_path=midi_path,
            key=key,
            tempo_bpm=tempo,
            duration_seconds=dur,
            emotion=emotion,
            structure=structure,
            instruments=instruments,
            harmony_style=str(mini_intent.get("harmony_style") or style),
            ensemble=True,
            user_text=prompt,
            style=style,
            seed=compose_seed_for_attempt(
                key=key,
                tempo=tempo,
                emotion=emotion,
                user_text=prompt,
            ),
        )
        sf2 = resolve_soundfont_sf2(settings.soundfont_sf2_path)
        if not sf2:
            raise HTTPException(503, detail="soundfont not configured")
        ok_wav = await asyncio.to_thread(
            render_midi_to_wav,
            midi_path,
            wav_path,
            soundfont_path=sf2,
            fluidsynth_bin=settings.fluidsynth_path,
            sample_rate=int(settings.midi_render_sample_rate),
            gain=float(settings.midi_render_gain),
            ffmpeg_bin=settings.ffmpeg_path,
        )
        if not ok_wav:
            raise HTTPException(500, detail="wav render failed")

    if not wav_path.is_file():
        raise HTTPException(500, detail="audio generation failed")

    audio_url = f"/api/files/{wav_path.name}"
    if settings.midi_render_mp3:
        ok_mp3 = await asyncio.to_thread(wav_to_mp3, wav_path, mp3_path, ffmpeg_bin=settings.ffmpeg_path)
        if ok_mp3:
            audio_url = f"/api/files/{mp3_path.name}"
    return {
        "ok": True,
        "audio_url": audio_url,
        "wav_url": f"/api/files/{wav_path.name}",
        "mp3_url": f"/api/files/{mp3_path.name}" if mp3_path.is_file() else None,
        "saved_filename": Path(audio_url).name,
        "duration_seconds": dur,
        "key": key,
        "tempo_bpm": tempo,
        "emotion": emotion,
        "style": style,
        "lyrics": brief_lyrics,
        "compose_backend": audio_backend,
        "neural": neural_info if audio_backend == "neural" else None,
        "music_brief": {
            "mood": brief_mood,
            "energy": brief_energy,
            "tempo": brief_tempo,
            "instrumentation": brief_instr,
            "lyrics": brief_lyrics,
            "style_hint": brief_style,
        },
        "midi_url": f"/api/files/{midi_path.name}" if midi_path.is_file() else None,
        "section_plan": [[a, b] for a, b in intent.section_plan] if intent else None,
    }


@app.post("/api/music/judge-midi")
async def judge_uploaded_midi(
    source_url: str = Form(...),
    user_note: str = Form(""),
):
    """
    对已上传的 MIDI 做基于技术指标摘要的 LLM 质检（Qwen3-VL 文本，非听音频）。
    """
    if not settings.enable_llm_judge:
        raise HTTPException(400, detail="已关闭 LLM 质检（ENABLE_LLM_JUDGE=false）")
    try:
        source_name = _upload_basename_from_source_url(source_url)
    except HTTPException:
        raise
    path = MEDIA_ROOT / source_name
    if not path.is_file():
        raise HTTPException(404, detail="uploaded file not found")
    if path.suffix.lower() not in (".mid", ".midi"):
        raise HTTPException(422, detail="仅支持对已上传的 .mid / .midi 文件质检")

    analysis = _analyze_uploaded_music(path)
    tech = _technical_summary_upload_midi(path, analysis)
    note = (user_note or "").strip()
    if note:
        tech = f"{tech}。用户备注：{note[:400]}"

    try:
        dur = int(float(analysis.get("duration_seconds") or 60))
    except (TypeError, ValueError):
        dur = 60
    dur = max(15, min(600, dur))

    intent: dict[str, Any] = {
        "key": "未知",
        "tempo": 100,
        "emotion": "neutral",
        "structure": "uploaded-midi",
        "instruments": ["midi_upload"],
        "duration_seconds": dur,
        "style": "unknown",
        "harmony_style": "pop",
        "confidence": 0.5,
    }
    user_prompt = (
        "请仅根据下列「MIDI 技术指标摘要」评估这首作品（你听不见真实音频）。"
        "从旋律线条、和声合理性、织体层次、节奏与可演奏性等维度打分；"
        "若摘要不足以判断某项，请在 suggestions 中说明依据不足。"
    )

    judge = await asyncio.to_thread(
        judge_composition,
        settings,
        user_prompt=user_prompt,
        intent=intent,
        technical_summary=tech,
        audio_path=None,
        force_audio_judge=False,
        stream_emit=None,
    )
    return {"ok": True, "judge": judge, "technical_summary": tech, "analysis": analysis}


async def _ws_send(ws: WebSocket, payload: dict) -> None:
    await ws.send_text(json.dumps(payload, ensure_ascii=False))


def _thinking_emit_factory(loop: asyncio.AbstractEventLoop, ws: WebSocket, phase: str):
    """在 worker 线程中把思考/正文片段投递回事件循环并发给前端。"""

    def emit(kind: str, text: str) -> None:
        if not text:
            return
        try:
            asyncio.run_coroutine_threadsafe(
                _ws_send(
                    ws,
                    {
                        "type": "thinking_delta",
                        "phase": phase,
                        "kind": kind,
                        "text": text,
                    },
                ),
                loop,
            )
        except Exception as ex:
            logger.debug("thinking emit skipped: %s", ex)

    return emit


def _sections_for_ws(plan: list[tuple[str, int]]) -> list[list[str | int]]:
    return [[a, b] for a, b in plan]


async def _run_compose(ws: WebSocket, payload: dict) -> None:
    _prune_compose_sessions()
    trace_id = str(payload.get("trace_id") or "").strip() or None
    started_at = time.time()
    prompt = (payload.get("prompt") or "").strip()
    session_refine = _payload_truthy(
        payload.get("session_refine") or payload.get("refine_session"),
    )
    sid_in = (payload.get("session_id") or "").strip()

    await _ws_send(ws, {"type": "config", "data": {}})

    loop = asyncio.get_running_loop()

    if session_refine:
        if not sid_in or sid_in not in _COMPOSE_SESSIONS:
            await _ws_send(
                ws,
                {
                    "type": "error",
                    "message": "会话无效或已过期：请取消「基于上轮修订」并重新完整描述创作需求。",
                },
            )
            return
        if not prompt:
            await _ws_send(ws, {"type": "error", "message": "修订说明不能为空"})
            return
        rec = _COMPOSE_SESSIONS[sid_in]
        await _ws_send(
            ws,
            {"type": "stage", "stage": "intent_refine", "message": "正在合并会话修订…"},
        )
        emit_refine = (
            _thinking_emit_factory(loop, ws, "intent_refine")
            if getattr(settings, "stream_model_thinking", True)
            else None
        )
        intent = await asyncio.to_thread(
            refine_music_intent,
            settings,
            original_prompt=rec.original_prompt,
            previous_intent=rec.last_intent,
            refine_instruction=prompt,
            stream_emit=emit_refine,
        )
        await _ws_send(ws, {"type": "thinking_end", "phase": "intent_refine"})
        user_prompt_for_judge = (
            f"{rec.original_prompt}\n【本轮修订】{prompt}"
        )
        active_session_id = sid_in
    else:
        if not prompt:
            await _ws_send(ws, {"type": "error", "message": "prompt 不能为空"})
            return
        await _ws_send(ws, {"type": "stage", "stage": "intent", "message": "正在解析音乐意图…"})
        emit_intent = (
            _thinking_emit_factory(loop, ws, "intent")
            if getattr(settings, "stream_model_thinking", True)
            else None
        )
        intent = await asyncio.to_thread(
            parse_music_intent,
            settings,
            prompt,
            stream_emit=emit_intent,
        )
        await _ws_send(ws, {"type": "thinking_end", "phase": "intent"})
        user_prompt_for_judge = prompt
        active_session_id = uuid.uuid4().hex[:16]
        _COMPOSE_SESSIONS[active_session_id] = ComposeSessionRecord(
            created=time.time(),
            original_prompt=prompt,
            last_intent=dict(intent),
        )

    await _ws_send(ws, {"type": "intent", "data": intent})
    await _ws_send(
        ws,
        {
            "type": "session",
            "session_id": active_session_id,
            "refined": bool(session_refine),
        },
    )

    base = uuid.uuid4().hex[:12]
    stem = f"music_{base}"
    final_mid = out_dir / f"{stem}.mid"

    current_intent: dict[str, Any] = dict(intent)

    max_try = max(1, int(settings.compose_max_attempts))
    if not settings.enable_llm_judge:
        max_try = 1

    threshold = max(1, min(10, int(settings.quality_score_threshold)))

    meta = None
    validation_report = None
    judge_result: dict | None = None
    last_tech = ""

    for attempt in range(max_try):
        key = str(current_intent.get("key") or "C大调")
        harmony_style = str(current_intent.get("harmony_style") or "pop")

        await _ws_send(
            ws,
            {
                "type": "stage",
                "stage": "compose",
                "message": f"正在生成 MIDI（第 {attempt + 1}/{max_try} 次）…",
            },
        )
        work = out_dir / f"work_{base}_{attempt}.mid"
        meta = await asyncio.to_thread(
            compose_midi,
            output_path=work,
            key=key,
            tempo_bpm=int(current_intent.get("tempo") or 100),
            duration_seconds=int(current_intent.get("duration_seconds") or 45),
            emotion=str(current_intent.get("emotion") or "calm"),
            structure=str(current_intent.get("structure") or "A-B-A"),
            instruments=list(current_intent.get("instruments") or ["piano"]),
            harmony_style=harmony_style,
            ensemble=True,
            seed=compose_seed_for_attempt(
                key=key,
                tempo=int(current_intent.get("tempo") or 100),
                emotion=str(current_intent.get("emotion") or "calm"),
                user_text=user_prompt_for_judge,
                attempt=attempt,
            ),
            user_text=user_prompt_for_judge,
            style=str(current_intent.get("style") or ""),
        )

        await _ws_send(
            ws,
            {
                "type": "structure",
                "sections": _sections_for_ws(meta.section_plan),
                "bars": meta.bars,
                "harmony_style": harmony_style,
            },
        )

        await _ws_send(ws, {"type": "stage", "stage": "validate", "message": "乐理校验（music21）…"})
        validation_report = await asyncio.to_thread(
            validate_and_repair,
            work,
            final_mid,
            key,
            meta.bar_transpose_semitones,
        )
        try:
            work.unlink(missing_ok=True)
        except OSError:
            pass

        await _ws_send(
            ws,
            {
                "type": "validation",
                "ok": validation_report.ok,
                "issues": validation_report.issues,
                "notes_snapped": validation_report.notes_snapped,
            },
        )

        n_ch = max(4, min(32, int(settings.technical_summary_chord_bars)))
        issues_joined = (
            "; ".join(validation_report.issues) if validation_report.issues else "无"
        )
        issues_joined = issues_joined[: int(settings.technical_summary_issues_max_chars)]
        tech = (
            f"bars={meta.bars};sec={_sections_for_ws(meta.section_plan)};"
            f"harm={harmony_style};deg={meta.chord_degrees[:n_ch]}"
            f"{'…' if len(meta.chord_degrees) > n_ch else ''};"
            f"val={issues_joined}"
        )
        last_tech = tech

        if settings.enable_llm_judge:
            await _ws_send(
                ws,
                {
                    "type": "stage",
                    "stage": "judge",
                    "message": "质量评估（循环内：Qwen3-VL 文本）；器乐 WAV 渲染完成后可选 Omni 听感终审。",
                },
            )
            emit_judge = (
                _thinking_emit_factory(loop, ws, "judge_vl")
                if getattr(settings, "stream_model_thinking", True)
                else None
            )
            judge_result = await asyncio.to_thread(
                judge_composition,
                settings,
                user_prompt=user_prompt_for_judge,
                intent=current_intent,
                technical_summary=tech,
                audio_path=None,
                force_audio_judge=False,
                stream_emit=emit_judge,
            )
            await _ws_send(
                ws,
                {"type": "thinking_end", "phase": "judge_vl"},
            )
            await _ws_send(ws, {"type": "judge", "data": judge_result})
            overall = int(judge_result.get("overall") or 0)
            if overall >= threshold:
                break
            if attempt < max_try - 1:
                patch_note = ""
                patch_ok = bool(getattr(settings, "enable_judge_intent_patch", True))
                if patch_ok and judge_result:
                    await _ws_send(
                        ws,
                        {
                            "type": "stage",
                            "stage": "intent_patch",
                            "message": "根据质检建议调整生成参数…",
                        },
                    )
                    emit_patch = (
                        _thinking_emit_factory(loop, ws, "intent_patch")
                        if getattr(settings, "stream_model_thinking", True)
                        else None
                    )
                    patched, patch_note = await asyncio.to_thread(
                        patch_intent_from_judge,
                        settings,
                        user_prompt=user_prompt_for_judge,
                        intent=current_intent,
                        judge_result=judge_result,
                        technical_summary=tech,
                        attempt_index=attempt,
                        stream_emit=emit_patch,
                    )
                    await _ws_send(
                        ws,
                        {"type": "thinking_end", "phase": "intent_patch"},
                    )
                    current_intent = dict(patched)
                    await _ws_send(
                        ws,
                        {
                            "type": "intent_patch",
                            "data": {
                                "intent": current_intent,
                                "patch_note": patch_note,
                            },
                        },
                    )
                msg = f"评分 {overall} 低于阈值 {threshold}，将重试生成"
                if patch_note:
                    msg += f"（调整说明：{patch_note}）"
                else:
                    msg += "…"
                await _ws_send(ws, {"type": "warn", "message": msg})
        else:
            judge_result = {
                "overall": None,
                "suggestions": "已关闭 LLM 评判（ENABLE_LLM_JUDGE=false）",
            }
            break

    if meta is None:
        await _ws_send(ws, {"type": "error", "message": "生成失败"})
        return

    midi_url = f"/api/files/{stem}.mid"
    await _ws_send(
        ws,
        {
            "type": "midi",
            "url": midi_url,
            "bars": meta.bars,
        },
    )

    await _ws_send(ws, {"type": "stage", "stage": "export", "message": "导出乐谱（MusicXML / 可选 PDF）…"})
    exports = await asyncio.to_thread(export_notation, final_mid, stem, out_dir)
    exp_urls: dict[str, str | None] = {}
    if exports.get("musicxml"):
        exp_urls["musicxml"] = f"/api/files/{exports['musicxml']}"
    if exports.get("pdf"):
        exp_urls["pdf"] = f"/api/files/{exports['pdf']}"
    await _ws_send(ws, {"type": "exports", "urls": exp_urls})

    instrumental_wav_url: str | None = None
    instrumental_mp3_url: str | None = None
    instrumental_path: Path | None = None
    audio_for_judge: Path | None = None

    compose_backend = resolve_compose_backend(settings)
    neural_preferred = bool(getattr(settings, "neural_compose_preferred", True))
    neural_ok, neural_skip_reason = should_use_neural_generation(settings)
    if (
        compose_backend == "neural"
        and neural_preferred
        and neural_ok
    ):
        await _ws_send(
            ws,
            {
                "type": "stage",
                "stage": "neural_generate",
                "message": "MusicGen GPU 神经音频生成（约 12s，首次已预加载模型）…",
            },
        )
        mg_prompt = build_neural_prompt(
            emotion=str(current_intent.get("emotion") or "calm"),
            style=str(current_intent.get("style") or "pop"),
            instruments=list(current_intent.get("instruments") or ["piano"]),
            tempo_bpm=int(current_intent.get("tempo") or 100),
            harmony_style=harmony_style,
            user_prompt=user_prompt_for_judge,
            instrumental=True,
        )
        wav_render = out_dir / f"{stem}_instrumental.wav"
        neural_result = await asyncio.to_thread(
            generate_neural_wav,
            settings,
            output_path=wav_render,
            prompt=mg_prompt,
            duration_seconds=int(current_intent.get("duration_seconds") or 45),
        )
        if neural_result.ok and wav_render.is_file():
            instrumental_path = wav_render
            instrumental_wav_url = f"/api/files/{wav_render.name}"
            audio_for_judge = wav_render
            await _ws_send(
                ws,
                {
                    "type": "instrumental_wav",
                    "url": instrumental_wav_url,
                    "backend": "neural",
                    "device": neural_result.device,
                },
            )
        else:
            await _ws_send(
                ws,
                {
                    "type": "warn",
                    "message": (
                        f"MusicGen 生成失败（{neural_result.error or 'unknown'}），"
                        "将尝试 FluidSynth 规则渲染。"
                    ),
                },
            )
    elif compose_backend == "neural" and neural_preferred and not neural_ok:
        await _ws_send(
            ws,
            {
                "type": "warn",
                "message": f"跳过 MusicGen：{neural_skip_reason}。将使用 FluidSynth 渲染。",
            },
        )

    if settings.midi_render_wav and final_mid.is_file() and instrumental_path is None:
        sf2 = resolve_soundfont_sf2(settings.soundfont_sf2_path)
        if not sf2:
            await _ws_send(
                ws,
                {
                    "type": "warn",
                    "message": (
                        "已开启 MIDI_RENDER_WAV，但未找到 SoundFont（.sf2）。"
                        "请设置 SOUNDFONT_SF2_PATH，或将 GeneralUser-GS.sf2 等放入 "
                        "Music_Agent/.data/soundfonts/。"
                    ),
                },
            )
        else:
            await _ws_send(
                ws,
                {
                    "type": "stage",
                    "stage": "render_wav",
                    "message": "FluidSynth 渲染立体声 WAV（GM 采样）…",
                },
            )
            wav_render = out_dir / f"{stem}_instrumental.wav"
            compose_style = str(
                intent.get("style") or intent.get("harmony_style") or "",
            ).strip().lower()
            ok_wav = await asyncio.to_thread(
                render_midi_to_wav,
                final_mid,
                wav_render,
                soundfont_path=sf2,
                fluidsynth_bin=settings.fluidsynth_path,
                sample_rate=int(settings.midi_render_sample_rate),
                gain=float(settings.midi_render_gain),
                style_hint=compose_style,
                ffmpeg_bin=settings.ffmpeg_path,
            )
            if ok_wav:
                target_sec = int(current_intent.get("duration_seconds") or 0)
                actual_sec = await asyncio.to_thread(_ffprobe_duration_seconds, wav_render)
                if target_sec > 0 and actual_sec and actual_sec > target_sec + 0.75:
                    trimmed = out_dir / f"{stem}_instrumental_trim.wav"
                    ok_trim = await asyncio.to_thread(
                        _trim_audio_to_seconds,
                        wav_render,
                        trimmed,
                        float(target_sec),
                        ffmpeg_bin=settings.ffmpeg_path,
                    )
                    if ok_trim:
                        try:
                            wav_render.unlink(missing_ok=True)
                        except OSError:
                            pass
                        trimmed.rename(wav_render)
                instrumental_path = wav_render
                instrumental_wav_url = f"/api/files/{wav_render.name}"
                await _ws_send(
                    ws,
                    {"type": "instrumental_wav", "url": instrumental_wav_url},
                )
                audio_for_judge = wav_render

                if settings.midi_render_mp3:
                    mp3_out = out_dir / f"{stem}_instrumental.mp3"
                    ok_mp3 = await asyncio.to_thread(
                        wav_to_mp3,
                        wav_render,
                        mp3_out,
                        ffmpeg_bin=settings.ffmpeg_path,
                    )
                    if ok_mp3:
                        instrumental_mp3_url = f"/api/files/{mp3_out.name}"
                        await _ws_send(
                            ws,
                            {"type": "instrumental_mp3", "url": instrumental_mp3_url},
                        )
            else:
                await _ws_send(
                    ws,
                    {
                        "type": "warn",
                        "message": (
                            "FluidSynth 渲染失败。请确认已安装 FluidSynth 且 "
                            "FLUIDSYNTH_PATH 指向可执行文件，或已将 fluidsynth 加入 PATH。"
                        ),
                    },
                )

    if (
        settings.enable_llm_judge
        and audio_for_judge
        and audio_for_judge.is_file()
        and settings.judge_audio_with_omni
        and settings.judge_omni_once_after_compose
    ):
        await _ws_send(
            ws,
            {
                "type": "stage",
                "stage": "judge",
                "message": "听感终审（Qwen-Omni，器乐 WAV）…",
            },
        )
        emit_omni = (
            _thinking_emit_factory(loop, ws, "judge_omni")
            if getattr(settings, "stream_model_thinking", True)
            else None
        )
        judge_result = await asyncio.to_thread(
            judge_composition,
            settings,
            user_prompt=user_prompt_for_judge,
            intent=current_intent,
            technical_summary=last_tech,
            audio_path=audio_for_judge,
            force_audio_judge=True,
            stream_emit=emit_omni,
        )
        await _ws_send(ws, {"type": "thinking_end", "phase": "judge_omni"})
        await _ws_send(ws, {"type": "judge", "data": judge_result})

    if active_session_id in _COMPOSE_SESSIONS:
        _COMPOSE_SESSIONS[active_session_id].last_intent = dict(current_intent)
        _COMPOSE_SESSIONS[active_session_id].created = time.time()

    done_body = finalize_music_ws_done(
        {
            "midi_url": midi_url,
            "instrumental_wav_url": instrumental_wav_url,
            "instrumental_mp3_url": instrumental_mp3_url,
            "session_id": active_session_id,
            "effective_prompt": user_prompt_for_judge,
            "validation": {
                "ok": validation_report.ok if validation_report else False,
                "issues": validation_report.issues if validation_report else [],
                "notes_snapped": validation_report.notes_snapped if validation_report else 0,
            },
            "judge": judge_result,
            "exports": exp_urls,
            "sections": _sections_for_ws(meta.section_plan),
        },
        trace_id=trace_id,
        started_at=started_at,
        mode="compose",
    )
    append_agent_trace_log(
        agent="music",
        path="/ws",
        trace_id=trace_id,
        ok=bool(done_body.get("agentResult", {}).get("ok")),
        latency_ms=done_body.get("agentResult", {}).get("latency_ms"),
    )
    await _ws_send(ws, {"type": "done", **{k: v for k, v in done_body.items() if k != "agentResult"}, "agentResult": done_body["agentResult"]})


def _payload_bool(v: Any, default: bool = True) -> bool:
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    s = str(v).strip().lower()
    if s in ("0", "false", "no", "off", ""):
        return False
    if s in ("1", "true", "yes", "on"):
        return True
    return default


async def _run_playback_insights(ws: WebSocket, payload: dict[str, Any]) -> None:
    """
    WebSocket 推送：先可视化意图，再四边听感文案（与 HTTP 接口同源逻辑）。
    可选字段 want_visual_intent（默认 true）、want_captions（默认 true）：
    任一为 false 时跳过对应阶段；二者均为 false 时仅 insight_done。
    消息：insight_stage → visual_intent | insight_error → insight_stage →
    listening_stream_begin（首条流式正文前）→（可选多条）listening_caption_chunk → listening_captions | insight_error → insight_done
    """
    rid = str(payload.get("request_id") or "").strip()
    source = str(payload.get("source") or "upload")
    filename = str(payload.get("filename") or "audio.wav")
    raw_intent = payload.get("intent")
    intent_d: dict[str, Any] | None = raw_intent if isinstance(raw_intent, dict) else None
    raw_analysis = payload.get("analysis")
    analysis_d: dict[str, Any] | None = raw_analysis if isinstance(raw_analysis, dict) else None
    dur_raw = payload.get("duration_seconds")
    try:
        dur = int(float(dur_raw)) if dur_raw is not None else None
    except (TypeError, ValueError):
        dur = None

    def _wrap(obj: dict[str, Any]) -> dict[str, Any]:
        if rid:
            return {**obj, "request_id": rid}
        return obj

    want_visual = _payload_bool(payload.get("want_visual_intent"), default=True)
    want_captions = _payload_bool(payload.get("want_captions"), default=True)

    if want_visual:
        await _ws_send(ws, _wrap({"type": "insight_stage", "stage": "visual_intent"}))
        try:
            out = await asyncio.to_thread(
                infer_playback_visual_intent,
                settings,
                source=source,
                filename=filename,
                analysis=analysis_d,
                intent=intent_d,
                duration_seconds=dur,
            )
            await _ws_send(ws, _wrap({"type": "visual_intent", "intent": out}))
        except Exception as e:
            logger.exception("ws playback visual intent")
            await _ws_send(ws, _wrap({"type": "insight_error", "phase": "visual_intent", "message": str(e)}))

    saved_fn0 = str(payload.get("saved_filename") or "").strip()
    skip_omni_tl0 = False
    if isinstance(analysis_d, dict):
        lt_chk0 = analysis_d.get("lyrics_timeline")
        if isinstance(lt_chk0, list) and len(lt_chk0) >= 6:
            skip_omni_tl0 = True
    if (
        source.strip().lower() == "upload"
        and saved_fn0
        and not skip_omni_tl0
        and getattr(settings, "enable_playback_omni_insight", False)
    ):
        safe_u0 = Path(saved_fn0).name
        up_path0 = MEDIA_ROOT / safe_u0
        if up_path0.is_file() and up_path0.resolve().parent == MEDIA_ROOT.resolve():
            try:
                d_hint0 = float(dur) if dur is not None else None
            except (TypeError, ValueError):
                d_hint0 = None
            try:
                om_lines0 = await asyncio.to_thread(
                    infer_playback_omni_timeline,
                    settings,
                    up_path0,
                    duration_hint=d_hint0,
                    ffmpeg_bin=settings.ffmpeg_path,
                )
                if om_lines0:
                    await _ws_send(
                        ws,
                        _wrap({"type": "listening_timeline", "lines": om_lines0, "source": "omni"}),
                    )
            except Exception as ex:
                logger.info("playback omni timeline skipped: %s", ex)

    if not want_captions:
        await _ws_send(ws, _wrap({"type": "insight_done"}))
        return

    await _ws_send(ws, _wrap({"type": "insight_stage", "stage": "listening_captions"}))
    out_q: queue.Queue[dict[str, Any] | None] = queue.Queue()

    def _listening_stream_worker() -> None:
        try:
            for ev in stream_listening_captions_events(
                settings,
                source=source,
                filename=filename,
                analysis=analysis_d,
                intent=intent_d,
                duration_seconds=dur,
            ):
                out_q.put(ev)
        except Exception as e:
            logger.exception("ws listening captions stream worker")
            try:
                fb = infer_listening_captions(
                    settings,
                    source=source,
                    filename=filename,
                    analysis=analysis_d,
                    intent=intent_d,
                    duration_seconds=dur,
                )
                out_q.put({"kind": "final", "captions": fb})
            except Exception:
                out_q.put({"kind": "_worker_error", "error": str(e)})
        finally:
            out_q.put(None)

    try:
        begun = False
        threading.Thread(target=_listening_stream_worker, daemon=True).start()
        while True:
            ev = await asyncio.to_thread(out_q.get)
            if ev is None:
                break
            if ev.get("kind") == "_worker_error":
                raise RuntimeError(str(ev.get("error") or "listening stream failed"))
            if ev.get("kind") == "chunk":
                if not begun:
                    await _ws_send(ws, _wrap({"type": "listening_stream_begin"}))
                    begun = True
                await _ws_send(
                    ws,
                    _wrap(
                        {
                            "type": "listening_caption_chunk",
                            "side": ev.get("side"),
                            "chunk": ev.get("chunk") or "",
                        },
                    ),
                )
            elif ev.get("kind") == "final":
                caps = ev.get("captions")
                if isinstance(caps, dict):
                    await _ws_send(ws, _wrap({"type": "listening_captions", "captions": caps}))
    except Exception as e:
        logger.exception("ws listening captions")
        await _ws_send(ws, _wrap({"type": "insight_error", "phase": "listening_captions", "message": str(e)}))

    await _ws_send(ws, _wrap({"type": "insight_done"}))


async def _run_remix(ws: WebSocket, payload: dict) -> None:
    """WebSocket：MIDI 换音色（默认）；音频重演绎需 ENABLE_AUDIO_REMIX=true。"""
    if not getattr(settings, "enable_midi_swap", True) and not getattr(settings, "enable_audio_remix", False):
        await _ws_send(ws, {"type": "error", "message": "重演绎/换音色已关闭"})
        return
    trace_id = str(payload.get("trace_id") or "").strip() or None
    started_at = time.time()
    remix_style = str(payload.get("remix_style") or payload.get("style_id") or "auto").strip().lower()
    prompt = (payload.get("prompt") or payload.get("user_note") or "").strip()
    use_manual_style = bool(remix_style) and remix_style not in ("", "auto")
    timbral_only = bool(getattr(settings, "remix_timbral_only", True))

    raw_name = str(
        payload.get("saved_filename") or payload.get("filename") or ""
    ).strip()
    safe = Path(raw_name).name
    if not safe:
        await _ws_send(ws, {"type": "error", "message": "缺少 saved_filename（请先上传文件）"})
        return

    src = MEDIA_ROOT / safe
    if not src.is_file() or src.resolve().parent != MEDIA_ROOT.resolve():
        await _ws_send(ws, {"type": "error", "message": "上传文件不存在"})
        return

    suffix = src.suffix.lower()
    is_midi_upload = suffix in (".mid", ".midi")
    if not is_midi_upload and not getattr(settings, "enable_audio_remix", False):
        await _ws_send(
            ws,
            {
                "type": "error",
                "message": (
                    "音频重演绎已下线。请上传 .mid/.midi 使用「换乐器」，"
                    "或在「AI 作曲」中描述需求生成新曲。"
                ),
            },
        )
        return
    if not getattr(settings, "enable_midi_swap", True) and is_midi_upload:
        await _ws_send(ws, {"type": "error", "message": "MIDI 换音色已关闭（ENABLE_MIDI_SWAP=false）"})
        return
    if timbral_only and use_manual_style and not is_midi_upload:
        await _ws_send(
            ws,
            {
                "type": "warn",
                "message": "已忽略手动曲风：音频重演绎仅保留主旋律并轻量换乐器",
            },
        )
        use_manual_style = False
        remix_style = "auto"
    elif use_manual_style and remix_style not in REMIX_STYLE_PRESETS:
        await _ws_send(ws, {"type": "error", "message": f"未知曲风: {remix_style}"})
        return

    if suffix not in (".mid", ".midi", ".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"):
        await _ws_send(
            ws,
            {
                "type": "error",
                "message": "仅支持 MIDI 或常见音频格式（wav/mp3/flac/ogg/m4a/aac）",
            },
        )
        return

    ws_mode = "midi_swap" if is_midi_upload else "remix"
    await _ws_send(ws, {"type": "config", "data": {"mode": ws_mode}})
    loop = asyncio.get_running_loop()
    analysis = await asyncio.to_thread(_load_upload_analysis, src)

    if (
        analysis.get("analysis_mode") == "audio"
        and not is_instrumental_audio(analysis)
        and not str(analysis.get("lyrics_text") or "").strip()
    ):
        await _ws_send(
            ws,
            {"type": "stage", "stage": "lyrics", "message": "正在识别歌词（供重演绎参考）…"},
        )
        analysis = await asyncio.to_thread(_ensure_upload_lyrics_analysis, src, analysis)
        if str(analysis.get("lyrics_text") or "").strip():
            await _ws_send(ws, {"type": "analysis_patch", "data": {"lyrics_text": analysis.get("lyrics_text")}})

    auto_style = infer_style_hint(analysis, safe)
    style_auto = not use_manual_style
    if use_manual_style:
        effective_prompt = selection_brief(remix_style) if not prompt else f"{selection_brief(remix_style)} {prompt}"
    else:
        if is_midi_upload:
            effective_prompt = prompt or "MIDI 换乐器：完整保留音符与时长，仅更换 GM 音色，勿重编。"
        elif is_instrumental_audio(analysis):
            effective_prompt = (
                prompt
                or "纯音乐 MP3：other+bass 多轨转写乐队重演绎，保留鼓轨混回，勿单旋律提取。"
            )
        else:
            effective_prompt = (
                prompt
                or "轻量重演绎：完整保留主旋律，仅根据曲气质换乐器与稀疏伴奏，勿全曲重编。"
            )

    if is_midi_upload:
        remix_stage_msg = "正在规划 MIDI 换音色（保留音符）…"
    elif is_instrumental_audio(analysis):
        remix_stage_msg = "正在规划纯音乐乐队重演绎（分轨 + 多轨转 MIDI + 换编制）…"
    else:
        remix_stage_msg = "正在规划算法重演绎方案…"

    await _ws_send(
        ws,
        {"type": "stage", "stage": "remix_intent", "message": remix_stage_msg},
    )
    if getattr(settings, "stream_model_thinking", True):
        _thinking_emit_factory(loop, ws, "remix_intent")
    plan = await asyncio.to_thread(
        build_remix_plan,
        settings,
        analysis=analysis,
        filename=safe,
        user_prompt=effective_prompt,
    )
    if plan.get("style_hint") in (None, "", "auto"):
        plan["style_hint"] = auto_style
    if not plan.get("remix_style"):
        plan["remix_style"] = plan.get("style_hint") or auto_style
    if use_manual_style:
        plan["style_hint"] = remix_style
        plan["remix_style"] = remix_style
        if not is_vocal_pop_analysis(analysis):
            plan["band_parts"] = build_band_parts(remix_style)
            midi_tracks = analysis.get("midi_tracks") or []
            if analysis.get("analysis_mode") == "midi" and midi_tracks:
                plan["track_mappings"] = build_track_mappings_from_roles(
                    midi_tracks, plan["band_parts"]
                )
                plan["midi_tracks"] = midi_tracks
                plan["remix_mode"] = "midi_swap"
            else:
                plan["track_mappings"] = band_parts_to_track_mappings(plan["band_parts"])
    plan = apply_vocal_pop_plan(plan, analysis=analysis, settings=settings)
    plan = apply_timbral_remix_defaults(plan, analysis=analysis, settings=settings)
    if is_instrumental_audio(analysis) and not is_midi_upload:
        plan = apply_instrumental_remix_plan(plan, analysis=analysis, settings=settings)
    plan["style_auto"] = style_auto
    plan["recommended_style"] = auto_style
    await _ws_send(ws, {"type": "thinking_end", "phase": "remix_intent"})
    await _ws_send(
        ws,
        {
            "type": "remix_plan",
            "data": {
                **plan,
                "style_label": style_label(str(plan.get("remix_style") or auto_style)),
            },
        },
    )

    base_stem = f"remix_{uuid.uuid4().hex[:10]}"
    max_try = max(1, int(getattr(settings, "remix_max_attempts", 2)))
    if not settings.enable_llm_judge:
        max_try = 1
    threshold = max(1, min(10, int(getattr(settings, "remix_quality_score_threshold", 7))))

    current_plan: dict[str, Any] = dict(plan)
    judge_result: dict | None = None
    art = None
    last_tech = ""

    for attempt in range(max_try):
        stage_msg = f"算法重演绎（第 {attempt + 1}/{max_try} 次）…"
        if is_midi_upload:
            await _ws_send(
                ws,
                {"type": "stage", "stage": "remap", "message": stage_msg + " MIDI 改音色"},
            )
        else:
            await _ws_send(
                ws,
                {
                    "type": "stage",
                    "stage": "separate",
                    "message": stage_msg + " 分轨 / 转 MIDI / 改音色",
                },
            )

        try:
            art = await asyncio.to_thread(
                run_remix_stages,
                settings=settings,
                src_path=src,
                analysis=analysis,
                plan=current_plan,
                out_dir=out_dir,
                stem_prefix=f"{base_stem}_a{attempt}",
            )
        except Exception as ex:
            logger.exception("remix pipeline")
            await _ws_send(ws, {"type": "error", "message": str(ex)})
            return

        for w in art.warnings:
            await _ws_send(ws, {"type": "warn", "message": w})

        if art.remixed_midi and art.remixed_midi.is_file():
            await _ws_send(
                ws,
                {
                    "type": "midi",
                    "url": f"/api/files/{art.remixed_midi.name}",
                    "bars": 0,
                },
            )
        if art.remap_report:
            await _ws_send(ws, {"type": "remix_remap", "data": art.remap_report})

        await _ws_send(
            ws,
            {"type": "stage", "stage": "render_wav", "message": "FluidSynth 渲染…"},
        )
        if art.instrumental_wav and art.instrumental_wav.is_file():
            await _ws_send(
                ws,
                {
                    "type": "instrumental_wav",
                    "url": f"/api/files/{art.instrumental_wav.name}",
                },
            )

        final = art.final_wav or art.instrumental_wav
        if final and final.is_file():
            await _ws_send(
                ws,
                {"type": "remix_wav", "url": f"/api/files/{final.name}"},
            )

        last_tech = technical_summary_for_remix(art, current_plan)
        if is_midi_upload:
            last_tech = f"{_technical_summary_upload_midi(src, analysis)}。{last_tech}"

        if settings.enable_llm_judge:
            await _ws_send(
                ws,
                {"type": "stage", "stage": "judge", "message": "质量评估（文本）…"},
            )
            emit_judge = (
                _thinking_emit_factory(loop, ws, "judge_vl")
                if getattr(settings, "stream_model_thinking", True)
                else None
            )
            judge_intent: dict[str, Any] = {
                "key": "未知",
                "tempo": 100,
                "emotion": "neutral",
                "structure": "remix",
                "instruments": ["remix"],
                "duration_seconds": int(analysis.get("duration_seconds") or 60),
                "style": str(current_plan.get("harmony_style") or "pop"),
                "harmony_style": str(current_plan.get("harmony_style") or "pop"),
                "confidence": float(current_plan.get("confidence") or 0.7),
            }
            judge_result = await asyncio.to_thread(
                judge_composition,
                settings,
                user_prompt=effective_prompt,
                intent=judge_intent,
                technical_summary=last_tech,
                audio_path=None,
                force_audio_judge=False,
                stream_emit=emit_judge,
            )
            await _ws_send(ws, {"type": "thinking_end", "phase": "judge_vl"})
            await _ws_send(ws, {"type": "judge", "data": judge_result})
            overall = int(judge_result.get("overall") or 0)
            if overall >= threshold:
                break
            if attempt < max_try - 1 and getattr(settings, "enable_remix_judge_patch", True):
                await _ws_send(
                    ws,
                    {
                        "type": "stage",
                        "stage": "remix_patch",
                        "message": "根据质检调整重演绎参数…",
                    },
                )
                emit_patch = (
                    _thinking_emit_factory(loop, ws, "remix_patch")
                    if getattr(settings, "stream_model_thinking", True)
                    else None
                )
                patched, patch_note = await asyncio.to_thread(
                    patch_remix_plan_with_judge,
                    settings,
                    user_prompt=effective_prompt,
                    plan=current_plan,
                    judge_result=judge_result,
                    technical_summary=last_tech,
                    attempt_index=attempt,
                )
                await _ws_send(ws, {"type": "thinking_end", "phase": "remix_patch"})
                current_plan = dict(patched)
                await _ws_send(
                    ws,
                    {
                        "type": "remix_plan_patch",
                        "data": {"plan": current_plan, "patch_note": patch_note},
                    },
                )
                await _ws_send(
                    ws,
                    {
                        "type": "warn",
                        "message": f"评分 {overall} 低于 {threshold}，将重试…"
                        + (f"（{patch_note}）" if patch_note else ""),
                    },
                )
        else:
            break

    if art is None:
        await _ws_send(ws, {"type": "error", "message": "重演绎失败"})
        return

    audio_for_judge = art.final_wav or art.instrumental_wav
    if (
        settings.enable_llm_judge
        and audio_for_judge
        and audio_for_judge.is_file()
        and settings.judge_audio_with_omni
        and getattr(settings, "remix_judge_omni_after_render", True)
    ):
        await _ws_send(
            ws,
            {"type": "stage", "stage": "judge", "message": "听感终审（Qwen-Omni）…"},
        )
        emit_omni = (
            _thinking_emit_factory(loop, ws, "judge_omni")
            if getattr(settings, "stream_model_thinking", True)
            else None
        )
        judge_result = await asyncio.to_thread(
            judge_composition,
            settings,
            user_prompt=effective_prompt,
            intent={
                "emotion": "neutral",
                "style": str(current_plan.get("harmony_style") or "pop"),
                "harmony_style": str(current_plan.get("harmony_style") or "pop"),
            },
            technical_summary=last_tech,
            audio_path=audio_for_judge,
            force_audio_judge=True,
            stream_emit=emit_omni,
        )
        await _ws_send(ws, {"type": "thinking_end", "phase": "judge_omni"})
        await _ws_send(ws, {"type": "judge", "data": judge_result})

    remix_mid_url = (
        f"/api/files/{art.remixed_midi.name}"
        if art.remixed_midi and art.remixed_midi.is_file()
        else None
    )
    remix_wav_url = (
        f"/api/files/{audio_for_judge.name}"
        if audio_for_judge and audio_for_judge.is_file()
        else None
    )
    inst_url = (
        f"/api/files/{art.instrumental_wav.name}"
        if art.instrumental_wav and art.instrumental_wav.is_file()
        else None
    )

    done_body = finalize_music_ws_done(
        {
            "midi_url": remix_mid_url,
            "remix_wav_url": remix_wav_url,
            "instrumental_wav_url": inst_url,
            "remix_plan": current_plan,
            "judge": judge_result,
            "stems": art.stems,
            "saved_filename": safe,
            "effective_prompt": prompt,
        },
        trace_id=trace_id,
        started_at=started_at,
        mode="midi_swap" if is_midi_upload else "remix",
    )
    append_agent_trace_log(
        agent="music",
        path="/ws",
        trace_id=trace_id,
        ok=bool(done_body.get("agentResult", {}).get("ok")),
        latency_ms=done_body.get("agentResult", {}).get("latency_ms"),
        detail="remix",
    )
    await _ws_send(ws, {"type": "done", **{k: v for k, v in done_body.items() if k != "agentResult"}, "agentResult": done_body["agentResult"]})


@app.websocket("/ws")
async def websocket_compose(ws: WebSocket):
    try:
        auth_from_websocket(ws)
    except ClawhiveAuthError:
        await ws.close(code=1008, reason="login_required")
        return
    await ws.accept()
    try:
        raw = await ws.receive_text()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            await _ws_send(ws, {"type": "error", "message": "无效的 JSON"})
            return
        action = (payload.get("type") or payload.get("action") or "").strip().lower()
        if action in ("compose", "generate", "music"):
            await _run_compose(ws, payload)
        elif action in ("playback_insight", "playback_insights", "music_insight"):
            await _run_playback_insights(ws, payload)
        elif action in ("remix", "rearrange", "music_remix", "midi_swap"):
            await _run_remix(ws, payload)
        else:
            await _ws_send(
                ws,
                {
                    "type": "error",
                    "message": "未知 action；创作 type: compose，MIDI 换音色 type: midi_swap，听感 type: playback_insight",
                },
            )
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.exception("ws error")
        try:
            await _ws_send(ws, {"type": "error", "message": str(e)})
        except Exception:
            pass


_dist = (settings.music_frontend_dist or "").strip()
if _dist:
    _dp = Path(_dist)
    if _dp.is_dir():
        app.mount("/", StaticFiles(directory=str(_dp), html=True), name="frontend")
    else:
        logger.warning("MUSIC_FRONTEND_DIST 已设置但不是目录: %s", _dist)
