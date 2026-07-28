"""各 Agent .env 模型键映射与漂移检测（只读模型相关键，不暴露密钥）。"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from .agent_config import list_agent_configs
from .config import get_settings

settings = get_settings()

# 运行时从平台拉配置（全集群 SSOT）
RUNTIME_SYNC_AGENTS = frozenset(
    {
        "DB_Agent",
        "RAG_Agent",
        "code_assistent_Agent",
        "Extractor_Agent",
        "AI_admin_Agent",
        "Manager_Agent",
        "Multimodal_Agent",
        "Music_Agent",
        "Video_Agent",
        "AI_Agent",
        "Lobster_Agent",
        "Tavern_Agent",
    }
)

# agent_name → 相对 workspace 的 env 路径 + 模型环境变量名
AGENT_ENV_SPECS: dict[str, dict[str, Any]] = {
    "DB_Agent": {
        "env_file": "DB_Agent/.env",
        "planner": ["OPENAI_ORCHESTRATION_MODEL", "OPENAI_NLU_MODEL"],
        "executor": ["OPENAI_AGENT_MODEL", "OPENAI_MODEL"],
        "embedding": ["EMBEDDING_MODEL", "OPENAI_EMBEDDING_MODEL"],
    },
    "RAG_Agent": {
        "env_file": "RAG_Agent/.env",
        "planner": ["OPENAI_MODEL", "OPENAI_PLANNER_MODEL"],
        "executor": ["OPENAI_MODEL", "OPENAI_EXECUTOR_MODEL"],
        "embedding": ["EMBEDDING_MODEL", "OPENAI_EMBEDDING_MODEL"],
    },
    "code_assistent_Agent": {
        "env_file": "code_assistent_Agent/.env",
        "planner": ["OPENAI_MODEL", "OPENAI_PLANNER_MODEL"],
        "executor": ["OPENAI_MODEL", "OPENAI_EXECUTOR_MODEL"],
        "embedding": ["EMBEDDING_MODEL"],
    },
    "Extractor_Agent": {
        "env_file": "Extractor_Agent/.env",
        "planner": ["QWEN_MODEL", "OPENAI_MODEL"],
        "executor": ["QWEN_MODEL", "OPENAI_MODEL", "OPENAI_EXECUTOR_MODEL"],
        "embedding": ["EMBEDDING_MODEL", "EXTRACTOR_EMBEDDING_MODEL"],
    },
    "AI_admin_Agent": {
        "env_file": "AI_admin_Agent/backend/.env",
        "planner": ["MODEL_NAME", "QWEN_PLANNER_MODEL", "QWEN_MODEL"],
        "executor": ["MODEL_NAME", "QWEN_EXECUTOR_MODEL", "QWEN_MODEL"],
        "embedding": ["QWEN_EMBEDDING_MODEL"],
    },
    "Manager_Agent": {
        "env_file": "Manager_Agent/.env",
        "planner": ["MANAGER_MODEL_PLAN", "MANAGER_MODEL_ROUTE", "OPENAI_MODEL"],
        "executor": ["MANAGER_MODEL_SYNTH", "MANAGER_MODEL_CRITIC", "OPENAI_MODEL"],
        "embedding": [],
    },
    "Multimodal_Agent": {
        "env_file": "Multimodal_Agent/.env",
        "planner": ["QWEN_HELPER_MODEL", "OPENAI_MODEL"],
        "executor": ["QWEN_TEXT_MODEL", "OPENAI_MODEL"],
        "embedding": [],
    },
    "Music_Agent": {
        "env_file": "Music_Agent/.env",
        "planner": ["OPENAI_MODEL", "QWEN_MODEL"],
        "executor": ["OPENAI_MODEL", "QWEN_MODEL"],
        "embedding": [],
    },
    "Video_Agent": {
        "env_file": "Video_Agent/.env",
        "planner": ["OPENAI_MODEL", "QWEN_MODEL"],
        "executor": ["OPENAI_MODEL", "QWEN_MODEL"],
        "embedding": [],
    },
    "AI_Agent": {
        "env_file": "AI_Agent/.env",
        "planner": ["LLM_MODEL", "OPENAI_MODEL"],
        "executor": ["LLM_MODEL", "OPENAI_MODEL"],
        "embedding": [],
    },
    "Lobster_Agent": {
        "env_file": "Lobster_Agent/.env",
        "planner": ["LOBSTER_PLANNER_MODEL", "OPENAI_MODEL"],
        "executor": ["LOBSTER_DECISION_MODEL", "OPENAI_MODEL"],
        "embedding": [],
    },
    "Tavern_Agent": {"env_file": "Tavern_Agent/.env", "planner": ["OPENAI_MODEL", "QWEN_MODEL"], "executor": ["OPENAI_MODEL"], "embedding": []},
}

GLOBAL_ENV_FILE = "Manage-platform_Agent/.env.agents-lan"
GLOBAL_MODEL_KEYS = {
    "planner": ["QWEN_PLANNER_MODEL", "QWEN_MODEL"],
    "executor": ["QWEN_EXECUTOR_MODEL", "QWEN_MODEL"],
    "embedding": [],
    "base_url": ["QWEN_BASE_URL", "OPENAI_BASE_URL"],
}


def _workspace() -> Path:
    return Path(settings.workspace_root or ".").resolve()


def _parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key:
            out[key] = val
    return out


def _first_val(env: dict[str, str], keys: list[str]) -> str:
    for k in keys:
        v = str(env.get(k) or "").strip()
        if v:
            return v
    return ""


def _models_from_env(env: dict[str, str], spec: dict[str, Any]) -> dict[str, str]:
    return {
        "planner": _first_val(env, spec.get("planner") or []),
        "executor": _first_val(env, spec.get("executor") or []),
        "embedding": _first_val(env, spec.get("embedding") or []),
    }


def _norm(v: str) -> str:
    return re.sub(r"\s+", "", str(v or "").strip().lower())


def _has_drift(platform: dict[str, str], env_models: dict[str, str]) -> bool:
    for field in ("planner", "executor", "embedding"):
        p = _norm(platform.get(field) or "")
        e = _norm(env_models.get(field) or "")
        if p and e and p != e:
            return True
    return False


def read_agent_env_models(agent_name: str) -> dict[str, Any]:
    spec = AGENT_ENV_SPECS.get(agent_name)
    if not spec:
        return {"env_file": None, "exists": False, "models": {}}
    rel = str(spec.get("env_file") or "")
    path = _workspace() / Path(rel)
    env = _parse_env_file(path)
    return {
        "env_file": rel,
        "exists": path.is_file(),
        "models": _models_from_env(env, spec),
    }


def build_config_sync_status(db: Session) -> dict[str, Any]:
    """分层漂移：model / mode；runtime_sync 的模型漂移以平台配置包为准（不因 .env 三槽误报）。"""
    from .agent_config import is_platform_model_configured
    from .capability_models import get_capability_models
    from .convergence_modes import check_mode_drift_for_agent, load_convergence_modes

    rows = list_agent_configs(db)
    global_path = _workspace() / Path(GLOBAL_ENV_FILE)
    global_env = _parse_env_file(global_path)
    global_models = {
        "planner": _first_val(global_env, GLOBAL_MODEL_KEYS["planner"]),
        "executor": _first_val(global_env, GLOBAL_MODEL_KEYS["executor"]),
        "base_url": _first_val(global_env, GLOBAL_MODEL_KEYS["base_url"]),
    }
    cap = get_capability_models(db)
    capability_configured = bool(cap.get("capability_configured"))
    mode_ssot = load_convergence_modes()

    agents_out: list[dict[str, Any]] = []
    drift_count = 0
    model_drift_count = 0
    mode_drift_count = 0
    runtime_count = 0
    for row in rows:
        name = row["agent_name"]
        platform = {
            "planner": row.get("model_planner") or "",
            "executor": row.get("model_executor") or "",
            "embedding": row.get("model_embedding") or "",
        }
        env_info = read_agent_env_models(name)
        env_models = env_info.get("models") or {}
        runtime_sync = name in RUNTIME_SYNC_AGENTS
        # runtime sync：模型听平台 pull；仅在平台已配置且本地.env 与三槽明显不一致时标 env 提示，不算总漂移
        file_model_drift = _has_drift(platform, env_models)
        if runtime_sync and capability_configured:
            model_drift = False
        elif runtime_sync and not capability_configured:
            model_drift = False
        else:
            model_drift = file_model_drift and is_platform_model_configured(row.get("updated_by"))
        mode_info = check_mode_drift_for_agent(name, mode_ssot)
        mode_drift = bool(mode_info.get("mode_drift"))
        any_drift = model_drift or mode_drift
        if any_drift:
            drift_count += 1
        if model_drift:
            model_drift_count += 1
        if mode_drift:
            mode_drift_count += 1
        if runtime_sync:
            runtime_count += 1
        agents_out.append(
            {
                "agent_name": name,
                "category": row.get("category"),
                "platform": platform,
                "env_file": env_info.get("env_file"),
                "env_exists": env_info.get("exists"),
                "env_models": env_models,
                "drift": any_drift,
                "model_drift": model_drift,
                "mode_drift": mode_drift,
                "mode_drift_keys": mode_info.get("mode_drift_keys") or [],
                "env_file_model_mismatch": file_model_drift,
                "local_drift": False,
                "runtime_sync": runtime_sync,
                "control_mode": "platform_db" if runtime_sync else "env_file_only",
            }
        )

    return {
        "ok": True,
        "source_of_truth": "capability_models + convergence-modes + agent_configs",
        "global_env_file": GLOBAL_ENV_FILE,
        "global_env_exists": global_path.is_file(),
        "global_models": global_models,
        "runtime_sync_agents": sorted(RUNTIME_SYNC_AGENTS),
        "capability_configured": capability_configured,
        "summary": {
            "total": len(agents_out),
            "drift_count": drift_count,
            "model_drift_count": model_drift_count,
            "mode_drift_count": mode_drift_count,
            "runtime_sync_count": runtime_count,
            "env_only_count": len(agents_out) - runtime_count,
        },
        "agents": agents_out,
        "recommendation": (
            "模型：能力层 SSOT → 保存并下发（runtime sync ~60s）；"
            "MODE：收敛 MODE 面板下发；集群基建：.env.agents-lan；密钥：系统设置 Vault。"
        ),
    }


def write_model_keys_to_env(agent_name: str, models: dict[str, str]) -> dict[str, Any]:
    """仅写模型相关键到 Agent .env（不碰 API Key）。"""
    spec = AGENT_ENV_SPECS.get(agent_name)
    if not spec:
        raise ValueError(f"未注册 env 映射: {agent_name}")
    rel = str(spec.get("env_file") or "")
    path = _workspace() / Path(rel)
    path.parent.mkdir(parents=True, exist_ok=True)

    existing = _parse_env_file(path) if path.is_file() else {}
    updates: dict[str, str] = {}
    if models.get("planner"):
        keys = spec.get("planner") or []
        if keys:
            updates[keys[0]] = models["planner"]
    if models.get("executor"):
        keys = spec.get("executor") or []
        if keys:
            updates[keys[0]] = models["executor"]
    if models.get("embedding"):
        keys = spec.get("embedding") or []
        if keys:
            updates[keys[0]] = models["embedding"]

    pending = dict(updates)
    lines: list[str] = []
    if path.is_file():
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = raw.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                lines.append(raw)
                continue
            key = stripped.split("=", 1)[0].strip()
            if key.lstrip("export ").strip() in pending:
                k = key.lstrip("export ").strip()
                lines.append(f"{key.split('=')[0].strip()}={pending.pop(k)}")
            else:
                lines.append(raw)
    else:
        lines.append(f"# synced from ClawHive platform — {agent_name}")
    for k, v in pending.items():
        lines.append(f"{k}={v}")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"agent_name": agent_name, "env_file": rel, "updated_keys": list(updates.keys())}


def write_capability_env_for_agent(agent_name: str, capability_models: dict[str, str]) -> dict[str, Any]:
    """按能力层映射写入 Agent .env 全部模型键（不碰 API Key）。"""
    from .capability_models import AGENT_CAPABILITY_ENV_BINDINGS, resolve_env_models_for_agent

    spec = AGENT_ENV_SPECS.get(agent_name)
    if not spec:
        raise ValueError(f"未注册 env 映射: {agent_name}")
    resolved = resolve_env_models_for_agent(agent_name, capability_models)
    resolved = {**resolved, **resolve_global_capability_env()}
    if not resolved:
        raise ValueError(f"无能力层 env 绑定: {agent_name}")

    rel = str(spec.get("env_file") or "")
    path = _workspace() / Path(rel)
    path.parent.mkdir(parents=True, exist_ok=True)

    pending = dict(resolved)
    lines: list[str] = []
    if path.is_file():
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = raw.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                lines.append(raw)
                continue
            key = stripped.split("=", 1)[0].strip().lstrip("export ").strip()
            if key in pending:
                lines.append(f"{key}={pending.pop(key)}")
            else:
                lines.append(raw)
    else:
        lines.append(f"# synced capability models from ClawHive — {agent_name}")
    for k, v in pending.items():
        lines.append(f"{k}={v}")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    bindings = AGENT_CAPABILITY_ENV_BINDINGS.get(agent_name) or {}
    return {
        "agent_name": agent_name,
        "env_file": rel,
        "updated_keys": list(resolved.keys()),
        "capability_bindings": len(bindings),
    }
