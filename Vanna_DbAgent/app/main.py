from __future__ import annotations

import json
import logging
import threading
from collections.abc import Iterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.audit import read_audit
from app.catalog import collection_count, exact_golden, ingest_tenant, load_golden, schema_table_hits
from app.engine import run_turn
from app.experience import experience_prompt_block, recall_experience, write_standalone_experience
from app.golden_store import promote_golden
from app.learning import (
    curate,
    invalidate_learning_for_messages,
    learning_summary,
    promote_patch,
    record_feedback,
    reset_learning,
)
from app.pending import load_pending, save_pending
from app.protocol import (
    build_db_agent_result,
    is_manager_request,
    last_user_message,
    mcp_token_ok,
    parse_manager_task,
    verify_agent_service_auth,
)
from app.scenes import get_scene, scene_public
from app.schema_link import cards_for, link_tables
from app.sessions import (
    append_turn,
    delete_session,
    list_sessions,
    load_session,
    new_session,
    peek_messages_from,
    recent_history,
    rename_session,
    replace_checkpoint_assistant,
    truncate_from_message,
)
from app.settings import ROOT, get_settings
from app.tenants import Tenant, load_tenants

log = logging.getLogger("vanna")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
FRONTEND = ROOT / "frontend"


class AskBody(BaseModel):
    question: str = Field(default="", max_length=400)
    messages: list[dict[str, Any]] | None = None
    tenant: str = ""
    dbId: str = ""
    db_id: str = ""
    scene: str = "assistant"
    confirm: bool = False
    pending_id: str = ""
    sql: str = ""
    auto_scene: bool = False
    session_id: str = ""
    sessionId: str = ""
    managerTask: dict[str, Any] | None = None
    manager_task_json: str = ""
    manager_task_envelope_v2: str | dict[str, Any] | None = None
    trace_id: str = ""
    traceId: str = ""


class SessionBody(BaseModel):
    tenant: str = "p2604"
    scene: str = "assistant"
    title: str = ""


class RenameBody(BaseModel):
    title: str = Field(min_length=1, max_length=80)


class TruncateBody(BaseModel):
    message_id: str = Field(min_length=1, max_length=80)


class GoldenBody(BaseModel):
    question: str = Field(min_length=1, max_length=400)
    sql: str = Field(min_length=1, max_length=4000)
    tenant: str = "p2604"
    scene: str = "assistant"
    tables: list[str] = Field(default_factory=list)


class ProbeBody(BaseModel):
    question: str = ""
    tenant: str = ""
    dbId: str = ""
    db_id: str = ""


class PlanBody(BaseModel):
    question: str = ""
    tenant: str = ""
    dbId: str = ""
    db_id: str = ""


class LearningPromoteBody(BaseModel):
    patchId: str = ""
    auto: bool = False


class LearningCurateBody(BaseModel):
    autoPromote: bool = False


class LearningResetBody(BaseModel):
    scope: str = "learning"
    tenant: str = "p2604"


class FeedbackBody(BaseModel):
    question: str = Field(min_length=1, max_length=400)
    score: int
    tenant: str = "p2604"
    session_id: str = ""
    message_id: str = ""
    sql: str = ""
    tables: list[str] = Field(default_factory=list)
    comment: str = ""


class McpBody(BaseModel):
    method: str = ""
    params: dict[str, Any] | None = None
    id: Any = None


