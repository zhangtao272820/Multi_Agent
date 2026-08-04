import json
import logging
import time
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import get_settings, resolve_proj_path
from .graph import build_video_graph, initial_state
from .agent_result import build_video_agent_result
from .trace_log import append_agent_trace_log
from .browser_auth import ClawhiveBrowserAuthMiddleware, install_auth_config_route, auth_from_websocket, ClawhiveAuthError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Video Agent API", version="0.1.0")
settings = get_settings()

_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["http://localhost:56291", "http://127.0.0.1:56291"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(ClawhiveBrowserAuthMiddleware, extra_public=("/api/probe",))
install_auth_config_route(app)

_out = resolve_proj_path(settings.output_dir)
_out.mkdir(parents=True, exist_ok=True)
app.mount("/api/video/out", StaticFiles(directory=str(_out)), name="video_out")

_compiled_graph = None


def _get_graph():
    global _compiled_graph
    if _compiled_graph is None:
        _compiled_graph = build_video_graph(settings)
    return _compiled_graph


async def _ws_send(ws: WebSocket, payload: dict) -> None:
    await ws.send_text(json.dumps(payload, ensure_ascii=False))


@app.get("/api/health")
def health():
    return {"ok": True, "service": "video-agent"}


@app.websocket("/ws/video")
async def websocket_video(ws: WebSocket):
    try:
        auth_from_websocket(ws)
    except ClawhiveAuthError:
        await ws.close(code=1008, reason="login_required")
        return
    await ws.accept()
    graph = _get_graph()
    started_at = time.time()
    trace_id: str | None = None
    try:
        raw = await ws.receive_text()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            await _ws_send(ws, {"type": "error", "message": "无效的 JSON"})
            return

        trace_id = str(payload.get("trace_id") or "").strip() or None

        action = (payload.get("type") or payload.get("action") or "").strip().lower()
        if action not in ("generate", "video", "compose"):
            await _ws_send(ws, {"type": "error", "message": "未知 type，请使用 type: generate"})
            return

        prompt = (payload.get("prompt") or payload.get("user_prompt") or "").strip()
        if not prompt:
            await _ws_send(ws, {"type": "error", "message": "prompt 不能为空"})
            return

        await _ws_send(ws, {"type": "config", "data": {"qa_max_fail_retries": settings.qa_max_fail_retries}})

        merged: dict = dict(initial_state(prompt))

        async for event in graph.astream(merged, stream_mode="updates"):
            for node_name, delta in event.items():
                if isinstance(delta, dict):
                    merged.update(delta)
                await _ws_send(
                    ws,
                    {
                        "type": "stage",
                        "node": node_name,
                        "delta": delta,
                    },
                )

        result_payload = {
            "user_prompt": merged.get("user_prompt"),
            "orchestrator": merged.get("orchestrator"),
            "shot_script": merged.get("shot_script"),
            "video_prompt": merged.get("video_prompt"),
            "negative_prompt": merged.get("negative_prompt"),
            "video_url": merged.get("video_url"),
            "video_meta": merged.get("video_meta"),
            "bgm_url": merged.get("bgm_url"),
            "bgm_meta": merged.get("bgm_meta"),
            "final_video_url": merged.get("final_video_url") or merged.get("video_url"),
            "final_video_meta": merged.get("final_video_meta"),
            "audio_url": merged.get("bgm_url"),
            "final_audio_url": merged.get("bgm_url"),
            "music_brief": merged.get("bgm_meta", {}).get("music_brief") if isinstance(merged.get("bgm_meta"), dict) else None,
            "quality_result": merged.get("quality_result"),
            "qa_failures": merged.get("qa_failures"),
            "error": merged.get("error"),
        }
        latency_ms = int((time.time() - started_at) * 1000)
        agent_result = build_video_agent_result(result_payload, trace_id=trace_id, latency_ms=latency_ms)
        append_agent_trace_log(
            agent="video",
            path="/ws/video",
            trace_id=trace_id,
            ok=bool(agent_result.get("ok")),
            latency_ms=latency_ms,
        )
        await _ws_send(
            ws,
            {
                "type": "done",
                "result": result_payload,
                "agentResult": agent_result,
                **result_payload,
            },
        )
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.exception("ws/video error")
        try:
            await _ws_send(ws, {"type": "error", "message": str(e)})
        except Exception:
            pass


_vdist = (settings.video_frontend_dist or "").strip()
if _vdist:
    _dp = Path(_vdist)
    if _dp.is_dir():
        app.mount("/", StaticFiles(directory=str(_dp), html=True), name="frontend")
    else:
        logger.warning("VIDEO_FRONTEND_DIST 已设置但不是目录: %s", _vdist)


def _run_uvicorn():
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=False,
    )


if __name__ == "__main__":
    _run_uvicorn()
