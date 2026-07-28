"""OpenAI 兼容 embedding 客户端（DashScope compatible-mode / OPENAI_*）。"""
from __future__ import annotations

import math
import os
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from typing import Sequence

_embed_client = None
_query_cache: dict[str, tuple[float, list[float]]] = {}
_QUERY_TTL_SEC = 180.0
_QUERY_MAX = 128
_DASHSCOPE_COMPAT_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"

from app.core.admin_env_modes import is_admin_intent_rag_enabled


def embedding_api_configured() -> bool:
    return bool(_api_key())


def is_admin_embedding_enabled() -> bool:
    return is_admin_intent_rag_enabled()


def _api_key() -> str:
    key = (
        os.getenv("OPENAI_API_KEY")
        or os.getenv("DASHSCOPE_API_KEY")
        or ""
    ).strip()
    if key:
        return key
    try:
        from app.core.config import settings

        return str(settings.DASHSCOPE_API_KEY or "").strip()
    except Exception:
        return ""


def _openai_compatible_base() -> str:
    """
    未配置 OPENAI_BASE_URL 时，若使用 DashScope key，默认走百炼 compatible-mode。
    否则 langchain OpenAIEmbeddings 会打到 api.openai.com 并长时间挂死。
    """
    explicit = (
        os.getenv("OPENAI_BASE_URL")
        or os.getenv("DASHSCOPE_BASE_URL")
        or ""
    ).strip()
    if explicit:
        return explicit.rstrip("/")
    # DashScope sk- key without base → force compatible endpoint
    if _api_key():
        return _DASHSCOPE_COMPAT_BASE
    return ""


def _embed_model() -> str:
    return (
        os.getenv("OPENAI_EMBEDDING_MODEL")
        or os.getenv("DASHSCOPE_EMBEDDING_MODEL")
        or "text-embedding-v1"
    ).strip()


def _embed_timeout_sec() -> float:
    raw = os.getenv("ADMIN_EMBEDDING_TIMEOUT_SEC") or os.getenv("AGENT_EMBEDDING_TIMEOUT_SEC") or "12"
    try:
        sec = float(raw)
    except (TypeError, ValueError):
        sec = 12.0
    return max(3.0, min(60.0, sec))


def _get_client():
    global _embed_client
    if _embed_client is None:
        from langchain_openai import OpenAIEmbeddings

        kwargs: dict = {
            "api_key": _api_key(),
            "model": _embed_model(),
            "timeout": _embed_timeout_sec(),
            "max_retries": 0,
        }
        base = _openai_compatible_base()
        if base:
            kwargs["base_url"] = base
        _embed_client = OpenAIEmbeddings(**kwargs)
    return _embed_client


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _prune_cache() -> None:
    if len(_query_cache) <= _QUERY_MAX:
        return
    items = sorted(_query_cache.items(), key=lambda kv: kv[1][0])
    for key, _ in items[: len(_query_cache) - _QUERY_MAX]:
        _query_cache.pop(key, None)


def _run_with_timeout(fn, *args):
    """硬超时：避免 embedding HTTP 无限挂死拖垮整轮 NLU/图执行。"""
    timeout = _embed_timeout_sec()
    with ThreadPoolExecutor(max_workers=1) as pool:
        fut = pool.submit(fn, *args)
        try:
            return fut.result(timeout=timeout)
        except FuturesTimeout:
            fut.cancel()
            return None
        except Exception:
            return None


def embed_query(text: str) -> list[float]:
    key = " ".join(str(text or "").split()).lower()[:400]
    if not key or not _api_key() or not is_admin_embedding_enabled():
        return []
    now = time.time()
    cached = _query_cache.get(key)
    if cached and now - cached[0] < _QUERY_TTL_SEC:
        return list(cached[1])
    try:
        client = _get_client()
        vec = _run_with_timeout(client.embed_query, key)
        if not vec:
            return []
        _query_cache[key] = (now, list(vec))
        _prune_cache()
        return list(vec)
    except Exception:
        return []


def embed_documents(texts: list[str]) -> list[list[float]]:
    if not texts or not _api_key() or not is_admin_embedding_enabled():
        return []
    try:
        client = _get_client()
        out = _run_with_timeout(client.embed_documents, texts)
        if not out:
            return []
        return [list(v) for v in out]
    except Exception:
        return []