MCP_TOOLS = [
    {
        "name": "schema_search",
        "description": "按问句召回表白名单内的表卡片（不执行 SQL）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {"type": "string"},
                "tenant": {"type": "string"},
            },
            "required": ["question"],
        },
    },
    {
        "name": "preview_sql",
        "description": "生成只读 SQL 并进入确认闸（不执行）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {"type": "string"},
                "tenant": {"type": "string"},
                "scene": {"type": "string"},
            },
            "required": ["question"],
        },
    },
    {
        "name": "confirm_sql",
        "description": "确认 pending SQL 后只读执行",
        "inputSchema": {
            "type": "object",
            "properties": {
                "pending_id": {"type": "string"},
                "tenant": {"type": "string"},
            },
            "required": ["pending_id"],
        },
    },
    {
        "name": "promote_golden",
        "description": "人审收入黄金 SQL（不自动晋级）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {"type": "string"},
                "sql": {"type": "string"},
                "tenant": {"type": "string"},
                "tables": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["question", "sql"],
        },
    },
]


def _tenants() -> dict[str, Tenant]:
    return load_tenants()


def _tenant_or_404(tid: str) -> Tenant:
    tenants = _tenants()
    t = tenants.get(tid)
    if not t:
        raise HTTPException(404, f"unknown tenant: {tid}")
    return t


def _resolve_tenant_id(
    *,
    tenant: str = "",
    db_id: str = "",
    required_if_explicit: bool = True,
) -> str:
    tenants = _tenants()
    settings = get_settings()
    default = str(settings.vanna_default_tenant or "p2604")
    explicit = str(db_id or "").strip() or str(tenant or "").strip()
    if explicit:
        if explicit in tenants:
            return explicit
        if required_if_explicit:
            raise HTTPException(400, f"unknown tenant/dbId: {explicit}")
    if default in tenants:
        return default
    if tenants:
        return next(iter(tenants.keys()))
    raise HTTPException(404, "no tenants configured")


def _headers_dict(request: Request | None) -> dict[str, Any]:
    if request is None:
        return {}
    return {k: v for k, v in request.headers.items()}


def _require_auth(request: Request | None) -> None:
    ok, reason = verify_agent_service_auth(_headers_dict(request))
    if not ok:
        raise HTTPException(401, reason or "unauthorized")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    tenants = _tenants()

    def _ingest_bg() -> None:
        if not (settings.vanna_auto_ingest and settings.openai_api_key):
            return
        for t in tenants.values():
            try:
                log.info("ingest start %s", t.id)
                result = ingest_tenant(t, skip_if_ready=True)
                log.info("ingest %s %s", t.id, result)
            except Exception as exc:
                log.warning("ingest %s failed: %s", t.id, exc)

    threading.Thread(target=_ingest_bg, name="vanna-ingest", daemon=True).start()
    yield


app = FastAPI(title="Vanna DbAgent", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/ready")
def ready() -> dict[str, Any]:
    tenants = _tenants()
    return {
        "ready": True,
        "service": "vanna_db_agent",
        "manager": False,
        "tenants": list(tenants.keys()),
        "scenes": [s["id"] for s in scene_public()],
        "contract": {"agentResult": True, "envelope": True, "learning": True},
    }


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "vanna_db_agent"}


@app.get("/api/meta")
def meta() -> dict[str, Any]:
    tenants = _tenants()
    settings = get_settings()
    return {
        "tenants": [
            {
                "id": t.id,
                "title": t.title,
                "database": t.mysql.database,
                "catalog": collection_count(t.id),
            }
            for t in tenants.values()
        ],
        "scenes": scene_public(),
        "checkpoint_default": settings.vanna_checkpoint_default,
        "scene_detect": settings.vanna_scene_detect,
        "budget": {
            "max_llm_calls": settings.vanna_max_llm_calls,
            "max_embed_calls": settings.vanna_max_embed_calls,
            "max_ingest_embed_calls": settings.vanna_max_ingest_embed_calls,
            "max_repair_llm_calls": settings.vanna_max_repair_llm_calls,
            "max_answer_llm_calls": settings.vanna_max_answer_llm_calls,
            "max_prompt_chars": settings.vanna_max_prompt_chars,
            "max_question_chars": settings.vanna_max_question_chars,
            "history_turns": settings.vanna_history_turns,
            "polish": settings.vanna_polish,
        },
    }


