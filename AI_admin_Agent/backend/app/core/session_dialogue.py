"""
按 session 保存多轮对话与未完成任务上下文（WebSocket 每轮只发一条消息时的续接）。
"""
from __future__ import annotations

import datetime
import json
import re
from app.core.time_nlu import resolve_datetime_with_llm
from typing import Any, Dict, List, Optional

from app.core.config import settings
from app.core.llm import qwen_llm
from app.core.admin_pg_store import (
    append_turn_pg,
    count_turns_pg,
    delete_session_pg,
    is_admin_dual_storage,
    is_admin_pg_primary,
    is_admin_pg_storage,
    load_recent_turns_pg,
    load_task_context_pg,
    load_turns_pg,
    replace_last_assistant_turn_pg,
    save_task_context_pg,
    trim_turns_pg,
    touch_adm_session_pg,
)
from app.db.database import SessionLocal, engine, Base
from sqlalchemy import Column, DateTime, Integer, String, Text


class SessionTurn(Base):
    __tablename__ = "session_turns"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, index=True)
    role = Column(String)  # user | assistant
    content = Column(Text)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class SessionTaskContext(Base):
    __tablename__ = "session_task_contexts"
    session_id = Column(String, primary_key=True, index=True)
    context_json = Column(Text, default="{}")
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)


def _ensure_tables() -> None:
    Base.metadata.create_all(bind=engine, tables=[SessionTurn.__table__, SessionTaskContext.__table__])


_ensure_tables()


def _sid(session_id: str | None) -> str:
    return (session_id or "default").strip() or "default"


def _use_pg_dialogue() -> bool:
    return is_admin_pg_storage()


def _mirror_sqlite() -> bool:
    return is_admin_dual_storage() or not is_admin_pg_primary()


def append_turn(session_id: str, role: str, content: str, user_id: str | None = None) -> None:
    sid = _sid(session_id)
    text = (content or "").strip()
    if not text:
        return
    if _use_pg_dialogue():
        append_turn_pg(sid, role, text, user_id=user_id)
    if _mirror_sqlite():
        db = SessionLocal()
        db.add(SessionTurn(session_id=sid, role=role, content=text))
        db.commit()
        db.close()


def replace_last_assistant_turn(session_id: str, content: str) -> bool:
    """用新内容覆盖最近一条助手回复（弹窗确认续跑时保持同一对话轮次）。"""
    sid = _sid(session_id)
    text = (content or "").strip()
    if not text:
        return False
    if _use_pg_dialogue():
        return replace_last_assistant_turn_pg(sid, text)
    db = SessionLocal()
    try:
        row = (
            db.query(SessionTurn)
            .filter(SessionTurn.session_id == sid, SessionTurn.role == "assistant")
            .order_by(SessionTurn.id.desc())
            .first()
        )
        if not row:
            append_turn(sid, "assistant", text)
            return True
        row.content = text
        db.commit()
        return True
    finally:
        db.close()


