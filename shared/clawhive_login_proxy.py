"""Shared: proxy browser login to ClawHive backend (container-reachable URL)."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any


def clawhive_backend_base() -> str:
    return str(
        os.getenv("CLAWHIVE_BACKEND_URL")
        or os.getenv("CLAWHIVE_INTERNAL_URL")
        or "http://clawhive_backend:8000"
    ).strip().rstrip("/")


def clawhive_public_auth_url() -> str:
    """Browser auth base. Empty = same-origin agent proxy (preferred)."""
    return str(
        os.getenv("CLAWHIVE_PUBLIC_URL") or os.getenv("NUXT_PUBLIC_CLAWHIVE_AUTH_URL") or ""
    ).strip().rstrip("/")


def _urlopen_direct(req: urllib.request.Request, timeout_sec: float):
    """Container→ClawHive must not use HTTP(S)_PROXY (egress proxy breaks docker DNS names)."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open(req, timeout=timeout_sec)


def proxy_clawhive_login(username: str, password: str, timeout_sec: float = 15.0) -> tuple[int, dict[str, Any]]:
    """POST to ClawHive /api/auth/login. Returns (status, json_body)."""
    url = f"{clawhive_backend_base()}/api/auth/login"
    body = json.dumps({"username": str(username or "").strip(), "password": str(password or "")}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with _urlopen_direct(req, timeout_sec) as resp:
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