@app.post("/api/ingest")
def ingest(tenant: str = "p2604") -> dict[str, Any]:
    t = _tenant_or_404(tenant)
    return ingest_tenant(t, skip_if_ready=False)


@app.get("/api/audit")
def audit(limit: int = 50) -> dict[str, Any]:
    return {"items": read_audit(limit=min(200, max(1, limit)))}


@app.get("/api/sessions")
def sessions(limit: int = 40) -> dict[str, Any]:
    return {"items": list_sessions(limit=min(80, max(1, limit)))}


@app.post("/api/sessions")
def create_session(body: SessionBody) -> dict[str, Any]:
    _tenant_or_404(body.tenant)
    return new_session(tenant=body.tenant, scene=body.scene, title=body.title)


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    doc = load_session(session_id)
    if not doc:
        raise HTTPException(404, "session not found")
    return doc


@app.patch("/api/sessions/{session_id}")
def patch_session(session_id: str, body: RenameBody) -> dict[str, Any]:
    doc = rename_session(session_id, body.title)
    if not doc:
        raise HTTPException(404, "session not found")
    return doc


@app.delete("/api/sessions/{session_id}")
def remove_session(session_id: str) -> dict[str, Any]:
    if not delete_session(session_id):
        raise HTTPException(404, "session not found")
    return {"ok": True}


@app.post("/api/sessions/{session_id}/truncate")
def truncate_session(session_id: str, body: TruncateBody) -> dict[str, Any]:
    if not load_session(session_id):
        raise HTTPException(404, "session not found")
    # 撤回 / 重新生成 / 编辑重发：先作废被删轮次的反馈学习，再截断会话
    removed = peek_messages_from(session_id, body.message_id)
    mids = [str(m.get("id") or "") for m in removed if str(m.get("id") or "")]
    questions = [
        str(m.get("content") or "").strip()
        for m in removed
        if str(m.get("role") or "") == "user" and str(m.get("content") or "").strip()
    ]
    learning_void = invalidate_learning_for_messages(
        session_id=session_id,
        message_ids=mids,
        questions=questions,
    )
    try:
        doc = truncate_from_message(session_id, body.message_id)
    except KeyError:
        raise HTTPException(404, "message not found") from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    out = dict(doc or {})
    out["learningVoid"] = learning_void
    return out


@app.post("/api/probe")
def probe(body: ProbeBody, request: Request) -> dict[str, Any]:
    _require_auth(request)
    tid = _resolve_tenant_id(tenant=body.tenant, db_id=body.dbId or body.db_id)
    tenant = _tenant_or_404(tid)
    q = str(body.question or "").strip()
    gold = exact_golden(tenant, q) if q else None
    linked = [t.get("name") for t in link_tables(tenant, q, n=4)] if q else []
    return {
        "ok": True,
        "ready": True,
        "tenant": tenant.id,
        "catalog": collection_count(tenant.id),
        "golden": bool(gold),
        "tables": linked,
        "can_answer": bool(gold or linked or load_golden(tenant)),
        "llm": False,
    }


@app.post("/api/plan")
def plan(body: PlanBody, request: Request) -> dict[str, Any]:
    _require_auth(request)
    tid = _resolve_tenant_id(tenant=body.tenant, db_id=body.dbId or body.db_id)
    tenant = _tenant_or_404(tid)
    q = str(body.question or "").strip()
    if not q:
        raise HTTPException(400, "question required")
    gold = exact_golden(tenant, q)
    if gold:
        return {
            "ok": True,
            "path": "golden",
            "tables": gold.get("tables") or [],
            "sql": gold.get("sql") or "",
            "question": q,
        }
    hits = schema_table_hits(tenant, q, n=6)
    tables = [h.get("table") for h in hits if h.get("table")]
    return {
        "ok": True,
        "path": "cards" if tables else "clarify",
        "tables": tables,
        "question": q,
    }


