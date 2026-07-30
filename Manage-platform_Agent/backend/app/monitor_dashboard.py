"""企业监控总览：单次请求聚合 health + cluster + summary（共享探活缓存）。
天相 Audit：Token / 成功率 / 全链路就绪度收口到 audit 字段，供 ClawHive 看板。
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode

from .config import get_settings
from .health_overview import build_health_overview
from .manager_cluster import build_manager_cluster_status

settings = get_settings()


def _prom_instant(expr: str, timeout_sec: float = 3.0) -> float | None:
    base = str(settings.prometheus_base_url or "").strip().rstrip("/")
    if not base:
        return None
    params = urlencode({"query": expr, "time": str(time.time())})
    url = f"{base}/api/v1/query?{params}"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:  # noqa: S310
            raw = json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
        result = raw.get("data", {}).get("result") if isinstance(raw, dict) else None
        if not isinstance(result, list) or not result:
            return None
        val = result[0].get("value")
        if not isinstance(val, (list, tuple)) or len(val) < 2:
            return None
        n = float(val[1])
        return n if n == n else None  # NaN guard
    except Exception:  # noqa: BLE001
        return None


def _first_number(*values) -> float | None:
    for v in values:
        if v is None:
            continue
        try:
            n = float(v)
        except (TypeError, ValueError):
            continue
        if n == n:
            return n
    return None


def build_monitor_dashboard() -> dict:
    health = build_health_overview(use_cache=True)
    cluster = build_manager_cluster_status(use_cache=True)

    metrics_data = None
    if isinstance(cluster.get("metrics"), dict) and cluster["metrics"].get("ok"):
        metrics_data = cluster["metrics"].get("data")

    phases = metrics_data.get("phases") if isinstance(metrics_data, dict) else {}
    token_summary = metrics_data.get("tokenSummary") if isinstance(metrics_data, dict) else None
    evolution = metrics_data.get("evolution") if isinstance(metrics_data, dict) else None

    down = [c for c in health.get("checks", []) if c.get("status") != "healthy"]

    prom = {
        "manager_runs": _prom_instant("manager_runs_total"),
        "manager_tokens": _prom_instant("manager_tokens_total"),
        "search_hit_rate": _prom_instant("manager_search_hit_rate"),
        "first_pass_success_rate": _prom_instant("manager_first_pass_success_rate"),
        "nlu_sample_count": _prom_instant("manager_nlu_sample_count"),
        "avg_final_confidence": _prom_instant("manager_avg_final_confidence"),
        "agents_healthy": _prom_instant("count(clawhive_agent_up == 1)"),
        "agents_total": _prom_instant("count(clawhive_agent_up)"),
    }

    evo_first_pass = (
        evolution.get("firstPassSuccessRate") if isinstance(evolution, dict) else None
    )
    evo_search = evolution.get("searchHitRate") if isinstance(evolution, dict) else None
    token_total = None
    if isinstance(token_summary, dict):
        token_total = token_summary.get("totalTokens")

    first_pass = _first_number(prom.get("first_pass_success_rate"), evo_first_pass)
    tokens = _first_number(prom.get("manager_tokens"), token_total)
    runs = _first_number(
        prom.get("manager_runs"),
        metrics_data.get("runs") if isinstance(metrics_data, dict) else None,
    )

    audit = {
        "total_tokens": tokens,
        "manager_runs": runs,
        "first_pass_success_rate": first_pass,
        "search_hit_rate": _first_number(prom.get("search_hit_rate"), evo_search),
        "avg_final_confidence": prom.get("avg_final_confidence"),
        "agents_healthy": prom.get("agents_healthy"),
        "agents_total": prom.get("agents_total"),
        "down_count": len(down),
        "sources": {
            "prometheus": True,
            "manager_metrics": bool(metrics_data),
            "health": True,
        },
    }

    return {
        "ok": True,
        "checked_at": int(time.time()),
        "overall_status": health.get("overall_status"),
        "health": health,
        "manager": {
            "reachable": bool(cluster.get("ok")),
            "endpoint": cluster.get("manager_endpoint"),
            "error": cluster.get("error"),
            "runs": metrics_data.get("runs") if isinstance(metrics_data, dict) else None,
            "phases": phases,
            "token_summary": token_summary,
            "evolution": evolution,
            "registry": (cluster.get("registry") or {}).get("data") if isinstance(cluster.get("registry"), dict) else None,
        },
        "down_agents": [{"name": c.get("name"), "target": c.get("target")} for c in down],
        "prometheus": prom,
        "audit": audit,
    }
