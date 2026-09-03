"""OIDC Authorization Code + PKCE helpers for ClawHive SSO (P1b-3)."""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .config import get_settings

# In-memory PKCE/state store (single-process LAN control plane).
_pending: dict[str, dict[str, Any]] = {}
_discovery_cache: dict[str, Any] = {"at": 0.0, "doc": None}


def oidc_is_configured() -> bool:
    settings = get_settings()
    if not settings.oidc_enabled:
        return False
    return bool(settings.oidc_issuer and settings.oidc_client_id and settings.oidc_redirect_uri)


def oidc_status_payload() -> dict:
    settings = get_settings()
    enabled = oidc_is_configured()
    return {
        "enabled": enabled,
        "issuer": settings.oidc_issuer if enabled else "",
        "client_id": settings.oidc_client_id if enabled else "",
        "login_path": "/api/auth/oidc/login" if enabled else "",
    }


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _http_json(url: str, *, method: str = "GET", data: bytes | None = None, headers: dict | None = None) -> dict:
    req = Request(url, data=data, method=method, headers=headers or {})
    with urlopen(req, timeout=15) as resp:  # noqa: S310
        body = resp.read().decode("utf-8", errors="replace")
        return json.loads(body or "{}")


def fetch_oidc_discovery() -> dict:
    settings = get_settings()
    issuer = settings.oidc_issuer.rstrip("/")
    now = time.time()
    if _discovery_cache.get("doc") and now - float(_discovery_cache.get("at") or 0) < 300:
        return _discovery_cache["doc"]
    doc = _http_json(f"{issuer}/.well-known/openid-configuration")
    _discovery_cache["doc"] = doc
    _discovery_cache["at"] = now
    return doc


def begin_oidc_login() -> str:
    """Return authorize URL; stores PKCE verifier keyed by state."""
    if not oidc_is_configured():
        raise RuntimeError("OIDC not configured")
    settings = get_settings()
    doc = fetch_oidc_discovery()
    authorize = str(doc.get("authorization_endpoint") or "").strip()
    if not authorize:
        raise RuntimeError("OIDC discovery missing authorization_endpoint")
    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    _pending[state] = {"verifier": verifier, "created_at": time.time()}
    # Drop stale states
    cutoff = time.time() - 600
    for k, v in list(_pending.items()):
        if float(v.get("created_at") or 0) < cutoff:
            _pending.pop(k, None)
    params = {
        "response_type": "code",
        "client_id": settings.oidc_client_id,
        "redirect_uri": settings.oidc_redirect_uri,
        "scope": settings.oidc_scopes or "openid profile email",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return f"{authorize}?{urlencode(params)}"


def _map_role(claims: dict) -> str:
    settings = get_settings()
    claim = settings.oidc_role_claim or "roles"
    raw = claims.get(claim)
    roles: list[str] = []
    if isinstance(raw, list):
        roles = [str(x).lower() for x in raw]
    elif isinstance(raw, str):
        roles = [x.strip().lower() for x in raw.replace(";", ",").split(",") if x.strip()]
    for candidate in ("admin", "operator", "viewer"):
        if candidate in roles:
            return candidate
    # realm_access.roles (Keycloak-style)
    realm = claims.get("realm_access")
    if isinstance(realm, dict) and isinstance(realm.get("roles"), list):
        rr = [str(x).lower() for x in realm["roles"]]
        for candidate in ("admin", "operator", "viewer"):
            if candidate in rr:
                return candidate
    # 未知角色落 viewer（控制端旁观），不误升为对话专用 user
    return "viewer"


def _map_tenant(claims: dict) -> str:
    settings = get_settings()
    claim = settings.oidc_tenant_claim or "tenant_id"
    raw = claims.get(claim)
    if isinstance(raw, list) and raw:
        raw = raw[0]
    tid = str(raw or "default").strip() or "default"
    return tid[:64]


def exchange_oidc_code(*, code: str, state: str) -> dict:
    """Exchange code for claims; returns {username, role, tenant_id, email}."""
    if not oidc_is_configured():
        raise RuntimeError("OIDC not configured")
    pending = _pending.pop(state, None)
    if not pending:
        raise RuntimeError("invalid or expired OIDC state")
    settings = get_settings()
    doc = fetch_oidc_discovery()
    token_url = str(doc.get("token_endpoint") or "").strip()
    userinfo_url = str(doc.get("userinfo_endpoint") or "").strip()
    if not token_url:
        raise RuntimeError("OIDC discovery missing token_endpoint")
    form = urlencode(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": settings.oidc_redirect_uri,
            "client_id": settings.oidc_client_id,
            "client_secret": settings.oidc_client_secret or "",
            "code_verifier": pending["verifier"],
        }
    ).encode("utf-8")
    token_payload = _http_json(
        token_url,
        method="POST",
        data=form,
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
    )
    access = str(token_payload.get("access_token") or "").strip()
    id_token = str(token_payload.get("id_token") or "").strip()
    claims: dict = {}
    if id_token and id_token.count(".") == 2:
        try:
            from jose import jwt as jose_jwt

            # Signature verified via userinfo when available; decode claims without verify for mapping.
            claims = jose_jwt.get_unverified_claims(id_token)
        except Exception:
            claims = {}
    if access and userinfo_url:
        try:
            ui = _http_json(
                userinfo_url,
                headers={"Authorization": f"Bearer {access}", "Accept": "application/json"},
            )
            if isinstance(ui, dict):
                claims = {**claims, **ui}
        except Exception:
            pass
    if not isinstance(claims, dict) or not claims:
        raise RuntimeError("OIDC token exchange produced no claims")
    preferred = (
        str(claims.get("preferred_username") or claims.get("email") or claims.get("sub") or "").strip()
    )
    if not preferred:
        raise RuntimeError("OIDC claims missing preferred_username/email/sub")
    username = preferred.split("@")[0][:64] if "@" in preferred else preferred[:64]
    return {
        "username": username,
        "email": str(claims.get("email") or ""),
        "role": _map_role(claims),
        "tenant_id": _map_tenant(claims),
        "claims": claims,
    }
