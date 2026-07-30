"""全集群能力层模型 SSOT：控制台修改 → agent_configs → internal API → 子 Agent runtime sync。"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .db_models import AgentConfigRecord, PlatformCapabilityRecord

# ── 能力层定义（与 ../docs/企业级能力层模型方案.md 一致）──

CAPABILITY_LAYERS: list[dict[str, str]] = [
    {"id": "route", "label": "T0 路由/轻推理", "env": "CAP_ROUTE", "description": "路由、NLU、condense、JSON 解析"},
    {"id": "reason", "label": "T1 标准推理", "env": "CAP_REASON", "description": "编排/路由决策、最终综合、RAG 作答"},
    {"id": "reason_max", "label": "T1+ 深度推理", "env": "CAP_REASON_MAX", "description": "编排/路由单层决策（可选 max，更准略慢）"},
    {"id": "coder", "label": "T2 代码/SQL", "env": "CAP_CODER", "description": "SQL 生成、Code Agent"},
    {"id": "vision", "label": "T3 视觉", "env": "CAP_VISION", "description": "识图、视频帧、通用截图理解"},
    {"id": "gui", "label": "T3-GUI 界面交互", "env": "CAP_GUI", "description": "GUI 专用（gui-plus；截图/坐标动作，勿当文本规划）"},
    {"id": "asr", "label": "T4 语音", "env": "CAP_ASR", "description": "语音转写"},
    {"id": "rerank", "label": "T5 重排", "env": "CAP_RERANK", "description": "RAG rerank（专用 API）"},
    {"id": "embedding", "label": "E0 向量", "env": "CAP_EMBEDDING", "description": "通用 Embedding（经验库/记忆）"},
    {"id": "embedding_rag", "label": "E0-RAG 向量", "env": "CAP_EMBEDDING_RAG", "description": "RAG 文档检索 Embedding"},
    {"id": "ocr", "label": "OCR", "env": "CAP_OCR", "description": "RAG 扫描件 OCR"},
    {"id": "vision_music", "label": "T3 音乐视觉", "env": "CAP_VISION_MUSIC", "description": "Music Agent VL"},
    {"id": "omni", "label": "T6 多模态", "env": "CAP_OMNI", "description": "Music/Video Omni"},
]

# SSOT 全局开关：同步为各 Agent 环境变量（非模型名）
GLOBAL_CAPABILITY_ENV_SYNC: dict[str, str] = {
    "CAP_ENABLE_THINKING": "QWEN_ENABLE_THINKING",
}

DEFAULT_CAPABILITY_MODELS: dict[str, str] = {
    "route": "qwen3.5-flash-2026-02-23",
    "reason": "qwen-plus-2025-09-11",
    "reason_max": "qwen-max-latest",
    "coder": "qwen3-coder-flash",
    "vision": "qwen-vl-plus",
    "gui": "gui-plus-2026-02-26",
    "asr": "qwen3-asr-flash-2025-09-08",
    "rerank": "gte-rerank-v2",
    "embedding": "text-embedding-v1",
    "embedding_rag": "text-embedding-v3",
    "ocr": "qwen-vl-ocr",
    "vision_music": "qwen3-vl-plus",
    "omni": "qwen3.5-omni-plus",
}

# agent_name → agent_configs 三槽映射（planner/executor/embedding）
AGENT_PROFILE_FROM_CAPABILITY: dict[str, dict[str, str]] = {
    "Manager_Agent": {"planner": "route", "executor": "reason", "embedding": ""},
    "DB_Agent": {"planner": "route", "executor": "coder", "embedding": "embedding"},
    "RAG_Agent": {"planner": "route", "executor": "reason", "embedding": "embedding_rag"},
    "code_assistent_Agent": {"planner": "route", "executor": "coder", "embedding": "embedding"},
    "Extractor_Agent": {"planner": "route", "executor": "route", "embedding": "embedding"},
    "AI_admin_Agent": {"planner": "route", "executor": "route", "embedding": ""},
    "Multimodal_Agent": {"planner": "route", "executor": "route", "embedding": ""},
    "Music_Agent": {"planner": "route", "executor": "route", "embedding": ""},
    "Video_Agent": {"planner": "route", "executor": "route", "embedding": ""},
    "AI_Agent": {"planner": "route", "executor": "reason", "embedding": ""},
    "Lobster_Agent": {"planner": "route", "executor": "route", "embedding": ""},
    "Tavern_Agent": {"planner": "route", "executor": "route", "embedding": ""},
}

# agent_name → 环境变量完整映射（能力层 id → env key）
AGENT_CAPABILITY_ENV_BINDINGS: dict[str, dict[str, str]] = {
    "Manager_Agent": {
        "OPENAI_MODEL": "route",
        "MANAGER_MODEL_ROUTE": "reason",
        "MANAGER_MODEL_ROUTE_MAX": "reason_max",
        # PLAN 对齐 sync-capability-models.AGENTS_LAN_DOCKER_MODEL_KEYS（route=T0 轻量规划）
        "MANAGER_MODEL_PLAN": "route",
        "MANAGER_MODEL_SYNTH": "reason",
        "MANAGER_MODEL_CRITIC": "route",
        "MANAGER_MODEL_LOW_COST": "route",
        "MANAGER_MODEL_CLEAN": "route",
        "MANAGER_MODEL_VISUALIZE": "route",
        "MANAGER_MODEL_REPORT": "route",
        "MANAGER_RAG_JUDGE_MODEL": "route",
        "OPENAI_EMBEDDING_MODEL": "embedding",
    },
    "DB_Agent": {
        "OPENAI_ORCHESTRATION_MODEL": "route",
        "OPENAI_NLU_MODEL": "route",
        "OPENAI_AGENT_MODEL": "coder",
        "EMBEDDING_MODEL": "embedding",
    },
    "RAG_Agent": {
        "CONDENSE_MODEL": "route",
        "QUERY_PLAN_MODEL": "route",
        "EXPANSION_MODEL": "route",
        "RAG_EVIDENCE_SELECT_MODEL": "route",
        "CHAT_MODEL": "reason",
        "RERANK_MODEL": "rerank",
        "RAG_CROSS_ENCODER_MODEL": "rerank",
        "EMBEDDING_MODEL": "embedding_rag",
        "OCR_MODEL": "ocr",
    },
    "code_assistent_Agent": {
        "OPENAI_MODEL": "coder",
        "OPENAI_EMBEDDING_MODEL": "embedding",
    },
    "Extractor_Agent": {
        "QWEN_MODEL": "route",
        "QWEN_VL_MODEL": "vision",
        "EXTRACTOR_EMBEDDING_MODEL": "embedding",
    },
    "AI_admin_Agent": {
        "MODEL_NAME": "route",
    },
    "Multimodal_Agent": {
        "QWEN_VL_MODEL": "vision",
        "QWEN_HELPER_MODEL": "route",
        "QWEN_ASR_MODEL": "asr",
        "QWEN_TEXT_MODEL": "route",
        "OPENAI_MODEL": "route",
    },
    "Music_Agent": {
        "OPENAI_MODEL": "route",
        "QWEN3_VL_MODEL": "vision_music",
        "QWEN_OMNI_MODEL": "omni",
    },
    "Video_Agent": {
        "OPENAI_MODEL": "route",
    },
    "AI_Agent": {
        "LLM_MODEL": "reason",
        "ASR_MODEL": "asr",
    },
    "Lobster_Agent": {
        "OPENAI_MODEL": "route",
        "LOBSTER_PLANNER_MODEL": "route",
        "LOBSTER_DECISION_MODEL": "route",
        "LOBSTER_STAGEHAND_MODEL": "route",
        "LOBSTER_VISION_MODEL": "gui",
        "LOBSTER_GUI_MODEL": "gui",
    },
    "Tavern_Agent": {
        "OPENAI_MODEL": "route",
    },
}

_PLATFORM_UNCONFIGURED = frozenset({"seed", "system", ""})


class CapabilityModelsUpdate(BaseModel):
    models: dict[str, str] = Field(default_factory=dict)
    sync_agent_configs: bool = True
    sync_env_files: bool = False


class CapabilityModelsApplyRequest(BaseModel):
    sync_env_files: bool = False


def list_capability_layers() -> list[dict[str, str]]:
    return list(CAPABILITY_LAYERS)


def _merge_defaults(raw: dict[str, Any] | None) -> dict[str, str]:
    out = dict(DEFAULT_CAPABILITY_MODELS)
    if isinstance(raw, dict):
        for k, v in raw.items():
            key = str(k or "").strip()
            val = str(v or "").strip()
            if key and val and key in out:
                out[key] = val
    return out


def is_capability_configured(updated_by: str | None) -> bool:
    return str(updated_by or "").strip() not in _PLATFORM_UNCONFIGURED


def get_capability_record(db: Session) -> PlatformCapabilityRecord | None:
    return db.query(PlatformCapabilityRecord).filter(PlatformCapabilityRecord.id == 1).first()


def seed_capability_models(db: Session) -> None:
    row = get_capability_record(db)
    if row:
        return
    db.add(
        PlatformCapabilityRecord(
            id=1,
            models_json=json.dumps(DEFAULT_CAPABILITY_MODELS, ensure_ascii=False),
            updated_by="seed",
        )
    )
    db.commit()


def get_capability_models(db: Session) -> dict[str, Any]:
    seed_capability_models(db)
    row = get_capability_record(db)
    raw: dict[str, Any] = {}
    if row:
        try:
            parsed = json.loads(row.models_json or "{}")
            if isinstance(parsed, dict):
                raw = parsed
        except json.JSONDecodeError:
            raw = {}
    models = _merge_defaults(raw)
    configured = bool(row and is_capability_configured(row.updated_by))
    return {
        "ok": True,
        "layers": list_capability_layers(),
        "models": models,
        "defaults": DEFAULT_CAPABILITY_MODELS,
        "capability_configured": configured,
        "updated_at": row.updated_at.isoformat() if row and row.updated_at else None,
        "updated_by": row.updated_by if row else "seed",
    }


def resolve_env_models_for_agent(agent_name: str, models: dict[str, str]) -> dict[str, str]:
    bindings = AGENT_CAPABILITY_ENV_BINDINGS.get(agent_name) or {}
    out: dict[str, str] = {}
    for env_key, cap_id in bindings.items():
        val = str(models.get(cap_id) or "").strip()
        if val:
            out[env_key] = val
    return out


def resolve_global_capability_env(ssot_env: dict[str, str] | None = None) -> dict[str, str]:
    """从 SSOT 解析 CAP_* 全局开关；缺省 CAP_ENABLE_THINKING=0（关闭 Qwen3 思考模式）。"""
    env = ssot_env or {}
    out: dict[str, str] = {}
    for cap_key, agent_key in GLOBAL_CAPABILITY_ENV_SYNC.items():
        default = "0" if cap_key == "CAP_ENABLE_THINKING" else ""
        val = str(env.get(cap_key) or default).strip()
        if val:
            out[agent_key] = val
    return out


def build_manager_models_from_capabilities(models: dict[str, str]) -> dict[str, str]:
    route = str(models.get("route") or "").strip()
    reason = str(models.get("reason") or "").strip()
    return {
        "model_route": route,
        "model_plan": route,
        "model_synth": reason or route,
        "model_critic": route,
        "model_verifier": reason or route,
        "model_low_cost": route,
    }


def propagate_capability_to_agent_configs(
    db: Session,
    models: dict[str, str],
    *,
    operator: str,
) -> list[str]:
    updated: list[str] = []
    rows = db.query(AgentConfigRecord).all()
    for row in rows:
        slots = AGENT_PROFILE_FROM_CAPABILITY.get(row.agent_name)
        if not slots:
            continue
        planner_id = str(slots.get("planner") or "").strip()
        executor_id = str(slots.get("executor") or "").strip()
        embedding_id = str(slots.get("embedding") or "").strip()
        row.model_planner = str(models.get(planner_id) or row.model_planner or "").strip()
        row.model_executor = str(models.get(executor_id) or row.model_executor or "").strip()
        if embedding_id:
            row.model_embedding = str(models.get(embedding_id) or row.model_embedding or "").strip()
        row.model_profile = "custom"
        row.updated_by = operator
        db.add(row)
        updated.append(row.agent_name)
    db.commit()
    return updated


def update_capability_models(
    db: Session,
    payload: CapabilityModelsUpdate,
    *,
    operator: str,
) -> dict[str, Any]:
    seed_capability_models(db)
    row = get_capability_record(db)
    if not row:
        raise ValueError("capability record missing")

    current = _merge_defaults(json.loads(row.models_json or "{}") if row.models_json else {})
    for k, v in (payload.models or {}).items():
        key = str(k or "").strip()
        val = str(v or "").strip()
        if key in DEFAULT_CAPABILITY_MODELS and val:
            current[key] = val

    row.models_json = json.dumps(current, ensure_ascii=False)
    row.updated_by = operator
    db.add(row)
    db.commit()

    synced_agents: list[str] = []
    env_synced: list[str] = []
    if payload.sync_agent_configs:
        synced_agents = propagate_capability_to_agent_configs(db, current, operator=operator)
    if payload.sync_env_files:
        from .agent_env_registry import write_capability_env_for_agent

        for name in synced_agents or list(AGENT_CAPABILITY_ENV_BINDINGS.keys()):
            try:
                write_capability_env_for_agent(name, current)
                env_synced.append(name)
            except ValueError:
                continue

    return {
        "ok": True,
        "models": current,
        "capability_configured": True,
        "synced_agents": synced_agents,
        "env_synced": env_synced,
        "updated_by": operator,
    }


def enrich_agent_row_with_capabilities(agent_row: dict[str, Any], models: dict[str, str], *, capability_configured: bool) -> dict[str, Any]:
    name = str(agent_row.get("agent_name") or agent_row.get("name") or "").strip()
    out = dict(agent_row)
    resolved = resolve_env_models_for_agent(name, models)
    out["resolved_env_models"] = resolved
    if capability_configured and resolved:
        out["env_model_source"] = "capability_layer"
    else:
        out["env_model_source"] = "agent_profile"
    return out