@app.post("/api/golden")
def golden(body: GoldenBody, request: Request) -> dict[str, Any]:
    _require_auth(request)
    tenant = _tenant_or_404(body.tenant)
    out = promote_golden(
        tenant,
        question=body.question,
        sql=body.sql,
        tables=body.tables,
        scene_id=body.scene,
    )
    if out.get("ok") and not out.get("deduped"):
        write_standalone_experience(
            question=body.question,
            sql=str(out.get("sql") or body.sql),
            tables=list(out.get("tables") or body.tables or []),
            tenant_id=tenant.id,
            data_domain=tenant.id,
        )
    if not out.get("ok"):
        raise HTTPException(400, str(out.get("error") or "promote_failed"))
    return out


@app.get("/api/learning")
def learning_get(tenant: str = "p2604") -> dict[str, Any]:
    t = _tenant_or_404(tenant)
    return learning_summary(t)


@app.post("/api/learning/curate")
def learning_curate(body: LearningCurateBody) -> dict[str, Any]:
    return curate(auto_promote=bool(body.autoPromote))


@app.post("/api/learning/promote")
def learning_promote(body: LearningPromoteBody) -> dict[str, Any]:
    if body.auto:
        return {"ok": False, "reason": "expert_auto_promote_disabled", "promoted": [], "count": 0}
    out = promote_patch(body.patchId)
    if not out.get("ok"):
        raise HTTPException(400, str(out.get("reason") or "promote_failed"))
    return out


@app.post("/api/learning/reset")
def learning_reset(body: LearningResetBody) -> dict[str, Any]:
    _tenant_or_404(body.tenant)
    return reset_learning(scope=body.scope)


@app.post("/api/feedback")
def feedback(body: FeedbackBody, request: Request) -> dict[str, Any]:
    _require_auth(request)
    if body.score not in (1, -1):
        raise HTTPException(400, "score 须为 1（有用）或 -1（无用）")
    out = record_feedback(
        question=body.question,
        score=int(body.score),
        sql=body.sql,
        tables=body.tables,
        comment=body.comment,
        tenant_id=body.tenant,
        session_id=body.session_id,
        message_id=body.message_id,
    )
    if not out.get("ok"):
        raise HTTPException(400, str(out.get("reason") or "feedback_failed"))
    ack = "已标记为有用 · 感谢反馈" if body.score == 1 else "已标记为无用 · 已记入学习影子，不会自动晋级"
    return {**out, "ack": ack}


@app.post("/api/mcp")
def mcp_endpoint(body: McpBody, request: Request) -> dict[str, Any]:
    if not mcp_token_ok(_headers_dict(request)):
        raise HTTPException(401, "mcp_token_invalid")
    method = str(body.method or "").strip()
    params = body.params if isinstance(body.params, dict) else {}
    if method in ("tools/list", "list_tools"):
        return {"jsonrpc": "2.0", "id": body.id, "result": {"tools": MCP_TOOLS}}
    if method in ("tools/call", "call_tool"):
        name = str(params.get("name") or params.get("tool") or "").strip()
        args = params.get("arguments") if isinstance(params.get("arguments"), dict) else params
        args = args if isinstance(args, dict) else {}
        try:
            result = _mcp_call(name, args)
        except HTTPException as exc:
            return {
                "jsonrpc": "2.0",
                "id": body.id,
                "error": {"code": exc.status_code, "message": str(exc.detail)},
            }
        return {"jsonrpc": "2.0", "id": body.id, "result": result}
    return {
        "jsonrpc": "2.0",
        "id": body.id,
        "error": {"code": -32601, "message": f"unknown method: {method}"},
    }


