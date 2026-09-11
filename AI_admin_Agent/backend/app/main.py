from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from app.core.config import settings
from app.core.llm import qwen_llm
from app.core.internal_auth import accept_websocket_connection, verify_internal_token
from app.core.browser_auth import ClawhiveBrowserAuthMiddleware, install_auth_config_route
from app.core.platform_config import refresh_platform_model_cache
from app.core.token_control import token_controller
from app.core.time_utils import utc_now_naive, utc_naive_to_local_iso
from langchain_core.messages import HumanMessage
from app.graph.state import agent_graph
from app.core.session_dialogue import append_turn, get_last_user_message, truncate_session_from_user_index, ensure_session_dialogue_budget, ensure_session_dialogue_budget, replace_last_assistant_turn
from app.core.admin_write_clarify import resolve_manager_persist_user_message
from app.core.agent_result import build_admin_agent_result
from app.core.prompt_evolution import list_prompt_patches
from app.core.tool_experience_store import get_admin_tool_experience_recall


def _snapshot_admin_evolution_applied(question: str = "") -> dict:
    patches = [
        {"id": str(p.get("id") or ""), "stage": str(p.get("stage") or ""), "hits": int(p.get("hits") or 0)}
        for p in (list_prompt_patches() or [])
        if not p.get("promoted_at") and not p.get("promotedAt")
    ][:4]
    hits = 0
    try:
        hits = len(get_admin_tool_experience_recall(str(question or ""), 2) or [])
    except Exception:
        hits = 0
    return {
        "promptPatches": patches,
        "experienceHits": hits,
    }
from app.core.learning_curator import maybe_run_lightweight_curator
from app.core.langgraph_checkpointer import build_graph_invoke_config
from app.core.admin_stream_thoughts import set_admin_thought_callback
from app.core.admin_turn_cancel import (
    begin_admin_turn_cancel,
    cancel_admin_turn,
    clear_admin_turn_cancel,
)
from app.core.admin_turn_exec import (
    admin_ws_turn_timeout_sec,
    run_agent_graph_invoke,
    run_agent_graph_stream,
)
from app.core.trace_log import append_agent_trace_log
from app.api.ready import router as ready_router
from app.api.internal_skills import router as internal_skills_router
from app.api.learning import router as learning_router
from app.api.integrations import router as integrations_router
from app.api.playground import router as playground_router
from app.api.metrics import router as metrics_router
from app.db.database import get_db, Task, Event, Note
from app.tools.skills import (
    restore_event_reminders,
    list_contacts,
    list_emails,
    get_email_detail,
    reply_email,
    classify_emails,
    list_pending_actions,
)
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List, Dict, Any
import asyncio
import json
import os
import time

app = FastAPI(title=settings.PROJECT_NAME)
app.include_router(ready_router)
app.include_router(internal_skills_router)
app.include_router(learning_router)
app.include_router(integrations_router)
app.include_router(playground_router)
app.include_router(metrics_router)
FRONTEND_DIST_DIR = os.getenv("FRONTEND_DIST_DIR", "/frontend-dist")


