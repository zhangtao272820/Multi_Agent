"""Shared tool helpers and module-level state."""
from __future__ import annotations

import datetime
import json
import re
from typing import Any, Dict

from app.db.database import AuditLog, SessionLocal

CONTACT_NOT_FOUND = "__CONTACT_NOT_FOUND__"
PENDING_NOT_FOUND = "__PENDING_NOT_FOUND__"
EMAIL_RE = re.compile(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$")
HTTP_TIMEOUT = 15.0
WEATHER_CACHE: Dict[str, Dict[str, Any]] = {}
WEATHER_LAST_CALL_AT: Dict[str, datetime.datetime] = {}
MAIL_CACHE_BY_SESSION: Dict[str, Dict[int, Dict[str, str]]] = {}

# Back-compat aliases used inside legacy chunks
_CONTACT_NOT_FOUND = CONTACT_NOT_FOUND
_PENDING_NOT_FOUND = PENDING_NOT_FOUND
_EMAIL_RE = EMAIL_RE
_HTTP_TIMEOUT = HTTP_TIMEOUT
_WEATHER_CACHE = WEATHER_CACHE
_WEATHER_LAST_CALL_AT = WEATHER_LAST_CALL_AT
_MAIL_CACHE_BY_SESSION = MAIL_CACHE_BY_SESSION


def mail_cache_key(user_id: str | None, session_id: str | None) -> str:
    uid = str(user_id or "").strip() or "_"
    sid = str(session_id or "default").strip() or "default"
    return f"{uid}::{sid}"


def get_mail_cache(user_id: str | None, session_id: str | None) -> Dict[int, Dict[str, str]]:
    return MAIL_CACHE_BY_SESSION.get(mail_cache_key(user_id, session_id), {})


def set_mail_cache(
    user_id: str | None, session_id: str | None, cache: Dict[int, Dict[str, str]]
) -> None:
    MAIL_CACHE_BY_SESSION[mail_cache_key(user_id, session_id)] = cache


def tool_ok(human_message: str, data: dict | None = None, code: str = "ok") -> dict:
    return {
        "ok": True,
        "code": code,
        "human_message": str(human_message or "").strip(),
        "data": data or {},
    }


def tool_err(human_message: str, data: dict | None = None, code: str = "error") -> dict:
    return {
        "ok": False,
        "code": code,
        "human_message": str(human_message or "").strip(),
        "data": data or {},
    }


_tool_ok = tool_ok
_tool_err = tool_err


def audit(session_id: str, tool_name: str, tool_args: dict, result_text: str, status: str = "ok") -> None:
    try:
        db = SessionLocal()
        db.add(
            AuditLog(
                session_id=session_id or "default",
                tool_name=tool_name,
                tool_args_json=json.dumps(tool_args or {}, ensure_ascii=False),
                result_text=str(result_text),
                status=status,
            )
        )
        db.commit()
        db.close()
    except Exception:
        try:
            db.close()
        except Exception:
            pass


_audit = audit
