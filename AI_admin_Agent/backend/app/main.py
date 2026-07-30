from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from app.core.config import settings
from app.core.llm import qwen_llm
from app.core.internal_auth import accept_websocket_connection, verify_internal_token
from app.core.platform_config import refresh_platform_model_cache
from app.core.token_control import token_controller
from app.core.time_utils import utc_now_naive, utc_naive_to_local_iso
from langchain_core.messages import HumanMessage
from app.graph.state import agent_graph
from app.core.session_dialogue import append_turn, get_last_user_message, truncate_session_from_user_index, ensure_session_dialogue_budget, ensure_session_dialogue_budget, replace_last_assistant_turn
from app.core.agent_result import build_admin_agent_result
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
    from_user_index: int
    from_turn_id: int | None = None
    replace_user_text: str | None = None


class PendingDecideRequest(BaseModel):
    session_id: str = "default"
    action_id: int
    decision: str


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
async def get_tasks(db: Session = Depends(get_db)):
    tasks = db.query(Task).order_by(Task.created_at.desc()).all()
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


@app.get("/api/tasks/{task_id}")
async def get_task_detail(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
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
async def delete_task_api(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    db.delete(task)
    db.commit()
    return {"status": "ok"}

@app.get("/api/calendar")
async def get_calendar(db: Session = Depends(get_db)):
    events = db.query(Event).all()
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
async def get_event_detail(event_id: int, db: Session = Depends(get_db)):
    event = db.query(Event).filter(Event.id == event_id).first()
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
async def get_notes(db: Session = Depends(get_db)):
    notes = db.query(Note).order_by(Note.created_at.desc()).all()
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
async def get_contacts():
    result = list_contacts()
    return {"contacts": _tool_text(result), "items": _tool_items(result)}


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


@app.get("/api/briefing")
async def api_daily_briefing(session_id: str = "default", city: str = "", include_emails: bool = True):
    from app.tools.briefing import daily_briefing

    result = daily_briefing(
        city=str(city or "").strip(),
        session_id=str(session_id or "default").strip() or "default",
        include_emails=bool(include_emails),
    )
    return {
        "ok": bool(result.get("ok")),
        "text": _tool_text(result),
        "raw": result,
    }


@app.get("/api/mail/inbox")
async def get_mail_inbox(session_id: str = "default", limit: int = 10, unread_only: bool = True):
    result = list_emails(session_id=session_id, limit=limit, unread_only=unread_only)
    return {"inbox": _tool_text(result), "items": _tool_items(result), "ok": isinstance(result, dict) and result.get("ok")}


@app.get("/api/mail/inbox/{email_id}")
async def get_mail_detail_api(email_id: int, session_id: str = "default"):
    result = get_email_detail(email_id=email_id, session_id=session_id)
    if isinstance(result, dict) and result.get("ok") is False:
        raise HTTPException(status_code=404, detail=_tool_text(result))
    return {"mail": _tool_data(result, {}), "ok": True}


@app.post("/api/mail/reply")
async def reply_mail_api(payload: ReplyEmailRequest):
    result = reply_email(
        email_id=payload.email_id,
        content=payload.content,
        session_id=payload.session_id,
    )
    return {"result": _tool_text(result), "raw": result}


@app.get("/api/mail/classify")
async def classify_mail_api(session_id: str = "default", limit: int = 20):
    result = classify_emails(session_id=session_id, limit=limit)
    return {"classification": _tool_text(result), "raw": result}


@app.get("/api/pending")
async def get_pending_actions(session_id: str = "default"):
    result = list_pending_actions(session_id=session_id)
    return {"pending": _tool_text(result), "items": _tool_items(result)}


@app.post("/api/pending/decide")
async def decide_pending_action(body: PendingDecideRequest):
    from app.tools.pending import decide_action

    sid = str(body.session_id or "default").strip() or "default"
    result = decide_action(sid, int(body.action_id), body.decision)
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
async def post_feedback(body: FeedbackRequest):
    from app.core.admin_session_feedback import turn_feedback_key, upsert_session_feedback, user_message_feedback_key
    from app.core.admin_artifact_feedback import handle_admin_feedback

    score = int(body.score)
    if score not in (1, -1):
        raise HTTPException(status_code=400, detail="score 须为 1 或 -1")
    question = str(body.question or "").strip()
    session_id = str(body.session_id or "").strip()
    if not question or not session_id:
        raise HTTPException(status_code=400, detail="question 与 session_id 不能为空")
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

            append_prompt_patch(stage="router", text=str(body.comment).strip()[:200], source="feedback")
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
async def get_session_feedback(session_id: str):
    from app.core.admin_session_feedback import list_session_feedback

    sid = str(session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id 不能为空")
    return {"items": list_session_feedback(sid)}


@app.post("/api/session-feedback/delete")
async def delete_session_feedback(body: FeedbackDeleteRequest):
    from app.core.admin_session_feedback import (
        delete_all_session_feedback,
        delete_feedback_at_user_index,
        delete_feedback_from_turn,
        delete_feedback_from_user_index,
    )

    sid = str(body.session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id 不能为空")
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


@app.post("/api/session-truncate")
async def truncate_session(body: SessionTruncateRequest):
    from app.core.admin_session_feedback import (
        delete_feedback_at_user_index,
        delete_feedback_from_turn,
        delete_feedback_from_user_index,
    )
    from app.core.session_dialogue import truncate_session_from_user_index

    sid = str(body.session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id 不能为空")
    result = truncate_session_from_user_index(
        sid,
        int(body.from_user_index),
        replace_user_text=body.replace_user_text,
    )
    feedback_deleted = 0
    if body.replace_user_text is not None and str(body.replace_user_text).strip():
        feedback_deleted = delete_feedback_at_user_index(sid, int(body.from_user_index))
    else:
        feedback_deleted = delete_feedback_from_user_index(sid, int(body.from_user_index))
        if body.from_turn_id is not None:
            feedback_deleted += delete_feedback_from_turn(sid, int(body.from_turn_id))
    return {
        "ok": bool(result.get("ok")),
        "session_id": sid,
        "user_message_count": result.get("user_message_count", 0),
        "message_count": result.get("message_count", 0),
        "feedback_deleted": feedback_deleted,
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
async def get_files():
    try:
        root = settings.WORKSPACE_DIR
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


def _resolve_workspace_file(rel_path: str) -> str:
    rel = str(rel_path or "").replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in rel.split("/"):
        raise HTTPException(status_code=400, detail="Invalid file path")
    abs_path = os.path.normpath(os.path.join(settings.WORKSPACE_DIR, rel))
    workspace = os.path.normpath(settings.WORKSPACE_DIR)
    if not abs_path.startswith(workspace):
        raise HTTPException(status_code=400, detail="Path outside workspace")
    if not os.path.isfile(abs_path):
        raise HTTPException(status_code=404, detail="File not found")
    return abs_path


@app.get("/api/files/content")
async def get_file_content(path: str, max_chars: int = 20000):
    abs_path = _resolve_workspace_file(path)
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
            user_id = str(
                message_data.get("user_id")
                or websocket.headers.get("x-user-id")
                or ""
            ).strip() or None
            auto_confirm_risky = bool(message_data.get("auto_confirm_risky", False))
            trace_id = str(
                message_data.get("trace_id")
                or websocket.headers.get("x-trace-id")
                or websocket.headers.get("x-run-id")
                or ""
            ).strip() or None
            raw_client_context = message_data.get("client_context")
            client_context = raw_client_context if isinstance(raw_client_context, dict) else {}
            if client_context.get("manager_task") and not client_context.get("manager_orchestrated"):
                client_context["manager_orchestrated"] = True
            # 总管显式传 auto_confirm_risky=false 时不得覆盖（写闸 / HITL 由 Manager 控制）
            if (
                "auto_confirm_risky" not in message_data
                and client_context.get("manager_orchestrated")
                and os.getenv("ADMIN_MANAGER_AUTO_CONFIRM", "1").strip() not in ("0", "false", "no")
            ):
                auto_confirm_risky = True
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
                            "args": {
                                "session_id": session_id,
                                "action_id": action_id,
                                "decision": decision,
                            },
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
                if not isinstance(user_message_index, int):
                    await manager.send_personal_message(
                        json.dumps(
                            {
                                "type": "error",
                                "error": "重新生成/编辑重发需要 user_message_index",
                            }
                        ),
                        websocket,
                    )
                    continue
                if chat_mode == "regenerate":
                    stored = get_last_user_message(session_id)
                    user_message = str(user_message or stored or "").strip()
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
                        from app.core.admin_session_feedback import delete_feedback_at_user_index

                        delete_feedback_at_user_index(session_id, int(user_message_index))
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
                    truncate_session_from_user_index(session_id, int(user_message_index))
                    append_turn(session_id, "user", user_message)
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
                append_turn(session_id, "user", user_message)

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

            # Send final response
            response_text = _graph_response_text(final_result)
            latency_ms = int((time.time() - started) * 1000)
            agent_result = build_admin_agent_result(
                response_text,
                trace_id=trace_id,
                latency_ms=latency_ms,
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
            response_data = {
                "type": "final",
                "response": response_text,
                "tokens_used": _calc_total_tokens(
                    final_result,
                    user_message,
                    response_text
                ),
                "status": "success",
                "thoughts": final_result.get("thoughts", []),
                "cards": final_result.get("ui_cards") or [],
                "agentResult": agent_result,
            }
            token_controller.update_usage(session_id, response_data["tokens_used"])

            await manager.send_personal_message(json.dumps(response_data), websocket)
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
    try:
        estimated_tokens = qwen_llm.get_token_count(request.message)
        if not token_controller.check_limit(request.session_id, estimated_tokens):
            raise HTTPException(status_code=429, detail="Token quota exceeded for this session.")

        # Initial state for LangGraph
        initial_state = {
            "messages": [HumanMessage(content=request.message)],
            "session_id": request.session_id,
            "user_id": str(request.user_id or "").strip() or None,
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
            structured={"tokens_used": tokens_used, **_mail_draft_structured(result)},
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