def truncate_session_from_user_index(
    session_id: str,
    from_user_index: int,
    *,
    replace_user_text: str | None = None,
    fallback_user_text: str | None = None,
) -> dict[str, int | bool]:
    """从第 from_user_index 条用户消息起截断（含该条及之后所有轮次）。

    index 未命中时，可用 fallback_user_text / replace_user_text 按内容回落定位。
    """
    sid = (session_id or "default").strip() or "default"
    try:
        raw_idx = int(from_user_index)
    except (TypeError, ValueError):
        raw_idx = -1
    idx = raw_idx if raw_idx >= 0 else -1
    needle = _normalize_user_anchor_text(fallback_user_text or replace_user_text or "")
    db = SessionLocal()
    try:
        rows = (
            db.query(SessionTurn)
            .filter(SessionTurn.session_id == sid)
            .order_by(SessionTurn.id.asc())
            .all()
        )
        user_idx = 0
        cut_id: int | None = None
        resolved_user_index = -1
        for row in rows:
            if row.role == "user":
                if idx >= 0 and user_idx == idx:
                    cut_id = row.id
                    resolved_user_index = user_idx
                    break
                user_idx += 1
        if cut_id is None and needle:
            user_idx = 0
            hits: list[tuple[int, int]] = []  # (row.id, user_idx)
            for row in rows:
                if row.role != "user":
                    continue
                if _normalize_user_anchor_text(str(row.content or "")) == needle:
                    hits.append((row.id, user_idx))
                user_idx += 1
            if hits:
                if idx >= 0:
                    best = min(hits, key=lambda h: abs(h[1] - idx))
                else:
                    best = hits[-1]
                cut_id, resolved_user_index = best
        if cut_id is None:
            return {"ok": False, "message_count": len(rows), "user_message_count": user_idx}
        db.query(SessionTurn).filter(
            SessionTurn.session_id == sid,
            SessionTurn.id >= cut_id,
        ).delete(synchronize_session=False)
        db.commit()
        replace = (replace_user_text or "").strip()
        if replace:
            db.add(SessionTurn(session_id=sid, role="user", content=replace))
            db.commit()
        message_count = db.query(SessionTurn).filter(SessionTurn.session_id == sid).count()
        user_message_count = (
            db.query(SessionTurn)
            .filter(SessionTurn.session_id == sid, SessionTurn.role == "user")
            .count()
        )
        return {
            "ok": True,
            "message_count": message_count,
            "user_message_count": user_message_count,
            "resolved_user_index": resolved_user_index,
        }
    finally:
        db.close()


