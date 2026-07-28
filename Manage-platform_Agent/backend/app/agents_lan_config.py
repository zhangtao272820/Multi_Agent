"""集群基建 .env.agents-lan：非密钥键控制台编辑。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .env_file_io import is_secret_env_key, parse_env_file, upsert_env_keys

# 可编辑（非密钥）键 — 宁缺勿滥；密钥走 vault
AGENTS_LAN_EDITABLE_KEYS: list[str] = [
    "LAN_HOST",
    "CLAWHIVE_PG_USER",
    "CLAWHIVE_PG_DB",
    "CLAWHIVE_PG_PORT",
    "CLAWHIVE_REDIS_PORT",
    "DB_PORT",
    "RAG_PORT",
    "MANAGER_PORT",
    "SEARXNG_BASE_URL",
    "WEB_SEARCH_PROVIDER",
    "AGENT_TIMEOUT_MS",
    "MANAGER_DOCKER_TIMEOUT_MS",
    "MANAGER_LLM_REQUEST_TIMEOUT_MS",
    "MANAGER_LLM_MAX_RETRIES",
    "AGENT_LLM_REQUEST_TIMEOUT_MS",
    "MANAGER_LOCAL_REPLAN_MAX",
    "MANAGER_MAX_RETRY",
    "MANAGER_GRAPH_RECURSION_LIMIT",
    "MANAGER_STORAGE_BACKEND",
    "MANAGER_OTEL_EXPORT",
    "CLAWHIVE_IMAGE_TAG",
    "CLAWHIVE_ALERT_WEBHOOK_URL",
]

AGENTS_LAN_FIELD_META: list[dict[str, str]] = [
    {"key": k, "label": k, "group": "infra"} for k in AGENTS_LAN_EDITABLE_KEYS
]


class AgentsLanUpdate(BaseModel):
    values: dict[str, str] = Field(default_factory=dict)


def _platform_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def agents_lan_path() -> Path:
    return _platform_dir() / ".env.agents-lan"


def get_agents_lan_config() -> dict[str, Any]:
    path = agents_lan_path()
    env = parse_env_file(path)
    values: dict[str, str] = {}
    for key in AGENTS_LAN_EDITABLE_KEYS:
        if key in env:
            values[key] = env[key]
    secret_refs = [
        {"key": k, "configured": bool(str(env.get(k) or "").strip())}
        for k in sorted(env.keys())
        if is_secret_env_key(k)
    ]
    return {
        "ok": True,
        "ssot_file": "Manage-platform_Agent/.env.agents-lan",
        "ssot_exists": path.is_file(),
        "fields": AGENTS_LAN_FIELD_META,
        "values": values,
        "secrets": secret_refs,
        "recreate_hint": [
            "manager_agent",
            "clawhive_backend",
            "db_agent",
            "rag_agent",
        ],
    }


def update_agents_lan_config(payload: AgentsLanUpdate) -> dict[str, Any]:
    path = agents_lan_path()
    if not path.is_file():
        raise ValueError(".env.agents-lan 不存在，请先从 .env.agents-lan.example 复制")
    allowed = set(AGENTS_LAN_EDITABLE_KEYS)
    updates: dict[str, str] = {}
    for k, v in (payload.values or {}).items():
        key = str(k).strip()
        if key not in allowed:
            continue
        if is_secret_env_key(key):
            continue
        updates[key] = str(v).strip()
    result = upsert_env_keys(path, updates, header_label="agents-lan")
    return {"ok": True, **get_agents_lan_config(), "write": result}
