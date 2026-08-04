"""总管 + 子 Agent 可观测聚合（对接 Manager /api/metrics 与探活）。"""

from __future__ import annotations

import time
import urllib.request

from .agents_metrics import build_agents_metrics_snapshot
from .config import get_settings
from .health_overview import build_health_overview
from .manager_cluster import build_manager_cluster_status
from .trace_links import (
    build_grafana_explore_url,
    build_grafana_loki_explore_url,
    build_langfuse_trace_url,
)


def _metrics_payload(cluster: dict) -> dict | None:
    metrics = cluster.get("metrics")
    if not isinstance(metrics, dict) or not metrics.get("ok"):
        return None
    data = metrics.get("data")
    return data if isinstance(data, dict) else None


def _fetch_manager_traces(limit: int = 12) -> dict:
    """Proxy Manager /api/metrics/traces when OTel export is enabled."""
    from .internal_http import fetch_json

    settings = get_settings()
    host = str(settings.manager_agent_host or "localhost").strip()
    port = str(settings.manager_agent_port or "13106").strip()
    url = f"http://{host}:{port}/api/metrics/traces?limit={max(1, min(50, limit))}"
    result = fetch_json(url, timeout_sec=3.0)
    if not result.get("ok"):
        return {"ok": False, "error": str(result.get("error") or "fetch_failed"), "recent": []}
    payload = result.get("data") if isinstance(result.get("data"), dict) else {}
    traces = payload.get("traces") if isinstance(payload, dict) else None
    recent = []
    if isinstance(traces, list):
        for t in traces[-limit:]:
            if not isinstance(t, dict):
                continue
            run_id = str(t.get("runId") or "").strip()
            trace_id = str(t.get("traceId") or "").strip()
            spans = t.get("spans") if isinstance(t.get("spans"), list) else []
            rid = run_id or trace_id
            recent.append(
                {
                    "run_id": run_id,
                    "trace_id": trace_id or run_id,
                    "span_count": len(spans),
                    "grafana_explore_url": build_grafana_explore_url(trace_id or run_id),
                    "grafana_loki_url": build_grafana_loki_explore_url(rid),
                    "langfuse_url": build_langfuse_trace_url(trace_id or run_id),
                }
            )
    return {
        "ok": True,
        "trace_count": int(payload.get("traceCount") or len(recent)) if isinstance(payload, dict) else len(recent),
        "recent": list(reversed(recent)),
    }


def _tempo_reachable() -> bool:
    settings = get_settings()
    base = str(settings.tempo_base_url or "").rstrip("/")
    if not base:
        return False
    try:
        req = urllib.request.Request(f"{base}/ready", headers={"Accept": "text/plain"})
        with urllib.request.urlopen(req, timeout=2.0) as resp:  # noqa: S310
            return int(getattr(resp, "status", 200) or 200) < 500
    except Exception:
        return False


def _loki_reachable() -> bool:
    settings = get_settings()
    base = str(settings.loki_base_url or "").rstrip("/")
    if not base:
        return False
    try:
        req = urllib.request.Request(f"{base}/ready", headers={"Accept": "text/plain"})
        with urllib.request.urlopen(req, timeout=2.0) as resp:  # noqa: S310
            return int(getattr(resp, "status", 200) or 200) < 500
    except Exception:
        return False


def _langfuse_reachable() -> bool:
    settings = get_settings()
    base = str(settings.langfuse_base_url or "").rstrip("/")
    if not base:
        return False
    try:
        req = urllib.request.Request(f"{base}/api/public/health", headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=2.0) as resp:  # noqa: S310
            return int(getattr(resp, "status", 200) or 200) < 500
    except Exception:
        try:
            req = urllib.request.Request(base, headers={"Accept": "text/html"})
            with urllib.request.urlopen(req, timeout=2.0) as resp:  # noqa: S310
                return int(getattr(resp, "status", 200) or 200) < 500
        except Exception:
            return False


def build_manager_observability() -> dict:
    health = build_health_overview()
    cluster = build_manager_cluster_status()
    agents_metrics = build_agents_metrics_snapshot()
    metrics_data = _metrics_payload(cluster)
    settings = get_settings()

    agent_checks = [
        c
        for c in (health.get("checks") or [])
        if c.get("name") not in ("PostgreSQL", "Redis")
    ]

    evolution = metrics_data.get("evolution") if isinstance(metrics_data, dict) else None
    by_agent = evolution.get("byAgent") if isinstance(evolution, dict) else {}
    traces = _fetch_manager_traces(12)

    return {
        "ok": True,
        "checked_at": int(time.time()),
        "overall_status": health.get("overall_status"),
        "manager": {
            "reachable": bool(cluster.get("ok")),
            "endpoint": cluster.get("manager_endpoint"),
            "runs": metrics_data.get("runs") if metrics_data else None,
            "phases": metrics_data.get("phases") if metrics_data else {},
            "token_summary": metrics_data.get("tokenSummary") if metrics_data else None,
            "recent_metrics": metrics_data.get("recentMetrics") if metrics_data else [],
            "evolution": evolution,
            "by_agent_success": by_agent,
            "registry": (cluster.get("registry") or {}).get("data"),
            "tool_health": metrics_data.get("toolHealth") if metrics_data else None,
            "policy_canary": metrics_data.get("policyCanary") if metrics_data else None,
        },
        "tracing": {
            "grafana_public_url": settings.grafana_public_url,
            "tempo_base_url": settings.tempo_base_url,
            "tempo_ready": _tempo_reachable(),
            "langfuse_public_url": settings.langfuse_public_url,
            "langfuse_base_url": settings.langfuse_base_url,
            "langfuse_ready": _langfuse_reachable(),
            "manager_traces_ok": bool(traces.get("ok")),
            "recent_traces": traces.get("recent") or [],
            "explore_hint": "Grafana Explore → Tempo; Langfuse → /trace/{trace_id}",
        },
        "logging": {
            "grafana_public_url": settings.grafana_public_url,
            "loki_base_url": settings.loki_base_url,
            "loki_ready": _loki_reachable(),
            "explore_hint": "Grafana Explore → Loki datasource (uid=loki); LogQL by run_id",
        },
        "agents_health": agent_checks,
        "agents_metrics": agents_metrics.get("agents") or [],
    }
