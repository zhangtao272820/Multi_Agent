"""
Admin 多租户 inflight 闸：与 shared/jobQueueKeys 同一 Redis key 约定。
无 REDIS_URL 或上限为 0 时放行（LAN 开发友好）。
"""
from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from typing import Iterator

_PREFIX = "clawhive:jq"
_lock = threading.Lock()
_memory: dict[str, int] = {}


def _read_max(env_key: str, default: int = 0) -> int:
    raw = str(os.environ.get(env_key, "") or "").strip()
    if not raw:
        return default
    try:
        n = int(raw)
    except ValueError:
        return default
    return max(0, n)


def _global_key(pool: str) -> str:
    return f"{_PREFIX}:inflight:global:{pool}"


def _tenant_key(pool: str, tenant_id: str) -> str:
    t = (tenant_id or "default").strip()[:64] or "default"
    return f"{_PREFIX}:inflight:tenant:{pool}:{t}"


def _mem_incr(key: str) -> int:
    with _lock:
        _memory[key] = int(_memory.get(key, 0)) + 1
        return _memory[key]


def _mem_decr(key: str) -> int:
    with _lock:
        n = max(0, int(_memory.get(key, 0)) - 1)
        if n <= 0:
            _memory.pop(key, None)
        else:
            _memory[key] = n
        return n


def _redis_client():
    url = str(os.environ.get("REDIS_URL") or os.environ.get("ADMIN_REDIS_URL") or "").strip()
    if not url:
        return None
    try:
        import redis  # type: ignore

        return redis.Redis.from_url(url, decode_responses=True, socket_connect_timeout=1.5)
    except Exception:
        return None


def try_acquire_admin_slots(
    *,
    pool: str,
    tenant_id: str,
    max_global: int,
    max_per_tenant: int,
) -> tuple[bool, str]:
    """返回 (ok, reason)。"""
    if max_global <= 0 and max_per_tenant <= 0:
        return True, ""
    gkey = _global_key(pool)
    tkey = _tenant_key(pool, tenant_id)
    client = _redis_client()
    if client is not None:
        try:
            g = int(client.incr(gkey))
            if max_global > 0 and g > max_global:
                client.decr(gkey)
                return False, f"Admin 并发已达全局上限（{max_global}）"
            t = int(client.incr(tkey))
            if max_per_tenant > 0 and t > max_per_tenant:
                client.decr(tkey)
                client.decr(gkey)
                return False, f"Admin 租户并发已达上限（{max_per_tenant}）"
            return True, ""
        except Exception:
            # Redis 失败回落内存，避免整站拒服务
            pass
    g = _mem_incr(gkey)
    if max_global > 0 and g > max_global:
        _mem_decr(gkey)
        return False, f"Admin 并发已达全局上限（{max_global}）"
    t = _mem_incr(tkey)
    if max_per_tenant > 0 and t > max_per_tenant:
        _mem_decr(tkey)
        _mem_decr(gkey)
        return False, f"Admin 租户并发已达上限（{max_per_tenant}）"
    return True, ""


def release_admin_slots(*, pool: str, tenant_id: str) -> None:
    gkey = _global_key(pool)
    tkey = _tenant_key(pool, tenant_id)
    client = _redis_client()
    if client is not None:
        try:
            client.decr(tkey)
            client.decr(gkey)
            return
        except Exception:
            pass
    _mem_decr(tkey)
    _mem_decr(gkey)


@contextmanager
def admin_inflight_slot(tenant_id: str, *, write: bool = False) -> Iterator[None]:
    pool = "admin_write" if write else "admin"
    max_g = _read_max("ADMIN_WRITE_MAX_INFLIGHT" if write else "ADMIN_MAX_INFLIGHT", 0)
    max_t = _read_max(
        "ADMIN_WRITE_MAX_INFLIGHT_PER_TENANT" if write else "ADMIN_MAX_INFLIGHT_PER_TENANT",
        0,
    )
    ok, reason = try_acquire_admin_slots(
        pool=pool, tenant_id=tenant_id, max_global=max_g, max_per_tenant=max_t
    )
    if not ok:
        raise RuntimeError(reason or "admin overloaded")
    try:
        yield
    finally:
        release_admin_slots(pool=pool, tenant_id=tenant_id)


def read_admin_max(env_key: str, default: int = 0) -> int:
    return _read_max(env_key, default)


def reset_admin_inflight_for_tests() -> None:
    with _lock:
        _memory.clear()
