"""ClawHive JWT（HS256）本地验签 —— 与 Manage-platform auth.create_access_token 对齐。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any


class ClawhiveAuthError(Exception):
    def __init__(self, code: str, message: str = "") -> None:
        self.code = code
        super().__init__(message or code)


def resolve_jwt_secret(env: dict[str, str] | None = None) -> str:
    e = env or os.environ
    return str(e.get("JWT_SECRET") or e.get("CLAWHIVE_JWT_SECRET") or "").strip()


def is_agent_browser_auth_enabled(env: dict[str, str] | None = None) -> bool:
    e = env or os.environ
    raw = str(e.get("AGENT_BROWSER_AUTH") or e.get("MANAGER_USER_AUTH") or "").strip().lower()
    if raw in ("0", "false", "no"):
        return False
    if raw in ("1", "true", "yes"):
        return True
    return bool(resolve_jwt_secret(e))


def _b64url_decode(data: str) -> bytes:
    s = data.replace("-", "+").replace("_", "/")
    pad = "=" * (-len(s) % 4)
    return base64.b64decode(s + pad)


def extract_bearer(authorization: str | None) -> str:
    raw = str(authorization or "").strip()
    if raw.lower().startswith("bearer "):
        return raw[7:].strip()
    return ""


def verify_clawhive_jwt(token: str, env: dict[str, str] | None = None) -> dict[str, Any]:
    secret = resolve_jwt_secret(env)
    if not secret:
        raise ClawhiveAuthError("JWT_SECRET_not_configured")
    parts = str(token or "").strip().split(".")
    if len(parts) != 3:
        raise ClawhiveAuthError("jwt_malformed")
    header_b64, payload_b64, sig_b64 = parts
    signing_input = f"{header_b64}.{payload_b64}".encode("utf-8")
    expected = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    try:
        got = _b64url_decode(sig_b64)
    except Exception as exc:  # noqa: BLE001
        raise ClawhiveAuthError("jwt_sig_invalid") from exc
    if not hmac.compare_digest(got, expected):
        raise ClawhiveAuthError("jwt_sig_invalid")
    try:
        header = json.loads(_b64url_decode(header_b64))
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception as exc:  # noqa: BLE001
        raise ClawhiveAuthError("jwt_malformed") from exc
    if str(header.get("alg") or "HS256") != "HS256":
        raise ClawhiveAuthError("jwt_alg_unsupported")
    sub = str(payload.get("sub") or "").strip()
    if not sub:
        raise ClawhiveAuthError("jwt_missing_sub")
    exp = payload.get("exp")
    if exp is not None:
        try:
            if time.time() >= float(exp):
                raise ClawhiveAuthError("jwt_expired")
        except ClawhiveAuthError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ClawhiveAuthError("jwt_malformed") from exc
    return {
        "sub": sub,
        "role": str(payload.get("role") or "viewer"),
        "tenant_id": str(payload.get("tenant_id") or "default"),
        "user_id": sub,
        "username": sub,
    }


def resolve_internal_token(headers: dict[str, str], env: dict[str, str] | None = None) -> bool:
    e = env or os.environ
    expected = str(e.get("CLAWHIVE_INTERNAL_TOKEN") or e.get("AGENT_INTERNAL_TOKEN") or "").strip()
    if not expected:
        return False
    got = (
        str(headers.get("x-clawhive-internal-token") or headers.get("X-Clawhive-Internal-Token") or "").strip()
        or str(headers.get("x-internal-token") or headers.get("X-Internal-Token") or "").strip()
    )
    return bool(got and hmac.compare_digest(got, expected))


def require_browser_or_internal(
    headers: dict[str, str],
    *,
    env: dict[str, str] | None = None,
    authorization: str | None = None,
) -> dict[str, Any]:
    """
    返回 {mode: internal|browser|open, user?: dict}
    失败抛 ClawhiveAuthError(code=login_required|invalid_user_token|...)
    """
    e = env or os.environ
    hdrs = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
    if resolve_internal_token(hdrs, e):
        return {"mode": "internal"}
    if not is_agent_browser_auth_enabled(e):
        return {"mode": "open"}
    token = extract_bearer(authorization or hdrs.get("authorization"))
    if not token:
        token = str(hdrs.get("x-clawhive-user-token") or "").strip()
    if not token:
        raise ClawhiveAuthError("login_required")
    try:
        user = verify_clawhive_jwt(token, e)
    except ClawhiveAuthError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ClawhiveAuthError("invalid_user_token") from exc
    return {"mode": "browser", "user": user}
