"""ClawHive 内部鉴权（未配置 token 时跳过）。"""

from __future__ import annotations

import os
from urllib.parse import urlparse

from fastapi import Header, HTTPException, WebSocket

from app.core.config import settings


def _expected_token() -> str:
    return str(
        os.getenv("AGENT_SERVICE_TOKEN")
        or os.getenv("CLAWHIVE_INTERNAL_TOKEN")
        or os.getenv("AGENT_INTERNAL_TOKEN")
        or os.getenv("MANAGER_OPS_TOKEN")
        or ""
    ).strip()


def _public_web_ws_enabled() -> bool:
    return os.getenv("ADMIN_PUBLIC_WEB_WS", "1").strip().lower() not in ("0", "false", "no")


def _allowed_browser_hosts() -> set[str]:
    hosts: set[str] = set()
    for origin in settings.get_cors_origins():
        try:
            netloc = urlparse(origin).netloc
            if netloc:
                hosts.add(netloc.lower())
        except Exception:
            continue
    return hosts


def _is_browser_ws_client(websocket: WebSocket) -> bool:
    """内置 Web UI 从浏览器直连 WS，不带内部 token。"""
    if not _public_web_ws_enabled():
        return False

    host = str(websocket.headers.get("host") or "").strip().lower()
    origin = str(websocket.headers.get("origin") or "").strip()
    allowed_hosts = _allowed_browser_hosts()

    if origin and host:
        try:
            # 同源：页面与 WS 同一 Host（如 localhost:13105）
            if urlparse(origin).netloc.lower() == host:
                return True
        except Exception:
            pass

    if origin and allowed_hosts:
        try:
            if urlparse(origin).netloc.lower() in allowed_hosts:
                return True
        except Exception:
            return False

    if host and host in allowed_hosts:
        return True

    # 本机 / 局域网 Host 直连（无 Origin 头的部分客户端）
    if host and (
        host.startswith("localhost:")
        or host.startswith("127.0.0.1:")
        or host.startswith("192.168.")
    ):
        return True

    return False


def accept_websocket_connection(websocket: WebSocket) -> bool:
    """
    返回 True 表示允许建立 WS。
    - 未配置内部 token 且未开浏览器鉴权：放行
    - 携带正确 internal token：放行（Manager）
    - 浏览器 JWT（query access_token / Authorization）：放行
    """
    from app.core.browser_auth import ClawhiveAuthError, auth_from_websocket, browser_auth_enabled

    expected = _expected_token()
    got = str(
        websocket.headers.get("x-agent-service-token")
        or websocket.headers.get("x-clawhive-internal-token")
        or websocket.headers.get("x-internal-token")
        or ""
    ).strip()
    if expected and got and got == expected:
        return True

    if browser_auth_enabled():
        try:
            auth_from_websocket(websocket)
            return True
        except ClawhiveAuthError:
            return False

    if not expected:
        return True
    if not got and _is_browser_ws_client(websocket):
        # 兼容旧行为：未开 AGENT_BROWSER_AUTH 时同源 UI 仍可连
        return True
    return False


def verify_internal_token(
    x_agent_service_token: str | None = Header(default=None, alias="x-agent-service-token"),
    x_clawhive_internal_token: str | None = Header(default=None, alias="x-clawhive-internal-token"),
    x_internal_token: str | None = Header(default=None, alias="x-internal-token"),
) -> None:
    expected = _expected_token()
    mode = str(os.getenv("AGENT_SERVICE_AUTH") or os.getenv("MANAGER_AGENT_SERVICE_AUTH") or "").strip().lower()
    require = mode in ("1", "true", "on", "yes", "require", "required")
    if not expected:
        if require:
            raise HTTPException(status_code=503, detail="agent_service_token_not_configured")
        return
    got = str(x_agent_service_token or x_clawhive_internal_token or x_internal_token or "").strip()
    if not got or got != expected:
        raise HTTPException(status_code=401, detail="invalid internal token")


def verify_ws_internal_token(websocket: WebSocket) -> None:
    if not accept_websocket_connection(websocket):
        raise HTTPException(status_code=401, detail="invalid internal token")
