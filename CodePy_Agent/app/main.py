"""CodePy FastAPI entry — Manager-compatible code agent on :13103."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.config import get_settings, reload_settings
from app.protocol.events import ws_msg
from app.runtime.compute import run_compute
from app.runtime.runner import run_code_task
from app.tools.fs_sandbox import SandboxError, get_root, list_dir, list_tree, read_file, write_file
from app.tools.search_replace import apply_search_replace, preview_search_replace
from app.pending_patch import combined_patch_text, drop_pending_patch, load_pending_patch
from app.tools.rollback import restore_rollback
from app.tools.shell_sandbox import run_terminal
from app.browser_auth import ClawhiveBrowserAuthMiddleware, install_auth_config_route, auth_from_websocket, ClawhiveAuthError
import subprocess

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIST = ROOT / "frontend" / "dist"
FRONTEND_FALLBACK = ROOT / "frontend" / "dist-fallback"

app = FastAPI(title="CodePy_Agent", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(ClawhiveBrowserAuthMiddleware, extra_public=("/api/probe",))
install_auth_config_route(app)

def _check_internal_token(request: Request) -> None:
    """E5.2：接受 x-agent-service-token 与兼容的 x-clawhive-internal-token。"""
    settings = get_settings()
    token = (
        str(os.getenv("AGENT_SERVICE_TOKEN") or "").strip()
        or str(settings.clawhive_internal_token or "").strip()
        or str(os.getenv("AGENT_INTERNAL_TOKEN") or "").strip()
        or str(os.getenv("MANAGER_OPS_TOKEN") or "").strip()
    )
    mode = str(os.getenv("AGENT_SERVICE_AUTH") or os.getenv("MANAGER_AGENT_SERVICE_AUTH") or "").strip().lower()
    require = mode in ("1", "true", "on", "yes", "require", "required")
    if not token:
        if require:
            raise HTTPException(status_code=503, detail="agent_service_token_not_configured")
        return
    got = (
        request.headers.get("x-agent-service-token")
        or request.headers.get("x-clawhive-internal-token")
        or request.headers.get("x-internal-token")
        or ""
    ).strip()
    if got != token:
        raise HTTPException(status_code=401, detail="unauthorized")


class ComputeBody(BaseModel):
    message: str = Field(min_length=1)
    threadId: str | None = None
    managerTask: dict[str, Any] | None = None
    manager_task_json: str | dict[str, Any] | None = None
    trace_id: str | None = None


class WriteFileBody(BaseModel):
    path: str
    content: str
    root: str | None = None


class SearchReplaceBody(BaseModel):
    patch: str
    root: str | None = None
    apply: bool = False


class GitRestoreBody(BaseModel):
    paths: list[str] = Field(default_factory=list)
    root: str | None = None


class PendingDecideBody(BaseModel):
    pending_id: str = Field(min_length=1)
    decision: str = "确认"
    confirm_token: str = ""
    root: str | None = None
    verify_after_apply: bool | None = None
    verify_command: str | None = None


class RollbackBody(BaseModel):
    rollback_ref: str = Field(min_length=1)
    root: str | None = None


class McpBody(BaseModel):
    jsonrpc: str = "2.0"
    id: Any = 1
    method: str = ""
    params: dict[str, Any] | None = None


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "agent": "code", "service": "CodePy_Agent"}


@app.get("/api/ready")
async def ready() -> dict[str, Any]:
    s = get_settings()
    return {
        "ready": True,
        "has_api_key": bool(s.openai_api_key),
        "project_dir": s.project_dir,
        "write_tool_enabled": s.write_tool_enabled,
    }


@app.get("/api/config")
async def config_info() -> dict[str, Any]:
    s = get_settings()
    return {
        "agent": "code",
        "port": s.port,
        "project_dir": s.project_dir,
        "write_tool_enabled": s.write_tool_enabled,
        "mcp_server": s.mcp_server_enabled,
        "llm": {
            "model": s.openai_model,
            "enable_thinking": s.enable_thinking,
            "json_max_tokens": s.llm_json_max_tokens,
        },
        "protocol": {
            "ws": "/_ws",
            "compute": "POST /api/compute",
            "mcp": "POST /api/mcp",
            "files": "GET /api/files",
        },
    }


@app.post("/api/compute")
async def compute(
    body: ComputeBody,
    request: Request,
    x_trace_id: str | None = Header(default=None, alias="x-trace-id"),
) -> dict[str, Any]:
    _check_internal_token(request)
    trace_id = (body.trace_id or x_trace_id or "").strip() or None
    manager_task = body.managerTask or body.manager_task_json
    return await run_compute(message=body.message, manager_task=manager_task, trace_id=trace_id)


@app.get("/api/files")
async def files(
    path: str = "",
    root: str | None = None,
    tree: int = Query(default=0),
) -> dict[str, Any]:
    try:
        if tree:
            entries = list_tree(root_override=root)
        else:
            entries = list_dir(path, root_override=root)
        return {"ok": True, "root": str(get_root(root)), "entries": entries}
    except SandboxError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.get("/api/file")
async def file_get(
    path: str,
    root: str | None = None,
) -> dict[str, Any]:
    try:
        data = read_file(path, root_override=root)
        return {"ok": True, **data}
    except SandboxError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/write-file")
async def file_write(body: WriteFileBody) -> dict[str, Any]:
    try:
        data = write_file(body.path, body.content, root_override=body.root, require_write_enabled=True)
        return data
    except SandboxError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/search-replace")
async def search_replace(body: SearchReplaceBody) -> dict[str, Any]:
    try:
        if body.apply:
            return apply_search_replace(body.patch, root_override=body.root, require_write_enabled=True)
        return preview_search_replace(body.patch, root_override=body.root)
    except SandboxError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/git-restore")
async def git_restore(body: GitRestoreBody) -> dict[str, Any]:
    """Restore paths via git checkout -- (Manager cancel / failure fallback)."""
    paths = [str(p).strip().replace("\\", "/") for p in (body.paths or []) if str(p).strip()]
    if not paths:
        return {"ok": True, "restored": []}
    root = Path(get_root(body.root)).resolve()
    # Safety: only relative paths under root
    safe: list[str] = []
    for p in paths[:40]:
        if p.startswith("/") or ".." in p.split("/"):
            continue
        cand = (root / p).resolve()
        try:
            cand.relative_to(root)
        except ValueError:
            continue
        safe.append(p)
    if not safe:
        return {"ok": False, "error": "no_safe_paths", "restored": []}
    try:
        proc = subprocess.run(
            ["git", "checkout", "--", *safe],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=30,
        )
        if proc.returncode != 0:
            return {
                "ok": False,
                "error": (proc.stderr or proc.stdout or "git checkout failed")[:400],
                "restored": [],
            }
        return {"ok": True, "restored": safe}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)[:400], "restored": []}


@app.post("/api/pending/decide")
async def pending_decide(body: PendingDecideBody) -> dict[str, Any]:
    pending = load_pending_patch(body.pending_id)
    if not pending:
        raise HTTPException(status_code=404, detail="pending not found")
    dec = str(body.decision or "").strip().lower()
    approve = dec in {"确认", "approve", "confirm", "yes", "y", "ok", "同意"}
    if not approve:
        drop_pending_patch(body.pending_id)
        return {"ok": True, "applied": False, "answer": "已取消写盘，未修改文件。"}
    if not str(body.confirm_token or "").strip():
        return {
            "ok": False,
            "error_code": "blast_radius_confirm_required",
            "answer": "写盘需要 HITL confirm_token。",
            "needs_human_confirm": True,
            "pending_id": body.pending_id,
        }
    settings = get_settings()
    if not settings.write_tool_enabled:
        return {"ok": False, "error_code": "write_disabled", "answer": "WRITE_TOOL_ENABLED=0，拒绝写盘。"}
    patch = combined_patch_text(pending)
    root = body.root or str(pending.get("root") or "") or None
    allowed = pending.get("allowed_paths") if isinstance(pending.get("allowed_paths"), list) else None
    try:
        result = apply_search_replace(
            patch,
            root_override=root,
            require_write_enabled=True,
            allowed_paths=[str(x) for x in (allowed or [])] or None,
            create_rollback=True,
        )
    except SandboxError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not result.get("ok"):
        return {
            "ok": False,
            "applied": False,
            "answer": str(result.get("error") or "apply failed"),
            "meta": result,
        }
    rollback_ref = str(result.get("rollback_ref") or "")
    verify_flag = body.verify_after_apply
    if verify_flag is None:
        verify_flag = bool(pending.get("verify_after_apply"))
    verify_cmd = str(body.verify_command or pending.get("verify_command") or "").strip()
    verify_meta: dict[str, Any] | None = None
    if verify_flag:
        cmd = verify_cmd or "pytest -q"
        verify_meta = run_terminal(cmd, root_override=root, profile="verify")
        if not verify_meta.get("ok"):
            restored = restore_rollback(rollback_ref, root_override=root, require_write_enabled=True)
            drop_pending_patch(body.pending_id)
            return {
                "ok": False,
                "applied": False,
                "rolled_back": True,
                "rollback_ref": rollback_ref,
                "answer": "写盘后验证失败，已自动回滚。",
                "files": result.get("files") or [],
                "verify": verify_meta,
                "restore": restored,
                "meta": result,
            }
    drop_pending_patch(body.pending_id)
    return {
        "ok": True,
        "applied": True,
        "answer": "补丁已写盘。" + (" 验证通过。" if verify_meta else ""),
        "files": result.get("files") or result.get("files_touched") or [],
        "rollback_ref": rollback_ref,
        "verify": verify_meta,
        "meta": result,
    }


@app.post("/api/rollback")
async def api_rollback(body: RollbackBody) -> dict[str, Any]:
    settings = get_settings()
    if not settings.write_tool_enabled:
        return {"ok": False, "error": "write_disabled"}
    return restore_rollback(body.rollback_ref, root_override=body.root, require_write_enabled=True)


@app.post("/api/set-root")
async def set_root(body: dict[str, Any]) -> dict[str, Any]:
    """Update PROJECT_DIR for this process (UI convenience)."""
    root = str(body.get("root") or "").strip()
    if not root:
        raise HTTPException(status_code=400, detail="missing root")
    os.environ["PROJECT_DIR"] = root
    if "ALLOWED_ROOTS" not in os.environ or not os.environ.get("ALLOWED_ROOTS"):
        os.environ["ALLOWED_ROOTS"] = root
    s = reload_settings()
    return {"ok": True, "project_dir": s.project_dir, "allowed_roots": s.allowed_roots}


MCP_TOOLS = [
    {
        "name": "run_code_task",
        "description": "执行 Code Agent 任务（compute/inspect/edit）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "message": {"type": "string"},
                "task_kind": {"type": "string", "enum": ["compute", "inspect", "edit", "script", "auto"]},
                "manager_task_envelope_v2": {"type": "string"},
                "manager_task": {"type": "object"},
                "thread_id": {"type": "string"},
                "root": {"type": "string"},
            },
            "required": ["message"],
        },
    },
    {
        "name": "read_file",
        "description": "读取仓库内文件（相对路径）",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "max_chars": {"type": "number"}},
            "required": ["path"],
        },
    },
    {
        "name": "apply_patch",
        "description": "受控写文件（需 WRITE_TOOL_ENABLED=1）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    },
]


@app.post("/api/mcp")
async def mcp_endpoint(body: McpBody, request: Request) -> dict[str, Any]:
    _check_internal_token(request)
    settings = get_settings()
    if not settings.mcp_server_enabled:
        return {
            "jsonrpc": "2.0",
            "id": body.id,
            "result": {"ok": False, "fallback": "websocket", "answer": "CODE_MCP_SERVER off"},
        }

    method = (body.method or "").strip()
    params = body.params or {}

    if method in ("tools/list", "list_tools"):
        return {"jsonrpc": "2.0", "id": body.id, "result": {"tools": MCP_TOOLS}}

    if method in ("tools/call", "call_tool"):
        name = str(params.get("name") or params.get("tool") or "").strip()
        args = params.get("arguments") if isinstance(params.get("arguments"), dict) else params
        args = args if isinstance(args, dict) else {}

        if name == "run_code_task":
            mt = args.get("manager_task")
            env_v2 = args.get("manager_task_envelope_v2")
            if env_v2 and not mt:
                mt = env_v2
            if args.get("task_kind") and isinstance(mt, dict):
                mt = {**mt, "task_kind": args["task_kind"]}
            elif args.get("task_kind") and not mt:
                mt = {"task_kind": args["task_kind"], "source": "manager"}
            result = await run_code_task(
                message=str(args.get("message") or ""),
                manager_task=mt,
                root=str(args.get("root") or "").strip() or None,
                trace_id=str(args.get("thread_id") or "") or None,
            )
            return {
                "jsonrpc": "2.0",
                "id": body.id,
                "result": {
                    "ok": result.get("ok"),
                    "answer": result.get("answer") or "",
                    "meta": result.get("meta"),
                    "agentResult": result.get("agentResult"),
                    "content": [{"type": "text", "text": result.get("answer") or ""}],
                },
            }

        if name == "read_file":
            try:
                data = read_file(str(args.get("path") or ""), max_chars=args.get("max_chars"))
                return {"jsonrpc": "2.0", "id": body.id, "result": data}
            except SandboxError as e:
                return {"jsonrpc": "2.0", "id": body.id, "error": {"code": -32000, "message": str(e)}}

        if name == "apply_patch":
            try:
                data = write_file(str(args.get("path") or ""), str(args.get("content") or ""), require_write_enabled=True)
                return {"jsonrpc": "2.0", "id": body.id, "result": data}
            except SandboxError as e:
                return {"jsonrpc": "2.0", "id": body.id, "error": {"code": -32000, "message": str(e)}}

        return {
            "jsonrpc": "2.0",
            "id": body.id,
            "result": {"ok": False, "fallback": "websocket", "answer": f"unsupported tool {name}"},
        }

    if method in ("initialize", "notifications/initialized"):
        return {
            "jsonrpc": "2.0",
            "id": body.id,
            "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "code-assist", "version": "0.1.0"}},
        }

    return {"jsonrpc": "2.0", "id": body.id, "error": {"code": -32601, "message": f"method not found: {method}"}}


@app.websocket("/_ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    try:
        auth_from_websocket(websocket)
    except ClawhiveAuthError:
        await websocket.close(code=1008, reason="login_required")
        return
    await websocket.accept()
    # Manager codeClient does not require an open status; UI can ignore

    async def safe_send(event: dict[str, Any]) -> None:
        try:
            await websocket.send_text(json.dumps(event, ensure_ascii=False))
        except Exception:
            pass

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await safe_send({"type": "error", "payload": "消息格式必须为 JSON"})
                await safe_send({"type": "done"})
                continue
            if not isinstance(data, dict):
                continue
            msg_type = str(data.get("type") or "")

            if msg_type == "ping":
                await safe_send({"type": "pong", "payload": int(time.time() * 1000)})
                continue

            if msg_type not in ("agent-chat", "start"):
                continue

            payload = data.get("payload") if isinstance(data.get("payload"), dict) else {}
            message = str(payload.get("message") or payload.get("task") or "").strip()
            if not message:
                await safe_send({"type": "error", "payload": "缺少 message"})
                await safe_send({"type": "done"})
                continue

            manager_task = payload.get("managerTask") or payload.get("manager_task_json")
            envelope = payload.get("manager_task_envelope_v2")
            if envelope and not manager_task:
                manager_task = envelope

            mode = str(payload.get("mode") or "").strip() or None
            root = str(payload.get("root") or "").strip() or None
            trace_id = str(payload.get("trace_id") or payload.get("threadId") or "").strip() or None
            auto_apply = bool(payload.get("auto_apply") or payload.get("autoApply"))

            try:
                await run_code_task(
                    message=message,
                    manager_task=manager_task,
                    mode=mode,
                    root=root,
                    trace_id=trace_id,
                    auto_apply=auto_apply,
                    send=safe_send,
                )
            except Exception as e:  # noqa: BLE001
                await safe_send({"type": "error", "payload": str(e)[:500]})
                await safe_send({"type": "done"})
    except WebSocketDisconnect:
        return


def _static_root() -> Path | None:
    if FRONTEND_DIST.is_dir() and (FRONTEND_DIST / "index.html").is_file():
        return FRONTEND_DIST
    if FRONTEND_FALLBACK.is_dir() and (FRONTEND_FALLBACK / "index.html").is_file():
        return FRONTEND_FALLBACK
    return None


_dist = _static_root()
if _dist is not None:
    assets = _dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/", response_model=None)
    async def index():
        return FileResponse(_dist / "index.html")

    @app.get("/{full_path:path}", response_model=None)
    async def spa_fallback(full_path: str):
        if full_path.startswith("api/") or full_path.startswith("_ws"):
            return JSONResponse({"ok": False, "error": "not found"}, status_code=404)
        candidate = _dist / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_dist / "index.html")
else:

    @app.get("/")
    async def index_fallback() -> dict[str, Any]:
        return {
            "ok": True,
            "agent": "code",
            "service": "CodePy_Agent",
            "hint": "frontend/dist missing — run npm run build in frontend/",
        }


def main() -> None:
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=os.environ.get("CODE_RELOAD", "").lower() in {"1", "true", "yes"},
    )


if __name__ == "__main__":
    main()
