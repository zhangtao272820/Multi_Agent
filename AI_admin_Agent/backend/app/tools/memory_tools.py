from __future__ import annotations

from app.core.tenant_scope import require_request_scope
from app.db.database import Memory, SessionLocal


def add_memory(content: str, pref_type: str = "general") -> str:
    db = SessionLocal()
    tid, uid = require_request_scope()
    mem = Memory(content=content, preference_type=pref_type, tenant_id=tid, user_id=uid)
    db.add(mem)
    db.commit()
    db.close()
    return f"已记住您的偏好: {content}"


def get_memories() -> str:
    db = SessionLocal()
    tid, uid = require_request_scope()
    mems = db.query(Memory).filter(Memory.tenant_id == tid, Memory.user_id == uid).all()
    db.close()
    if not mems:
        return ""
    return "系统记忆的偏好:\n" + "\n".join([f"- {m.content}" for m in mems])