def _normalize_user_anchor_text(content: str) -> str:
    import re

    s = str(content or "").strip()
    s = re.sub(r"\n\[附件:[^\]]+\]\s*$", "", s, flags=re.I)
    s = re.sub(r"^\[附件:[^\]]+\]\s*$", "", s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip()

def get_last_user_message(session_id: str) -> str:
    sid = _sid(session_id)
    if _use_pg_dialogue():
        rows = load_recent_turns_pg(sid, 50)
        for row in reversed(rows):
            if str(row.get("role") or "") == "user":
                return str(row.get("content") or "").strip()
        return ""
    db = SessionLocal()
    try:
        row = (
            db.query(SessionTurn)
            .filter(SessionTurn.session_id == sid, SessionTurn.role == "user")
            .order_by(SessionTurn.id.desc())
            .first()
        )
        return str(row.content or "").strip() if row else ""
    finally:
        db.close()


def _count_turns(session_id: str) -> int:
    sid = _sid(session_id)
    if _use_pg_dialogue():
        return count_turns_pg(sid)
    db = SessionLocal()
    try:
        return db.query(SessionTurn).filter(SessionTurn.session_id == sid).count()
    finally:
        db.close()


def delete_session_dialogue(session_id: str) -> dict[str, Any]:
    """整段删除会话对话与任务上下文（SQLite + 可选 PG）。"""
    sid = _sid(session_id)
    _ensure_tables()
    pg_stats = {"turns": 0, "contexts": 0}
    sqlite_turns = 0
    sqlite_ctx = 0
    if is_admin_pg_storage():
        try:
            pg_stats = delete_session_pg(sid)
        except Exception:
            pg_stats = {"turns": 0, "contexts": 0}
    if not is_admin_pg_primary():
        db = SessionLocal()
        try:
            sqlite_turns = (
                db.query(SessionTurn).filter(SessionTurn.session_id == sid).delete(synchronize_session=False)
            )
            sqlite_ctx = (
                db.query(SessionTaskContext)
                .filter(SessionTaskContext.session_id == sid)
                .delete(synchronize_session=False)
            )
            db.commit()
        finally:
            db.close()
    return {
        "ok": True,
        "session_id": sid,
        "pg": pg_stats,
        "sqlite": {"turns": int(sqlite_turns or 0), "contexts": int(sqlite_ctx or 0)},
    }


def _load_dialogue_summary_meta(session_id: str) -> dict:
    ctx = load_task_context(session_id)
    meta = ctx.get("dialogue_summary_meta")
    return meta if isinstance(meta, dict) else {}


def _save_dialogue_summary_meta(session_id: str, meta: dict) -> None:
    ctx = load_task_context(session_id)
    ctx["dialogue_summary_meta"] = meta
    save_task_context(session_id, ctx)


def _maybe_refresh_dialogue_summary(session_id: str, total_turns: int) -> str:
    if not settings.ADMIN_DIALOGUE_SUMMARY:
        return ""
    max_recent = max(6, int(settings.ADMIN_DIALOGUE_MAX_TURNS))
    if total_turns <= max_recent + 2:
        return ""

    meta = _load_dialogue_summary_meta(session_id)
    last_at_turn = int(meta.get("summarized_through_turn", 0) or 0)
    if total_turns - last_at_turn < 4 and meta.get("summary"):
        return str(meta.get("summary") or "")

    older_count = total_turns - max_recent
    if _use_pg_dialogue():
        older = load_turns_pg(session_id, limit=max(0, older_count))
    else:
        db = SessionLocal()
        try:
            older = (
                db.query(SessionTurn)
                .filter(SessionTurn.session_id == _sid(session_id))
                .order_by(SessionTurn.id.asc())
                .limit(max(0, older_count))
                .all()
            )
        finally:
            db.close()

    if not older:
        return str(meta.get("summary") or "")

    lines = []
    for row in older[-20:]:
        role_val = row.role if hasattr(row, "role") else row.get("role")
        content_val = row.content if hasattr(row, "content") else row.get("content")
        role = "用户" if role_val == "user" else "助手"
        lines.append(f"{role}：{str(content_val or '')[:200]}")
    prompt = (
        "请用 2～4 句中文概括以下较早对话的要点（人物/事项/待办/已确认操作），"
        "不要编造，没有要点可说「无重要历史」。\n\n"
        + "\n".join(lines)
    )
    try:
        summary = qwen_llm.chat_text([{"role": "user", "content": prompt}]).strip()
    except Exception:
        summary = f"（此前共 {older_count} 轮对话，涉及日程/待办/邮件等办公事项）"

    _save_dialogue_summary_meta(
        session_id,
        {"summary": summary, "summarized_through_turn": total_turns, "updated_at": datetime.datetime.utcnow().isoformat()},
    )
    return summary


def get_dialogue_text(session_id: str, max_turns: int | None = None) -> str:
    sid = _sid(session_id)
    limit = int(max_turns or settings.ADMIN_DIALOGUE_MAX_TURNS or 6)
    total = _count_turns(sid)
    summary = _maybe_refresh_dialogue_summary(sid, total)

    if _use_pg_dialogue():
        rows = load_recent_turns_pg(sid, limit)
    else:
        db = SessionLocal()
        rows = (
            db.query(SessionTurn)
            .filter(SessionTurn.session_id == sid)
            .order_by(SessionTurn.id.desc())
            .limit(limit)
            .all()
        )
        db.close()
    lines: List[str] = []
    if summary:
        lines.append(f"【较早对话摘要】{summary}")
    for row in rows:
        role_val = row.role if hasattr(row, "role") else row.get("role")
        content_val = row.content if hasattr(row, "content") else row.get("content")
        role = "用户" if role_val == "user" else "助手"
        lines.append(f"{role}：{content_val}")
    return "\n".join(lines)


def ensure_session_dialogue_budget(session_id: str, max_turns: int | None = None) -> bool:
    """删除最早对话轮次，保留近 max_turns 条消息。返回是否执行了截断。"""
    sid = _sid(session_id)
    limit = max(4, int(max_turns or settings.ADMIN_DIALOGUE_MAX_TURNS or 6))
    max_messages = limit * 2
    if _use_pg_dialogue():
        trimmed = trim_turns_pg(sid, max_messages)
        if _mirror_sqlite():
            db = SessionLocal()
            try:
                rows = (
                    db.query(SessionTurn)
                    .filter(SessionTurn.session_id == sid)
                    .order_by(SessionTurn.id.asc())
                    .all()
                )
                if len(rows) > max_messages:
                    cut = len(rows) - max_messages
                    ids_to_drop = [r.id for r in rows[:cut]]
                    db.query(SessionTurn).filter(SessionTurn.id.in_(ids_to_drop)).delete(synchronize_session=False)
                    db.commit()
                    return True
            finally:
                db.close()
        return trimmed
    db = SessionLocal()
    try:
        rows = (
            db.query(SessionTurn)
            .filter(SessionTurn.session_id == sid)
            .order_by(SessionTurn.id.asc())
            .all()
        )
        if len(rows) <= max_messages:
            return False
        cut = len(rows) - max_messages
        ids_to_drop = [r.id for r in rows[:cut]]
        db.query(SessionTurn).filter(SessionTurn.id.in_(ids_to_drop)).delete(synchronize_session=False)
        db.commit()
        return True
    finally:
        db.close()


def save_task_context(session_id: str, ctx: Dict[str, Any]) -> None:
    sid = _sid(session_id)
    payload = ctx or {}
    if _use_pg_dialogue():
        save_task_context_pg(sid, payload)
    if _mirror_sqlite():
        db = SessionLocal()
        row = db.query(SessionTaskContext).filter(SessionTaskContext.session_id == sid).first()
        payload_json = json.dumps(payload, ensure_ascii=False)
        now = datetime.datetime.utcnow()
        if row:
            row.context_json = payload_json
            row.updated_at = now
        else:
            db.add(SessionTaskContext(session_id=sid, context_json=payload_json, updated_at=now))
        db.commit()
        db.close()


def load_task_context(session_id: str) -> Dict[str, Any]:
    sid = _sid(session_id)
    if _use_pg_dialogue():
        data = load_task_context_pg(sid)
        if data:
            return data
        if not _mirror_sqlite():
            return {}
    db = SessionLocal()
    row = db.query(SessionTaskContext).filter(SessionTaskContext.session_id == sid).first()
    db.close()
    if not row:
        return {}
    try:
        data = json.loads(row.context_json or "{}")
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def remember_last_intent(session_id: str, intent: str) -> None:
    """跨轮记录上一轮 NLU intent，供 output_followup 锁定工具面。"""
    label = str(intent or "").strip()
    if not label or label in ("其他", "二次确认"):
        return
    ctx = load_task_context(session_id) or {}
    if ctx.get("last_intent") == label:
        return
    save_task_context(session_id, {**ctx, "last_intent": label})


def load_last_intent(session_id: str) -> str:
    ctx = load_task_context(session_id) or {}
    return str(ctx.get("last_intent") or "").strip()


def clear_task_context(session_id: str) -> None:
    save_task_context(session_id, {})


def _looks_like_new_intent(text: str, pending_field: str = "") -> bool:
    from app.core.admin_text_sensitivity import looks_like_time_answer

    s = (text or "").strip()
    if pending_field in ("start_time_expression", "task_due_time_expression"):
        if looks_like_time_answer(s):
            return False
    if len(s) <= 28 and looks_like_time_answer(s):
        return False
    if len(s) > 40:
        return True
    if re.search(r"(帮我|请|添加|查|搜索|天气|邮件|待办|日程|开会|会议|删除|列出)", s):
        return True
    if re.search(r"(确认|取消)\s*[\d０-９]+", s):
        return True
    return False


def _missing_fields_for_schedule(slots: Dict[str, Any], resolved_time: Any) -> List[str]:
    missing: List[str] = []
    title = str(slots.get("event_title") or "").strip()
    time_expr = str(slots.get("start_time_expression") or "").strip()
    if len(title) < 2:
        missing.append("event_title")
    if not time_expr and not (isinstance(resolved_time, dict) and resolved_time.get("start_time_local")):
        missing.append("start_time_expression")
    return missing


def _missing_fields_for_contact(slots: Dict[str, Any]) -> List[str]:
    missing: List[str] = []
    if len(str(slots.get("contact_name") or "").strip()) < 1:
        missing.append("contact_name")
    if len(str(slots.get("contact_email") or "").strip()) < 3:
        missing.append("contact_email")
    return missing


def save_clarification_from_understanding(
    session_id: str, understanding: Dict[str, Any], dialogue: str
) -> None:
    intent = str(understanding.get("intent") or "")
    if intent not in ("日程", "待办", "联系人", "混合任务"):
        return
    slots = understanding.get("slots") if isinstance(understanding.get("slots"), dict) else {}
    resolved = understanding.get("resolved_time")
    if intent == "待办":
        missing = []
        if len(str(slots.get("task_title") or "").strip()) < 2:
            missing.append("task_title")
    elif intent == "联系人":
        missing = _missing_fields_for_contact(slots)
    else:
        missing = _missing_fields_for_schedule(slots, resolved)
    if not missing:
        return
    save_task_context(
        session_id,
        {
            "intent": intent,
            "slots": slots,
            "resolved_time": resolved,
            "missing": missing,
            "dialogue": dialogue,
        },
    )


def clarification_question_for_missing(missing: List[str]) -> str:
    if not missing:
        return "我还需要一点信息才能继续。"
    field = missing[0]
    if field == "event_title":
        return "请问这次会议/日程的标题是什么？"
    if field == "start_time_expression":
        return "请问具体在什么时间？（例如：下周五上午9点 / next Friday 9am / tomorrow 3pm）"
    if field == "task_title":
        return "请问待办事项的内容是什么？"
    if field == "contact_name":
        return "请问联系人的姓名是什么？"
    if field == "contact_email":
        return "请问联系人的邮箱是什么？"
    return "我还需要一点信息才能继续。"


def try_continue_task(session_id: str, user_message: str) -> Optional[Dict[str, Any]]:
    """
    若上一轮在等用户补槽位，则将本轮短回复合并进 understanding，避免「员工大会」被当成新员工咨询。
    """
    ctx = load_task_context(session_id)
    if not ctx:
        return None
    missing = list(ctx.get("missing") or [])
    if not missing:
        return None
    if _looks_like_new_intent(user_message, pending_field=missing[0] if missing else ""):
        clear_task_context(session_id)
        return None

    slots = dict(ctx.get("slots") or {})
    field = missing[0]
    answer = (user_message or "").strip()
    resolved_time = ctx.get("resolved_time")
    if field == "event_title":
        slots["event_title"] = answer
    elif field in ("start_time_expression", "task_due_time_expression"):
        if field == "start_time_expression":
            slots["start_time_expression"] = answer
        else:
            slots["task_due_time_expression"] = answer
        dialogue_ctx = str(ctx.get("dialogue") or "").strip()
        anchor = f"{dialogue_ctx}\n用户：{answer}" if dialogue_ctx else answer
        time_res = resolve_datetime_with_llm(anchor, answer)
        if time_res.get("ok"):
            resolved_time = time_res
    elif field == "task_title":
        slots["task_title"] = answer
    elif field == "contact_name":
        slots["contact_name"] = answer
    elif field == "contact_email":
        slots["contact_email"] = answer
    else:
        return None

    missing = missing[1:]
    intent = str(ctx.get("intent") or "日程")

    if missing:
        save_task_context(
            session_id,
            {**ctx, "slots": slots, "missing": missing, "resolved_time": resolved_time},
        )
        return {
            "intent": intent,
            "needs_clarification": True,
            "clarification_questions": [clarification_question_for_missing(missing)],
            "slots": slots,
            "resolved_time": resolved_time,
        }

    clear_task_context(session_id)
    return {
        "intent": intent,
        "needs_clarification": False,
        "slots": slots,
        "resolved_time": resolved_time,
    }
