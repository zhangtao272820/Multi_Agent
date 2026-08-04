"""并行拉取各子 Agent /api/metrics（供平台监控页展示）。"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from .internal_http import fetch_json
from .managed_agents import managed_agent_specs


def _fetch_json(url: str, timeout_sec: float = 2.5) -> dict:
    return fetch_json(url, timeout_sec=timeout_sec)


def _agent_metrics_url(spec: dict) -> str | None:
    name = str(spec.get("name") or "").strip()
    if name in ("Manager_Agent", "manager_agent"):
        return None
    endpoint = str(spec.get("endpoint") or "").strip().rstrip("/")
    if not endpoint:
        host = str(spec.get("host") or "").strip()
        port = str(spec.get("port") or "").strip()
        if host and port:
            endpoint = f"http://{host}:{port}"
    if not endpoint:
        return None
    return f"{endpoint}/api/metrics"


def build_agents_metrics_snapshot() -> dict:
    specs = managed_agent_specs()
    jobs: list[tuple[str, str]] = []
    for spec in specs:
        url = _agent_metrics_url(spec)
        if not url:
            continue
        jobs.append((str(spec.get("name") or "unknown"), url))

    agents: list[dict] = []
    if not jobs:
        return {"ok": True, "checked_at": int(time.time()), "agents": agents}

    with ThreadPoolExecutor(max_workers=min(8, len(jobs))) as pool:
        futures = {pool.submit(_fetch_json, url): (name, url) for name, url in jobs}
        for fut in as_completed(futures):
            name, url = futures[fut]
            result = fut.result()
            agents.append(
                {
                    "name": name,
                    "endpoint": url.rsplit("/api/metrics", 1)[0],
                    "ok": bool(result.get("ok")),
                    "latency_ms": result.get("latency_ms"),
                    "metrics": result.get("data") if result.get("ok") else None,
                    "error": result.get("error"),
                }
            )

    agents.sort(key=lambda x: x.get("name") or "")
    return {
        "ok": True,
        "checked_at": int(time.time()),
        "agents": agents,
    }