def _mcp_call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    if name == "schema_search":
        tid = _resolve_tenant_id(tenant=str(args.get("tenant") or ""), db_id="")
        tenant = _tenant_or_404(tid)
        q = str(args.get("question") or "").strip()
        tables = link_tables(tenant, q, n=8)
        names = [str(t.get("name") or "") for t in tables]
        return {
            "ok": True,
            "tables": names,
            "cards": cards_for(tenant, names, question=q),
        }
    if name == "preview_sql":
        ask_body = AskBody(
            question=str(args.get("question") or ""),
            tenant=str(args.get("tenant") or "p2604"),
            scene=str(args.get("scene") or "assistant"),
            confirm=False,
        )
        events = list(_run(ask_body, headers=None, force_manager=False))
        answer = next((e for e in reversed(events) if e.get("event") == "answer"), {})
        return {
            "ok": True,
            "checkpoint": bool(answer.get("checkpoint")),
            "pending_id": answer.get("pending_id") or "",
            "sql": answer.get("sql") or "",
            "text": answer.get("text") or "",
        }
    if name == "confirm_sql":
        ask_body = AskBody(
            question="确认执行",
            tenant=str(args.get("tenant") or "p2604"),
            pending_id=str(args.get("pending_id") or ""),
            confirm=True,
        )
        events = list(_run(ask_body, headers=None, force_manager=False))
        answer = next((e for e in reversed(events) if e.get("event") == "answer"), {})
        return {
            "ok": True,
            "text": answer.get("text") or "",
            "sql": answer.get("sql") or "",
            "rows": answer.get("rows") or [],
        }
    if name == "promote_golden":
        return promote_golden(
            _tenant_or_404(str(args.get("tenant") or "p2604")),
            question=str(args.get("question") or ""),
            sql=str(args.get("sql") or ""),
            tables=list(args.get("tables") or []),
        )
    raise HTTPException(400, f"unknown tool: {name}")


@app.post("/api/ask")
def ask(body: AskBody, request: Request) -> dict[str, Any]:
    _require_auth(request)
    events = list(_run(body, headers=_headers_dict(request)))
    answer_ev = next((e for e in reversed(events) if e.get("event") == "answer"), {})
    text = str(answer_ev.get("text") or "")
    sql = str(answer_ev.get("sql") or "")
    empty = bool(answer_ev.get("empty"))
    needs_clarify = bool(answer_ev.get("needs_clarify"))
    cost = answer_ev.get("cost") or {}
    agent_result = build_db_agent_result(
        answer=text,
        empty=empty,
        reason=str(answer_ev.get("error_code") or ("ok" if not needs_clarify else "needs_clarify")),
        trace_id=str(body.trace_id or body.traceId or ""),
        needs_clarify=needs_clarify,
        clarify=text if needs_clarify else "",
        executed_sql=sql,
        error_code=str(answer_ev.get("error_code") or ""),
        path=str(next((e.get("source") for e in events if e.get("event") == "sql"), "") or ""),
        latency_ms=int(cost.get("elapsed_ms") or 0),
        usage={
            "tokens": int(cost.get("prompt_tokens") or 0) + int(cost.get("completion_tokens") or 0),
            "actual": True,
        },
        tables=list(next((e.get("tables") for e in events if e.get("event") == "guard"), []) or []),
        experience_hits=int(getattr(body, "_experience_hits", 0) or 0),
    )
    sid = str(body.session_id or body.sessionId or "")
    return {
        "answer": text,
        "events": events,
        "agentResult": agent_result,
        "empty": empty,
        "reason": agent_result.get("structured", {}).get("reason") or "ok",
        "sql": sql,
        "checkpoint": bool(answer_ev.get("checkpoint")),
        "pending_id": answer_ev.get("pending_id") or "",
        "rows": answer_ev.get("rows") or [],
        "session_id": sid,
        "ok": bool(agent_result.get("ok")),
    }


@app.post("/api/ask/stream")
def ask_stream(body: AskBody, request: Request) -> StreamingResponse:
    _require_auth(request)

    def gen() -> Iterator[str]:
        for ev in _run(body, headers=_headers_dict(request)):
            yield f"event: {ev.get('event')}\ndata: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.websocket("/api/chat.ws")
