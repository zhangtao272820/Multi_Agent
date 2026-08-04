import asyncio
import base64
import json
import logging
import queue
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .agent import MultimodalAgent
from .agent_result import build_multimodal_agent_result
from .config import PROJECT_ROOT, get_settings, resolve_proj_path
from .trace_log import append_agent_trace_log
from .browser_auth import ClawhiveBrowserAuthMiddleware, install_auth_config_route, auth_from_websocket, ClawhiveAuthError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Multimodal Agent API", version="0.1.0")
settings = get_settings()
agent = MultimodalAgent(settings)

_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["http://localhost:13107"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(ClawhiveBrowserAuthMiddleware, extra_public=("/api/probe", "/api/multimodal/out"))
install_auth_config_route(app)

_out = resolve_proj_path(settings.output_dir)
_out.mkdir(parents=True, exist_ok=True)
_upload = resolve_proj_path(settings.upload_dir)
_upload.mkdir(parents=True, exist_ok=True)
app.mount("/api/multimodal/out", StaticFiles(directory=str(_out)), name="multimodal_out")


async def _save_upload(file: UploadFile) -> Path:
    if not file.filename:
        raise HTTPException(400, "缺少文件名")
    data = await file.read()
    if not data:
        raise HTTPException(400, "空文件")
    name = f"{uuid.uuid4().hex[:10]}_{file.filename}"
    if file.content_type and file.content_type.startswith("image/"):
        return agent.image.save_upload(data, name)
    if file.content_type and file.content_type.startswith("video/"):
        dest = _upload / name
        dest.write_bytes(data)
        return dest
    if file.content_type and file.content_type.startswith("audio/"):
        return agent.audio.save_upload(data, name)
    dest = _upload / name
    dest.write_bytes(data)
    return dest


class UnifiedRequest(BaseModel):
    query: str = ""
    media_type: str = "image"
    action: str = "understand"
    file_path: str | None = None
    trace_id: str | None = None


def _resolve_trace_id(request: Request | None, body_trace: str | None = None) -> str | None:
    if request is not None:
        hdr = str(request.headers.get("x-trace-id") or request.headers.get("x-run-id") or "").strip()
        if hdr:
            return hdr
    tid = str(body_trace or "").strip()
    return tid or None


def _attach_multimodal_contract(
    payload: dict[str, Any],
    *,
    trace_id: str | None,
    started_at: float,
    path: str,
    media_type: str,
) -> dict[str, Any]:
    latency_ms = int((time.time() - started_at) * 1000)
    agent_result = build_multimodal_agent_result(
        payload,
        trace_id=trace_id,
        latency_ms=latency_ms,
        media_type=media_type,
    )
    append_agent_trace_log(
        agent="multimodal",
        path=path,
        trace_id=trace_id,
        ok=bool(agent_result.get("ok")),
        latency_ms=latency_ms,
    )
    if isinstance(payload, dict):
        out = dict(payload)
        out["agentResult"] = agent_result
        return out
    return {"result": payload, "agentResult": agent_result}


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "service": "multimodal-agent",
        "vl_model": settings.qwen_vl_model,
        "helper_model": settings.qwen_helper_model,
        "use_helper": settings.use_helper_for_vision,
        "music_agent": settings.music_agent_http_url,
        "video_agent": settings.video_agent_http_url,
        "music_agent_ui": settings.music_agent_ui_url,
        "video_agent_ui": settings.video_agent_ui_url,
    }


@app.get("/api/probe")
def probe():
    return {
        "ok": True,
        "capabilities": ["image", "video", "audio"],
        "music_agent_ui": settings.music_agent_ui_url,
        "video_agent_ui": settings.video_agent_ui_url,
    }


@app.post("/api/multimodal/analyze")
async def analyze(
    file: UploadFile = File(...),
    media_type: str = Form("image"),
    question: str = Form(""),
):
    path = await _save_upload(file)
    mt = media_type.strip().lower()
    if mt.startswith("vid"):
        return agent.analyze_video(path, question)
    if mt.startswith("aud"):
        return agent.transcribe_audio(path)
    return agent.analyze_image(path, question)


