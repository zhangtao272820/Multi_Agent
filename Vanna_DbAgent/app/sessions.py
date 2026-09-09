"""会话记忆：本地 JSON 落盘，不进 Manager / 不绑 LangGraph。"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.settings import data_dir


def _root() -> Path:
    p = data_dir() / "sessions"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _path(session_id: str) -> Path:
    sid = "".join(ch for ch in str(session_id or "").strip() if ch.isalnum() or ch in "-_")
    if not sid:
        raise ValueError("empty session_id")
    return _root() / f"{sid}.json"


def new_session(
    *,
    tenant: str = "p2604",
    scene: str = "assistant",
    title: str = "",
    org_tenant_id: str = "default",
    user_id: str = "",
) -> dict[str, Any]:
    sid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": sid,
        "tenant": tenant,  # 业务库域（p2604…），与 JWT org_tenant_id 分字段
        "org_tenant_id": str(org_tenant_id or "default").strip() or "default",
        "user_id": str(user_id or "").strip(),
        "scene": scene,
        "title": title or "新对话",
        "created_at": now,
        "updated_at": now,
        "messages": [],
    }
    _path(sid).write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    return doc


def load_session(
    session_id: str,
    *,
    org_tenant_id: str | None = None,
    user_id: str | None = None,
) -> dict[str, Any] | None:
    path = _path(session_id)
    if not path.is_file():
        return None
    doc = json.loads(path.read_text(encoding="utf-8"))
    want_org = str(org_tenant_id or "").strip()
    want_uid = str(user_id or "").strip()
    if want_org:
        got_org = str(doc.get("org_tenant_id") or "default").strip() or "default"
        if got_org != want_org:
            return None
    if want_uid:
        got_uid = str(doc.get("user_id") or "").strip()
        if got_uid and got_uid != want_uid:
            return None
    return doc


def list_sessions(
    limit: int = 40,
    *,
    org_tenant_id: str | None = None,
    user_id: str | None = None,
) -> list[dict[str, Any]]:
    want_org = str(org_tenant_id or "").strip()
    want_uid = str(user_id or "").strip()
    items: list[dict[str, Any]] = []
    for path in sorted(_root().glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if want_org:
            got_org = str(raw.get("org_tenant_id") or "default").strip() or "default"
            if got_org != want_org:
                continue
        if want_uid:
            got_uid = str(raw.get("user_id") or "").strip()
            if got_uid and got_uid != want_uid:
                continue
        items.append(
            {
                "id": raw.get("id") or path.stem,
                "title": raw.get("title") or "对话",
                "tenant": raw.get("tenant"),
                "org_tenant_id": raw.get("org_tenant_id"),
                "user_id": raw.get("user_id"),
                "scene": raw.get("scene"),
                "updated_at": raw.get("updated_at"),
                "turns": len(raw.get("messages") or []),
            }
        )
        if len(items) >= max(1, limit):
            break
    return items


def save_session(doc: dict[str, Any]) -> dict[str, Any]:
    sid = str(doc.get("id") or "")
    doc["updated_at"] = datetime.now(timezone.utc).isoformat()
    _path(sid).write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    return doc


def delete_session(session_id: str) -> bool:
    path = _path(session_id)
    if path.is_file():
        path.unlink()
        return True
    return False


def rename_session(session_id: str, title: str) -> dict[str, Any] | None:
    doc = load_session(session_id)
    if not doc:
        return None
    doc["title"] = str(title or "").strip() or doc.get("title") or "对话"
    return save_session(doc)


def append_turn(
    session_id: str,
    *,
    role: str,
    content: str,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    doc = load_session(session_id)
    if not doc:
        return None
    msgs = list(doc.get("messages") or [])
    msgs.append(
        {
            "id": str(uuid.uuid4()),
            "role": role,
            "content": content,
            "ts": datetime.now(timezone.utc).isoformat(),
            "meta": meta or {},
        }
    )
    doc["messages"] = msgs[-80:]
    if role == "user" and (doc.get("title") in ("", "新对话", "对话") or not doc.get("title")):
        title = str(content or "").strip().replace("\n", " ")
        doc["title"] = (title[:28] + "…") if len(title) > 28 else (title or "对话")
    return save_session(doc)


def peek_messages_from(session_id: str, message_id: str) -> list[dict[str, Any]]:
    """返回将从 truncate 删除的消息（含自身），不改盘。"""
    doc = load_session(session_id)
    if not doc:
        return []
    mid = str(message_id or "").strip()
    if not mid:
        return []
    msgs = list(doc.get("messages") or [])
    idx = next((i for i, m in enumerate(msgs) if str(m.get("id") or "") == mid), -1)
    if idx < 0:
        return []
    return msgs[idx:]


def truncate_from_message(session_id: str, message_id: str) -> dict[str, Any] | None:
    """删除指定消息及其之后的全部轮次。"""
    doc = load_session(session_id)
    if not doc:
        return None
    mid = str(message_id or "").strip()
    if not mid:
        raise ValueError("empty message_id")
    msgs = list(doc.get("messages") or [])
    idx = next((i for i, m in enumerate(msgs) if str(m.get("id") or "") == mid), -1)
    if idx < 0:
        raise KeyError("message not found")
    doc["messages"] = msgs[:idx]
    return save_session(doc)


def replace_checkpoint_assistant(
    session_id: str,
    *,
    content: str,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """确认执行后合并成同一轮：覆盖最近一条 checkpoint 助手消息。"""
    doc = load_session(session_id)
    if not doc:
        return None
    msgs = list(doc.get("messages") or [])
    for i in range(len(msgs) - 1, -1, -1):
        m = msgs[i]
        if str(m.get("role") or "") != "assistant":
            continue
        meta0 = m.get("meta") if isinstance(m.get("meta"), dict) else {}
        if meta0.get("checkpoint"):
            msgs[i] = {
                **m,
                "content": content,
                "ts": datetime.now(timezone.utc).isoformat(),
                "meta": meta or {},
            }
            doc["messages"] = msgs
            return save_session(doc)
    return append_turn(session_id, role="assistant", content=content, meta=meta)


def recent_history(session_id: str | None, limit: int = 6) -> list[dict[str, str]]:
    if not session_id:
        return []
    doc = load_session(session_id)
    if not doc:
        return []
    out: list[dict[str, str]] = []
    for m in (doc.get("messages") or [])[-max(1, limit) :]:
        role = str(m.get("role") or "")
        content = str(m.get("content") or "").strip()
        if role in {"user", "assistant"} and content:
            out.append({"role": role, "content": content[:500]})
    return out