async def chat_ws(ws: WebSocket) -> None:
    await ws.accept()
    try:
        raw = await ws.receive_text()
        payload = json.loads(raw or "{}")
    except Exception as exc:
        await ws.send_json({"event": "error", "data": f"bad payload: {exc}"})
        await ws.close()
        return
    headers = {k.lower(): v for k, v in ws.headers.items()}
    ok, reason = verify_agent_service_auth(headers)
    if not ok:
        await ws.send_json({"event": "error", "data": reason or "unauthorized"})
        await ws.close()
        return
    body = AskBody.model_validate(payload if isinstance(payload, dict) else {})
    trace_id = str(body.trace_id or body.traceId or payload.get("trace_id") or "")
    try:
        await ws.send_json({"event": "status", "data": "start"})
        await ws.send_json({"event": "thinking", "data": "数据库 Agent：处理中…"})
        events = list(_run(body, headers=headers, force_manager=True))
        answer_ev = next((e for e in reversed(events) if e.get("event") == "answer"), {})
        text = str(answer_ev.get("text") or "")
        sql = str(answer_ev.get("sql") or "")
        empty = bool(answer_ev.get("empty"))
        needs_clarify = bool(answer_ev.get("needs_clarify"))
        meta = {
            "empty": empty,
            "error_code": answer_ev.get("error_code") or ("empty_result" if empty else None),
            "executed_sql": sql,
            "needs_clarification": needs_clarify,
            "path": next((e.get("source") for e in events if e.get("event") == "sql"), ""),
            "fail_reason": "ok" if not empty and not needs_clarify else (answer_ev.get("error_code") or "no_data_or_unmatched"),
        }
        await ws.send_json({"event": "meta", "data": meta})
        await ws.send_json({"event": "message", "data": text})
        await ws.send_json({"event": "status", "data": "end"})
    except WebSocketDisconnect:
        return
    except Exception as exc:
        await ws.send_json({"event": "error", "data": str(exc)})
    finally:
        try:
            await ws.close()
        except Exception:
            pass
        _ = trace_id


