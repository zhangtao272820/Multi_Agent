from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .assets import assets_root, load_audio_cache, load_utterance_links
from .config import get_settings, api_key
from .graph import run_turn
from .pipeline_stream import run_turn_stream
from . import livetalking_client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Virtual Avatar Agent", version="0.3.0")

_root = assets_root(get_settings())
_videos_dir = _root / "videos"
_videos_dir.mkdir(parents=True, exist_ok=True)
_frontend_dist = _root.parent / "frontend" / "dist"


@app.on_event("startup")
async def startup():
    s = get_settings()
    if not api_key(s):
        logger.warning("未配置 DASHSCOPE_API_KEY：WebSocket 处理将报错直至配置 Key")
    lip = (s.lip_sync_mode or "client_rhythm").strip().lower()
    logger.info(
        "lip_sync=%s stream_llm=%s stream_tts=%s",
        lip,
        s.stream_llm,
        s.stream_tts,
    )
    load_utterance_links(s)


def _setup_cors(application: FastAPI) -> None:
    s = get_settings()
    origins = [o.strip() for o in s.cors_origins.split(",") if o.strip()]
    application.add_middleware(
        CORSMiddleware,
        allow_origins=origins or ["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


_setup_cors(app)


@app.get("/health")
async def health():
    s = get_settings()
    root = assets_root(s)
    frontend_ready = _frontend_dist.exists()
    lip = (s.lip_sync_mode or "client_rhythm").strip().lower()
    lt = None
    if lip == "livetalking":
        lt = livetalking_client.health(s)
    return {
        "ok": True,
        "has_key": bool(api_key(s)),
        "frontend_ready": frontend_ready,
        "lip_sync_mode": s.lip_sync_mode,
        "stream_llm": s.stream_llm,
        "stream_tts": s.stream_tts,
        "lipsync_service_url": s.lipsync_service_url,
        "lipsync_backend": s.lipsync_backend,
        "livetalking_url": s.livetalking_url,
        "livetalking_webrtc_url": s.livetalking_webrtc_url or s.livetalking_url,
        "livetalking": lt,
        "rag_enabled": s.rag_enabled,
        "director_enabled": s.director_enabled,
        "llm_model": s.llm_model,
        "asr_model": s.asr_model,
        "tts_model": s.tts_model,
        "wan_s2v_model": s.wan_s2v_model,
        "cache_videos_dir": str(root / "videos"),
    }


def _ws_payload(data: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in data.items() if not isinstance(v, (bytes, bytearray))}


def _api_base_from_ws(ws: WebSocket) -> str:
    host = ws.headers.get("host") or "127.0.0.1:8080"
    scheme = "https" if ws.url.scheme == "wss" else "http"
    return f"{scheme}://{host}"


def _use_streaming_pipeline(lip_mode: str) -> bool:
    """流式 LLM/TTS；livetalking 边合成边喂；遗留模式结束后再生成。"""
    return lip_mode in (
        "",
        "client_rhythm",
        "livetalking",
        "cached_s2v",
        "wan_s2v",
        "local_ultralight",
        "local_wav2lip",
        "local_lipsync",
    )


@app.websocket("/ws")
async def websocket_session(ws: WebSocket):
    await ws.accept()
    settings = get_settings()
    api_base = _api_base_from_ws(ws)
    lip_mode = (settings.lip_sync_mode or "client_rhythm").strip().lower()
    use_stream = _use_streaming_pipeline(lip_mode)

    try:
        await ws.send_json(
            {
                "type": "ready",
                "payload": {
                    "message": "已连接",
                    "lip_sync_mode": lip_mode,
                    "streaming": use_stream,
                    "livetalking_url": settings.livetalking_url,
                    "livetalking_webrtc_url": settings.livetalking_webrtc_url
                    or settings.livetalking_url,
                    "livetalking_offer_url": livetalking_client.webrtc_offer_url(
                        settings
                    ),
                    "rag_enabled": settings.rag_enabled,
                    "director_enabled": settings.director_enabled,
                },
            }
        )
    except Exception:
        return

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "payload": {"message": "JSON 无效"}})
                continue

            mtype = msg.get("type")
            if mtype == "interrupt":
                payload = msg.get("payload") or {}
                sid = payload.get("livetalking_sessionid")
                if sid is not None and sid != "":
                    await asyncio.to_thread(
                        livetalking_client.interrupt,
                        settings,
                        session_id=sid,
                    )
                await ws.send_json({"type": "interrupted", "payload": {"ok": True}})
                continue

            if mtype != "utterance":
                await ws.send_json(
                    {"type": "error", "payload": {"message": f"未知 type: {mtype}"}}
                )
                continue

            payload = msg.get("payload") or {}
            mode = payload.get("mode", "audio")
            initial: dict[str, Any] = {"mode": mode}
            if payload.get("livetalking_sessionid") is not None:
                initial["livetalking_sessionid"] = payload.get("livetalking_sessionid")

            if mode == "text":
                initial["user_text"] = str(payload.get("text") or "")
            else:
                mime = str(payload.get("mime") or "audio/webm")
                b64 = payload.get("audio_base64")
                if not b64:
                    await ws.send_json(
                        {"type": "error", "payload": {"message": "audio 模式需要 audio_base64"}}
                    )
                    continue
                try:
                    initial["audio_bytes"] = base64.b64decode(b64, validate=True)
                except Exception:
                    await ws.send_json(
                        {"type": "error", "payload": {"message": "audio_base64 解码失败"}}
                    )
                    continue
                initial["audio_mime"] = mime

            if not api_key(settings):
                await ws.send_json(
                    {
                        "type": "error",
                        "payload": {"message": "服务器未配置 DASHSCOPE_API_KEY"},
                    }
                )
                continue

            await ws.send_json({"type": "pipeline_started", "payload": {"mode": mode}})

            if use_stream:
                loop = asyncio.get_running_loop()
                outbound: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue()

                def emit(event: str, pl: dict[str, Any]) -> None:
                    loop.call_soon_threadsafe(outbound.put_nowait, (event, pl))

                async def forward_events() -> None:
                    while True:
                        event, pl = await outbound.get()
                        await ws.send_json(
                            {"type": event, "payload": _ws_payload(pl)}
                        )
                        if event in ("done", "error"):
                            return

                def work_stream() -> None:
                    try:
                        run_turn_stream(
                            settings,
                            initial,
                            emit,
                            api_base=api_base,
                        )
                    except Exception as ex:
                        logger.exception("stream pipeline")
                        emit("error", {"message": str(ex)})

                forwarder = asyncio.create_task(forward_events())
                await asyncio.to_thread(work_stream)
                await forwarder
                continue

            # —— 非流式（含对口型遗留路径）——
            if lip_mode in ("cached_s2v", "wan_s2v", "local_ultralight", "local_wav2lip", "local_lipsync"):
                await ws.send_json(
                    {
                        "type": "lip_sync",
                        "payload": {
                            "status": "generating",
                            "hint": "正在生成或读取对口型视频（缓存命中则较快）…",
                            "deprecated": True,
                        },
                    }
                )

            def work():
                return run_turn(settings, initial)  # type: ignore[arg-type]

            try:
                result = await asyncio.to_thread(work)
            except Exception as ex:
                logger.exception("pipeline")
                await ws.send_json({"type": "error", "payload": {"message": str(ex)}})
                continue

            if result.get("error"):
                await ws.send_json({"type": "error", "payload": {"message": result["error"]}})
                continue

            await ws.send_json(
                {
                    "type": "transcript",
                    "payload": {
                        "text": result.get("transcript", ""),
                        "emotion": result.get("emotion"),
                    },
                }
            )
            await ws.send_json({"type": "reply", "payload": {"text": result.get("reply", "")}})

            lip = result.get("lip_sync") or {}
            await ws.send_json(
                {
                    "type": "lip_sync",
                    "payload": _ws_payload({**lip, "status": "done"}),
                }
            )

            play_path = lip.get("play_path")
            s2v_ok = bool(play_path and not lip.get("fallback"))
            if s2v_ok:
                asset_id = str(lip.get("asset_id") or "")
                av_pl: dict[str, Any] = {
                    "url": f"{api_base}{play_path}",
                    "cache_hit": bool(lip.get("cache_hit")),
                    "utterance_cache_hit": bool(lip.get("utterance_cache_hit")),
                    "asset_id": asset_id,
                    "sync_mode": "embedded",
                }
                disk_audio = load_audio_cache(settings, asset_id) if asset_id else None
                tts_b64 = result.get("tts_audio_b64")
                if disk_audio:
                    av_pl["tts_mime"] = disk_audio[1]
                    av_pl["tts_base64"] = base64.b64encode(disk_audio[0]).decode(
                        "ascii"
                    )
                elif tts_b64:
                    from . import assets as assets_mod

                    av_pl["tts_mime"] = result.get("tts_mime") or "audio/wav"
                    av_pl["tts_base64"] = tts_b64
                    av_pl["legacy_cache"] = True
                    if asset_id:
                        try:
                            raw = base64.b64decode(tts_b64)
                            assets_mod.save_audio_cache(
                                settings, asset_id, raw, av_pl["tts_mime"]
                            )
                        except Exception:
                            pass
                if av_pl.get("tts_base64"):
                    av_pl["sync_mode"] = "dual"
                await ws.send_json({"type": "avatar_video", "payload": av_pl})

            audio_b64 = result.get("tts_audio_b64")
            if audio_b64 and not s2v_ok:
                await ws.send_json(
                    {
                        "type": "tts_audio",
                        "payload": {
                            "mime": result.get("tts_mime") or "audio/wav",
                            "base64": audio_b64,
                        },
                    }
                )

            await ws.send_json({"type": "done", "payload": {}})

    except WebSocketDisconnect:
        logger.info("WebSocket 断开")


def _mount_static_files() -> None:
    """静态挂载必须晚于 /ws、/health 注册，否则 WebSocket 会落入 StaticFiles 并报 AssertionError。"""
    app.mount(
        "/cache",
        StaticFiles(directory=str(_videos_dir)),
        name="lip_sync_cache",
    )
    if not _frontend_dist.exists():
        return
    assets_dir = _frontend_dist / "assets"
    if assets_dir.is_dir():
        app.mount(
            "/assets",
            StaticFiles(directory=str(assets_dir)),
            name="frontend_assets",
        )
    app.mount(
        "/",
        StaticFiles(directory=str(_frontend_dist), html=True),
        name="frontend",
    )


_mount_static_files()
