"""ClawHive 浏览器 JWT / internal token 门禁（与 shared/clawhive_jwt.py 对齐）。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Callable

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware


class ClawhiveAuthError(Exception):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _secret() -> str:
    return str(os.getenv("JWT_SECRET") or os.getenv("CLAWHIVE_JWT_SECRET") or "").strip()


def browser_auth_enabled() -> bool:
    raw = str(os.getenv("AGENT_BROWSER_AUTH") or os.getenv("MANAGER_USER_AUTH") or "").strip().lower()
    if raw in ("0", "false", "no"):
        return False
    if raw in ("1", "true", "yes"):
        return True
    return bool(_secret())


def _b64url_decode(data: str) -> bytes:
    s = data.replace("-", "+").replace("_", "/")
    pad = "=" * (-len(s) % 4)
    return base64.b64decode(s + pad)


def verify_jwt(token: str) -> dict[str, Any]:
    secret = _secret()
    if not secret:
        raise ClawhiveAuthError("JWT_SECRET_not_configured")
    parts = str(token or "").strip().split(".")
    if len(parts) != 3:
        raise ClawhiveAuthError("jwt_malformed")
    h, p, sig = parts
    expected = hmac.new(secret.encode("utf-8"), f"{h}.{p}".encode("utf-8"), hashlib.sha256).digest()
    try:
        got = _b64url_decode(sig)
    except Exception as exc:  # noqa: BLE001
        raise ClawhiveAuthError("jwt_sig_invalid") from exc
    if not hmac.compare_digest(got, expected):
        raise ClawhiveAuthError("jwt_sig_invalid")
    payload = json.loads(_b64url_decode(p))
    sub = str(payload.get("sub") or "").strip()
    if not sub:
        raise ClawhiveAuthError("jwt_missing_sub")
    exp = payload.get("exp")
    if exp is not None and time.time() >= float(exp):
        raise ClawhiveAuthError("jwt_expired")
    return {
        "user_id": sub,
        "username": sub,
        "role": str(payload.get("role") or "viewer"),
        "tenant_id": str(payload.get("tenant_id") or "default"),
    }


def _internal_ok(headers: dict[str, str]) -> bool:
    expected = str(os.getenv("CLAWHIVE_INTERNAL_TOKEN") or os.getenv("AGENT_INTERNAL_TOKEN") or "").strip()
    if not expected:
        return False
    got = (
        headers.get("x-clawhive-internal-token")
        or headers.get("x-internal-token")
        or ""
    ).strip()
    return bool(got and hmac.compare_digest(got, expected))


def _bearer(authorization: str | None) -> str:
    raw = str(authorization or "").strip()
    if raw.lower().startswith("bearer "):
        return raw[7:].strip()
    return ""


def require_browser_or_internal(headers: dict[str, str], authorization: str | None = None) -> dict[str, Any]:
    lower = {str(k).lower(): str(v) for k, v in headers.items()}
    if _internal_ok(lower):
        return {"mode": "internal"}
    if not browser_auth_enabled():
        return {"mode": "open"}
    token = _bearer(authorization or lower.get("authorization"))
    if not token:
        token = lower.get("x-clawhive-user-token") or ""
    if not token:
        raise ClawhiveAuthError("login_required")
    user = verify_jwt(token)
    return {"mode": "browser", "user": user}


DEFAULT_PUBLIC_PREFIXES = (
    "/api/health",
    "/api/ready",
    "/api/metrics",
    "/api/auth/config",
    "/api/auth/login",
    "/health",
    "/ready",
    "/metrics",
    "/docs",
    "/openapi.json",
    "/favicon",
)


def clawhive_backend_base() -> str:
    return str(
        os.getenv("CLAWHIVE_BACKEND_URL")
        or os.getenv("CLAWHIVE_INTERNAL_URL")
        or "http://clawhive_backend:8000"
    ).strip().rstrip("/")


def clawhive_public_auth_url() -> str:
    """Empty = same-origin login proxy (preferred). Optional override for direct browser→ClawHive."""
    return str(
        os.getenv("CLAWHIVE_PUBLIC_URL") or os.getenv("NUXT_PUBLIC_CLAWHIVE_AUTH_URL") or ""
    ).strip().rstrip("/")


def _proxy_clawhive_login(username: str, password: str) -> tuple[int, dict[str, Any]]:
    url = f"{clawhive_backend_base()}/api/auth/login"
    body = json.dumps({"username": str(username or "").strip(), "password": str(password or "")}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15.0) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                data = {"detail": raw[:300] or "invalid_json"}
            return int(resp.status), data if isinstance(data, dict) else {"detail": "invalid_response"}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        try:
            data = json.loads(raw) if raw else {"detail": str(exc.reason)}
        except json.JSONDecodeError:
            data = {"detail": raw[:300] or str(exc.reason)}
        return int(exc.code), data if isinstance(data, dict) else {"detail": "login_failed"}
    except Exception as exc:  # noqa: BLE001
        return 502, {"detail": f"clawhive_login_unreachable:{exc}"}


def install_auth_config_route(app) -> None:
    """同源登录代理 + config（空 clawhiveAuthUrl = 浏览器打当前 Agent）。"""

    @app.get("/api/auth/config")
    def _auth_config() -> dict[str, str]:
        # Prefer same-origin; only advertise external URL when explicitly set for direct mode
        return {"clawhiveAuthUrl": clawhive_public_auth_url()}

    @app.post("/api/auth/login")
    async def _auth_login(request: Request):
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        status, data = _proxy_clawhive_login(
            str(payload.get("username") or ""),
            str(payload.get("password") or ""),
        )
        return JSONResponse(status_code=status, content=data)


def auth_from_request(request: Request) -> dict[str, Any]:
    headers = dict(request.headers)
    authorization = request.headers.get("authorization")
    if not authorization:
        q = request.query_params.get("access_token") or request.query_params.get("token")
        if q:
            authorization = f"Bearer {q}"
    return require_browser_or_internal(headers, authorization)


def auth_from_websocket(websocket) -> dict[str, Any]:
    try:
        headers = dict(websocket.headers)
    except Exception:  # noqa: BLE001
        headers = {}
    authorization = headers.get("authorization")
    if not authorization:
        q = websocket.query_params.get("access_token") or websocket.query_params.get("token")
        if q:
            authorization = f"Bearer {q}"
    return require_browser_or_internal(headers, authorization)


class ClawhiveBrowserAuthMiddleware(BaseHTTPMiddleware):
    def __init__(
        self,
        app,
        public_prefixes: tuple[str, ...] = DEFAULT_PUBLIC_PREFIXES,
        extra_public: tuple[str, ...] = (),
    ) -> None:
        super().__init__(app)
        self.public = tuple(public_prefixes) + tuple(extra_public)

    async def dispatch(self, request: Request, call_next: Callable):
        path = request.url.path or ""
        if request.method == "OPTIONS":
            return await call_next(request)
        if any(path == p or path.startswith(p + "/") for p in self.public):
            return await call_next(request)

        # SPA shell（非 API / 非 WS）
        if not path.startswith("/api/") and not path.startswith("/_ws") and path != "/_ws":
            return await call_next(request)

        try:
            auth_from_request(request)
        except ClawhiveAuthError as exc:
            return JSONResponse(status_code=401, content={"detail": exc.code, "ok": False})
        return await call_next(request)