def _run(
    body: AskBody,
    *,
    headers: dict[str, Any] | None = None,
    force_manager: bool = False,
):
    mgr_raw: Any = body.managerTask
    if not mgr_raw and body.manager_task_json:
        mgr_raw = body.manager_task_json
    if not mgr_raw and body.manager_task_envelope_v2:
        mgr_raw = body.manager_task_envelope_v2
    mgr = parse_manager_task(mgr_raw)
    tid = _resolve_tenant_id(
        tenant=body.tenant,
        db_id=body.dbId or body.db_id,
        required_if_explicit=True,
    )
    tenant = _tenant_or_404(tid)
    scene = get_scene(body.scene)
    pending = load_pending(body.pending_id) if body.pending_id else None
    if body.pending_id and not pending:
        raise HTTPException(404, "pending not found")
    question = last_user_message(body.messages, body.question)
    if mgr.refined_question:
        question = mgr.refined_question
    if pending:
        question = str(pending.get("question") or question)
        if pending.get("tenant") and pending["tenant"] != tenant.id:
            raise HTTPException(400, "pending tenant mismatch")
        scene = get_scene(str(pending.get("scene") or scene.id))
    if not str(question or "").strip() and not pending:
        raise HTTPException(400, "question 不能为空")
    confirm = bool(body.confirm or body.pending_id)
    manager_path = is_manager_request(
        headers=headers,
        messages=body.messages,
        mgr=mgr,
        force_manager=force_manager,
    )
    session_id = str(body.session_id or body.sessionId or (pending or {}).get("session_id") or "").strip()
    if session_id and not load_session(session_id):
        raise HTTPException(404, "session not found")
    suppress_history = bool(mgr.turn_scope and mgr.turn_scope.suppress_history)
    history = []
    if session_id and not suppress_history:
        history = recent_history(session_id, limit=get_settings().vanna_history_turns)
    if session_id and not pending:
        append_turn(session_id, role="user", content=question)
    experience_block = ""
    experience_hits = 0
    if not (mgr.turn_scope and mgr.turn_scope.suppress_experience_replay):
        xp = recall_experience(question, tenant_id=tenant.id, manager_path=manager_path)
        experience_hits = len(xp)
        experience_block = experience_prompt_block(xp)
    setattr(body, "_experience_hits", experience_hits)
    answer_ev: dict[str, Any] | None = None
    trace_meta: dict[str, Any] = {
        "tables": [],
        "source": "",
        "intent": "",
        "reason": "",
        "guard_ok": None,
        "executed": False,
        "repair": False,
        "row_count": 0,
        "error": "",
    }
    for ev in run_turn(
        tenant=tenant,
        scene=scene,
        question=question,
        confirm=confirm,
        pending=pending,
        sql_override=body.sql.strip() or None,
        history=history,
        manager_path=manager_path,
        hint_tables=mgr.hint_tables,
        hint_fields=mgr.hint_fields,
        must_filters=mgr.must_filters,
        experience_block=experience_block,
        experience_hits=experience_hits,
    ):
        kind = str(ev.get("event") or "")
        if kind == "retrieve":
            trace_meta["tables"] = list(ev.get("tables") or [])
        elif kind == "understand":
            trace_meta["intent"] = str(ev.get("intent") or "")
            trace_meta["reason"] = str(ev.get("reason") or "")
            if ev.get("tables"):
                trace_meta["tables"] = list(ev.get("tables") or [])
        elif kind == "sql":
            trace_meta["source"] = str(ev.get("source") or "")
        elif kind == "guard":
            trace_meta["guard_ok"] = bool(ev.get("ok"))
            if ev.get("tables"):
                trace_meta["tables"] = list(ev.get("tables") or [])
        elif kind == "repair":
            trace_meta["repair"] = True
        elif kind == "execute":
            trace_meta["executed"] = bool(ev.get("ok"))
            trace_meta["row_count"] = int(ev.get("row_count") or 0)
            trace_meta["error"] = str(ev.get("error") or "")
        if kind == "checkpoint" and session_id:
            pid = str(ev.get("pending_id") or "")
            draft = load_pending(pid) if pid else None
            if draft:
                draft["session_id"] = session_id
                save_pending(draft)
        if kind == "answer":
            answer_ev = ev
        yield ev
    if session_id and answer_ev:
        meta = {
            "sql": answer_ev.get("sql") or "",
            "checkpoint": bool(answer_ev.get("checkpoint")),
            "pending_id": answer_ev.get("pending_id") or "",
            "row_count": len(answer_ev.get("rows") or []) or int(trace_meta.get("row_count") or 0),
            "cost": answer_ev.get("cost") or {},
            "tables": trace_meta.get("tables") or [],
            "source": trace_meta.get("source") or "",
            "intent": trace_meta.get("intent") or "",
            "reason": trace_meta.get("reason") or "",
            "guard_ok": trace_meta.get("guard_ok"),
            "executed": bool(trace_meta.get("executed") or answer_ev.get("executed")),
            "repair": bool(trace_meta.get("repair")),
            "error": trace_meta.get("error") or "",
            "rows": list(answer_ev.get("rows") or [])[:30],
            "field_details": list(answer_ev.get("field_details") or [])[:12],
            "needs_clarify": bool(answer_ev.get("needs_clarify")),
        }
        text = str(answer_ev.get("text") or "")
        if pending:
            replace_checkpoint_assistant(session_id, content=text, meta=meta)
        else:
            append_turn(session_id, role="assistant", content=text, meta=meta)


if FRONTEND.is_dir():
    app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="static")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(FRONTEND / "index.html")
