"""收敛 MODE SSOT：.env.convergence-modes → 各 Agent .env / .env.agents-lan。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .config import get_settings
from .env_file_io import norm_env_val, parse_env_file, upsert_env_keys

settings = get_settings()

# 与 scripts/sync-convergence-modes.py 保持同一绑定表（脚本改为 import 本模块）
AGENT_MODE_BINDINGS: dict[str, dict[str, Any]] = {
    "Manager_Agent": {
        "env_file": "Manager_Agent/.env",
        "keys": [
            "EVO_MODE",
            "ARTIFACT_FEEDBACK_MODE",
            "MANAGER_ROUTE_MODE",
            "MANAGER_PRO_MODE",
            "MANAGER_EVOLUTION_MODE",
            "MANAGER_WEB_SEARCH_MODE",
            "MANAGER_PLATFORM_MODE",
            "MANAGER_AUTH_MODE",
            "MANAGER_RUNTIME",
            "QWEN_ENABLE_THINKING",
            "MANAGER_INTENT_RAG_TOP_K",
            "MANAGER_PROMPT_AUTO_PROMOTE",
            "EVO_ALLOW_EXPERT_AUTO_PROMOTE",
            "EVO_PROMOTE_REQUIRES_VERIFY",
            "EVO_VERIFY_BEFORE_PROMOTE",
            "MGR_SKILL_BATCH_PROMOTE",
            "MGR_ONLINE_EVAL_MODE",
            "MGR_ONLINE_EVAL_LIVE",
            "MGR_ONLINE_EVAL_JUDGE",
            "EVO_ONLINE_EVAL_GATE",
            "EVO_ONLINE_EVAL_CACHE_TTL_SEC",
            "MANAGER_STICKY_CANARY_BUNDLE",
            "MANAGER_POLICY_CANARY_PERCENT",
            "MANAGER_RELEASE_BUNDLE_CANARY_PERCENT",
            "MANAGER_PROMPT_BUDGET_TOKEN_MODE",
            "MANAGER_EVOLUTION_SHADOW_SAMPLE",
            "MANAGER_EVOLUTION_SHADOW_SAMPLE_PERCENT",
            "AMP_RECALL_DECAY_LAMBDA",
        ],
    },
    "DB_Agent": {
        "env_file": "DB_Agent/.env",
        "keys": [
            "EVO_MODE",
            "ARTIFACT_FEEDBACK_MODE",
            "DB_AGENT_DOMAIN",
            "DB_AGENT_PROFILE",
            "DB_ROUTE_MODE",
            "DB_LEGACY_SHORTCUTS",
            "DB_NLU_MODE",
            "ENABLE_AUTO_CURATE_ON_QUERY",
            "EVO_ALLOW_EXPERT_AUTO_PROMOTE",
            "EVO_PROMOTE_REQUIRES_VERIFY",
        ],
    },
    "RAG_Agent": {
        "env_file": "RAG_Agent/.env",
        "keys": [
            "EVO_MODE",
            "ARTIFACT_FEEDBACK_MODE",
            "RAG_CORPUS_TIER",
            "RAG_NLU_MODE",
            "RAG_AUTO_CURATE_ON_FEEDBACK",
            "RAG_AB_AUTO_PROMOTE",
            "EVO_ALLOW_EXPERT_AUTO_PROMOTE",
            "EVO_PROMOTE_REQUIRES_VERIFY",
        ],
    },
    "code_assistent_Agent": {
        "env_file": "CodePy_Agent/.env",
        "keys": ["EVO_MODE", "WRITE_TOOL_ENABLED", "CODE_MCP_SERVER"],
    },
    "CodePy_Agent": {
        "env_file": "CodePy_Agent/.env",
        "keys": ["WRITE_TOOL_ENABLED", "CODE_MCP_SERVER"],
    },
    "Extractor_Agent": {
        "env_file": "Extractor_Agent/.env",
        "keys": ["EVO_MODE", "EXTRACTOR_MODE", "EXTRACTOR_LEARNING_MODE"],
    },
    "AI_admin_Agent": {
        "env_file": "AI_admin_Agent/backend/.env",
        "keys": [
            "EVO_MODE",
            "ARTIFACT_FEEDBACK_MODE",
            "ADMIN_EVOLUTION_MODE",
            "ADMIN_NLU_MODE",
            "ADMIN_MEMORY_MODE",
            "ADMIN_AUTO_CURATE",
            "EVO_ALLOW_EXPERT_AUTO_PROMOTE",
            "EVO_PROMOTE_REQUIRES_VERIFY",
        ],
    },
    "Lobster_Agent": {
        "env_file": "Lobster_Agent/.env",
        "keys": [
            "EVO_MODE",
            "LOBSTER_PLAYBOOK_EVOLUTION",
            "LOBSTER_PLAYBOOK_AUTO_PROMOTE",
            "EVO_ALLOW_EXPERT_AUTO_PROMOTE",
            "EVO_PROMOTE_REQUIRES_VERIFY",
        ],
    },
}

AGENTS_LAN_MODE_KEYS = [
    "EVO_MODE",
    "ARTIFACT_FEEDBACK_MODE",
    "MANAGER_ROUTE_MODE",
    "MANAGER_PRO_MODE",
    "MANAGER_EVOLUTION_MODE",
    "MANAGER_WEB_SEARCH_MODE",
    "MANAGER_PLATFORM_MODE",
    "MANAGER_AUTH_MODE",
    "MANAGER_RUNTIME",
    "QWEN_ENABLE_THINKING",
    "MANAGER_PROMPT_AUTO_PROMOTE",
    "DB_AGENT_PROFILE",
    "DB_ROUTE_MODE",
    "DB_LEGACY_SHORTCUTS",
    "DB_NLU_MODE",
    "ENABLE_AUTO_CURATE_ON_QUERY",
    "RAG_CORPUS_TIER",
    "RAG_NLU_MODE",
    "RAG_AUTO_CURATE_ON_FEEDBACK",
    "RAG_AB_AUTO_PROMOTE",
    "EXTRACTOR_MODE",
    "EXTRACTOR_LEARNING_MODE",
    "CODE_LEARNING_MODE",
    "ADMIN_EVOLUTION_MODE",
    "ADMIN_NLU_MODE",
    "ADMIN_MEMORY_MODE",
    "ADMIN_AUTO_CURATE",
    "EVO_ALLOW_EXPERT_AUTO_PROMOTE",
    "EVO_PROMOTE_REQUIRES_VERIFY",
    "EVO_VERIFY_BEFORE_PROMOTE",
    "MGR_SKILL_BATCH_PROMOTE",
    "LOBSTER_PLAYBOOK_EVOLUTION",
    "LOBSTER_PLAYBOOK_AUTO_PROMOTE",
    "MGR_ONLINE_EVAL_MODE",
    "MGR_ONLINE_EVAL_LIVE",
    "MGR_ONLINE_EVAL_JUDGE",
    "EVO_ONLINE_EVAL_GATE",
    "EVO_ONLINE_EVAL_CACHE_TTL_SEC",
    "MANAGER_STICKY_CANARY_BUNDLE",
    "MANAGER_POLICY_CANARY_PERCENT",
    "MANAGER_RELEASE_BUNDLE_CANARY_PERCENT",
    "MANAGER_PROMPT_BUDGET_TOKEN_MODE",
    "MANAGER_EVOLUTION_SHADOW_SAMPLE",
    "MANAGER_EVOLUTION_SHADOW_SAMPLE_PERCENT",
    "AMP_RECALL_DECAY_LAMBDA",
]

MODE_FIELD_META: list[dict[str, str]] = [
    {"key": "EVO_MODE", "label": "自进化 MODE", "group": "global"},
    {"key": "ARTIFACT_FEEDBACK_MODE", "label": "产物学习", "group": "global"},
    {"key": "MANAGER_ROUTE_MODE", "label": "Manager 路由", "group": "manager"},
    {"key": "MANAGER_PRO_MODE", "label": "Manager Pro", "group": "manager"},
    {"key": "MANAGER_EVOLUTION_MODE", "label": "Manager 进化", "group": "manager"},
    {"key": "MANAGER_WEB_SEARCH_MODE", "label": "联网搜索", "group": "manager"},
    {"key": "MANAGER_PLATFORM_MODE", "label": "平台同步", "group": "manager"},
    {"key": "MANAGER_AUTH_MODE", "label": "鉴权 MODE", "group": "manager"},
    {"key": "MANAGER_RUNTIME", "label": "Runtime", "group": "manager"},
    {"key": "QWEN_ENABLE_THINKING", "label": "Qwen 思考", "group": "manager"},
    {"key": "MANAGER_INTENT_RAG_TOP_K", "label": "Intent RAG TopK", "group": "manager"},
    {"key": "DB_AGENT_DOMAIN", "label": "DB 域", "group": "db"},
    {"key": "DB_AGENT_PROFILE", "label": "DB Profile", "group": "db"},
    {"key": "DB_ROUTE_MODE", "label": "DB 路由", "group": "db"},
    {"key": "DB_LEGACY_SHORTCUTS", "label": "DB Legacy", "group": "db"},
    {"key": "DB_NLU_MODE", "label": "DB NLU", "group": "db"},
    {"key": "RAG_CORPUS_TIER", "label": "RAG Corpus", "group": "rag"},
    {"key": "RAG_NLU_MODE", "label": "RAG NLU", "group": "rag"},
    {"key": "CODE_LEARNING_MODE", "label": "Code 学习", "group": "code"},
    {"key": "EXTRACTOR_MODE", "label": "Extractor MODE", "group": "extractor"},
    {"key": "EXTRACTOR_LEARNING_MODE", "label": "Extractor 学习", "group": "extractor"},
    {"key": "ADMIN_EVOLUTION_MODE", "label": "Admin 进化", "group": "admin"},
    {"key": "ADMIN_NLU_MODE", "label": "Admin NLU", "group": "admin"},
    {"key": "ADMIN_MEMORY_MODE", "label": "Admin 记忆", "group": "admin"},
]


class ConvergenceModesUpdate(BaseModel):
    modes: dict[str, str] = Field(default_factory=dict)
    sync_env_files: bool = True


class ConvergenceModesApplyRequest(BaseModel):
    sync_env_files: bool = True


def _platform_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def _workspace() -> Path:
    return Path(settings.workspace_root or ".").resolve()


def ssot_path() -> Path:
    return _platform_dir() / ".env.convergence-modes"


def ssot_example_path() -> Path:
    return _platform_dir() / ".env.convergence-modes.example"


def agents_lan_path() -> Path:
    return _platform_dir() / ".env.agents-lan"


def load_convergence_modes() -> dict[str, str]:
    path = ssot_path()
    if not path.is_file():
        path = ssot_example_path()
    return parse_env_file(path)


def get_convergence_modes() -> dict[str, Any]:
    modes = load_convergence_modes()
    path = ssot_path()
    return {
        "ok": True,
        "ssot_file": "Manage-platform_Agent/.env.convergence-modes",
        "ssot_exists": path.is_file(),
        "fields": MODE_FIELD_META,
        "modes": modes,
        "agent_bindings": {
            name: {"env_file": spec["env_file"], "keys": list(spec["keys"])}
            for name, spec in AGENT_MODE_BINDINGS.items()
        },
    }


def save_convergence_modes(modes: dict[str, str]) -> dict[str, Any]:
    allowed = {f["key"] for f in MODE_FIELD_META}
    updates = {
        str(k).strip(): str(v).strip()
        for k, v in (modes or {}).items()
        if str(k).strip() in allowed and str(v).strip() != ""
    }
    path = ssot_path()
    # 保留未在 payload 中的已有键
    current = parse_env_file(path) if path.is_file() else parse_env_file(ssot_example_path())
    current.update(updates)
    result = upsert_env_keys(path, current, header_label="convergence-modes")
    return {"ok": True, "modes": parse_env_file(path), **result}


def apply_convergence_modes(*, sync_env_files: bool = True) -> dict[str, Any]:
    ssot = load_convergence_modes()
    if not ssot:
        raise ValueError("convergence-modes SSOT 为空")
    env_synced: list[str] = []
    changed_total = 0
    if sync_env_files:
        ws = _workspace()
        for agent_name, spec in AGENT_MODE_BINDINGS.items():
            updates = {k: ssot[k] for k in spec["keys"] if k in ssot and str(ssot[k]).strip()}
            if not updates:
                continue
            path = ws / str(spec["env_file"])
            out = upsert_env_keys(path, updates, header_label=agent_name)
            changed_total += len(out.get("changed_keys") or [])
            env_synced.append(agent_name)
        lan_updates = {k: ssot[k] for k in AGENTS_LAN_MODE_KEYS if k in ssot and str(ssot[k]).strip()}
        lan = agents_lan_path()
        if lan.is_file() and lan_updates:
            out = upsert_env_keys(lan, lan_updates, header_label="agents-lan")
            changed_total += len(out.get("changed_keys") or [])
            env_synced.append(".env.agents-lan")
    return {
        "ok": True,
        "modes": ssot,
        "env_synced": env_synced,
        "changed_key_count": changed_total,
    }


def update_and_apply_convergence_modes(payload: ConvergenceModesUpdate) -> dict[str, Any]:
    saved = save_convergence_modes(payload.modes or {})
    applied = apply_convergence_modes(sync_env_files=bool(payload.sync_env_files))
    return {**saved, **applied, "ok": True}


def check_mode_drift_for_agent(agent_name: str, ssot: dict[str, str] | None = None) -> dict[str, Any]:
    spec = AGENT_MODE_BINDINGS.get(agent_name)
    if not spec:
        return {"mode_drift": False, "mode_drift_keys": []}
    ssot = ssot if ssot is not None else load_convergence_modes()
    env = parse_env_file(_workspace() / str(spec["env_file"]))
    drift_keys: list[str] = []
    for key in spec["keys"]:
        exp = str(ssot.get(key) or "").strip()
        if not exp:
            continue
        cur = str(env.get(key) or "").strip()
        if not cur or norm_env_val(cur) != norm_env_val(exp):
            drift_keys.append(key)
    return {"mode_drift": bool(drift_keys), "mode_drift_keys": drift_keys}
