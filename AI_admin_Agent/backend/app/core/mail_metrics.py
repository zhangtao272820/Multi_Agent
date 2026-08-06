"""In-process mail metrics counters (exposed via /api/metrics)."""
from __future__ import annotations

from threading import Lock

_LOCK = Lock()
_COUNTERS: dict[str, int] = {
    "mail_list": 0,
    "mail_search": 0,
    "mail_send": 0,
    "mail_hitl_cancel": 0,
    "mail_mark_read": 0,
    "mail_forward": 0,
    "mail_delete": 0,
    "mail_bind": 0,
}


def mail_metric_inc(name: str, n: int = 1) -> None:
    key = str(name or "").strip()
    if not key:
        return
    with _LOCK:
        _COUNTERS[key] = int(_COUNTERS.get(key, 0)) + int(n)


def mail_metrics_snapshot() -> dict[str, int]:
    with _LOCK:
        return dict(_COUNTERS)