@app.post("/api/multimodal/describe")
async def describe(file: UploadFile = File(...), media_type: str = Form("image")):
    path = await _save_upload(file)
    mt = media_type.strip().lower()
    if mt.startswith("vid"):
        r = agent.analyze_video(path)
        return {"description": r.get("summary") or r.get("description"), **r}
    if mt.startswith("aud"):
        r = agent.transcribe_audio(path)
        return {"description": r.get("transcript"), **r}
    r = agent.analyze_image(path)
    return {"description": r.get("description"), **r}


@app.post("/api/multimodal/qa")
async def qa(
    file: UploadFile = File(...),
    question: str = Form(...),
    media_type: str = Form("image"),
):
    path = await _save_upload(file)
    return agent.multimodal_qa(path, question, media_type.strip().lower())


@app.post("/api/multimodal/unified")
async def unified(body: UnifiedRequest, request: Request):
    started = time.time()
    trace_id = _resolve_trace_id(request, body.trace_id)
    fp = Path(body.file_path) if body.file_path else None
    if fp and not fp.is_absolute():
        fp = resolve_proj_path(body.file_path)
    raw = agent.unified_understand(
        file_path=fp,
        media_type=body.media_type,
        query=body.query,
        action=body.action,
    )
    return _attach_multimodal_contract(
        raw if isinstance(raw, dict) else {"result": raw},
        trace_id=trace_id,
        started_at=started,
        path="/api/multimodal/unified",
        media_type=body.media_type,
    )


def _path_for_manager(path: Path) -> str:
    try:
        return str(path.relative_to(PROJECT_ROOT)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


@app.post("/api/multimodal/upload")
async def upload_only(
    file: UploadFile = File(...),
    media_type: str = Form(""),
):
    """仅保存附件，返回供总管 Agent unified 调用的相对 file_path。"""
    path = await _save_upload(file)
    ct = (file.content_type or "").lower()
    mt = (media_type or "").strip().lower()
    if not mt:
        if ct.startswith("video/"):
            mt = "video"
        elif ct.startswith("audio/"):
            mt = "audio"
        else:
            mt = "image"
    return {
        "ok": True,
        "file_path": _path_for_manager(path),
        "media_type": mt,
        "filename": file.filename or path.name,
    }


@app.post("/api/multimodal/unified/upload")
async def unified_upload(
    request: Request,
    file: UploadFile = File(...),
    query: str = Form(""),
    media_type: str = Form("image"),
    action: str = Form("understand"),
):
    started = time.time()
    trace_id = _resolve_trace_id(request)
    path = await _save_upload(file)
    raw = agent.unified_understand(file_path=path, media_type=media_type, query=query, action=action)
    return _attach_multimodal_contract(
        raw if isinstance(raw, dict) else {"result": raw},
        trace_id=trace_id,
        started_at=started,
        path="/api/multimodal/unified/upload",
        media_type=media_type,
    )


async def _ws_send(ws: WebSocket, payload: dict) -> None:
    await ws.send_text(json.dumps(payload, ensure_ascii=False))


async def _run_understand_with_stages(
    ws: WebSocket,
    *,
    file_path: Path | None,
    media_type: str,
    query: str,
    trace_id: str | None = None,
) -> None:
    started = time.time()
    stage_q: queue.Queue[tuple[str, str]] = queue.Queue()
    loop = asyncio.get_running_loop()

    def on_stage(node: str, message: str) -> None:
        loop.call_soon_threadsafe(stage_q.put_nowait, (node, message))

    async def pump_stages(task: asyncio.Task) -> None:
        while not task.done() or not stage_q.empty():
            try:
                while True:
                    node, message = stage_q.get_nowait()
                    await _ws_send(ws, {"type": "stage", "node": node, "message": message})
            except queue.Empty:
                pass
            if not task.done():
                await asyncio.sleep(0.04)

    await _ws_send(ws, {"type": "stage", "node": "start", "message": "接收任务，准备分析…"})
    task = asyncio.create_task(
        asyncio.to_thread(
            agent.unified_understand,
            file_path=file_path,
            media_type=media_type,
            query=query,
            action="understand",
            on_stage=on_stage,
        )
    )
    await pump_stages(task)
    res = await task
    wrapped = _attach_multimodal_contract(
        res if isinstance(res, dict) else {"result": res},
        trace_id=trace_id,
        started_at=started,
        path="/ws/multimodal",
        media_type=media_type,
    )
    await _ws_send(ws, {"type": "done", "channel": "understand", "result": wrapped, "agentResult": wrapped.get("agentResult")})


def _save_upload_bytes(data: bytes, filename: str, content_type: str = "") -> Path:
    if not data:
        raise ValueError("空文件")
    name = f"{uuid.uuid4().hex[:10]}_{filename or 'upload.bin'}"
    ct = (content_type or "").lower()
    if ct.startswith("image/") or name.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".gif")):
        return agent.image.save_upload(data, name)
    if ct.startswith("audio/") or name.lower().endswith((".wav", ".mp3", ".webm", ".m4a", ".ogg")):
        return agent.audio.save_upload(data, name)
    dest = _upload / name
    dest.write_bytes(data)
    return dest