@app.on_event("startup")
async def restore_reminders_on_startup():
    refresh_platform_model_cache(force=True)
    restored = restore_event_reminders()
    print(f"DEBUG: restored event reminders count = {restored}")
    try:
        from app.core.tool_experience_store import hydrate_admin_tool_experience_cache

        hydrate_admin_tool_experience_cache()
    except Exception:
        pass
    try:
        from app.core.admin_nlu import warm_admin_nlu_caches

        warm_admin_nlu_caches()
    except Exception:
        pass
    try:
        from app.core.admin_data_dir import migrate_legacy_admin_data

        migrate_legacy_admin_data()
    except Exception:
        pass

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.get_cors_origins(),
    allow_origin_regex=settings.get_cors_origin_regex(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(ClawhiveBrowserAuthMiddleware, extra_public=("/api/probe",))
install_auth_config_route(app)

class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"
    user_id: str | None = None
    # 由总管编排等可信调用方传入：跳过高风险工具的待确认队列，直接执行
    auto_confirm_risky: bool = False
    trace_id: str | None = None
    client_context: Dict[str, Any] | None = None

class ChatResponse(BaseModel):
    response: str
    tokens_used: int
    status: str
    thoughts: List[str] = [] # 新增思考过程字段
    agentResult: Dict[str, Any] | None = None


class ReplyEmailRequest(BaseModel):
    email_id: int
    content: str
    session_id: str = "default"
    user_id: str | None = None


class MailboxBindingRequest(BaseModel):
    user_id: str
    provider: str
    email_address: str
    auth_code: str = ""
    test_first: bool = True


class MailboxTestRequest(BaseModel):
    user_id: str
    provider: str = "qq"
    email_address: str = ""
    auth_code: str = ""


def _require_request_user_id(user_id: str | None, header_user: str | None = None) -> str:
    from app.core.mailbox_binding import sanitize_user_id

    uid = sanitize_user_id(user_id) or sanitize_user_id(header_user)
    if not uid:
        raise HTTPException(status_code=400, detail="user_id required")
    return uid


def _assert_same_user(request_user: str, path_or_body_user: str) -> str:
    from app.core.mailbox_binding import sanitize_user_id

    a = sanitize_user_id(request_user)
    b = sanitize_user_id(path_or_body_user)
    if not a or not b or a != b:
        raise HTTPException(status_code=403, detail="forbidden: user_id mismatch")
    return a


def _activate_request_scope(
    request: Request | None = None,
    *,
    claimed_user: str | None = None,
    claimed_tenant: str | None = None,
    headers: dict | None = None,
):
    """鉴权派生 tenant+user 并写入 contextvars；返回 (tid, uid, token)。"""
    from app.core.browser_auth import auth_from_request, auth_from_websocket, ClawhiveAuthError
    from app.core.tenant_scope import resolve_tenant_user_from_auth, set_request_scope

    hdrs = headers or (dict(request.headers) if request is not None else {})
    lower = {str(k).lower(): str(v) for k, v in hdrs.items()}
    try:
        if request is not None:
            auth = auth_from_request(request)
        else:
            auth = {"mode": "open"}
    except ClawhiveAuthError as exc:
        raise HTTPException(status_code=401, detail=exc.code) from exc
    try:
        tid, uid = resolve_tenant_user_from_auth(
            auth,
            header_tenant=lower.get("x-tenant-id"),
            header_user=lower.get("x-user-id"),
            claimed_tenant=claimed_tenant,
            claimed_user=claimed_user,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    token = set_request_scope(tid, uid)
    return tid, uid, token


class FeedbackRequest(BaseModel):
    question: str
    score: int
    comment: str | None = None
    session_id: str
    turn_id: int | None = None
    user_message_index: int | None = None
    run_id: str | None = None
    artifact: dict | None = None


class ArtifactRevokeRequest(BaseModel):
    run_id: str
    action: str = "revoke"
    artifact: dict | None = None


class FeedbackDeleteRequest(BaseModel):
    session_id: str
    from_turn_id: int | None = None
    from_user_index: int | None = None
    delete_all: bool = False


class SessionTruncateRequest(BaseModel):
    session_id: str
    from_user_index: int | None = None
    from_turn_id: int | None = None
    replace_user_text: str | None = None
    fallback_user_text: str | None = None


class SessionDeleteRequest(BaseModel):
    session_id: str


class PendingDecideRequest(BaseModel):
    session_id: str = "default"
    action_id: int
    decision: str
    mail_compose: dict | None = None


class ComposeRefineRequest(BaseModel):
    content: str
    tone: str = "更正式"
    session_id: str = "default"
    action_id: int | None = None
    subject: str | None = None


def _tool_text(result: Any) -> str:
    """
    Backward-compat extractor for tool outputs.
    - Structured dict: prefer `human_message`.
    - Legacy string: return as-is.
    """
    if isinstance(result, dict):
        msg = result.get("human_message")
        if msg is not None and str(msg).strip():
            return str(msg)
        return json.dumps(result, ensure_ascii=False)
    return str(result)


def _tool_data(result: Any, default: Any) -> Any:
    if isinstance(result, dict):
        data = result.get("data")
        if data is not None:
            return data
    return default


def _tool_items(result: Any) -> list:
    """
    REST list endpoints expect top-level `items: [...]`.
    Tool envelopes use `data: {items: [...], count: N}` — unwrap that shape.
    """
    data = _tool_data(result, None)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        items = data.get("items")
        if isinstance(items, list):
            return items
    return []


def _mail_draft_structured(final_result: Dict[str, Any]) -> dict:
    md = final_result.get("mail_draft") if isinstance(final_result, dict) else None
    if not isinstance(md, dict):
        return {}
    content = str(md.get("draft_content") or md.get("content") or "").strip()
    if not content:
        return {}
    return {"mail_draft": {**md, "content": content, "draft_content": content}, "draft_content": content}


def _calc_total_tokens(result: Dict[str, Any], request_text: str, response_text: str) -> int:
    usage_total = result.get("token_usage", {}).get("total", 0)
    if usage_total and usage_total > 0:
        return usage_total
    return qwen_llm.get_token_count(request_text) + qwen_llm.get_token_count(response_text)


def _graph_response_text(final_result: Dict[str, Any]) -> str:
    """
    从图谱终态取用户可见文案：优先 pending/验证结果与最后一条 AI，避免只剩 HumanMessage 时把用户原话当回复。
    保证总管侧总能拿到可解析的 final 文本（含【待确认】）。
    """
    pending = final_result.get("pending_actions") or []
    vr = str(final_result.get("verification_result") or "").strip()
    if pending and vr:
        return vr
    if vr.startswith("【待确认】") or "处理已取消或超时" in vr:
        return vr
    messages = final_result.get("messages") or []
    for msg in reversed(messages):
        if isinstance(msg, HumanMessage):
            continue
        content = getattr(msg, "content", None)
        text = str(content or "").strip()
        if text:
            return text
    if vr:
        return vr
    return "处理完成"

@app.get("/api/health")
async def health_check():
    llm = qwen_llm.validate_config()
    return {
        "ok": bool(llm.get("ok")),
        "status": "ok" if llm.get("ok") else "degraded",
        "model": settings.MODEL_NAME,
        "llm": llm,
        "timezone": settings.TIMEZONE,
    }


@app.get("/api/location/reverse")
async def reverse_user_location(lng: float, lat: float):
    """浏览器定位坐标 → 文字地址（高德逆地理编码）。"""
    from app.core.amap_client import amap_configured, reverse_geocode

    if not amap_configured():
        raise HTTPException(status_code=503, detail="amap_not_configured")
    result = reverse_geocode(f"{lng},{lat}")
    if not result.get("ok"):
        raise HTTPException(
            status_code=400,
            detail=str(result.get("hint") or result.get("error") or "reverse_geocode_failed"),
        )
    return result


@app.get("/api/amap/map-image")
async def amap_map_image(
    center: str = "",
    zoom: int = 12,
    markers: str = "",
):
    """代理高德静态地图 PNG，供对话卡片内嵌预览。"""
    from app.core.amap_client import amap_configured, fetch_static_map_bytes
    from fastapi.responses import Response

    if not amap_configured():
        raise HTTPException(status_code=503, detail="amap_not_configured")
    parsed: list[tuple[str, str, str]] = []
    for part in str(markers or "").split("|"):
        seg = part.strip()
        if not seg:
            continue
        bits = seg.split(":", 2)
        if len(bits) == 3:
            parsed.append((bits[0], bits[1], bits[2]))
        elif len(bits) == 2:
            parsed.append((bits[0], bits[1], "0x0088FF"))
    raw = fetch_static_map_bytes(markers=parsed, center=str(center or "").strip(), zoom=int(zoom or 12))
    if not raw:
        raise HTTPException(status_code=404, detail="map_image_unavailable")
    return Response(content=raw, media_type="image/png")


# API endpoints per architecture
@app.get("/api/tasks")
async def get_tasks(request: Request, db: Session = Depends(get_db)):
    from app.core.tenant_scope import reset_request_scope

    _tid, _uid, scope_tok = _activate_request_scope(request)
    try:
        tasks = (
            db.query(Task)
            .filter(Task.tenant_id == _tid, Task.user_id == _uid)
            .order_by(Task.created_at.desc())
            .all()
        )
        now = utc_now_naive()
        out = []
        for t in tasks:
            expired = bool(t.due_at and t.due_at < now)
            completed = bool(t.completed or expired)
            out.append(
                {
                    "id": t.id,
                    "title": t.title,
                    "description": t.description or "",
                    "completed": completed,
                    "due_at": utc_naive_to_local_iso(t.due_at) if t.due_at else None,
                    "created_at": utc_naive_to_local_iso(t.created_at) if t.created_at else None,
                    "status": "completed" if completed else "pending",
                }
            )
        return {"tasks": out}
    finally:
        reset_request_scope(scope_tok)


@app.get("/api/tasks/{task_id}")
async def get_task_detail(task_id: int, request: Request, db: Session = Depends(get_db)):
    from app.core.tenant_scope import reset_request_scope

    _tid, _uid, scope_tok = _activate_request_scope(request)
    try:
        task = db.query(Task).filter(Task.id == task_id, Task.tenant_id == _tid, Task.user_id == _uid).first()
    finally:
        reset_request_scope(scope_tok)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    now = utc_now_naive()
    expired = bool(task.due_at and task.due_at < now)
    completed = bool(task.completed or expired)
    return {
        "task": {
            "id": task.id,
            "title": task.title,
            "description": task.description or "",
            "completed": completed,
            "due_at": utc_naive_to_local_iso(task.due_at) if task.due_at else None,
            "created_at": utc_naive_to_local_iso(task.created_at) if task.created_at else None,
            "status": "completed" if completed else "pending",
        }
    }

@app.delete("/api/tasks/{task_id}")
async def delete_task_api(task_id: int, request: Request, db: Session = Depends(get_db)):
    from app.core.tenant_scope import reset_request_scope
    _tid, _uid, scope_tok = _activate_request_scope(request)
    try:
        task = db.query(Task).filter(Task.id == task_id, Task.tenant_id == _tid, Task.user_id == _uid).first()
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        db.delete(task)
        db.commit()
        return {"status": "ok"}
    finally:
        reset_request_scope(scope_tok)

@app.get("/api/calendar")
async def get_calendar(request: Request, db: Session = Depends(get_db)):
    from app.core.tenant_scope import reset_request_scope
    _tid, _uid, scope_tok = _activate_request_scope(request)
    try:
        events = db.query(Event).filter(Event.tenant_id == _tid, Event.user_id == _uid).all()
    finally:
        reset_request_scope(scope_tok)
    now = utc_now_naive()
    return {
        "events": [
            {
                "id": e.id,
                "title": e.title,
                "description": e.description or "",
                "start_time": utc_naive_to_local_iso(e.start_time) if e.start_time else None,
                "end_time": utc_naive_to_local_iso(e.end_time) if e.end_time else None,
                "completed": bool(e.completed or (e.start_time and e.start_time < now)),
                "status": "completed"
                if bool(e.completed or (e.start_time and e.start_time < now))
                else "pending",
            }
            for e in events
        ]
    }


@app.get("/api/calendar/{event_id}")
async def get_event_detail(event_id: int, request: Request, db: Session = Depends(get_db)):
    from app.core.tenant_scope import reset_request_scope
    _tid, _uid, scope_tok = _activate_request_scope(request)
    try:
        event = db.query(Event).filter(Event.id == event_id, Event.tenant_id == _tid, Event.user_id == _uid).first()
    finally:
        reset_request_scope(scope_tok)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    now = utc_now_naive()
    completed = bool(event.completed or (event.start_time and event.start_time < now))
    return {
        "event": {
            "id": event.id,
            "title": event.title,
            "description": event.description or "",
            "start_time": utc_naive_to_local_iso(event.start_time) if event.start_time else None,
            "end_time": utc_naive_to_local_iso(event.end_time) if event.end_time else None,
            "completed": completed,
            "status": "completed" if completed else "pending",
        }
    }


@app.get("/api/notes")
async def get_notes(request: Request, db: Session = Depends(get_db)):
    from app.core.tenant_scope import reset_request_scope
    _tid, _uid, scope_tok = _activate_request_scope(request)
    try:
        notes = db.query(Note).filter(Note.tenant_id == _tid, Note.user_id == _uid).order_by(Note.created_at.desc()).all()
    finally:
        reset_request_scope(scope_tok)
    return {
        "notes": [
            {
                "id": n.id,
                "title": n.title,
                "content": n.content,
                "created_at": utc_naive_to_local_iso(n.created_at) if n.created_at else None,
            }
            for n in notes
        ]
    }


@app.get("/api/notes/{note_id}")
async def get_note_detail(note_id: int, db: Session = Depends(get_db)):
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return {
        "note": {
            "id": note.id,
            "title": note.title,
            "content": note.content,
            "created_at": utc_naive_to_local_iso(note.created_at) if note.created_at else None,
        }
    }


@app.delete("/api/notes/{note_id}")
async def delete_note_api(note_id: int, db: Session = Depends(get_db)):
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    db.delete(note)
    db.commit()
    return {"status": "ok"}

@app.get("/api/contacts")
async def get_contacts(request: Request):
    from app.core.tenant_scope import reset_request_scope
    _tid, _uid, scope_tok = _activate_request_scope(request)
    try:
        result = list_contacts()
        return {"contacts": _tool_text(result), "items": _tool_items(result)}
    finally:
        reset_request_scope(scope_tok)


@app.get("/api/search")
async def api_web_search(q: str = "", mode: str = "general", limit: int = 8):
    from app.core.web_search import run_web_search

    query = str(q or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="query 不能为空")
    max_n = max(1, min(int(limit or 8), 12))
    human, hits, provider = run_web_search(query, max_results=max_n, mode=str(mode or "general"))
    return {
        "ok": bool(hits),
        "query": query,
        "provider": provider,
        "summary": human,
        "hits": hits,
        "count": len(hits),
    }


def _assert_binding_user_allowed(request_user_id: str, auth_user_id: str | None) -> str:
    """When browser JWT is present, body/query user_id must match token sub."""
    from app.core.mailbox_binding import sanitize_user_id

    uid = sanitize_user_id(request_user_id)
    if not uid:
        raise HTTPException(status_code=400, detail="user_id required")
    auth_uid = sanitize_user_id(auth_user_id or "")
    if auth_uid and auth_uid != uid:
        raise HTTPException(status_code=403, detail="forbidden: user_id mismatch")
    return uid


def _jwt_user_from_request(request: Request) -> str | None:
    try:
        from app.core.browser_auth import _bearer, verify_jwt

        auth = request.headers.get("authorization")
        token = _bearer(auth) or str(request.headers.get("x-clawhive-user-token") or "").strip()
        if not token:
            cookie = str(request.headers.get("cookie") or "")
            for part in cookie.split(";"):
                k, _, v = part.strip().partition("=")
                if k == "clawhive_access_token" and v:
                    token = v
                    break
        if not token:
            return None
        payload = verify_jwt(token)
        return str(payload.get("user_id") or payload.get("sub") or "") or None
    except Exception:
        return None


def _is_internal_request(request: Request) -> bool:
    import os

    got = (
        str(request.headers.get("x-clawhive-internal-token") or "").strip()
        or str(request.headers.get("x-agent-service-token") or "").strip()
        or str(request.headers.get("x-internal-token") or "").strip()
    )
    if not got:
        return False
    expected = str(
        os.getenv("CLAWHIVE_INTERNAL_TOKEN") or os.getenv("AGENT_INTERNAL_TOKEN") or ""
    ).strip()
    return bool(expected) and got == expected


def _resolve_authoritative_user(request: Request, claimed: str | None = None) -> str:
    """browser → JWT.sub；internal → X-User-Id/claimed；open → claimed/local。"""
    from app.core.browser_auth import browser_auth_enabled
    from app.core.mailbox_binding import sanitize_user_id

    claimed_uid = sanitize_user_id(claimed or "")
    header_uid = sanitize_user_id(str(request.headers.get("x-user-id") or "").strip())
    jwt_uid = sanitize_user_id(_jwt_user_from_request(request) or "")

    if _is_internal_request(request):
        return header_uid or claimed_uid or "local"

    if browser_auth_enabled():
        if not jwt_uid:
            raise HTTPException(status_code=401, detail="login_required")
        if claimed_uid and claimed_uid != jwt_uid:
            raise HTTPException(status_code=403, detail="forbidden: user_id mismatch")
        if header_uid and header_uid != jwt_uid:
            raise HTTPException(status_code=403, detail="forbidden: user_id mismatch")
        return jwt_uid

    return claimed_uid or header_uid or "local"


def _assert_session_owned(session_id: str, user_id: str, *, bind_if_unbound: bool = True) -> None:
    from app.core.admin_pg_store import get_adm_session_user_id, is_admin_pg_storage, touch_adm_session_pg
    from app.core.mailbox_binding import sanitize_user_id

    sid = str(session_id or "").strip()
    uid = sanitize_user_id(user_id)
    if not sid or not uid:
        raise HTTPException(status_code=400, detail="session_id/user_id required")
    if not is_admin_pg_storage():
        return
    owner = get_adm_session_user_id(sid)
    if owner and owner != uid:
        raise HTTPException(status_code=403, detail="forbidden: session ownership")
    if not owner and bind_if_unbound:
        touch_adm_session_pg(sid, user_id=uid)


@app.get("/api/mailbox/providers")
async def api_mailbox_providers():
    from app.core.mailbox_binding import list_provider_presets

    return {"ok": True, "providers": list_provider_presets()}


@app.get("/api/mailbox/binding")
async def api_mailbox_binding_get(request: Request, user_id: str = ""):
    from app.core.mailbox_binding import binding_public_status

    uid = _assert_binding_user_allowed(user_id, _jwt_user_from_request(request))
    return binding_public_status(uid)


@app.put("/api/mailbox/binding")
async def api_mailbox_binding_put(request: Request, body: MailboxBindingRequest):
    from app.core.mailbox_binding import upsert_binding
    from app.core.mail_metrics import mail_metric_inc

    uid = _assert_binding_user_allowed(body.user_id, _jwt_user_from_request(request))
    result = upsert_binding(
        uid,
        provider=body.provider,
        email_address=body.email_address,
        auth_code=body.auth_code,
        test_first=bool(body.test_first),
    )
    if result.get("ok"):
        mail_metric_inc("mail_bind")
        return result
    raise HTTPException(status_code=400, detail=result.get("human_message") or result.get("code") or "bind failed")


@app.post("/api/mailbox/binding/test")
async def api_mailbox_binding_test(request: Request, body: MailboxTestRequest):
    from app.core.mailbox_binding import test_binding_input

    uid = _assert_binding_user_allowed(body.user_id, _jwt_user_from_request(request))
    result = test_binding_input(
        uid,
        provider=body.provider,
        email_address=body.email_address,
        auth_code=body.auth_code,
    )
    if result.get("ok"):
        return result
    raise HTTPException(status_code=400, detail=result.get("human_message") or result.get("code") or "test failed")


@app.delete("/api/mailbox/binding")
async def api_mailbox_binding_delete(request: Request, user_id: str = ""):
    from app.core.mailbox_binding import delete_binding

    uid = _assert_binding_user_allowed(user_id, _jwt_user_from_request(request))
    return delete_binding(uid)


@app.get("/api/briefing")
async def api_daily_briefing(
    session_id: str = "default",
    city: str = "",
    include_emails: bool = True,
    user_id: str = "",
):
    from app.tools.briefing import daily_briefing

    result = daily_briefing(
        city=str(city or "").strip(),
        session_id=str(session_id or "default").strip() or "default",
        include_emails=bool(include_emails),
        user_id=str(user_id or "").strip(),
    )
    return {
        "ok": bool(result.get("ok")),
        "text": _tool_text(result),
        "raw": result,
    }


@app.get("/api/mail/inbox")
async def get_mail_inbox(
    session_id: str = "default",
    limit: int = 10,
    unread_only: bool = True,
    user_id: str = "",
    mailbox: str = "INBOX",
):
    result = list_emails(
        session_id=session_id,
        limit=limit,
        unread_only=unread_only,
        user_id=user_id,
        mailbox=mailbox,
    )
    return {
        "inbox": _tool_text(result),
        "items": _tool_items(result),
        "ok": isinstance(result, dict) and result.get("ok"),
        "raw": result if isinstance(result, dict) else {},
    }


@app.get("/api/mail/inbox/{email_id}")
async def get_mail_detail_api(email_id: int, session_id: str = "default", user_id: str = ""):
    result = get_email_detail(email_id=email_id, session_id=session_id, user_id=user_id)
    if isinstance(result, dict) and result.get("ok") is False:
        raise HTTPException(status_code=404, detail=_tool_text(result))
    return {"mail": _tool_data(result, {}), "ok": True}


@app.post("/api/mail/reply")
async def reply_mail_api(payload: ReplyEmailRequest):
    result = reply_email(
        email_id=payload.email_id,
        content=payload.content,
        session_id=payload.session_id,
        user_id=str(payload.user_id or "").strip(),
    )
    return {"result": _tool_text(result), "raw": result}


@app.post("/api/mail/compose/refine")
async def refine_mail_compose_api(body: ComposeRefineRequest):
    """就地改写 Compose 草稿正文；可选同步写回 pending args。不发 SMTP。"""
    from app.core.outbound_email_compose import refine_outbound_email_body
    from app.tools.pending import patch_pending_mail_compose

    content = str(body.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content_required")
    try:
        refined = refine_outbound_email_body(content, str(body.tone or "").strip() or "更正式")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"refine_llm_error:{exc}") from exc
    if not refined:
        raise HTTPException(status_code=502, detail="refine_failed")

    pending_patched = False
    patch_raw = None
    if body.action_id and int(body.action_id) > 0:
        try:
            patch_raw = patch_pending_mail_compose(
                str(body.session_id or "default"),
                int(body.action_id),
                content=refined,
                subject=body.subject,
            )
            pending_patched = bool(isinstance(patch_raw, dict) and patch_raw.get("ok"))
        except Exception as exc:
            # 成稿已成功：写回 pending 失败不阻断 UI 改写
            patch_raw = {"ok": False, "code": "patch_exception", "error": str(exc)}
            pending_patched = False

    return {
        "ok": True,
        "content": refined,
        "tone": body.tone,
        "pending_patched": pending_patched,
        "raw": patch_raw,
    }


@app.get("/api/mail/classify")
async def classify_mail_api(session_id: str = "default", limit: int = 20, user_id: str = ""):
    result = classify_emails(
        session_id=session_id,
        limit=limit,
        user_id=str(user_id or "").strip(),
    )
    return {"classification": _tool_text(result), "raw": result}


@app.get("/api/pending")
async def get_pending_actions(session_id: str = "default"):
    result = list_pending_actions(session_id=session_id)
    return {"pending": _tool_text(result), "items": _tool_items(result)}


@app.post("/api/pending/decide")
async def decide_pending_action(body: PendingDecideRequest):
    from app.tools.pending import decide_action

    sid = str(body.session_id or "default").strip() or "default"
    result = decide_action(
        sid,
        int(body.action_id),
        body.decision,
        mail_compose=body.mail_compose if isinstance(body.mail_compose, dict) else None,
    )
    result_text = _tool_text(result)
    ok = bool(result.get("ok", True)) if isinstance(result, dict) else True
    if ok and result_text.strip():
        replace_last_assistant_turn(sid, result_text)
    return {
        "ok": ok,
        "result": result_text,
        "code": result.get("code") if isinstance(result, dict) else None,
        "raw": result,
    }


@app.post("/api/feedback")
async def post_feedback(request: Request, body: FeedbackRequest):
    from app.core.admin_session_feedback import turn_feedback_key, upsert_session_feedback, user_message_feedback_key
    from app.core.admin_artifact_feedback import handle_admin_feedback

    score = int(body.score)
    if score not in (1, -1):
        raise HTTPException(status_code=400, detail="score 须为 1 或 -1")
    question = str(body.question or "").strip()
    session_id = str(body.session_id or "").strip()
    if not question or not session_id:
        raise HTTPException(status_code=400, detail="question 与 session_id 不能为空")
    uid = _resolve_authoritative_user(request)
    _assert_session_owned(session_id, uid)
    feedback_key = (body.run_id or "").strip()
    if body.user_message_index is not None and int(body.user_message_index) >= 0:
        feedback_key = user_message_feedback_key(int(body.user_message_index))
    elif not feedback_key and body.turn_id is not None:
        feedback_key = turn_feedback_key(body.turn_id)
    if not feedback_key:
        raise HTTPException(status_code=400, detail="缺少 turn_id 或 run_id")
    artifact_action = handle_admin_feedback(
        score=score,
        question=question,
        run_id=body.run_id,
        artifact=body.artifact,
    )
    saved = upsert_session_feedback(
        session_id=session_id,
        feedback_key=feedback_key,
        score=score,
        turn_id=body.turn_id,
        user_message_index=body.user_message_index,
        run_id=body.run_id,
        question=question,
        comment=body.comment,
        artifact=body.artifact,
    )
    if score < 0 and body.comment:
        try:
            from app.core.prompt_evolution import append_prompt_patch

            append_prompt_patch(
                stage="planning",
                text=str(body.comment).strip()[:200],
                source="feedback",
                session_id=session_id,
                user_message_index=body.user_message_index,
                run_id=str(body.run_id or "").strip(),
            )
        except Exception:
            pass
    return {"ok": True, "persisted": saved, "artifactAction": artifact_action}


@app.post("/api/artifact-revoke")
async def post_artifact_revoke(body: ArtifactRevokeRequest):
    from app.core.admin_artifact_feedback import handle_admin_feedback, revoke_admin_artifacts

    run_id = str(body.run_id or "").strip()
    if not run_id:
        raise HTTPException(status_code=400, detail="run_id 不能为空")
    if body.action == "confirm":
        action = handle_admin_feedback(score=1, question="", run_id=run_id, artifact=body.artifact)
        return {"ok": True, "action": "confirm", "artifactAction": action}
    n = revoke_admin_artifacts(run_id)
    return {"ok": True, "action": "revoke", "revoked": n}


@app.get("/api/session-feedback")
async def get_session_feedback(request: Request, session_id: str):
    from app.core.admin_session_feedback import list_session_feedback

    sid = str(session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id 不能为空")
    uid = _resolve_authoritative_user(request)
    _assert_session_owned(sid, uid)
    return {"items": list_session_feedback(sid)}


@app.post("/api/session-feedback/delete")
async def delete_session_feedback(request: Request, body: FeedbackDeleteRequest):
    from app.core.admin_session_feedback import (
        delete_all_session_feedback,
        delete_feedback_at_user_index,
        delete_feedback_from_turn,
        delete_feedback_from_user_index,
    )

    sid = str(body.session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id 不能为空")
    uid = _resolve_authoritative_user(request)
    _assert_session_owned(sid, uid)
    deleted = 0
    if body.delete_all:
        deleted = delete_all_session_feedback(sid)
    elif body.from_user_index is not None:
        deleted = delete_feedback_from_user_index(sid, int(body.from_user_index))
        if body.from_turn_id is not None:
            deleted += delete_feedback_from_turn(sid, int(body.from_turn_id))
    elif body.from_turn_id is not None:
        deleted = delete_feedback_from_turn(sid, int(body.from_turn_id))
    else:
        raise HTTPException(status_code=400, detail="请指定 from_turn_id、from_user_index 或 delete_all")
    return {"ok": True, "deleted": deleted}


@app.post("/api/session-delete")
async def delete_session(request: Request, body: SessionDeleteRequest):
    """删除整段会话：对话 turns + 任务上下文 + 反馈。"""
    from app.core.admin_session_feedback import delete_all_session_feedback
    from app.core.session_dialogue import delete_session_dialogue

    sid = str(body.session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id 不能为空")
    uid = _resolve_authoritative_user(request)
    _assert_session_owned(sid, uid)
    dialogue = delete_session_dialogue(sid)
    feedback_deleted = delete_all_session_feedback(sid)
    return {"ok": True, "session_id": sid, "dialogue": dialogue, "feedback_deleted": feedback_deleted}


class LocalLearningResetRequest(BaseModel):
    scope: str = "memory"  # memory | evolution | experience | all
    session_id: str | None = None
    tenant_id: str | None = None


@app.post("/api/learning/reset-local")
async def learning_reset_local(body: LocalLearningResetRequest):
    """浏览器端清除本 Agent 记忆/进化（走 JWT 门禁，不要求 internal token）。"""
    from app.api.learning import ResetBody, run_learning_reset

    scope = str(body.scope or "memory").strip().lower()
    mapped = {
        "memory": "memory",
        "evolution": "evolution",
        "experience": "experience",
        "all": "all",
        "learning": "learning",
    }.get(scope, "memory")
    return run_learning_reset(
        ResetBody(scope=mapped, session_id=body.session_id, tenant_id=body.tenant_id)
    )


@app.get("/api/sessions")
async def list_sessions(request: Request, user_id: str = ""):
    """按用户列出会话（PG adm_sessions 权威）。"""
    from app.core.admin_pg_store import is_admin_pg_storage, list_adm_sessions_pg

    uid = _resolve_authoritative_user(request, user_id)
    if not uid:
        return {"items": []}
    if not is_admin_pg_storage():
        return {"items": [], "warning": "ADMIN_STORAGE_BACKEND 未启用 postgres"}
    try:
        return {"items": list_adm_sessions_pg(uid)}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"list sessions failed: {e}") from e


@app.get("/api/session")
async def get_session(request: Request, session_id: str):
    """拉取单会话消息（PG adm_session_turns 权威）。"""
    from app.core.admin_pg_store import is_admin_pg_storage, load_turns_pg
    from app.core.session_dialogue import SessionTurn, SessionLocal, _ensure_tables

    sid = str(session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id 不能为空")
    uid = _resolve_authoritative_user(request)
    _assert_session_owned(sid, uid)
    rows: list[dict] = []
    if is_admin_pg_storage():
        try:
            rows = load_turns_pg(sid)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"get session failed: {e}") from e
    else:
        _ensure_tables()
        db = SessionLocal()
        try:
            rows = []
            for r in (
                db.query(SessionTurn)
                .filter(SessionTurn.session_id == sid)
                .order_by(SessionTurn.id.asc())
                .all()
            ):
                thoughts_raw = getattr(r, "thoughts", "") or ""
                thoughts: list[str] = []
                if thoughts_raw:
                    try:
                        parsed = json.loads(thoughts_raw)
                        if isinstance(parsed, list):
                            thoughts = [str(t).strip() for t in parsed if str(t or "").strip()]
                    except Exception:
                        thoughts = []
                rows.append({"role": r.role, "content": r.content, "thoughts": thoughts})
        finally:
            db.close()
    messages = [
        {
            "role": "agent" if str(r.get("role") or "") == "assistant" else "user",
            "content": str(r.get("content") or ""),
            "thoughts": list(r.get("thoughts") or []) if isinstance(r.get("thoughts"), list) else [],
        }
        for r in rows
        if str(r.get("content") or "").strip()
    ]
    return {"session_id": sid, "messages": messages}


class SessionMetaRequest(BaseModel):
    session_id: str
    user_id: str | None = None
    title: str | None = None
    custom_title: bool | None = None


@app.post("/api/session-meta")
async def update_session_meta(request: Request, body: SessionMetaRequest):
    from app.core.admin_pg_store import is_admin_pg_storage, touch_adm_session_pg

    sid = str(body.session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id 不能为空")
    uid = _resolve_authoritative_user(request, body.user_id)
    _assert_session_owned(sid, uid)
    if not is_admin_pg_storage():
        return {"ok": False, "warning": "ADMIN_STORAGE_BACKEND 未启用 postgres"}
    title = str(body.title or "").strip()[:80] or None
    try:
        touch_adm_session_pg(
            sid,
            user_id=uid,
            title=title,
            custom_title=True if body.custom_title else body.custom_title,
        )
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"session meta failed: {e}") from e


@app.post("/api/session-truncate")
async def truncate_session(body: SessionTruncateRequest):
    from app.core.admin_artifact_feedback import revoke_admin_artifacts
    from app.core.admin_session_feedback import (
        delete_feedback_at_user_index,
        delete_feedback_from_turn,
        delete_feedback_from_user_index,
        list_run_ids_for_revision,
    )
    from app.core.prompt_evolution import supersede_prompt_patches_for_revision
    from app.core.session_dialogue import truncate_session_from_user_index

    sid = str(body.session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id 不能为空")
    fallback = str(body.fallback_user_text or body.replace_user_text or "").strip()
    if body.from_user_index is None and not fallback:
        raise HTTPException(status_code=400, detail="需要 from_user_index 或用户原文")
    result = truncate_session_from_user_index(
        sid,
        int(body.from_user_index) if body.from_user_index is not None else -1,
        replace_user_text=body.replace_user_text,
        fallback_user_text=fallback or None,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail="找不到对应用户消息，无法截断会话")
    resolved_idx = int(result.get("resolved_user_index") or body.from_user_index or 0)
    is_regen_or_edit = bool(body.replace_user_text is not None and str(body.replace_user_text).strip())
    run_ids = list_run_ids_for_revision(
        sid,
        user_message_index=resolved_idx,
        from_user_index=None if is_regen_or_edit else resolved_idx,
        at_index_only=is_regen_or_edit,
    )
    feedback_deleted = 0
    if is_regen_or_edit:
        feedback_deleted = delete_feedback_at_user_index(sid, resolved_idx)
    else:
        feedback_deleted = delete_feedback_from_user_index(sid, resolved_idx)
        if body.from_turn_id is not None:
            feedback_deleted += delete_feedback_from_turn(sid, int(body.from_turn_id))

    reason = "regenerate" if is_regen_or_edit else "withdraw"
    learning = supersede_prompt_patches_for_revision(
        session_id=sid,
        user_message_index=resolved_idx,
        from_user_message_index=None if is_regen_or_edit else resolved_idx,
        reason=reason,
    )
    experience_revoked = 0
    for rid in run_ids:
        experience_revoked += int(revoke_admin_artifacts(rid) or 0)

    return {
        "ok": True,
        "session_id": sid,
        "user_message_count": result.get("user_message_count", 0),
        "message_count": result.get("message_count", 0),
        "feedback_deleted": feedback_deleted,
        "learning_voided": int(learning.get("voided") or 0),
        "experience_revoked": experience_revoked,
        "resolved_user_index": resolved_idx,
    }


@app.delete("/api/calendar/{event_id}")
async def delete_event_api(event_id: int, db: Session = Depends(get_db)):
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    db.delete(event)
    db.commit()
    return {"status": "ok"}

@app.get("/api/files")
async def get_files(request: Request):
    from app.core.tenant_scope import reset_request_scope, user_workspace_dir
    _tid, _uid, scope_tok = _activate_request_scope(request)
    try:
        root = user_workspace_dir(settings.WORKSPACE_DIR, _tid, _uid)
        os.makedirs(root, exist_ok=True)
        rel_paths: list[str] = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for name in filenames:
                if name.startswith("."):
                    continue
                abs_path = os.path.join(dirpath, name)
                rel = os.path.relpath(abs_path, root).replace("\\", "/")
                rel_paths.append(rel)
        rel_paths.sort()
        return {"files": rel_paths, "workspace": root}
    except Exception as e:
        return {"files": [], "error": str(e)}
    finally:
        reset_request_scope(scope_tok)


def _resolve_workspace_file(rel_path: str, tenant_id: str | None = None, user_id: str | None = None) -> str:
    from app.core.tenant_scope import user_workspace_dir, require_request_scope

    rel = str(rel_path or "").replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in rel.split("/"):
        raise HTTPException(status_code=400, detail="Invalid file path")
    if tenant_id and user_id:
        root = user_workspace_dir(settings.WORKSPACE_DIR, tenant_id, user_id)
    else:
        root = user_workspace_dir(settings.WORKSPACE_DIR, *require_request_scope())
    abs_path = os.path.normpath(os.path.join(root, rel))
    workspace = os.path.normpath(root)
    if not abs_path.startswith(workspace):
        raise HTTPException(status_code=400, detail="Path outside workspace")
    if not os.path.isfile(abs_path):
        raise HTTPException(status_code=404, detail="File not found")
    return abs_path


@app.get("/api/files/content")
async def get_file_content(request: Request, path: str, max_chars: int = 20000):
    from app.core.tenant_scope import reset_request_scope

    _tid, _uid, scope_tok = _activate_request_scope(request)
    try:
        abs_path = _resolve_workspace_file(path, _tid, _uid)
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace") as fh:
                content = fh.read(max(1000, min(int(max_chars or 20000), 50000)))
            truncated = os.path.getsize(abs_path) > len(content.encode("utf-8", errors="ignore"))
            return {
                "path": path,
                "content": content,
                "truncated": truncated,
                "size": os.path.getsize(abs_path),
            }
        except UnicodeDecodeError:
            return {
                "path": path,
                "content": "",
                "binary": True,
                "size": os.path.getsize(abs_path),
                "message": "二进制文件，无法在浏览器中预览文本。",
            }
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e)) from e
    finally:
        reset_request_scope(scope_tok)

@app.get("/api/agent/status")
async def get_agent_status():
    return {"status": "idle"}

# WebSocket connection manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def send_personal_message(self, message: str, websocket: WebSocket) -> bool:
        """发送成功返回 True；连接已关闭时吞掉异常，避免 ASGI 'websocket.send' after close。"""
        try:
            if websocket.client_state.name != "CONNECTED":
                return False
            await websocket.send_text(message)
            return True
        except Exception:
            return False

manager = ConnectionManager()

@app.websocket("/api/chat/ws")
async def websocket_endpoint(websocket: WebSocket):
    if not accept_websocket_connection(websocket):
        await websocket.close(code=1008, reason="invalid internal token")
        return
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            message_data = json.loads(data)
            started = time.time()
            user_message = message_data.get("message", "")
            session_id = str(message_data.get("session_id") or "default").strip() or "default"
            chat_mode = str(message_data.get("mode") or "normal").strip().lower()
            user_message_index = message_data.get("user_message_index")
            raw_client_context = message_data.get("client_context")
            client_context = raw_client_context if isinstance(raw_client_context, dict) else {}
            user_id = str(
                message_data.get("user_id")
                or client_context.get("user_id")
                or websocket.headers.get("x-user-id")
                or ""
            ).strip() or None
            tenant_id = str(
                message_data.get("tenant_id")
                or client_context.get("tenant_id")
                or websocket.headers.get("x-tenant-id")
                or ""
            ).strip() or None
            from app.core.browser_auth import auth_from_websocket, ClawhiveAuthError
            from app.core.tenant_scope import resolve_tenant_user_from_auth, set_request_scope, reset_request_scope
            try:
                _ws_auth = auth_from_websocket(websocket)
                _tid, _uid = resolve_tenant_user_from_auth(
                    _ws_auth,
                    header_tenant=websocket.headers.get("x-tenant-id"),
                    header_user=websocket.headers.get("x-user-id"),
                    claimed_tenant=tenant_id,
                    claimed_user=user_id,
                )
                user_id = _uid
                tenant_id = _tid
            except (ClawhiveAuthError, PermissionError, ValueError):
                from app.core.tenant_scope import normalize_tenant_id
                tenant_id = normalize_tenant_id(tenant_id)
                if not user_id:
                    user_id = "__unscoped__"
            _scope_tok = set_request_scope(tenant_id, user_id)
            auto_confirm_risky = bool(message_data.get("auto_confirm_risky", False))
            trace_id = str(
                message_data.get("trace_id")
                or websocket.headers.get("x-trace-id")
                or websocket.headers.get("x-run-id")
                or ""
            ).strip() or None
            if client_context.get("manager_task") and not client_context.get("manager_orchestrated"):
                client_context["manager_orchestrated"] = True
            # 总管显式传 auto_confirm_risky=false 时不得覆盖（写闸 / HITL 由 Manager 控制）
            if (
                "auto_confirm_risky" not in message_data
                and client_context.get("manager_orchestrated")
                and os.getenv("ADMIN_MANAGER_AUTO_CONFIRM", "1").strip() not in ("0", "false", "no")
            ):
                auto_confirm_risky = True
            # 总管编排：落库/计 token/入图用 lean 子句，避免 preamble 穿透对话记录
            user_message = resolve_manager_persist_user_message(user_message, client_context)
            estimated_tokens = qwen_llm.get_token_count(user_message)

            if estimated_tokens > settings.MAX_TOKENS_PER_REQUEST:
                await manager.send_personal_message(
                    json.dumps(
                        {
                            "type": "error",
                            "error": "Single message exceeds token limit.",
                        }
                    ),
                    websocket,
                )
                continue

            if not token_controller.check_limit(session_id, estimated_tokens):
                ensure_session_dialogue_budget(session_id)
                if not token_controller.check_limit(session_id, estimated_tokens):
                    await manager.send_personal_message(
                        json.dumps(
                            {
                                "type": "thought",
                                "content": "会话 token 配额偏高，已截断较早对话；本轮继续处理。",
                            }
                        ),
                        websocket,
                    )

            if chat_mode == "pending_decide":
                action_id = int(message_data.get("action_id") or 0)
                decision = str(message_data.get("decision") or "").strip()
                original_user_message = str(message_data.get("original_user_message") or "").strip()
                mail_compose_raw = message_data.get("mail_compose")
                mail_compose_arg = mail_compose_raw if isinstance(mail_compose_raw, dict) else None
                if action_id <= 0 or not decision:
                    await manager.send_personal_message(
                        json.dumps(
                            {
                                "type": "error",
                                "error": "pending_decide 需要 action_id 与 decision",
                            }
                        ),
                        websocket,
                    )
                    continue
                if not original_user_message:
                    original_user_message = get_last_user_message(session_id)
                user_message = original_user_message or f"{decision} {action_id}"
                decide_args: Dict[str, Any] = {
                    "session_id": session_id,
                    "action_id": action_id,
                    "decision": decision,
                }
                if mail_compose_arg:
                    decide_args["mail_compose"] = mail_compose_arg
                initial_state = {
                    "messages": [HumanMessage(content=user_message)],
                    "session_id": session_id,
                    "user_id": user_id,
                    "trace_id": trace_id,
                    "auto_confirm_risky": False,
                    "next_node": "executing",
                    "token_usage": {"total": 0},
                    "plan": [
                        {
                            "name": "decide_action",
                            "args": decide_args,
                        }
                    ],
                    "verification_result": "",
                    "current_task": "二次确认",
                    "understanding": {
                        "intent": "二次确认",
                        "confirm_action": {
                            "decision": decision,
                            "action_id": action_id,
                            "is_confirmation": True,
                        },
                    },
                    "memories": "",
                    "thoughts": [f"弹窗确认：{decision} {action_id}"],
                    "client_context": client_context,
                    "ui_cards": [],
                    "pending_decide_mode": True,
                }
            elif chat_mode in ("regenerate", "edit_resend"):
                if not isinstance(user_message_index, int) and not str(user_message or "").strip():
                    await manager.send_personal_message(
                        json.dumps(
                            {
                                "type": "error",
                                "error": "重新生成/编辑重发需要 user_message_index 或原文",
                            }
                        ),
                        websocket,
                    )
                    continue
                if chat_mode == "regenerate":
                    client_text = str(user_message or "").strip()
                    trunc = truncate_session_from_user_index(
                        session_id,
                        int(user_message_index) if isinstance(user_message_index, int) else -1,
                        replace_user_text=client_text or None,
                        fallback_user_text=client_text or None,
                    )
                    if not trunc.get("ok"):
                        await manager.send_personal_message(
                            json.dumps(
                                {
                                    "type": "error",
                                    "error": "找不到对应用户消息，无法重新生成",
                                }
                            ),
                            websocket,
                        )
                        continue
                    user_message = client_text or get_last_user_message(session_id)
                    if not user_message:
                        await manager.send_personal_message(
                            json.dumps(
                                {
                                    "type": "error",
                                    "error": "找不到对应用户消息，无法重新生成",
                                }
                            ),
                            websocket,
                        )
                        continue
                    try:
                        from app.core.admin_artifact_feedback import revoke_admin_artifacts
                        from app.core.admin_session_feedback import (
                            delete_feedback_at_user_index,
                            list_run_ids_for_revision,
                        )
                        from app.core.prompt_evolution import supersede_prompt_patches_for_revision

                        resolved = int(trunc.get("resolved_user_index") or 0)
                        for rid in list_run_ids_for_revision(
                            session_id, user_message_index=resolved, at_index_only=True
                        ):
                            revoke_admin_artifacts(rid)
                        delete_feedback_at_user_index(session_id, resolved)
                        supersede_prompt_patches_for_revision(
                            session_id=session_id,
                            user_message_index=resolved,
                            reason="regenerate",
                        )
                    except Exception:
                        pass
                else:
                    user_message = str(user_message or "").strip()
                    if not user_message:
                        await manager.send_personal_message(
                            json.dumps(
                                {
                                    "type": "error",
                                    "error": "编辑后内容不能为空",
                                }
                            ),
                            websocket,
                        )
                        continue
                    trunc = truncate_session_from_user_index(
                        session_id,
                        int(user_message_index) if isinstance(user_message_index, int) else -1,
                        fallback_user_text=user_message,
                    )
                    # HTTP 侧可能已截断：index 未命中时仍追加新用户消息
                    if not trunc.get("ok"):
                        pass
                    append_turn(session_id, "user", user_message, user_id=user_id)
                initial_state = {
                    "messages": [HumanMessage(content=user_message)],
                    "session_id": session_id,
                    "user_id": user_id,
                    "trace_id": trace_id,
                    "auto_confirm_risky": auto_confirm_risky,
                    "next_node": "routing",
                    "token_usage": {"total": 0},
                    "plan": [],
                    "verification_result": "",
                    "current_task": "",
                    "understanding": {},
                    "memories": "",
                    "thoughts": ["开始处理请求..."],
                    "client_context": client_context,
                    "ui_cards": [],
                }
            else:
                user_message = str(user_message or "").strip()
                if not user_message:
                    await manager.send_personal_message(
                        json.dumps({"type": "error", "error": "消息不能为空"}),
                        websocket,
                    )
                    continue
                append_turn(session_id, "user", user_message, user_id=user_id)

                initial_state = {
                    "messages": [HumanMessage(content=user_message)],
                    "session_id": session_id,
                    "user_id": user_id,
                    "trace_id": trace_id,
                    "auto_confirm_risky": auto_confirm_risky,
                    "next_node": "routing",
                    "token_usage": {"total": 0},
                    "plan": [],
                    "verification_result": "",
                    "current_task": "",
                    "understanding": {},
                    "memories": "",
                    "thoughts": ["开始处理请求..."],
                    "client_context": client_context,
                    "ui_cards": [],
                }
            
            # Use stream to send updates to frontend
            # 关键：同步 LangGraph 必须 offload，否则 LLM 卡住会冻死整个 uvicorn（健康检查也挂）
            final_result = initial_state
            graph_config = build_graph_invoke_config(session_id, trace_id)
            stream_kwargs = {"config": graph_config} if graph_config else {}
            loop = asyncio.get_running_loop()
            streamed_thoughts: list[str] = []
            turn_timeout = admin_ws_turn_timeout_sec()
            turn_cancel = begin_admin_turn_cancel()

            def _push_thought(content: str) -> None:
                msg = str(content or "").strip()
                if not msg or msg in streamed_thoughts:
                    return
                streamed_thoughts.append(msg)
                asyncio.run_coroutine_threadsafe(
                    manager.send_personal_message(
                        json.dumps({"type": "thought", "content": msg}),
                        websocket,
                    ),
                    loop,
                )

            set_admin_thought_callback(_push_thought)
            try:
                await manager.send_personal_message(
                    json.dumps(
                        {
                            "type": "thought",
                            "content": f"开始处理请求（整轮超时 {turn_timeout:.0f}s）…",
                        }
                    ),
                    websocket,
                )
                from app.core.admin_inflight import try_acquire_admin_slots, release_admin_slots, read_admin_max

                _adm_ok, _adm_reason = try_acquire_admin_slots(
                    pool="admin",
                    tenant_id=str(tenant_id or "default"),
                    max_global=read_admin_max("ADMIN_MAX_INFLIGHT", 0),
                    max_per_tenant=read_admin_max("ADMIN_MAX_INFLIGHT_PER_TENANT", 0),
                )
                if not _adm_ok:
                    await manager.send_personal_message(
                        json.dumps(
                            {
                                "type": "error",
                                "error": _adm_reason or "Admin 繁忙，请稍后重试",
                                "error_code": "overloaded",
                            }
                        ),
                        websocket,
                    )
                    continue
                try:
                    try:
                        final_result = await asyncio.wait_for(
                            asyncio.to_thread(
                                run_agent_graph_stream,
                                agent_graph,
                                initial_state,
                                stream_kwargs,
                                on_thought=_push_thought,
                                on_node=lambda n: print(f"DEBUG: node {n} emitted state delta"),
                                cancel_token=turn_cancel,
                            ),
                            timeout=turn_timeout,
                        )
                    except asyncio.TimeoutError:
                        # 先置取消，堵住线程内后续孤儿写；再必回 error，避免总管空等
                        cancel_admin_turn()
                        err = f"处理超时（{turn_timeout:.0f}s 未完成）。请稍后重试，或简化任务后重发。"
                        latency_ms = int((time.time() - started) * 1000)
                        agent_result = build_admin_agent_result(
                            err,
                            trace_id=trace_id,
                            latency_ms=latency_ms,
                            error_code="timeout",
                            structured={"timeout_sec": turn_timeout},
                        )
                        append_agent_trace_log(
                            agent="admin",
                            path="/api/chat/ws",
                            trace_id=trace_id,
                            ok=False,
                            latency_ms=latency_ms,
                        )
                        await manager.send_personal_message(
                            json.dumps(
                                {
                                    "type": "error",
                                    "error": err,
                                    "agentResult": agent_result,
                                }
                            ),
                            websocket,
                        )
                        continue
                finally:
                    release_admin_slots(pool="admin", tenant_id=str(tenant_id or "default"))
            finally:
                set_admin_thought_callback(None)
                clear_admin_turn_cancel()

            # 若工作线程因取消提前结束，仍发 final（含取消文案 / pending），协议不得静默
            if turn_cancel.is_cancelled() and not (final_result.get("pending_actions") or []):
                vr = str(final_result.get("verification_result") or "").strip()
                if not vr:
                    final_result = {
                        **final_result,
                        "verification_result": "处理已取消或超时，未继续执行。",
                    }

            # Send final response — 先推 thought/delta，再 final（Manager 可真流展示）
            response_text = _graph_response_text(final_result)
            latency_ms = int((time.time() - started) * 1000)
            agent_result = build_admin_agent_result(
                response_text,
                trace_id=trace_id,
                latency_ms=latency_ms,
                gaps=list(final_result.get("specialist_gaps") or []) if isinstance(final_result, dict) else None,
                rounds_used=int(final_result.get("replan_count") or 0) + 1 if isinstance(final_result, dict) else None,
                structured={
                    "tokens_used": _calc_total_tokens(
                        final_result,
                        user_message,
                        response_text,
                    ),
                    "ui_cards": final_result.get("ui_cards") or [],
                    "pending_actions": final_result.get("pending_actions") or [],
                    "needs_human_confirm": bool(final_result.get("pending_actions")),
                    "turn_scope_mode": (final_result.get("turn_scope") or {}).get("mode"),
                    "context_history_turns": 0 if (final_result.get("turn_scope") or {}).get("suppress_history") else settings.ADMIN_DIALOGUE_MAX_TURNS,
                    "evolutionApplied": _snapshot_admin_evolution_applied(user_message),
                    **_mail_draft_structured(final_result),
                },
            )
            append_agent_trace_log(
                agent="admin",
                path="/api/chat/ws",
                trace_id=trace_id,
                ok=bool(agent_result.get("ok")),
                latency_ms=latency_ms,
            )
            maybe_run_lightweight_curator()

            thoughts = list(final_result.get("thoughts") or [])
            for thought in thoughts[-12:]:
                msg = str(thought or "").strip()
                if msg:
                    await manager.send_personal_message(
                        json.dumps({"type": "thought_delta", "content": msg}, ensure_ascii=False),
                        websocket,
                    )

            body = str(response_text or "")
            if body:
                await manager.send_personal_message(
                    json.dumps({"type": "stream_start", "phase": "answer"}, ensure_ascii=False),
                    websocket,
                )
                chunk_size = 12
                for i in range(0, len(body), chunk_size):
                    piece = body[i : i + chunk_size]
                    await manager.send_personal_message(
                        json.dumps({"type": "delta", "content": piece}, ensure_ascii=False),
                        websocket,
                    )
                    if i + chunk_size < len(body):
                        await asyncio.sleep(0.016)

            response_data = {
                "type": "final",
                "response": response_text,
                "tokens_used": _calc_total_tokens(
                    final_result,
                    user_message,
                    response_text
                ),
                "status": "success",
                "thoughts": thoughts,
                "cards": final_result.get("ui_cards") or [],
                "agentResult": agent_result,
            }
            token_controller.update_usage(session_id, response_data["tokens_used"])

            await manager.send_personal_message(json.dumps(response_data), websocket)
            try:
                reset_request_scope(_scope_tok)
            except Exception:
                pass
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        error_data = {"type": "error", "error": str(e)}
        if websocket in manager.active_connections:
            await manager.send_personal_message(json.dumps(error_data), websocket)
        manager.disconnect(websocket)

@app.post("/api/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest, _: None = Depends(verify_internal_token)):
    started = time.time()
    _chat_scope = None
    try:
        estimated_tokens = qwen_llm.get_token_count(request.message)
        if not token_controller.check_limit(request.session_id, estimated_tokens):
            raise HTTPException(status_code=429, detail="Token quota exceeded for this session.")

        # Initial state for LangGraph
        from app.core.tenant_scope import set_request_scope, reset_request_scope, normalize_tenant_id
        _chat_tid = normalize_tenant_id(
            (request.client_context or {}).get("tenant_id") if isinstance(request.client_context, dict) else None
        )
        _chat_uid = str(request.user_id or "").strip() or "__unscoped__"
        _chat_scope = set_request_scope(_chat_tid, _chat_uid)
        initial_state = {
            "messages": [HumanMessage(content=request.message)],
            "session_id": request.session_id,
            "user_id": str(request.user_id or "").strip() or None,
            "tenant_id": _chat_tid,
            "trace_id": str(request.trace_id or "").strip() or None,
            "auto_confirm_risky": bool(request.auto_confirm_risky),
            "next_node": "routing",
            "token_usage": {"total": 0},
            "plan": [],
            "verification_result": "",
            "current_task": "",
            "understanding": {},
            "memories": "",
            "thoughts": [],
            "client_context": request.client_context if isinstance(request.client_context, dict) else {},
            "ui_cards": [],
        }
        
        # Invoke the graph（线程卸载 + 整轮超时，避免卡死事件循环）
        graph_config = build_graph_invoke_config(request.session_id, request.trace_id)
        invoke_kwargs = {"config": graph_config} if graph_config else {}
        turn_timeout = admin_ws_turn_timeout_sec()
        turn_cancel = begin_admin_turn_cancel()
        from app.core.admin_inflight import try_acquire_admin_slots, release_admin_slots, read_admin_max
        from app.core.tenant_scope import require_request_scope

        try:
            _tid, _ = require_request_scope()
        except Exception:
            _tid = "default"
        _ok, _reason = try_acquire_admin_slots(
            pool="admin",
            tenant_id=_tid,
            max_global=read_admin_max("ADMIN_MAX_INFLIGHT", 0),
            max_per_tenant=read_admin_max("ADMIN_MAX_INFLIGHT_PER_TENANT", 0),
        )
        if not _ok:
            raise HTTPException(status_code=429, detail=_reason or "Admin busy")
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(
                    run_agent_graph_invoke,
                    agent_graph,
                    initial_state,
                    invoke_kwargs,
                    cancel_token=turn_cancel,
                ),
                timeout=turn_timeout,
            )
        except asyncio.TimeoutError:
            cancel_admin_turn()
            raise HTTPException(
                status_code=504,
                detail=f"处理超时（{turn_timeout:.0f}s 未完成）。请稍后重试。",
            )
        finally:
            release_admin_slots(pool="admin", tenant_id=_tid)
            clear_admin_turn_cancel()
        response_text = _graph_response_text(result)
        tokens_used = _calc_total_tokens(result, request.message, response_text)
        token_controller.update_usage(request.session_id, tokens_used)
        trace_id = str(request.trace_id or "").strip() or None
        latency_ms = int((time.time() - started) * 1000)
        agent_result = build_admin_agent_result(
            response_text,
            trace_id=trace_id,
            latency_ms=latency_ms,
            gaps=list(result.get("specialist_gaps") or []) if isinstance(result, dict) else None,
            rounds_used=int(result.get("replan_count") or 0) + 1 if isinstance(result, dict) else None,
            self_check_ok=None,
            structured={
                "tokens_used": tokens_used,
                "evolutionApplied": _snapshot_admin_evolution_applied(request.message),
                **_mail_draft_structured(result),
            },
        )
        append_agent_trace_log(
            agent="admin",
            path="/api/chat",
            trace_id=trace_id,
            ok=bool(agent_result.get("ok")),
            latency_ms=latency_ms,
        )
        maybe_run_lightweight_curator()
        
        return ChatResponse(
            response=response_text,
            tokens_used=tokens_used,
            status="success",
            thoughts=result.get("thoughts", []),
            agentResult=agent_result,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if _chat_scope is not None:
            try:
                from app.core.tenant_scope import reset_request_scope

                reset_request_scope(_chat_scope)
            except Exception:
                pass

if os.path.isdir(FRONTEND_DIST_DIR):
    assets_dir = os.path.join(FRONTEND_DIST_DIR, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="frontend-assets")

    @app.get("/", include_in_schema=False)
    async def frontend_index():
        return FileResponse(os.path.join(FRONTEND_DIST_DIR, "index.html"))

    @app.get("/{full_path:path}", include_in_schema=False)
    async def frontend_spa_fallback(full_path: str):
        # Keep API routes handled by existing /api/* endpoints.
        if full_path.startswith("api/") or full_path == "api":
            raise HTTPException(status_code=404, detail="Not Found")
        target = os.path.join(FRONTEND_DIST_DIR, full_path)
        if full_path and os.path.isfile(target):
            return FileResponse(target)
        return FileResponse(os.path.join(FRONTEND_DIST_DIR, "index.html"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=True)
