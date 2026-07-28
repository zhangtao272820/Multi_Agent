"""A3：Admin metrics — 按 path（phase）分桶 P95 / 错误码 / pending 等待（JSON）。E1：Prometheus exposition。"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from app.core.admin_data_dir import admin_data_dir

router = APIRouter()


def _read_jsonl(path: Path, limit: int = 200) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for line in lines[-max(1, limit) :]:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                out.append(row)
        except Exception:
            continue
    return out


def _p95(vals: list[int]) -> int | None:
    if not vals:
        return None
    sorted_vals = sorted(vals)
    idx = max(0, min(len(sorted_vals) - 1, int((len(sorted_vals) * 0.95 + 0.999) // 1) - 1))
    return sorted_vals[idx]


def _normalize_phase(path: str) -> str:
    """trace_log.path → phase 桶名（routing/planning/executing/… 或 API path）。"""
    p = str(path or "unknown").strip() or "unknown"
    for node in (
        "routing",
        "loading_memory",
        "planning",
        "executing",
        "verifying",
        "pending",
        "ws_chat",
        "http_chat",
    ):
        if node in p.lower():
            return node
    if p.startswith("/"):
        parts = [x for x in p.split("/") if x]
        return "/".join(parts[:2]) if parts else p
    return p[:64]


@router.get("/metrics")
@router.get("/api/metrics")
def admin_metrics() -> dict[str, Any]:
    trace_path = Path(
        os.getenv("AGENT_TRACE_LOG_PATH", "").strip() or str(admin_data_dir() / "agent-trace.jsonl")
    )
    rows = _read_jsonl(trace_path, 300)
    latencies: list[int] = []
    errors = 0
    error_codes: dict[str, int] = {}
    by_path: dict[str, int] = {}
    by_phase_latencies: dict[str, list[int]] = {}
    pending_waits: list[int] = []
    for r in rows:
        ms = r.get("latency_ms")
        path = str(r.get("path") or "unknown")
        phase = _normalize_phase(path)
        by_path[path] = by_path.get(path, 0) + 1
        if isinstance(ms, (int, float)) and ms > 0:
            latencies.append(int(ms))
            by_phase_latencies.setdefault(phase, []).append(int(ms))
        if r.get("ok") is False:
            errors += 1
            detail = str(r.get("detail") or "unknown")
            code = detail
            if "error_code=" in detail:
                code = detail.split("error_code=", 1)[-1].split()[0].strip() or detail
            error_codes[code] = error_codes.get(code, 0) + 1
        if phase == "pending" or "pending" in path.lower() or "pending" in str(r.get("detail") or "").lower():
            if isinstance(ms, (int, float)) and ms > 0:
                pending_waits.append(int(ms))

    by_phase_p95 = {k: _p95(v) for k, v in sorted(by_phase_latencies.items())}
    overall = _p95(latencies)

    return {
        "ok": True,
        "service": "AI_admin_Agent",
        "samples": len(rows),
        "sli": {
            "overallP95Ms": overall,
            "byPhaseP95Ms": by_phase_p95,
            "phaseP95Ms": overall,
            "toolErrorRate": round(errors / len(rows), 4) if rows else None,
            "errorCodes": error_codes,
            "pendingWaitP95Ms": _p95(pending_waits),
            "byPath": by_path,
        },
        "capabilityAudit": {
            "CAP_ROUTE": os.getenv("CAP_ROUTE"),
            "CAP_REASON": os.getenv("CAP_REASON"),
            "silent_upgrade_forbidden": True,
        },
    }


@router.get("/metrics/prometheus")
@router.get("/api/metrics/prometheus")
def admin_metrics_prometheus() -> PlainTextResponse:
    """E1：真实 Prometheus exposition（供 scrape，不做 auth）。"""
    body = admin_metrics()
    sli = body.get("sli") if isinstance(body, dict) else {}
    sli = sli if isinstance(sli, dict) else {}
    lines: list[str] = [
        "# HELP admin_agent_up Expert process scrape target",
        "# TYPE admin_agent_up gauge",
        "admin_agent_up 1",
    ]
    mapping = {
        "overallP95Ms": "admin_agent_sli_overall_p95_ms",
        "toolErrorRate": "admin_agent_sli_tool_error_rate",
        "pendingWaitP95Ms": "admin_agent_sli_pending_wait_p95_ms",
        "phaseP95Ms": "admin_agent_sli_phase_p95_ms",
    }
    for src, metric in mapping.items():
        v = sli.get(src)
        if isinstance(v, (int, float)) and v == v:
            lines.append(f"# HELP {metric} Admin SLI {src}")
            lines.append(f"# TYPE {metric} gauge")
            lines.append(f"{metric} {float(v)}")
    codes = sli.get("errorCodes")
    if isinstance(codes, dict):
        for code, n in codes.items():
            if not isinstance(n, (int, float)):
                continue
            c = str(code).replace("\\", "\\\\").replace('"', '\\"')[:64]
            lines.append("# HELP admin_agent_error_code_total Expert error_code counts")
            lines.append("# TYPE admin_agent_error_code_total gauge")
            lines.append(f'admin_agent_error_code_total{{code="{c}"}} {float(n)}')
    samples = body.get("samples") if isinstance(body, dict) else None
    if isinstance(samples, (int, float)):
        lines.append("# HELP admin_agent_sli_sample_count Admin trace samples")
        lines.append("# TYPE admin_agent_sli_sample_count gauge")
        lines.append(f"admin_agent_sli_sample_count {float(samples)}")
    return PlainTextResponse("\n".join(lines) + "\n", media_type="text/plain; version=0.0.4; charset=utf-8")
