"""请求级租户 + 用户隔离（鉴权派生，禁 body 伪造）。"""

from __future__ import annotations

import contextvars
import os
import re
from typing import Any

from app.core.mailbox_binding import sanitize_user_id

LEGACY_USER_ID = "__legacy__"
UNSCOPED_USER_ID = "__unscoped__"

_SCOPE: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar(
    "admin_tenant_user_scope", default=None
)

_SAFE_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def normalize_tenant_id(raw: Any = None) -> str:
    explicit = str(raw or "").strip()
    if explicit:
        return explicit[:64]
    from_env = str(os.getenv("MGR_DEFAULT_TENANT_ID") or os.getenv("TENANT_ID") or "default").strip()
    return (from_env or "default")[:64]


def is_tenant_fail_closed() -> bool:
    v = str(os.getenv("MGR_TENANT_FAIL_CLOSED") or "").strip().lower()
    if v in ("0", "false", "no"):
        return False
    if v in ("1", "true", "yes"):
        return True
    profile = str(os.getenv("SECURITY_PROFILE") or os.getenv("CLAWHIVE_SECURITY_PROFILE") or "").strip().lower()
    if profile in ("enterprise", "prod", "production"):
        return True
    return str(os.getenv("NODE_ENV") or os.getenv("ENV") or "").strip().lower() == "production"


def safe_path_segment(raw: str) -> str:
    s = _SAFE_RE.sub("_", str(raw or "").strip())[:64]
    return s or "default"


def set_request_scope(tenant_id: str, user_id: str) -> contextvars.Token:
    tid = normalize_tenant_id(tenant_id)
    uid = sanitize_user_id(user_id) or UNSCOPED_USER_ID
    return _SCOPE.set((tid, uid))


def reset_request_scope(token: contextvars.Token) -> None:
    _SCOPE.reset(token)


def get_request_scope() -> tuple[str, str] | None:
    return _SCOPE.get()


def require_request_scope() -> tuple[str, str]:
    """工具读写必须带 scope；缺失时 fail-closed 用不可见桶，避免扫到他人数据。"""
    cur = _SCOPE.get()
    if cur:
        return cur
    if is_tenant_fail_closed():
        return normalize_tenant_id(None), UNSCOPED_USER_ID
    return normalize_tenant_id(None), UNSCOPED_USER_ID


def prefs_scope_key(tenant_id: str | None = None, user_id: str | None = None) -> str:
    tid, uid = (tenant_id, user_id) if tenant_id and user_id else require_request_scope()
    return f"{normalize_tenant_id(tid)}:{sanitize_user_id(uid) or UNSCOPED_USER_ID}"


def user_workspace_dir(base: str, tenant_id: str | None = None, user_id: str | None = None) -> str:
    tid, uid = (tenant_id, user_id) if tenant_id and user_id else require_request_scope()
    return os.path.join(
        str(base).rstrip("/\\"),
        "tenants",
        safe_path_segment(normalize_tenant_id(tid)),
        "users",
        safe_path_segment(sanitize_user_id(uid) or UNSCOPED_USER_ID),
    )


def resolve_tenant_user_from_auth(
    auth: dict[str, Any],
    *,
    header_tenant: str | None = None,
    header_user: str | None = None,
    claimed_tenant: str | None = None,
    claimed_user: str | None = None,
) -> tuple[str, str]:
    """
    鉴权派生 (tenant_id, user_id)。
    browser：只用 JWT；claimed 不一致则拒绝（由调用方转 403）。
    internal：允许 header / claimed（Manager 透传）。
    open：开发回落，仍优先 header/claimed。
    """
    mode = str(auth.get("mode") or "")
    user = auth.get("user") if isinstance(auth.get("user"), dict) else {}

    if mode == "browser" and user:
        tid = normalize_tenant_id(user.get("tenant_id"))
        uid = sanitize_user_id(user.get("user_id") or user.get("sub") or "") or ""
        if not uid:
            raise ValueError("login_required")
        claim_uid = sanitize_user_id(claimed_user or header_user or "")
        if claim_uid and claim_uid != uid:
            raise PermissionError("forbidden: user_id mismatch")
        claim_tid = str(claimed_tenant or header_tenant or "").strip()
        if claim_tid and normalize_tenant_id(claim_tid) != tid:
            raise PermissionError("forbidden: tenant_id mismatch")
        return tid, uid

    tid = normalize_tenant_id(header_tenant or claimed_tenant)
    uid = sanitize_user_id(header_user or claimed_user or "") or ""
    if mode == "internal":
        if not uid:
            if is_tenant_fail_closed():
                raise ValueError("user_id required")
            uid = UNSCOPED_USER_ID
        return tid, uid

    # open / auth disabled
    if not uid:
        uid = sanitize_user_id(os.getenv("ADMIN_DEV_USER_ID") or "dev") or "dev"
    return tid, uid
