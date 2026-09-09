from __future__ import annotations

from app.db.database import Note, SessionLocal
from app.tools.common import _tool_err, _tool_ok
from app.core.time_utils import utc_naive_to_local_naive
from app.core.tenant_scope import require_request_scope


def add_note(title: str, content: str) -> str:
    clean_title = (title or "").strip() or "未命名笔记"
    db = SessionLocal()
    tid, uid = require_request_scope()
    note = Note(title=clean_title, content=content or "", tenant_id=tid, user_id=uid)
    db.add(note)
    db.commit()
    db.refresh(note)
    db.close()
    return _tool_ok(
        f"已创建笔记: {clean_title}",
        data={"note_id": note.id, "title": clean_title},
    )


def list_notes() -> str:
    db = SessionLocal()
    tid, uid = require_request_scope()
    notes = (
        db.query(Note)
        .filter(Note.tenant_id == tid, Note.user_id == uid)
        .order_by(Note.created_at.desc())
        .all()
    )
    db.close()
    if not notes:
        return _tool_ok("当前没有笔记。", data={"items": [], "count": 0}, code="empty")
    lines = ["笔记列表："]
    items = []
    for n in notes[:30]:
        local_created = utc_naive_to_local_naive(n.created_at) if n.created_at else None
        lines.append(
            f"- [{n.id}] {n.title}（{local_created.strftime('%Y-%m-%d %H:%M') if local_created else '未知时间'}）"
        )
        items.append(
            {
                "id": n.id,
                "title": n.title,
                "content": n.content or "",
                "created_at_local": local_created.strftime("%Y-%m-%d %H:%M:%S") if local_created else None,
            }
        )
    return _tool_ok("\n".join(lines), data={"items": items, "count": len(items)})


def delete_note(note_id: int) -> str:
    db = SessionLocal()
    tid, uid = require_request_scope()
    note = (
        db.query(Note)
        .filter(Note.id == note_id, Note.tenant_id == tid, Note.user_id == uid)
        .first()
    )
    if not note:
        db.close()
        return _tool_err(
            f"未找到ID为 {note_id} 的笔记。",
            data={"note_id": note_id},
            code="note_not_found",
        )
    title = note.title
    db.delete(note)
    db.commit()
    db.close()
    return _tool_ok(
        f"已删除笔记: {title}",
        data={"note_id": note_id, "title": title},
    )
