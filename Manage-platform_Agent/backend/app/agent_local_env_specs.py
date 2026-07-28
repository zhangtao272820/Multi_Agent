"""各 Agent 本地 .env 白名单（editable / readonly_from_ssot / secret）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .agent_env_registry import AGENT_ENV_SPECS
from .capability_models import AGENT_CAPABILITY_ENV_BINDINGS
from .config import get_settings
from .convergence_modes import AGENT_MODE_BINDINGS
from .env_file_io import is_secret_env_key, norm_env_val, parse_env_file, upsert_env_keys

settings = get_settings()

# Agent → 可编辑业务/调优键（不含模型、MODE SSOT、密钥）
AGENT_LOCAL_EDITABLE: dict[str, list[str]] = {
    "DB_Agent": [
        "DB_QUERY_SLOT_SCHEMA_REFINE",
        "DB_SCHEMA_LINK_STRUCTURAL_MIN_SCORE",
        "ENABLE_EXPLAIN_PREFLIGHT",
        "ENABLE_SQL_TEMPLATE_DIRECT",
        "SCHEMA_CACHE_TTL_SEC",
        "AGENT_FALLBACK_ONLY_ON_HARD_FAIL",
        "EMBEDDING_DIMENSIONS",
    ],
    "RAG_Agent": [
        "RAG_HEURISTIC_MODE",
        "RAG_VECTOR_BACKEND",
        "RAG_PG_TABLE_NAME",
        "RAG_TOP_K",
        "RAG_RERANK_TOP_K",
    ],
    "Manager_Agent": [
        "MANAGER_INTENT_RAG_TOP_K",
        "MANAGER_PARALLEL_INDEPENDENT",
        "MANAGER_STREAM_DELTA",
        "MANAGER_OTEL_EXPORT",
        "AGENT_TIMEOUT_MS",
    ],
    "code_assistent_Agent": [
        "CODE_MAX_STEPS",
        "CODE_TIMEOUT_MS",
    ],
    "Extractor_Agent": [
        "EXTRACTOR_MAX_PAGES",
        "EXTRACTOR_TIMEOUT_MS",
    ],
    "AI_admin_Agent": ["PORT"],
    "Multimodal_Agent": [],
    "Music_Agent": [],
    "Video_Agent": [],
    "AI_Agent": [],
    "Lobster_Agent": [],
    "Tavern_Agent": [],
}


class LocalEnvUpdate(BaseModel):
    values: dict[str, str] = Field(default_factory=dict)


def _workspace() -> Path:
    return Path(settings.workspace_root or ".").resolve()


def _env_rel(agent_name: str) -> str | None:
    spec = AGENT_ENV_SPECS.get(agent_name)
    if spec:
        return str(spec.get("env_file") or "") or None
    mode = AGENT_MODE_BINDINGS.get(agent_name)
    if mode:
        return str(mode.get("env_file") or "") or None
    return None


def _readonly_keys(agent_name: str) -> set[str]:
    keys: set[str] = set()
    bindings = AGENT_CAPABILITY_ENV_BINDINGS.get(agent_name) or {}
    keys.update(bindings.keys())
    mode = AGENT_MODE_BINDINGS.get(agent_name) or {}
    keys.update(mode.get("keys") or [])
    return keys


def get_agent_local_env(agent_name: str) -> dict[str, Any]:
    rel = _env_rel(agent_name)
    if not rel:
        raise ValueError(f"未注册 Agent: {agent_name}")
    path = _workspace() / rel
    env = parse_env_file(path)
    readonly = _readonly_keys(agent_name)
    editable_keys = list(AGENT_LOCAL_EDITABLE.get(agent_name) or [])
    # 去掉与 SSOT 重叠的可编辑声明
    editable_keys = [k for k in editable_keys if k not in readonly and not is_secret_env_key(k)]

    editable_vals = {k: env.get(k, "") for k in editable_keys}
    readonly_vals = [
        {
            "key": k,
            "value": env.get(k, ""),
            "source": "capability" if k in (AGENT_CAPABILITY_ENV_BINDINGS.get(agent_name) or {}) else "mode",
        }
        for k in sorted(readonly)
        if k in env or k in (AGENT_CAPABILITY_ENV_BINDINGS.get(agent_name) or {})
    ]
    secrets = [
        {"key": k, "configured": bool(str(env.get(k) or "").strip())}
        for k in sorted(env.keys())
        if is_secret_env_key(k)
    ]
    return {
        "ok": True,
        "agent_name": agent_name,
        "env_file": rel,
        "env_exists": path.is_file(),
        "editable": editable_vals,
        "editable_keys": editable_keys,
        "readonly_from_ssot": readonly_vals,
        "secrets": secrets,
    }


def update_agent_local_env(agent_name: str, payload: LocalEnvUpdate) -> dict[str, Any]:
    rel = _env_rel(agent_name)
    if not rel:
        raise ValueError(f"未注册 Agent: {agent_name}")
    allowed = set(AGENT_LOCAL_EDITABLE.get(agent_name) or [])
    readonly = _readonly_keys(agent_name)
    updates: dict[str, str] = {}
    for k, v in (payload.values or {}).items():
        key = str(k).strip()
        if key not in allowed or key in readonly or is_secret_env_key(key):
            continue
        updates[key] = str(v).strip()
    path = _workspace() / rel
    write = upsert_env_keys(path, updates, header_label=agent_name) if updates else {"changed_keys": []}
    out = get_agent_local_env(agent_name)
    out["write"] = write
    return out


def check_local_drift(agent_name: str, desired: dict[str, str] | None = None) -> dict[str, Any]:
    """本地白名单键相对「上次期望」可选；默认无平台期望则不算漂移。"""
    if not desired:
        return {"local_drift": False, "local_drift_keys": []}
    info = get_agent_local_env(agent_name)
    env_vals = info.get("editable") or {}
    drift_keys: list[str] = []
    for k, exp in desired.items():
        if k not in (info.get("editable_keys") or []):
            continue
        cur = str(env_vals.get(k) or "")
        if norm_env_val(cur) != norm_env_val(str(exp)):
            drift_keys.append(k)
    return {"local_drift": bool(drift_keys), "local_drift_keys": drift_keys}
