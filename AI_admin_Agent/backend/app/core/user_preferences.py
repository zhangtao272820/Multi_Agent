"""
轻量用户偏好：跨请求沉淀常用城市、联系人等，注入 planning 阶段。
Key: {tenant_id}:{user_id}（禁共享 "default" 桶）。
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

GLOBAL_KEY = "__global__"


def _prefs_enabled() -> bool:
    return os.getenv("ADMIN_AUTO_LEARN_PREFS", "1").strip().lower() not in ("0", "false", "no")


from app.core.admin_data_dir import admin_data_dir


def _prefs_file() -> Path:
    return admin_data_dir() / "admin-user-preferences.json"


def _load_all() -> dict[str, dict[str, Any]]:
    p = _prefs_file()
    if not p.is_file():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _save_all(store: dict[str, dict[str, Any]]) -> None:
    _prefs_file().write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")


def _normalize_prefs_key(session_id: str | None = None) -> str:
    """优先请求 scope (tenant:user)；session_id 仅作兼容回退。"""
    try:
        from app.core.tenant_scope import prefs_scope_key, get_request_scope

        if get_request_scope():
            return prefs_scope_key()
    except Exception:
        pass
    s = str(session_id or "").strip()[:64]
    if s and s not in ("default", GLOBAL_KEY):
        # 兼容旧调用：session 级 key，但不与跨用户共享
        return f"session:{s}"
    try:
        from app.core.tenant_scope import prefs_scope_key

        return prefs_scope_key()
    except Exception:
        return GLOBAL_KEY


def get_user_preferences(session_id: str | None = None) -> dict[str, Any]:
    store = _load_all()
    return dict(store.get(_normalize_prefs_key(session_id), {}))


def learn_weather_city(session_id: str | None, city: str) -> None:
    if not _prefs_enabled():
        return
    c = str(city or "").strip()
    if len(c) < 2:
        return
    key = _normalize_prefs_key(session_id)
    store = _load_all()
    prev = store.get(key, {})
    store[key] = {
        **prev,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "default_weather_city": c,
    }
    _save_all(store)


def learn_email_contact(session_id: str | None, name: str, email: str) -> None:
    if not _prefs_enabled():
        return
    n, e = str(name or "").strip(), str(email or "").strip()
    if not n or not e:
        return
    key = _normalize_prefs_key(session_id)
    store = _load_all()
    prev = store.get(key, {})
    contacts: list[dict[str, str]] = list(prev.get("frequent_contacts") or [])
    contacts = [x for x in contacts if str(x.get("email", "")).lower() != e.lower()]
    contacts.insert(0, {"name": n, "email": e})
    contacts = contacts[:8]
    store[key] = {
        **prev,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "frequent_contacts": contacts,
    }
    _save_all(store)


def format_preferences_block(session_id: str | None = None) -> str:
    p = get_user_preferences(session_id)
    if not p:
        return ""
    lines: list[str] = []
    city = str(p.get("default_weather_city") or "").strip()
    if city:
        lines.append(f"- 默认查询天气城市：{city}")
    contacts = p.get("frequent_contacts") or []
    if isinstance(contacts, list) and contacts:
        shown = contacts[:5]
        parts = [f"{c.get('name', '')}<{c.get('email', '')}>" for c in shown if isinstance(c, dict)]
        if parts:
            lines.append("- 常用联系人：" + "、".join(parts))
    if not lines:
        return ""
    return "【用户偏好】\n" + "\n".join(lines)
