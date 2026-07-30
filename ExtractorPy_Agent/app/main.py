"""ExtractorPy FastAPI entry — Manager-compatible crawler on :13104."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.config import get_settings
from app.protocol.events import ws_msg
from app.runtime.jobs import get_job_store
from app.runtime.runner import run_extract
from app.tools.crw_scrape import probe_crw
from app.tools.playwright_mcp import probe_playwright_mcp
from app.tools.searxng import probe_searxng

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIST = ROOT / "frontend" / "dist"

app = FastAPI(title="ExtractorPy_Agent", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _check_internal_token(request: Request) -> None:
    settings = get_settings()
    token = settings.clawhive_internal_token
    if not token:
        return
    got = (
        request.headers.get("x-clawhive-internal-token")
        or request.headers.get("x-internal-token")
        or ""
    ).strip()
    if got != token:
        raise HTTPException(status_code=401, detail="unauthorized")


class ExtractBody(BaseModel):
    task: str = ""
    manager_task_json: str | dict[str, Any] | None = None
    session_id: str | None = None
    history: list[dict[str, Any]] | None = None
    options: dict[str, Any] | None = None
    trace_id: str | None = None
    network: bool | None = None


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "agent": "crawler", "service": "ExtractorPy_Agent"}


@app.get("/api/ready")
async def ready() -> dict[str, Any]:
    crw = await probe_crw()
    searx = await probe_searxng()
    pw = await probe_playwright_mcp()
    ready_ok = bool(crw.get("ok")) or bool(pw.get("ok"))
    return {
        "ready": ready_ok,
        "crw": crw,
        "searxng": searx,
        "playwright_mcp": pw,
    }


@app.get("/api/config")
async def config_info() -> dict[str, Any]:
    s = get_settings()
    return {
        "agent": "crawler",
        "port": s.port,
        "web_search": s.web_search_enabled,
        "mcp_provider": s.mcp_provider,
        "mcp_base_url": s.mcp_base_url,
        "playwright_mcp_url": s.playwright_mcp_url,
        "async_queue": s.async_queue,
        "llm": {
            "model": s.qwen_model,
            "enable_thinking": s.enable_thinking,
            "json_max_tokens": s.llm_json_max_tokens,
            "max_pages": s.llm_max_pages,
            "page_chars": s.llm_page_chars,
            "capability": "CAP_ROUTE",
        },
        "protocol": {
            "ws": "/_ws",
            "extract": "POST /api/extract",
            "extract_async": "POST /api/extract/async",
            "jobs": "GET /api/jobs/{id}",
        },
    }


@app.post("/api/extract")
async def extract(
    body: ExtractBody,
    request: Request,
    x_trace_id: str | None = Header(default=None, alias="x-trace-id"),
) -> dict[str, Any]:
    _check_internal_token(request)
    task = (body.task or "").strip()
    if not task:
        raise HTTPException(status_code=400, detail="缺少 task")
    trace_id = (body.trace_id or x_trace_id or "").strip() or None
    result = await run_extract(
        task=task,
        manager_task_json=body.manager_task_json,
        options=body.options,
        trace_id=trace_id,
        network=body.network,
    )
    return result


@app.post("/api/extract/async")
async def extract_async(
    body: ExtractBody,
    request: Request,
    x_trace_id: str | None = Header(default=None, alias="x-trace-id"),
) -> dict[str, Any]:
    _check_internal_token(request)
    task = (body.task or "").strip()
    if not task:
        raise HTTPException(status_code=400, detail="缺少 task")
    settings = get_settings()
    if not settings.async_queue:
        # sync fallback shape still returns job? Manager expects job_id — run sync and fake done
        pass
    store = get_job_store()
    job = await store.create()
    trace_id = (body.trace_id or x_trace_id or "").strip() or None

    async def _run() -> None:
        await store.update(job.id, status="running")
        try:
            result = await run_extract(
                task=task,
                manager_task_json=body.manager_task_json,
                options=body.options,
                trace_id=trace_id,
                network=body.network,
            )
            await store.update(job.id, status="done", result=result)
        except Exception as e:  # noqa: BLE001
            await store.update(job.id, status="failed", error=str(e)[:500])

    asyncio.create_task(_run())
    return {"ok": True, "job_id": job.id}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str, request: Request) -> dict[str, Any]:
    _check_internal_token(request)
    store = get_job_store()
    job = await store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return {
        "ok": True,
        "job": {
            "id": job.id,
            "status": job.status,
            "result": job.result,
            "error": job.error,
            "created_at": job.created_at,
            "updated_at": job.updated_at,
        },
    }


@app.websocket("/_ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    await websocket.send_text(ws_msg("status", "open"))
    abort_flag = {"v": False}
    run_task: asyncio.Task[Any] | None = None

    async def send(msg_type: str, payload: Any = None) -> None:
        try:
            await websocket.send_text(ws_msg(msg_type, payload))
        except Exception:
            pass

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await send("error", {"message": "消息格式必须为 JSON"})
                continue
            if not isinstance(data, dict):
                continue
            msg_type = str(data.get("type") or "")

            if msg_type == "ping":
                await send("pong", int(asyncio.get_event_loop().time() * 1000))
                continue

            if msg_type == "cancel":
                abort_flag["v"] = True
                if run_task and not run_task.done():
                    run_task.cancel()
                await send("status", "canceled")
                continue

            if msg_type != "start":
                continue

            payload = data.get("payload") if isinstance(data.get("payload"), dict) else {}
            task = str(payload.get("task") or "").strip()
            if not task:
                await send("error", {"message": "缺少 task"})
                continue

            abort_flag["v"] = False
            if run_task and not run_task.done():
                abort_flag["v"] = True
                run_task.cancel()
                abort_flag["v"] = False

            await send("status", "start")

            async def emit_log(level: str, message: str) -> None:
                await send("log", {"level": level, "message": message, "ts": int(time_ms())})

            async def _do_run() -> None:
                try:
                    net = payload.get("network")
                    network = None if net is None else bool(net)
                    result = await run_extract(
                        task=task,
                        manager_task_json=payload.get("manager_task_json"),
                        options=payload.get("options") if isinstance(payload.get("options"), dict) else None,
                        trace_id=str(payload.get("trace_id") or "").strip() or None,
                        network=network,
                        emit_log=emit_log,
                        aborted=lambda: abort_flag["v"],
                    )
                    await send("result", result)
                    await send("status", "end")
                except asyncio.CancelledError:
                    await send("status", "canceled")
                except Exception as e:  # noqa: BLE001
                    await send("error", {"message": str(e)[:500]})
                    await send("status", "error")

            run_task = asyncio.create_task(_do_run())
    except WebSocketDisconnect:
        abort_flag["v"] = True
        if run_task and not run_task.done():
            run_task.cancel()


def time_ms() -> int:
    import time

    return int(time.time() * 1000)


# Static frontend (built React)
if FRONTEND_DIST.is_dir():
    assets = FRONTEND_DIST / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/", response_model=None)
    async def index():
        return FileResponse(FRONTEND_DIST / "index.html")

    @app.get("/{full_path:path}", response_model=None)
    async def spa_fallback(full_path: str):
        if full_path.startswith("api/") or full_path.startswith("_ws"):
            return JSONResponse({"ok": False, "error": "not found"}, status_code=404)
        candidate = FRONTEND_DIST / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
else:

    @app.get("/")
    async def index_fallback() -> dict[str, Any]:
        return {
            "ok": True,
            "agent": "crawler",
            "service": "ExtractorPy_Agent",
            "hint": "frontend/dist missing — run npm run build in frontend/",
        }


def main() -> None:
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=os.environ.get("EXTRACTOR_RELOAD", "").lower() in {"1", "true", "yes"},
    )


if __name__ == "__main__":
    main()
