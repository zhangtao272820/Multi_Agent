"""Platform → Agent HTTP with ClawHive internal service token."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any

from .config import get_settings


def internal_request_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    headers = {"Accept": "application/json"}
    token = str(getattr(get_settings(), "clawhive_internal_token", "") or "").strip()
    if token:
        headers["x-clawhive-internal-token"] = token
    if extra:
        headers.update(extra)
    return headers


def fetch_json(url: str, timeout_sec: float = 3.0, *, accept: str = "application/json") -> dict[str, Any]:
    """GET JSON from an Agent/Manager endpoint; attaches internal token when configured."""
    return _request_json(url, timeout_sec=timeout_sec, accept=accept)


def post_json(
    url: str,
    body: dict[str, Any] | None = None,
    timeout_sec: float = 8.0,
    *,
    accept: str = "application/json",
) -> dict[str, Any]:
    """POST JSON to an Agent/Manager endpoint."""
    return _request_json(url, timeout_sec=timeout_sec, accept=accept, method="POST", body=body or {})


def _request_json(
    url: str,
    timeout_sec: float = 3.0,
    *,
    accept: str = "application/json",
    method: str = "GET",
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        data = None
        headers = internal_request_headers({"Accept": accept})
        if method.upper() != "GET":
            payload = json.dumps(body or {}).encode("utf-8")
            headers["Content-Type"] = "application/json"
            data = payload
        req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:  # noqa: S310
            raw = resp.read(512_000)
            latency = int((time.perf_counter() - started) * 1000)
            text = raw.decode("utf-8", errors="replace") or ""
            if text.lstrip().startswith("<"):
                return {
                    "ok": False,
                    "url": url,
                    "latency_ms": latency,
                    "status_code": getattr(resp, "status", 200),
                    "error": "返回 HTML 页面（目标服务未启动或端口错误）",
                }
            try:
                payload_out = json.loads(text) if text.strip() else {}
            except json.JSONDecodeError as exc:
                return {
                    "ok": False,
                    "url": url,
                    "latency_ms": latency,
                    "status_code": getattr(resp, "status", 200),
                    "error": f"JSON 解析失败: {exc}; 片段: {text[:120]}",
                }
            return {
                "ok": True,
                "url": url,
                "latency_ms": latency,
                "status_code": getattr(resp, "status", 200),
                "data": payload_out,
            }
    except urllib.error.HTTPError as exc:
        latency = int((time.perf_counter() - started) * 1000)
        body_txt = ""
        try:
            body_txt = exc.read(4096).decode("utf-8", errors="replace")
        except Exception:
            pass
        detail = body_txt[:400] or str(exc)
        if exc.code == 401 and "login_required" in detail:
            detail = (
                f"{detail}（平台→Agent 探测缺 internal token 或令牌不一致；"
                "请确认 CLAWHIVE_INTERNAL_TOKEN 已注入 clawhive_backend 与目标 Agent）"
            )
        return {
            "ok": False,
            "url": url,
            "latency_ms": latency,
            "status_code": exc.code,
            "error": detail,
        }
    except Exception as exc:  # noqa: BLE001
        latency = int((time.perf_counter() - started) * 1000)
        hint = str(exc)
        if "Connection refused" in hint or "Name or service not known" in hint:
            hint = f"无法连接目标服务: {hint}"
        return {
            "ok": False,
            "url": url,
            "latency_ms": latency,
            "status_code": None,
            "error": hint,
        }