@app.websocket("/ws/multimodal")
async def websocket_multimodal(ws: WebSocket):
    """实时流：口述转写、生成进度推送。"""
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
        trace_id = str(payload.get("trace_id") or "").strip() or None

        if action in ("ping", "health"):
            await _ws_send(ws, {"type": "pong", "ok": True})
            return

        if action in ("generate_music", "music", "compose", "generate_video", "video_gen"):
            ui = (
                settings.music_agent_ui_url
                if "music" in action
                else settings.video_agent_ui_url
            )
            await _ws_send(
                ws,
                {
                    "type": "error",
                    "message": f"音乐/视频生成已迁移至独立 Agent，请访问 {ui}",
                    "redirect": ui,
                },
            )
            return

        if action in ("understand_upload", "upload", "analyze_upload"):
            b64 = payload.get("file_base64") or payload.get("data")
            if not b64:
                await _ws_send(ws, {"type": "error", "message": "需要 file_base64"})
                return
            try:
                raw_bytes = base64.b64decode(b64)
            except Exception:
                await _ws_send(ws, {"type": "error", "message": "file_base64 无效"})
                return
            try:
                path = _save_upload_bytes(
                    raw_bytes,
                    str(payload.get("filename") or "upload.bin"),
                    str(payload.get("content_type") or ""),
                )
            except ValueError as e:
                await _ws_send(ws, {"type": "error", "message": str(e)})
                return
            query = (payload.get("query") or payload.get("question") or "").strip()
            media_type = (payload.get("media_type") or "image").strip().lower()
            await _run_understand_with_stages(ws, file_path=path, media_type=media_type, query=query, trace_id=trace_id)
            return

        if action in ("transcribe", "asr", "audio"):
            b64 = payload.get("audio_base64") or payload.get("data")
            if not b64:
                await _ws_send(ws, {"type": "error", "message": "需要 audio_base64"})
                return
            try:
                raw_bytes = base64.b64decode(b64)
            except Exception:
                await _ws_send(ws, {"type": "error", "message": "audio_base64 无效"})
                return
            path = agent.audio.save_upload(raw_bytes, f"ws_{uuid.uuid4().hex[:8]}.webm")
            query = (payload.get("query") or payload.get("question") or "").strip()
            await _run_understand_with_stages(
                ws, file_path=path, media_type="audio", query=query, trace_id=trace_id
            )
            return

        if action in ("understand", "analyze", "qa"):
            query = (payload.get("query") or payload.get("question") or "").strip()
            media_type = (payload.get("media_type") or "text").strip().lower()
            file_path = payload.get("file_path")
            fp = Path(file_path) if file_path else None
            if fp and not fp.is_absolute():
                fp = resolve_proj_path(str(file_path))
            await _run_understand_with_stages(ws, file_path=fp, media_type=media_type, query=query, trace_id=trace_id)
            return

        await _ws_send(ws, {"type": "error", "message": f"未知 action: {action}"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.exception("ws/multimodal error")
        try:
            await _ws_send(ws, {"type": "error", "message": str(e)})
        except Exception:
            pass


_dist = (settings.multimodal_frontend_dist or "").strip()
if _dist:
    _dp = Path(_dist)
    if _dp.is_dir():
        app.mount("/", StaticFiles(directory=str(_dp), html=True), name="frontend")
    else:
        logger.warning("MULTIMODAL_FRONTEND_DIST 不是目录: %s", _dist)


def _run_uvicorn():
    import uvicorn

    uvicorn.run("app.main:app", host=settings.api_host, port=settings.api_port, reload=False)


if __name__ == "__main__":
    _run_uvicorn()
