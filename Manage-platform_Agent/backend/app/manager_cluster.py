import threading
import time
from concurrent.futures import ThreadPoolExecutor

from .config import get_settings
from .internal_http import fetch_json

settings = get_settings()

_CLUSTER_CACHE_TTL_SEC = 15.0
_cluster_cache_lock = threading.Lock()
_cluster_cache: dict = {"at": 0.0, "data": None}


def _manager_base_url() -> str:
    host = str(settings.manager_agent_host or "localhost").strip()
    port = str(settings.manager_agent_port or "13106").strip()
    return f"http://{host}:{port}"


def _fetch_json(url: str, timeout_sec: float = 3.0) -> dict:
    result = fetch_json(url, timeout_sec=timeout_sec)
    # Preserve previous connection-refused hint for Manager
    err = str(result.get("error") or "")
    if (
        not result.get("ok")
        and result.get("status_code") is None
        and ("Connection refused" in err or "Name or service not known" in err or "无法连接" in err)
    ):
        result = {
            **result,
            "error": f"无法连接 Manager（请 docker compose up -d manager_agent）: {err}",
        }
    return result


def _build_manager_cluster_status_uncached() -> dict:
    base = _manager_base_url().rstrip("/")
    metrics_url = f"{base}/api/metrics"
    registry_url = f"{base}/api/agents/registry"
    with ThreadPoolExecutor(max_workers=2) as pool:
        fm = pool.submit(_fetch_json, metrics_url)
        fr = pool.submit(_fetch_json, registry_url)
        metrics = fm.result()
        registry = fr.result()
    ok = bool(metrics.get("ok") and registry.get("ok"))
    err_parts = []
    if not metrics.get("ok"):
        err_parts.append(f"metrics: {metrics.get('error') or 'failed'}")
    if not registry.get("ok"):
        err_parts.append(f"registry: {registry.get('error') or 'failed'}")
    return {
        "ok": ok,
        "manager_endpoint": base,
        "checked_at": int(time.time()),
        "metrics": metrics,
        "registry": registry,
        "error": "; ".join(err_parts) if err_parts else None,
    }


def build_manager_cluster_status(*, use_cache: bool = True) -> dict:
    now = time.monotonic()
    if use_cache:
        with _cluster_cache_lock:
            cached = _cluster_cache.get("data")
            cached_at = float(_cluster_cache.get("at") or 0)
            if cached and now - cached_at < _CLUSTER_CACHE_TTL_SEC:
                return cached

    data = _build_manager_cluster_status_uncached()
    with _cluster_cache_lock:
        _cluster_cache["at"] = now
        _cluster_cache["data"] = data
    return data
