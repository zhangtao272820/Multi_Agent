import asyncio
import hashlib
import json
import time
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest
from urllib.request import urlopen
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from jsonschema import ValidationError as JsonSchemaValidationError
from jsonschema import validate as jsonschema_validate
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session
import yaml

from .audit import write_audit
from .auth import (
    create_access_token,
    decode_access_token,
    get_current_user,
    hash_password,
    require_roles,
    verify_password,
)
from .config import get_settings
from .db import Base, SessionLocal, engine, get_db
from .db_models import (
    AgentRecord,
    AuditLogRecord,
    MonitorAlertRecord,
    SkillArtifactRecord,
    SkillInstallRecord,
    SkillPipelineJobRecord,
    SkillRolloutJobRecord,
    SkillRecord,
    SkillReviewRecord,
    SkillRunRecord,
    SkillScanReportRecord,
    SkillSignatureRecord,
    SkillSmokeTestRecord,
    TaskRecord,
    TenantRecord,
    UserRecord,
)
from .health_overview import build_health_overview
from .monitor_dashboard import build_monitor_dashboard
from .monitor_charts import build_monitor_charts_snapshot
from .agent_metrics_collector import start_agent_metrics_collector, stop_agent_metrics_collector
from .agent_config import (
    AgentConfigBulkUpdate,
    AgentConfigUpdate,
    ApplyModelProfileRequest,
    GlobalModelPreset,
    apply_global_model_preset,
    apply_model_profile,
    bulk_update_agent_configs,
    build_internal_agent_config,
    list_agent_configs,
    peek_config_package_meta,
    peek_config_version,
    seed_agent_configs,
    update_agent_config,
)
from .agent_runtime_status import build_agent_runtime_status
from .model_profiles import list_model_profiles
from .capability_models import (
    CapabilityModelsApplyRequest,
    CapabilityModelsUpdate,
    get_capability_models,
    propagate_capability_to_agent_configs,
    update_capability_models,
    seed_capability_models,
)
from .agent_env_registry import build_config_sync_status, write_capability_env_for_agent, write_model_keys_to_env
from .convergence_modes import (
    ConvergenceModesApplyRequest,
    ConvergenceModesUpdate,
    apply_convergence_modes,
    get_convergence_modes,
    update_and_apply_convergence_modes,
)
from .agents_lan_config import AgentsLanUpdate, get_agents_lan_config, update_agents_lan_config
from .agent_local_env_specs import LocalEnvUpdate, get_agent_local_env, update_agent_local_env
from .ops_jobs import get_deploy_status, list_backups, run_backup, run_recreate, run_restore, run_rollback
from .internal_agents import build_internal_agent_endpoints, verify_internal_token
from .manager_observability import build_manager_observability
from .trace_links import build_trace_link_payload, build_log_link_payload
from .manager_cluster import build_manager_cluster_status
from .manager_bridge import dispatch_manager_task_sync
from .platform_env import build_platform_env_snapshot
from .secret_vault import build_internal_secrets, list_secret_refs_public, rotate_secret_ref, seed_secret_refs
from .tenant_usage import (
    QuotaExceededError,
    assert_tenant_quota_available,
    ensure_default_tenant,
    get_tenant_usage_summary,
    list_tenants,
    refresh_tenant_quota_metrics,
    resolve_request_tenant_id,
    set_tenant_quota,
    upsert_tenant,
)
from .metrics import (
    api_requests_total,
    metrics_response,
    skill_catalog_install_total,
    skill_failure_total,
    skill_success_total,
    skill_duration_seconds,
    skill_cost_tokens_total,
    skill_external_api_cost_total,
    skill_errors_total,
    skill_invocations_total,
    skill_total_cost_total,
    update_skill_derived_metrics,
)
from .managed_agents import managed_agent_specs, seed_managed_agents
from .models import AgentRegistration, PlatformEvent, TaskRequest, TaskResult
from .process_control import (
    drain_agent_process,
    list_process_states,
    restart_agent_process,
    restart_manager_stack,
    rolling_restart_agent_process,
    start_agent_process,
    start_all_agent_processes,
    stop_agent_process,
    stop_all_agent_processes,
)
from .skill_engine import execute_skill_run
from .skill_registry import (
    download_package,
    get_registry_ref,
    get_registry_skill,
    infer_kind_from_path,
    list_registry_sources,
    parse_playbook_frontmatter,
    resolve_catalog_workspace_path,
    search_registry_skills,
)
from .skill_market_stats import build_skill_market_stats
from .skill_sync import list_effective_agent_skills, remove_synced_skill_from_agent, sync_skill_to_agent
from .task_queue import enqueue_task, worker_loop

settings = get_settings()
app = FastAPI(title="ClawHive Agent 管理平台", version="0.1.0")
_startup_ready = False

_STARTUP_GATE_ALLOW = frozenset(
    {
        "/health",
        "/health/ready",
        "/metrics",
        "/api/auth/login",
        "/api/auth/oidc/status",
        "/api/auth/oidc/login",
        "/api/auth/oidc/callback",
    }
)


@app.middleware("http")
async def startup_readiness_gate(request: Request, call_next):
    if not _startup_ready:
        path = request.url.path.rstrip("/") or "/"
        if path.startswith("/api/") and path not in _STARTUP_GATE_ALLOW:
            return JSONResponse(status_code=503, content={"detail": "服务启动中，请稍后重试"})
    return await call_next(request)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allow_origins,
    allow_origin_regex=settings.cors_allow_origin_regex or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConnectionManager:
    def __init__(self) -> None:
        self.clients: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.clients.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.clients:
            self.clients.remove(websocket)

    async def broadcast(self, event: PlatformEvent) -> None:
        message = event.model_dump(mode="json")
        stale_clients: list[WebSocket] = []
        for client in self.clients:
            try:
                await client.send_json(message)
            except RuntimeError:
                stale_clients.append(client)
        for client in stale_clients:
            self.disconnect(client)


ws_manager = ConnectionManager()
worker_task: asyncio.Task | None = None
pipeline_jobs: dict[str, asyncio.Task] = {}
rollout_jobs: dict[str, asyncio.Task] = {}


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    tenant_id: str = "default"


class UserCreateRequest(BaseModel):
    username: str
    password: str
    role: str = "viewer"
    tenant_id: str = "default"


class UserRoleUpdateRequest(BaseModel):
    role: str


class TenantCreateRequest(BaseModel):
    tenant_id: str
    name: str = ""
    status: str = "active"
    quota_tokens: int | None = None


class TenantUpdateRequest(BaseModel):
    name: str | None = None
    status: str | None = None
    quota_tokens: int | None = None
    clear_quota: bool = False


class SkillCreateRequest(BaseModel):
    skill_id: str
    name: str
    version: str = "0.1.0"
    description: str = ""
    runtime: str = "python3.11"
    entrypoint: str = ""
    tags: list[str] = []
    owner: str = "platform"


class SkillInstallRequest(BaseModel):
    skill_id: str
    version: str
    agent_id: str
    note: str = ""
    force_replace: bool = False


class SkillUninstallRequest(BaseModel):
    skill_id: str
    version: str
    agent_id: str
    note: str = ""


class SkillInvokeRequest(BaseModel):
    skill_id: str
    version: str
    agent_id: str = ""
    input_data: dict = {}
    context: dict = {}
    trace_id: str = ""


class SkillLifecycleRequest(BaseModel):
    version: str
    note: str = ""


class SkillPipelineStageRequest(BaseModel):
    version: str
    result: str = "passed"
    note: str = ""
    fingerprint: str = ""


class SkillPipelineJobRequest(BaseModel):
    version: str
    force_retry: bool = False


class SkillReleaseRequest(BaseModel):
    version: str
    note: str = ""


class SkillRolloutRequest(BaseModel):
    skill_id: str
    version: str
    strategy: str = "single-agent"
    target_agents: list[str] = []
    canary_percent: int = 10
    failure_rate_threshold: float = 0.2
    timeout_rate_threshold: float = 0.2
    cost_threshold: int = 50000
    total_cost_threshold: float = 10000.0
    force_replace: bool = False
    note: str = ""


class SkillCatalogInstallRequest(BaseModel):
    source: str = "registry"
    registry_id: str = "builtin"
    skill_id: str
    version: str = ""
    target_agents: list[str] = []
    force_replace: bool = True
    auto_publish: bool = False
    note: str = ""


class SkillSyncRequest(BaseModel):
    skill_id: str
    version: str
    agent_id: str


class SkillImportUrlRequest(BaseModel):
    package_url: str
    sha256: str = ""
    registry_id: str = ""
    auto_publish: bool = False


class SkillImportRegistryRequest(BaseModel):
    registry_id: str = "builtin"
    skill_id: str
    version: str = ""
    auto_publish: bool = False


SKILL_ALLOWED_STATUS_TRANSITIONS = {
    "draft": {"review"},
    "review": {"signed", "draft"},
    "signed": {"published"},
    "published": {"deprecated"},
    "deprecated": {"archived", "published"},
    "archived": set(),
}


def _transition_skill_status(
    *,
    db: Session,
    skill_id: str,
    version: str,
    target_status: str,
    current: UserRecord,
    action: str,
    note: str = "",
) -> dict:
    row = (
        db.query(SkillRecord)
        .filter(SkillRecord.skill_id == skill_id, SkillRecord.version == version)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="技能版本不存在")

    current_status = (row.status or "draft").strip() or "draft"
    if current_status == target_status:
        return {"ok": True, "skill_id": skill_id, "version": version, "status": row.status, "unchanged": True}

    allowed = SKILL_ALLOWED_STATUS_TRANSITIONS.get(current_status, set())
    if target_status not in allowed:
        raise HTTPException(
            status_code=409,
            detail=f"非法状态流转: {current_status} -> {target_status}",
        )

    row.status = target_status
    db.add(row)
    db.commit()
    write_audit(
        db,
        current,
        action,
        "skill",
        f"{skill_id}@{version}",
        f"{current_status}->{target_status};{(note or '').strip()[:120]}".strip(";"),
    )
    return {"ok": True, "skill_id": skill_id, "version": version, "status": row.status, "unchanged": False}


def _normalize_pipeline_result(value: str) -> str:
    v = (value or "").strip().lower()
    if v not in {"pending", "passed", "failed"}:
        raise HTTPException(status_code=400, detail="result 必须是 pending/passed/failed")
    return v


def _ensure_skill_exists(db: Session, skill_id: str, version: str) -> None:
    row = (
        db.query(SkillRecord)
        .filter(SkillRecord.skill_id == skill_id, SkillRecord.version == version)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="技能版本不存在")


def _latest_stage_result(db: Session, model, skill_id: str, version: str) -> dict:
    row = (
        db.query(model)
        .filter(model.skill_id == skill_id, model.version == version)
        .order_by(model.created_at.desc(), model.id.desc())
        .first()
    )
    if not row:
        return {"result": "pending", "updated_at": None, "note": ""}
    return {
        "result": row.result,
        "updated_at": row.created_at.isoformat() if row.created_at else None,
        "note": row.note or "",
    }


def _get_pipeline_status(db: Session, skill_id: str, version: str) -> dict:
    review = _latest_stage_result(db, SkillReviewRecord, skill_id, version)
    scan = _latest_stage_result(db, SkillScanReportRecord, skill_id, version)
    signature = _latest_stage_result(db, SkillSignatureRecord, skill_id, version)
    smoke = _latest_stage_result(db, SkillSmokeTestRecord, skill_id, version)
    publish_ready = all(stage["result"] == "passed" for stage in [review, scan, signature, smoke])
    return {
        "skill_id": skill_id,
        "version": version,
        "stages": {
            "review": review,
            "scan": scan,
            "signature": signature,
            "smoke_test": smoke,
        },
        "publish_ready": publish_ready,
    }


def _pipeline_job_to_dict(row: SkillPipelineJobRecord) -> dict:
    try:
        detail = json.loads(row.detail_json or "{}")
    except json.JSONDecodeError:
        detail = {"raw": row.detail_json}
    return {
        "job_id": row.job_id,
        "skill_id": row.skill_id,
        "version": row.version,
        "status": row.status,
        "started_by": row.started_by,
        "detail": detail,
        "error": row.error_text,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "finished_at": row.finished_at.isoformat() if row.finished_at else None,
    }


def _load_artifact_for_skill(db: Session, skill_id: str, version: str) -> SkillArtifactRecord:
    artifact = (
        db.query(SkillArtifactRecord)
        .filter(SkillArtifactRecord.skill_id == skill_id, SkillArtifactRecord.version == version)
        .order_by(SkillArtifactRecord.created_at.desc())
        .first()
    )
    if not artifact:
        raise HTTPException(status_code=400, detail="该技能版本缺少可执行 artifact（请先上传技能包）")
    return artifact


def _run_pipeline_checks(
    *,
    db: Session,
    skill_id: str,
    version: str,
    started_by: str,
) -> dict:
    artifact = _load_artifact_for_skill(db, skill_id, version)
    manifest = _load_manifest_from_artifact(artifact)
    stages: dict[str, dict] = {}

    try:
        _extract_manifest_fields(manifest, started_by)
        stages["review"] = {"result": "passed", "note": "manifest 结构检查通过"}
    except HTTPException as exc:
        stages["review"] = {"result": "failed", "note": str(exc.detail)}
        return {"stages": stages, "ok": False}
    db.add(
        SkillReviewRecord(
            skill_id=skill_id,
            version=version,
            result=stages["review"]["result"],
            reviewer=started_by,
            note=stages["review"]["note"],
        )
    )
    db.commit()

    input_ref, output_ref = _extract_schema_refs(manifest)
    try:
        if not input_ref or not output_ref:
            raise HTTPException(status_code=400, detail="manifest 缺少 inputSchema/outputSchema")
        _load_schema_from_artifact(artifact, input_ref)
        _load_schema_from_artifact(artifact, output_ref)
        stages["scan"] = {"result": "passed", "note": "schema 引用与解析检查通过"}
    except HTTPException as exc:
        stages["scan"] = {"result": "failed", "note": str(exc.detail)}
        db.add(
            SkillScanReportRecord(
                skill_id=skill_id,
                version=version,
                result=stages["scan"]["result"],
                scanner=started_by,
                note=stages["scan"]["note"],
            )
        )
        db.commit()
        return {"stages": stages, "ok": False}
    db.add(
        SkillScanReportRecord(
            skill_id=skill_id,
            version=version,
            result=stages["scan"]["result"],
            scanner=started_by,
            note=stages["scan"]["note"],
        )
    )
    db.commit()

    fp = hashlib.sha256(f"{skill_id}:{version}:{artifact.storage_path}".encode("utf-8")).hexdigest()[:32]
    stages["signature"] = {"result": "passed", "note": "签名生成成功", "fingerprint": fp}
    db.add(
        SkillSignatureRecord(
            skill_id=skill_id,
            version=version,
            result="passed",
            signer=started_by,
            note=stages["signature"]["note"],
            fingerprint=fp,
        )
    )
    db.commit()

    try:
        entry = _extract_manifest_fields(manifest, started_by).get("entrypoint", "")
        if not entry:
            raise HTTPException(status_code=400, detail="manifest 缺少 entrypoint")
        storage = Path(artifact.storage_path)
        if storage.suffix.lower() in (".yaml", ".yml"):
            entry_file = entry.split(":", 1)[0] if ":" in entry else entry
            if not (storage.parent / entry_file).exists():
                raise HTTPException(status_code=400, detail=f"entrypoint 文件不存在: {entry_file}")
        elif storage.suffix.lower() == ".zip":
            with zipfile.ZipFile(storage, "r") as zf:
                names = [n.replace("\\", "/").strip("/") for n in zf.namelist()]
                entry_file = entry.split(":", 1)[0].replace("\\", "/").strip("/")
                if not any(name.endswith(entry_file) for name in names):
                    raise HTTPException(status_code=400, detail=f"技能包缺少 entrypoint 文件: {entry_file}")
        stages["smoke_test"] = {"result": "passed", "note": "entrypoint 冒烟检查通过"}
    except HTTPException as exc:
        stages["smoke_test"] = {"result": "failed", "note": str(exc.detail)}
        db.add(
            SkillSmokeTestRecord(
                skill_id=skill_id,
                version=version,
                result=stages["smoke_test"]["result"],
                runner=started_by,
                note=stages["smoke_test"]["note"],
            )
        )
        db.commit()
        return {"stages": stages, "ok": False}

    db.add(
        SkillSmokeTestRecord(
            skill_id=skill_id,
            version=version,
            result=stages["smoke_test"]["result"],
            runner=started_by,
            note=stages["smoke_test"]["note"],
        )
    )
    db.commit()
    return {"stages": stages, "ok": True}


def _auto_promote_for_publish(
    *,
    db: Session,
    current: UserRecord,
    skill_id: str,
    version: str,
    note: str = "",
) -> dict:
    row = (
        db.query(SkillRecord)
        .filter(SkillRecord.skill_id == skill_id, SkillRecord.version == version)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="技能版本不存在")
    status = (row.status or "draft").strip() or "draft"
    transitions: list[str] = []

    if status == "draft":
        _transition_skill_status(
            db=db,
            skill_id=skill_id,
            version=version,
            target_status="review",
            current=current,
            action="skill.review",
            note=f"auto-release {note}".strip(),
        )
        transitions.append("draft->review")
        status = "review"

    if status == "review":
        _transition_skill_status(
            db=db,
            skill_id=skill_id,
            version=version,
            target_status="signed",
            current=current,
            action="skill.sign",
            note=f"auto-release {note}".strip(),
        )
        transitions.append("review->signed")
        status = "signed"

    if status == "signed":
        _transition_skill_status(
            db=db,
            skill_id=skill_id,
            version=version,
            target_status="published",
            current=current,
            action="skill.publish",
            note=f"auto-release {note}".strip(),
        )
        transitions.append("signed->published")
        status = "published"

    return {
        "skill_id": skill_id,
        "version": version,
        "status": status,
        "transitions": transitions,
    }


async def _execute_pipeline_job(job_id: str) -> None:
    db = SessionLocal()
    try:
        row = db.query(SkillPipelineJobRecord).filter(SkillPipelineJobRecord.job_id == job_id).first()
        if not row:
            return
        row.status = "running"
        row.started_at = datetime.utcnow()
        db.add(row)
        db.commit()
        db.refresh(row)

        result = _run_pipeline_checks(
            db=db,
            skill_id=row.skill_id,
            version=row.version,
            started_by=row.started_by,
        )
        row.detail_json = json.dumps(result, ensure_ascii=False)
        row.status = "success" if result.get("ok") else "failed"
        row.error_text = "" if result.get("ok") else "流水线阶段未全部通过"
        row.finished_at = datetime.utcnow()
        db.add(row)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        row = db.query(SkillPipelineJobRecord).filter(SkillPipelineJobRecord.job_id == job_id).first()
        if row:
            row.status = "failed"
            row.error_text = str(exc)
            row.finished_at = datetime.utcnow()
            db.add(row)
            db.commit()
    finally:
        pipeline_jobs.pop(job_id, None)
        db.close()


def _rollout_job_to_dict(row: SkillRolloutJobRecord) -> dict:
    try:
        targets = json.loads(row.target_agents_json or "[]")
    except json.JSONDecodeError:
        targets = []
    try:
        detail = json.loads(row.detail_json or "{}")
    except json.JSONDecodeError:
        detail = {"raw": row.detail_json}
    return {
        "job_id": row.job_id,
        "skill_id": row.skill_id,
        "version": row.version,
        "strategy": row.strategy,
        "status": row.status,
        "started_by": row.started_by,
        "target_agents": targets,
        "detail": detail,
        "error": row.error_text,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "finished_at": row.finished_at.isoformat() if row.finished_at else None,
    }


def _evaluate_rollout_health(
    db: Session,
    *,
    skill_id: str,
    version: str,
    agent_ids: list[str],
    failure_rate_threshold: float,
    timeout_rate_threshold: float,
    cost_threshold: int,
    total_cost_threshold: float,
) -> dict:
    rows = (
        db.query(SkillRunRecord)
        .filter(
            SkillRunRecord.skill_id == skill_id,
            SkillRunRecord.version == version,
            SkillRunRecord.agent_id.in_(agent_ids),
        )
        .order_by(SkillRunRecord.started_at.desc())
        .limit(200)
        .all()
    )
    total = len(rows)
    failed = len([r for r in rows if (r.status or "") != "success"])
    timeout_failed = len([r for r in rows if (r.error_code or "").upper().find("TIMEOUT") >= 0])
    total_cost = int(sum(int(r.cost_tokens or 0) for r in rows))
    total_cost_unified = float(sum(float(r.total_cost or 0.0) for r in rows))
    failure_rate = (failed / total) if total else 0.0
    timeout_rate = (timeout_failed / total) if total else 0.0
    breached = (
        failure_rate > failure_rate_threshold
        or timeout_rate > timeout_rate_threshold
        or total_cost > cost_threshold
        or total_cost_unified > total_cost_threshold
    )
    return {
        "sample_size": total,
        "failure_rate": failure_rate,
        "timeout_rate": timeout_rate,
        "total_cost_tokens": total_cost,
        "total_cost_unified": total_cost_unified,
        "thresholds": {
            "failure_rate": failure_rate_threshold,
            "timeout_rate": timeout_rate_threshold,
            "cost_tokens": cost_threshold,
            "total_cost": total_cost_threshold,
        },
        "breached": breached,
    }


def _rollback_agents_to_previous_version(
    db: Session,
    *,
    skill_id: str,
    current_version: str,
    agent_ids: list[str],
    operator: str,
) -> dict:
    restored: list[dict] = []
    for agent_id in agent_ids:
        installed_rows = (
            db.query(SkillInstallRecord)
            .filter(
                SkillInstallRecord.skill_id == skill_id,
                SkillInstallRecord.agent_id == agent_id,
                SkillInstallRecord.status == "installed",
                SkillInstallRecord.version == current_version,
            )
            .all()
        )
        for row in installed_rows:
            row.status = "rolled_back"
            row.note = f"{row.note}; auto_rollback" if row.note else "auto_rollback"
            db.add(row)
        prev = (
            db.query(SkillInstallRecord)
            .filter(
                SkillInstallRecord.skill_id == skill_id,
                SkillInstallRecord.agent_id == agent_id,
                SkillInstallRecord.version != current_version,
            )
            .order_by(SkillInstallRecord.created_at.desc())
            .first()
        )
        if prev:
            db.add(
                SkillInstallRecord(
                    skill_id=skill_id,
                    version=prev.version,
                    agent_id=agent_id,
                    agent_name=prev.agent_name,
                    status="installed",
                    installed_by=operator,
                    note=f"auto rollback restore {prev.version}",
                )
            )
            restored.append({"agent_id": agent_id, "restored_version": prev.version})
    db.commit()
    return {"restored": restored}


async def _execute_rollout_job(job_id: str) -> None:
    db = SessionLocal()
    try:
        row = db.query(SkillRolloutJobRecord).filter(SkillRolloutJobRecord.job_id == job_id).first()
        if not row:
            return
        row.status = "running"
        row.started_at = datetime.utcnow()
        db.add(row)
        db.commit()

        targets = json.loads(row.target_agents_json or "[]")
        if not targets:
            raise RuntimeError("target_agents 不能为空")

        if row.strategy == "canary":
            cfg = json.loads(row.detail_json or "{}")
            canary_percent = max(1, min(100, int(cfg.get("canary_percent", 10))))
            canary_count = max(1, int(len(targets) * (canary_percent / 100.0)))
            first_wave = targets[:canary_count]
            second_wave = targets[canary_count:]
            waves = [first_wave, second_wave]
        elif row.strategy == "batch":
            mid = max(1, len(targets) // 2)
            waves = [targets[:mid], targets[mid:]]
        else:
            waves = [targets[:1]]

        detail: dict = {"waves": [], "rolled_back": False}
        thresholds = json.loads(row.detail_json or "{}").get("thresholds", {})
        for wave in waves:
            if not wave:
                continue
            installs = []
            for agent_id in wave:
                install_payload = SkillInstallRequest(
                    skill_id=row.skill_id,
                    version=row.version,
                    agent_id=agent_id,
                    note=f"rollout:{row.strategy}",
                    force_replace=True,
                )
                result = _install_skill_core(db=db, payload=install_payload, operator=row.started_by)
                installs.append({"agent_id": agent_id, "result": result["message"]})
            health = _evaluate_rollout_health(
                db,
                skill_id=row.skill_id,
                version=row.version,
                agent_ids=wave,
                failure_rate_threshold=float(thresholds.get("failure_rate", 0.2)),
                timeout_rate_threshold=float(thresholds.get("timeout_rate", 0.2)),
                cost_threshold=int(thresholds.get("cost_tokens", 50000)),
                total_cost_threshold=float(thresholds.get("total_cost", 10000.0)),
            )
            detail["waves"].append({"agents": wave, "installs": installs, "health": health})
            if health["breached"]:
                rollback = _rollback_agents_to_previous_version(
                    db,
                    skill_id=row.skill_id,
                    current_version=row.version,
                    agent_ids=wave,
                    operator=row.started_by,
                )
                detail["rolled_back"] = True
                detail["rollback"] = rollback
                row.status = "rolled_back"
                row.error_text = "触发阈值，已自动回滚"
                row.detail_json = json.dumps(detail, ensure_ascii=False)
                row.finished_at = datetime.utcnow()
                db.add(row)
                db.commit()
                return

        row.status = "success"
        row.detail_json = json.dumps(detail, ensure_ascii=False)
        row.finished_at = datetime.utcnow()
        db.add(row)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        row = db.query(SkillRolloutJobRecord).filter(SkillRolloutJobRecord.job_id == job_id).first()
        if row:
            row.status = "failed"
            row.error_text = str(exc)
            row.finished_at = datetime.utcnow()
            db.add(row)
            db.commit()
    finally:
        rollout_jobs.pop(job_id, None)
        db.close()


class SkillRollbackRequest(BaseModel):
    skill_id: str
    to_version: str
    note: str = ""


class MonitorAlertCreateRequest(BaseModel):
    severity: str = "warning"
    source: str = "global"
    message: str
    fingerprint: str = ""


class TenantQuotaUpdateRequest(BaseModel):
    quota_tokens: int | None = None


def _skill_package_dir() -> Path:
    base_dir = Path(__file__).resolve().parent.parent
    target = base_dir / ".local" / "skill-packages"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _parse_skill_manifest_from_zip(zip_path: Path) -> tuple[dict, str]:
    with zipfile.ZipFile(zip_path, "r") as zf:
        manifest_name = None
        for candidate in zf.namelist():
            lower = candidate.lower()
            if lower.endswith("skill.yaml") or lower.endswith("skill.yml"):
                manifest_name = candidate
                break
        if not manifest_name:
            raise HTTPException(status_code=400, detail="技能包缺少 skill.yaml")

        manifest_text = zf.read(manifest_name).decode("utf-8")
        try:
            parsed = yaml.safe_load(manifest_text) or {}
        except yaml.YAMLError as exc:
            raise HTTPException(status_code=400, detail=f"skill.yaml 解析失败: {exc}") from exc
        if not isinstance(parsed, dict):
            raise HTTPException(status_code=400, detail="skill.yaml 顶层必须是对象")
        return parsed, manifest_text


def _extract_manifest_fields(manifest: dict, default_owner: str) -> dict:
    metadata = manifest.get("metadata", {}) if isinstance(manifest.get("metadata"), dict) else {}
    spec = manifest.get("spec", {}) if isinstance(manifest.get("spec"), dict) else {}
    skill_id = str(metadata.get("id") or "").strip()
    name = str(metadata.get("name") or "").strip()
    version = str(metadata.get("version") or "0.1.0").strip()
    description = str(metadata.get("description") or "").strip()
    tags = metadata.get("tags") or []
    runtime = str(spec.get("runtime") or "python3.11").strip()
    entrypoint = str(spec.get("entry") or "").strip()
    owner = str(metadata.get("owner") or default_owner).strip()
    if not skill_id or not name:
        raise HTTPException(status_code=400, detail="skill.yaml 缺少 metadata.id 或 metadata.name")
    return {
        "skill_id": skill_id,
        "name": name,
        "version": version,
        "description": description,
        "runtime": runtime,
        "entrypoint": entrypoint,
        "tags": tags if isinstance(tags, list) else [],
        "owner": owner,
    }


def _user_tenant_id(user: UserRecord) -> str:
    return str(getattr(user, "tenant_id", None) or "default").strip() or "default"


def _scope_skill_installs(q, user: UserRecord):
    if user.role == "admin":
        return q
    return q.filter(SkillInstallRecord.tenant_id == _user_tenant_id(user))


def _skill_install_to_dict(row: SkillInstallRecord) -> dict:
    return {
        "skill_id": row.skill_id,
        "version": row.version,
        "agent_id": row.agent_id,
        "agent_name": row.agent_name,
        "status": row.status,
        "installed_by": row.installed_by,
        "note": row.note,
        "sync_status": row.sync_status or "pending",
        "sync_path": row.sync_path or "",
        "sync_error": row.sync_error or "",
        "registry_id": row.registry_id or "",
        "kind": row.kind or "",
        "tenant_id": row.tenant_id or "default",
        "created_at": row.created_at.isoformat(),
        "last_synced_at": row.last_synced_at.isoformat() if row.last_synced_at else "",
    }


def _import_skill_from_workspace_path(
    db: Session,
    *,
    base_path: Path,
    operator: str,
    target_status: str = "draft",
    kind: str = "",
) -> dict:
    resolved_kind = (kind or infer_kind_from_path(base_path)).strip().lower()
    if resolved_kind == "playbook":
        skill_md = base_path / "skill.md"
        if not skill_md.is_file():
            raise HTTPException(status_code=400, detail=f"playbook 缺少 skill.md: {base_path}")
        fields = parse_playbook_frontmatter(skill_md)
        manifest_text = fields.pop("manifest_text", "")
        manifest_path = skill_md
    else:
        manifest_path = None
        for name in ("skill.yaml", "skill.yml"):
            candidate = base_path / name
            if candidate.is_file():
                manifest_path = candidate
                break
        if not manifest_path:
            raise HTTPException(status_code=400, detail=f"executable 缺少 skill.yaml: {base_path}")
        manifest_text = manifest_path.read_text(encoding="utf-8")
        manifest = yaml.safe_load(manifest_text) or {}
        if not isinstance(manifest, dict):
            raise HTTPException(status_code=400, detail="skill.yaml 顶层必须是对象")
        fields = _extract_manifest_fields(manifest, operator)
        fields["kind"] = "executable"

    skill_id = fields["skill_id"]
    version = fields["version"]
    exists = (
        db.query(SkillRecord)
        .filter(SkillRecord.skill_id == skill_id, SkillRecord.version == version)
        .first()
    )
    if exists:
        artifact = (
            db.query(SkillArtifactRecord)
            .filter(SkillArtifactRecord.skill_id == skill_id, SkillArtifactRecord.version == version)
            .first()
        )
        if target_status == "published" and exists.status != "published":
            exists.status = "published"
            db.add(exists)
            db.commit()
        return {
            "imported": False,
            "skill_id": skill_id,
            "version": version,
            "status": exists.status,
            "kind": resolved_kind,
            "artifact_id": artifact.id if artifact else None,
        }

    row = SkillRecord(
        skill_id=skill_id,
        name=fields["name"],
        version=version,
        description=fields["description"],
        runtime=fields.get("runtime", "python3.11"),
        entrypoint=fields.get("entrypoint", ""),
        status=target_status,
        tags=",".join(fields.get("tags") or []),
        owner=fields.get("owner") or operator,
    )
    db.add(row)
    db.flush()
    artifact = SkillArtifactRecord(
        skill_id=skill_id,
        version=version,
        filename=manifest_path.name if manifest_path else "skill.md",
        storage_path=str(manifest_path or base_path),
        uploaded_by=operator,
        manifest_text=manifest_text,
    )
    db.add(artifact)
    db.commit()
    return {
        "imported": True,
        "skill_id": skill_id,
        "version": version,
        "status": target_status,
        "kind": resolved_kind,
        "artifact_id": artifact.id,
    }


def _persist_skill_zip(
    db: Session,
    *,
    zip_path: Path,
    operator: str,
    filename: str,
    target_status: str = "draft",
) -> dict:
    manifest, manifest_text = _parse_skill_manifest_from_zip(zip_path)
    fields = _extract_manifest_fields(manifest, operator)
    skill_id = fields["skill_id"]
    version = fields["version"]

    exists = (
        db.query(SkillRecord)
        .filter(SkillRecord.skill_id == skill_id, SkillRecord.version == version)
        .first()
    )
    if exists:
        if target_status == "published" and exists.status != "published":
            exists.status = "published"
            db.add(exists)
            db.commit()
        artifact = (
            db.query(SkillArtifactRecord)
            .filter(SkillArtifactRecord.skill_id == skill_id, SkillArtifactRecord.version == version)
            .first()
        )
        return {
            "imported": False,
            "skill_id": skill_id,
            "version": version,
            "status": exists.status,
            "kind": "executable",
            "artifact_id": artifact.id if artifact else None,
        }

    row = SkillRecord(
        skill_id=skill_id,
        name=fields["name"],
        version=version,
        description=fields["description"],
        runtime=fields["runtime"],
        entrypoint=fields["entrypoint"],
        status=target_status,
        tags=",".join(fields.get("tags") or []),
        owner=fields.get("owner") or operator,
    )
    db.add(row)
    db.flush()
    artifact = SkillArtifactRecord(
        skill_id=skill_id,
        version=version,
        filename=filename,
        storage_path=str(zip_path),
        uploaded_by=operator,
        manifest_text=manifest_text,
    )
    db.add(artifact)
    db.commit()
    return {
        "imported": True,
        "skill_id": skill_id,
        "version": version,
        "status": target_status,
        "kind": "executable",
        "artifact_id": artifact.id,
    }


def _import_skill_from_package_url(
    db: Session,
    *,
    entry: dict,
    operator: str,
    auto_publish: bool,
    registry_id: str,
) -> dict:
    package_url = str(entry.get("package_url") or "").strip()
    if not package_url:
        raise HTTPException(status_code=400, detail="catalog 条目缺少 package_url")
    target_status = "published" if (auto_publish or entry.get("status") == "published") else "draft"
    try:
        zip_path, digest = download_package(
            package_url,
            expected_sha256=str(entry.get("sha256") or ""),
            registry_ref=get_registry_ref(registry_id),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"下载技能包失败: {exc}") from exc

    result = _persist_skill_zip(
        db,
        zip_path=zip_path,
        operator=operator,
        filename=zip_path.name,
        target_status=target_status,
    )
    result["sha256"] = digest
    result["package_url"] = package_url
    return result


def _ensure_catalog_skill_in_db(
    db: Session,
    *,
    entry: dict,
    operator: str,
    auto_publish: bool,
    registry_id: str = "builtin",
) -> dict:
    target_status = "published" if (auto_publish or entry.get("status") == "published") else "draft"
    workspace_rel = str(entry.get("workspace_path") or "").strip()
    if workspace_rel:
        try:
            workspace_path = resolve_catalog_workspace_path(entry)
            return _import_skill_from_workspace_path(
                db,
                base_path=workspace_path,
                operator=operator,
                target_status=target_status,
                kind=str(entry.get("kind") or ""),
            )
        except (ValueError, FileNotFoundError):
            pass

    package_url = str(entry.get("package_url") or "").strip()
    if package_url:
        return _import_skill_from_package_url(
            db,
            entry=entry,
            operator=operator,
            auto_publish=auto_publish,
            registry_id=registry_id,
        )

    raise HTTPException(status_code=400, detail="catalog 条目缺少有效的 workspace_path 或 package_url")


def _assert_skill_installable(db: Session, skill_id: str, version: str, *, auto_publish: bool) -> SkillRecord:
    skill = (
        db.query(SkillRecord)
        .filter(SkillRecord.skill_id == skill_id, SkillRecord.version == version)
        .first()
    )
    if not skill:
        raise HTTPException(status_code=404, detail="技能版本不存在")
    if settings.skill_install_require_published and not auto_publish and skill.status != "published":
        raise HTTPException(status_code=400, detail="仅 published 技能可赋能，请先发布或开启 auto_publish")
    return skill


def _assert_agent_compatible(entry: dict | None, agent_name: str) -> None:
    if not entry:
        return
    compat = entry.get("compatible_agents") or ["*"]
    if not isinstance(compat, list):
        compat = ["*"]
    if "*" in compat:
        return
    if agent_name not in compat:
        raise HTTPException(
            status_code=400,
            detail=f"技能不兼容 Agent {agent_name}，允许: {', '.join(compat)}",
        )


def _load_manifest_from_artifact(artifact: SkillArtifactRecord) -> dict:
    if artifact.manifest_text.strip():
        try:
            parsed = yaml.safe_load(artifact.manifest_text) or {}
        except yaml.YAMLError as exc:
            raise HTTPException(status_code=400, detail=f"技能 manifest 解析失败: {exc}") from exc
        if isinstance(parsed, dict):
            return parsed
    storage = Path(artifact.storage_path)
    if storage.suffix.lower() in (".yaml", ".yml") and storage.exists():
        try:
            parsed = yaml.safe_load(storage.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as exc:
            raise HTTPException(status_code=400, detail=f"技能 manifest 解析失败: {exc}") from exc
        if isinstance(parsed, dict):
            return parsed
    raise HTTPException(status_code=400, detail="技能 manifest 缺失或无效")


def _extract_schema_refs(manifest: dict) -> tuple[str, str]:
    spec = manifest.get("spec") if isinstance(manifest.get("spec"), dict) else {}
    io_cfg = spec.get("io") if isinstance(spec.get("io"), dict) else {}
    input_ref = str(io_cfg.get("inputSchema") or "").strip()
    output_ref = str(io_cfg.get("outputSchema") or "").strip()
    return input_ref, output_ref


def _load_schema_from_artifact(artifact: SkillArtifactRecord, schema_ref: str) -> dict | None:
    if not schema_ref:
        return None
    storage = Path(artifact.storage_path)
    # workspace import: storage path is usually skill.yaml path
    if storage.suffix.lower() in (".yaml", ".yml"):
        candidate = (storage.parent / schema_ref).resolve()
        if not candidate.exists():
            raise HTTPException(status_code=400, detail=f"技能 schema 文件不存在: {schema_ref}")
        try:
            parsed = json.loads(candidate.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"技能 schema 解析失败: {schema_ref}") from exc
        if not isinstance(parsed, dict):
            raise HTTPException(status_code=400, detail=f"技能 schema 顶层必须是对象: {schema_ref}")
        return parsed

    # uploaded zip artifact
    if storage.suffix.lower() == ".zip":
        if not storage.exists():
            raise HTTPException(status_code=400, detail=f"技能 artifact 不存在: {storage}")
        with zipfile.ZipFile(storage, "r") as zf:
            names = zf.namelist()
            norm_ref = schema_ref.replace("\\", "/").strip("/")
            matched = None
            if norm_ref in names:
                matched = norm_ref
            else:
                for name in names:
                    if name.replace("\\", "/").strip("/").endswith(norm_ref):
                        matched = name
                        break
            if not matched:
                raise HTTPException(status_code=400, detail=f"技能包缺少 schema: {schema_ref}")
            try:
                parsed = json.loads(zf.read(matched).decode("utf-8"))
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=400, detail=f"技能 schema 解析失败: {schema_ref}") from exc
            if not isinstance(parsed, dict):
                raise HTTPException(status_code=400, detail=f"技能 schema 顶层必须是对象: {schema_ref}")
            return parsed
    return None


def _validate_payload_against_schema(payload: dict, schema: dict, kind: str) -> None:
    try:
        jsonschema_validate(instance=payload, schema=schema)
    except JsonSchemaValidationError as exc:
        msg = f"SKILL_VALIDATION_ERROR: {kind} schema 校验失败: {exc.message}"
        raise HTTPException(status_code=422, detail={"code": "SKILL_VALIDATION_ERROR", "message": msg}) from exc


def _skill_run_to_dict(row: SkillRunRecord) -> dict:
    input_obj = json.loads(row.input_json or "{}")
    output_obj = {}
    if row.output_json:
        try:
            output_obj = json.loads(row.output_json)
        except json.JSONDecodeError:
            output_obj = {"raw": row.output_json}
    return {
        "run_id": row.run_id,
        "skill_id": row.skill_id,
        "version": row.version,
        "agent_id": row.agent_id,
        "agent_name": row.agent_name,
        "status": row.status,
        "trace_id": row.trace_id or row.run_id,
        "input_summary": row.input_summary,
        "output_summary": row.output_summary,
        "error_code": row.error_code,
        "cost_tokens": row.cost_tokens,
        "external_api_cost": float(row.external_api_cost or 0.0),
        "resource_cpu_ms": int(row.resource_cpu_ms or 0),
        "resource_mem_mb_ms": int(row.resource_mem_mb_ms or 0),
        "total_cost": float(row.total_cost or 0.0),
        "input": input_obj,
        "output": output_obj,
        "error": row.error_text,
        "logs": row.logs,
        "started_by": row.started_by,
        "started_at": row.started_at.isoformat(),
        "finished_at": row.finished_at.isoformat() if row.finished_at else None,
        "duration_ms": row.duration_ms,
    }


def _monitor_alert_to_dict(row) -> dict:
    return {
        "id": row.id,
        "severity": row.severity,
        "source": row.source,
        "message": row.message,
        "fingerprint": row.fingerprint,
        "acked": bool(row.acked),
        "notify_status": getattr(row, "notify_status", None) or "none",
        "notify_detail": getattr(row, "notify_detail", None) or "",
        "created_at": row.created_at.isoformat(),
        "acked_at": row.acked_at.isoformat() if row.acked_at else None,
    }


def _short_json_summary(value: dict, max_len: int = 240) -> str:
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= max_len else f"{text[:max_len]}..."


def _extract_error_code(error_text: str) -> str:
    if not error_text:
        return ""
    lines = [line.strip() for line in error_text.splitlines() if line.strip()]
    if not lines:
        return "UnknownError"
    last = lines[-1]
    if ":" in last:
        return last.split(":", 1)[0].strip() or "RuntimeError"
    return last[:64]


def _install_skill_core(
    *,
    db: Session,
    payload: SkillInstallRequest,
    operator: str,
    registry_id: str = "",
    kind: str = "",
    do_sync: bool = True,
    tenant_id: str = "default",
) -> dict:
    skill = (
        db.query(SkillRecord)
        .filter(SkillRecord.skill_id == payload.skill_id, SkillRecord.version == payload.version)
        .first()
    )
    if not skill:
        raise HTTPException(status_code=404, detail="技能版本不存在")

    agent = db.query(AgentRecord).filter(AgentRecord.agent_id == payload.agent_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="目标 Agent 不存在")

    conflict = (
        db.query(SkillInstallRecord)
        .filter(
            SkillInstallRecord.skill_id == payload.skill_id,
            SkillInstallRecord.agent_id == payload.agent_id,
            SkillInstallRecord.status == "installed",
            SkillInstallRecord.version != payload.version,
            SkillInstallRecord.tenant_id == tenant_id,
        )
        .all()
    )
    if conflict and not payload.force_replace:
        raise HTTPException(
            status_code=409,
            detail="目标 Agent 已安装该技能的其他版本，请使用 force_replace=true 或先卸载",
        )
    if conflict and payload.force_replace:
        for item in conflict:
            item.status = "replaced"
            item.note = f"{item.note}; replaced_by={payload.version}" if item.note else f"replaced_by={payload.version}"
            db.add(item)

    exists = (
        db.query(SkillInstallRecord)
        .filter(
            SkillInstallRecord.skill_id == payload.skill_id,
            SkillInstallRecord.version == payload.version,
            SkillInstallRecord.agent_id == payload.agent_id,
            SkillInstallRecord.status == "installed",
            SkillInstallRecord.tenant_id == tenant_id,
        )
        .first()
    )
    if exists:
        return {"ok": True, "message": "该技能已安装到目标 Agent", "agent_name": agent.name}

    install = SkillInstallRecord(
        skill_id=payload.skill_id,
        version=payload.version,
        agent_id=payload.agent_id,
        agent_name=agent.name,
        status="installed",
        installed_by=operator,
        note=payload.note,
        sync_status="pending",
        registry_id=registry_id,
        kind=kind,
        tenant_id=tenant_id,
    )
    db.add(install)
    db.commit()

    sync_result: dict = {}
    if do_sync and settings.skill_sync_on_install:
        sync_result = sync_skill_to_agent(
            db,
            skill_id=payload.skill_id,
            version=payload.version,
            agent_id=payload.agent_id,
            kind=kind,
        )
        if sync_result.get("sync_status") == "synced":
            msg = "安装并赋能成功"
        elif sync_result.get("sync_status") == "synced_pending_reload":
            msg = f"安装成功，文件已同步，待 Agent reload: {sync_result.get('sync_error', '')}"
        elif sync_result.get("sync_error"):
            msg = f"安装成功，同步异常: {sync_result.get('sync_error')}"
        else:
            msg = "安装成功"
    else:
        msg = "安装成功"

    return {
        "ok": True,
        "message": msg,
        "agent_name": agent.name,
        "sync": sync_result,
    }


def _ensure_skill_runs_schema() -> None:
    """
    Lightweight schema migration for `skill_runs`.
    This project currently relies on `create_all()` only; we add columns if missing.
    """

    try:
        inspector = inspect(engine)
        if "skill_runs" not in inspector.get_table_names():
            return
        cols = {col["name"] for col in inspector.get_columns("skill_runs")}
        with engine.begin() as conn:
            if "trace_id" not in cols:
                conn.execute(text("ALTER TABLE skill_runs ADD COLUMN trace_id VARCHAR(64) DEFAULT ''"))
            if "input_summary" not in cols:
                conn.execute(text("ALTER TABLE skill_runs ADD COLUMN input_summary VARCHAR(255) DEFAULT ''"))
            if "output_summary" not in cols:
                conn.execute(text("ALTER TABLE skill_runs ADD COLUMN output_summary VARCHAR(255) DEFAULT ''"))
            if "error_code" not in cols:
                conn.execute(text("ALTER TABLE skill_runs ADD COLUMN error_code VARCHAR(64) DEFAULT ''"))
            if "cost_tokens" not in cols:
                conn.execute(text("ALTER TABLE skill_runs ADD COLUMN cost_tokens INTEGER DEFAULT 0"))
            if "external_api_cost" not in cols:
                conn.execute(text("ALTER TABLE skill_runs ADD COLUMN external_api_cost FLOAT DEFAULT 0"))
            if "resource_cpu_ms" not in cols:
                conn.execute(text("ALTER TABLE skill_runs ADD COLUMN resource_cpu_ms INTEGER DEFAULT 0"))
            if "resource_mem_mb_ms" not in cols:
                conn.execute(text("ALTER TABLE skill_runs ADD COLUMN resource_mem_mb_ms INTEGER DEFAULT 0"))
            if "total_cost" not in cols:
                conn.execute(text("ALTER TABLE skill_runs ADD COLUMN total_cost FLOAT DEFAULT 0"))
    except Exception as exc:  # noqa: BLE001
        # If migration fails, better to crash early so schema mismatch is visible.
        raise RuntimeError(f"skill_runs schema migration failed: {exc}") from exc


def _ensure_enterprise_schema() -> None:
    """Lightweight migration for tenant / task audit / secret vault tables."""

    try:
        inspector = inspect(engine)
        table_names = set(inspector.get_table_names())

        def _add_column(table: str, column: str, ddl: str) -> None:
            if table not in table_names:
                return
            cols = {col["name"] for col in inspector.get_columns(table)}
            if column in cols:
                return
            with engine.begin() as conn:
                conn.execute(text(ddl))

        _add_column("users", "tenant_id", "ALTER TABLE users ADD COLUMN tenant_id VARCHAR(64) DEFAULT 'default'")
        _add_column("users", "auth_provider", "ALTER TABLE users ADD COLUMN auth_provider VARCHAR(32) DEFAULT 'local'")
        _add_column("tasks", "tenant_id", "ALTER TABLE tasks ADD COLUMN tenant_id VARCHAR(64) DEFAULT 'default'")
        _add_column("tasks", "created_by", "ALTER TABLE tasks ADD COLUMN created_by VARCHAR(64) DEFAULT ''")
        _add_column("tasks", "trace_id", "ALTER TABLE tasks ADD COLUMN trace_id VARCHAR(64) DEFAULT ''")
        _add_column("audit_logs", "tenant_id", "ALTER TABLE audit_logs ADD COLUMN tenant_id VARCHAR(64) DEFAULT 'default'")
        _add_column("agent_configs", "model_profile", "ALTER TABLE agent_configs ADD COLUMN model_profile VARCHAR(32) DEFAULT 'standard'")
        _add_column(
            "monitor_alerts",
            "notify_status",
            "ALTER TABLE monitor_alerts ADD COLUMN notify_status VARCHAR(32) DEFAULT 'none'",
        )
        _add_column(
            "monitor_alerts",
            "notify_detail",
            "ALTER TABLE monitor_alerts ADD COLUMN notify_detail TEXT DEFAULT ''",
        )
        _add_column(
            "secret_refs",
            "rotated_at",
            "ALTER TABLE secret_refs ADD COLUMN rotated_at TIMESTAMP NULL",
        )
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"enterprise schema migration failed: {exc}") from exc


def _ensure_skill_installs_schema() -> None:
    try:
        inspector = inspect(engine)
        if "skill_installs" not in inspector.get_table_names():
            return
        cols = {col["name"] for col in inspector.get_columns("skill_installs")}
        with engine.begin() as conn:
            if "sync_status" not in cols:
                conn.execute(text("ALTER TABLE skill_installs ADD COLUMN sync_status VARCHAR(32) DEFAULT 'pending'"))
            if "sync_path" not in cols:
                conn.execute(text("ALTER TABLE skill_installs ADD COLUMN sync_path TEXT DEFAULT ''"))
            if "sync_error" not in cols:
                conn.execute(text("ALTER TABLE skill_installs ADD COLUMN sync_error TEXT DEFAULT ''"))
            if "last_synced_at" not in cols:
                conn.execute(text("ALTER TABLE skill_installs ADD COLUMN last_synced_at TIMESTAMP NULL"))
            if "registry_id" not in cols:
                conn.execute(text("ALTER TABLE skill_installs ADD COLUMN registry_id VARCHAR(64) DEFAULT ''"))
            if "kind" not in cols:
                conn.execute(text("ALTER TABLE skill_installs ADD COLUMN kind VARCHAR(32) DEFAULT ''"))
            if "tenant_id" not in cols:
                conn.execute(text("ALTER TABLE skill_installs ADD COLUMN tenant_id VARCHAR(64) DEFAULT 'default'"))
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"skill_installs schema migration failed: {exc}") from exc


@app.on_event("startup")
async def startup_event():
    global worker_task, _startup_ready
    _startup_ready = False
    Base.metadata.create_all(bind=engine)
    _ensure_skill_runs_schema()
    _ensure_enterprise_schema()
    _ensure_skill_installs_schema()
    db = SessionLocal()
    try:
        ensure_default_tenant(db)
        user = db.query(UserRecord).filter(UserRecord.username == settings.admin_username).first()
        if not user:
            db.add(
                UserRecord(
                    username=settings.admin_username,
                    password_hash=hash_password(settings.admin_password),
                    role="admin",
                    tenant_id="default",
                    auth_provider="local",
                )
            )
            db.commit()
        else:
            dirty = False
            if not str(getattr(user, "tenant_id", "") or "").strip():
                user.tenant_id = "default"
                dirty = True
            if not str(getattr(user, "auth_provider", "") or "").strip():
                user.auth_provider = "local"
                dirty = True
            if dirty:
                db.add(user)
                db.commit()
    finally:
        db.close()
    db = SessionLocal()
    try:
        seed_managed_agents(db)
        seed_agent_configs(db)
        seed_capability_models(db)
        seed_secret_refs(db)
        refresh_tenant_quota_metrics(db)
    finally:
        db.close()
    worker_task = asyncio.create_task(worker_loop(ws_manager.broadcast))
    start_agent_metrics_collector()
    _startup_ready = True


@app.on_event("shutdown")
async def shutdown_event():
    global _startup_ready
    _startup_ready = False
    stop_agent_metrics_collector()
    if worker_task:
        worker_task.cancel()
    for task in list(pipeline_jobs.values()):
        task.cancel()
    pipeline_jobs.clear()
    for task in list(rollout_jobs.values()):
        task.cancel()
    rollout_jobs.clear()


@app.get("/health")
async def health() -> dict[str, str]:
    api_requests_total.labels(endpoint="/health", method="GET").inc()
    return {"status": "ok", "service": "clawhive-management-platform"}


@app.get("/health/ready")
async def health_ready() -> dict[str, object]:
    api_requests_total.labels(endpoint="/health/ready", method="GET").inc()
    if not _startup_ready:
        raise HTTPException(status_code=503, detail="服务启动中，请稍后重试")
    return {"ready": True, "service": "clawhive-management-platform"}


@app.get("/metrics")
async def metrics():
    return metrics_response()


def _prom_fetch_json(path: str, params: dict) -> dict:
    """拉取 Prometheus HTTP API（须用 UrlRequest，避免被 FastAPI Request 遮蔽）。"""
    base = settings.prometheus_base_url.rstrip("/")
    url = f"{base}{path}?{urlencode(params)}"
    req = UrlRequest(url, headers={"Accept": "application/json"})
    with urlopen(req, timeout=6) as resp:  # noqa: S310
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw)


@app.get("/api/metrics/prom/query")
async def prom_query(
    expr: str = Query(..., min_length=1),
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/metrics/prom/query", method="GET").inc()
    try:
        data = _prom_fetch_json("/api/v1/query", {"query": expr, "time": str(time.time())})
        return {"ok": True, "data": data}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"Prometheus 不可用: {exc}") from exc


@app.get("/api/metrics/prom/query_range")
async def prom_query_range(
    expr: str = Query(..., min_length=1),
    start: float = Query(...),
    end: float = Query(...),
    step: int = Query(default=10, ge=1, le=300),
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/metrics/prom/query_range", method="GET").inc()
    try:
        data = _prom_fetch_json(
            "/api/v1/query_range",
            {"query": expr, "start": str(start), "end": str(end), "step": str(step)},
        )
        return {"ok": True, "data": data}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"Prometheus 不可用: {exc}") from exc


@app.get("/api/monitor/alerts")
async def list_monitor_alerts(
    limit: int = Query(default=100, ge=1, le=500),
    acked: int | None = Query(default=None),
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/monitor/alerts", method="GET").inc()
    q = db.query(MonitorAlertRecord)
    if acked is not None:
        q = q.filter(MonitorAlertRecord.acked == (1 if acked else 0))
    rows = q.order_by(MonitorAlertRecord.created_at.desc()).limit(limit).all()
    return [_monitor_alert_to_dict(r) for r in rows]


@app.post("/api/monitor/alerts")
async def create_monitor_alert(
    payload: MonitorAlertCreateRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/monitor/alerts", method="POST").inc()
    fingerprint = payload.fingerprint.strip() or f"{payload.severity}:{payload.source}:{payload.message[:80]}"
    dedup = (
        db.query(MonitorAlertRecord)
        .filter(
            MonitorAlertRecord.fingerprint == fingerprint,
            MonitorAlertRecord.acked == 0,
        )
        .order_by(MonitorAlertRecord.created_at.desc())
        .first()
    )
    if dedup:
        return {"ok": True, "alert": _monitor_alert_to_dict(dedup), "deduped": True}
    row = MonitorAlertRecord(
        severity=(payload.severity or "warning").lower(),
        source=payload.source or "global",
        message=payload.message,
        fingerprint=fingerprint,
        acked=0,
        notify_status="none",
        notify_detail="",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    write_audit(db, current, "monitor.alert.create", "monitor_alert", str(row.id), row.message[:160])
    return {"ok": True, "alert": _monitor_alert_to_dict(row), "deduped": False}


@app.post("/api/monitor/alerts/{alert_id}/ack")
async def ack_monitor_alert(
    alert_id: int,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/monitor/alerts/{alert_id}/ack", method="POST").inc()
    row = db.query(MonitorAlertRecord).filter(MonitorAlertRecord.id == alert_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="告警不存在")
    row.acked = 1
    row.acked_at = datetime.utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    write_audit(db, current, "monitor.alert.ack", "monitor_alert", str(row.id), row.message[:120])
    return {"ok": True, "alert": _monitor_alert_to_dict(row)}


@app.post("/api/monitor/alertmanager/webhook")
async def alertmanager_webhook(
    request: Request,
    x_clawhive_internal_token: str | None = Header(default=None, alias="x-clawhive-internal-token"),
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    """Alertmanager webhook → 控制台告警，notify_status=delivered。"""
    token = (x_clawhive_internal_token or "").strip()
    if not token and authorization:
        auth = authorization.strip()
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
    q_token = (request.query_params.get("token") or "").strip()
    if not token and q_token:
        token = q_token
    verify_internal_token(token or None)
    api_requests_total.labels(endpoint="/api/monitor/alertmanager/webhook", method="POST").inc()
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"invalid json: {exc}") from exc
    alerts = body.get("alerts") if isinstance(body, dict) else None
    if not isinstance(alerts, list):
        alerts = [body] if isinstance(body, dict) else []
    created = 0
    for item in alerts:
        if not isinstance(item, dict):
            continue
        labels = item.get("labels") if isinstance(item.get("labels"), dict) else {}
        annotations = item.get("annotations") if isinstance(item.get("annotations"), dict) else {}
        status = str(item.get("status") or labels.get("alertstate") or "firing").lower()
        if status == "resolved":
            continue
        alertname = str(labels.get("alertname") or "Alertmanager")
        severity = str(labels.get("severity") or "warning").lower()
        summary = str(annotations.get("summary") or annotations.get("description") or alertname)
        fingerprint = str(item.get("fingerprint") or f"am:{alertname}:{summary[:80]}")
        dedup = (
            db.query(MonitorAlertRecord)
            .filter(
                MonitorAlertRecord.fingerprint == fingerprint,
                MonitorAlertRecord.acked == 0,
            )
            .order_by(MonitorAlertRecord.created_at.desc())
            .first()
        )
        if dedup:
            dedup.notify_status = "delivered"
            dedup.notify_detail = "platform webhook ok (Alertmanager → ClawHive)"
            db.add(dedup)
            continue
        row = MonitorAlertRecord(
            severity=severity,
            source=f"alertmanager:{alertname}",
            message=summary,
            fingerprint=fingerprint,
            acked=0,
            notify_status="delivered",
            notify_detail="platform webhook ok (Alertmanager → ClawHive)",
        )
        db.add(row)
        created += 1
    db.commit()
    return {"ok": True, "created": created}


@app.post("/api/monitor/alerts/ack-all")
async def ack_all_monitor_alerts(
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/monitor/alerts/ack-all", method="POST").inc()
    rows = db.query(MonitorAlertRecord).filter(MonitorAlertRecord.acked == 0).all()
    now = datetime.utcnow()
    for row in rows:
        row.acked = 1
        row.acked_at = now
        db.add(row)
    db.commit()
    write_audit(db, current, "monitor.alert.ack_all", "monitor_alert", "all", f"count={len(rows)}")
    return {"ok": True, "count": len(rows)}


@app.delete("/api/monitor/alerts")
async def clear_monitor_alerts(
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/monitor/alerts", method="DELETE").inc()
    count = db.query(MonitorAlertRecord).delete()
    db.commit()
    write_audit(db, current, "monitor.alert.clear", "monitor_alert", "all", f"count={count}")
    return {"ok": True, "count": count}


@app.get("/api/health/overview")
async def health_overview(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/health/overview", method="GET").inc()
    return build_health_overview()


@app.get("/api/manager/cluster-status")
async def manager_cluster_status(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/manager/cluster-status", method="GET").inc()
    return build_manager_cluster_status()


@app.get("/api/internal/secrets")
async def internal_secrets(
    x_clawhive_internal_token: str | None = Header(default=None, alias="x-clawhive-internal-token"),
    db: Session = Depends(get_db),
):
    verify_internal_token(x_clawhive_internal_token)
    return build_internal_secrets(db)


@app.get("/api/secrets/refs")
async def secrets_refs_public(
    _: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/secrets/refs", method="GET").inc()
    return {"ok": True, "refs": list_secret_refs_public(db)}


class SecretRotateRequest(BaseModel):
    new_value: str | None = None


@app.post("/api/secrets/{ref_id}/rotate")
async def secrets_rotate(
    ref_id: str,
    payload: SecretRotateRequest | None = None,
    current: UserRecord = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/secrets/{ref_id}/rotate", method="POST").inc()
    body = payload or SecretRotateRequest()
    try:
        result = rotate_secret_ref(
            db,
            ref_id,
            operator=current.username,
            new_value=body.new_value,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    write_audit(
        db,
        current,
        "secret.rotate",
        "secret_ref",
        ref_id,
        f"applied_env={result.get('applied_env')};configured={result.get('configured')}",
    )
    return result


@app.get("/api/tenants/usage")
async def tenants_usage(
    tenant_id: str | None = Query(default=None),
    current: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/tenants/usage", method="GET").inc()
    scoped = tenant_id
    if current.role != "admin":
        scoped = str(getattr(current, "tenant_id", None) or "default")
    refresh_tenant_quota_metrics(db)
    return {"ok": True, **get_tenant_usage_summary(db, scoped)}


@app.get("/api/tenants")
async def tenants_list(
    current: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/tenants", method="GET").inc()
    rows = list_tenants(db)
    if current.role != "admin":
        tid = str(getattr(current, "tenant_id", None) or "default")
        rows = [r for r in rows if r.get("tenant_id") == tid]
    return {"ok": True, "tenants": rows}


@app.post("/api/tenants")
async def tenants_create(
    payload: TenantCreateRequest,
    current: UserRecord = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/tenants", method="POST").inc()
    tid = str(payload.tenant_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="tenant_id required")
    existing = db.query(TenantRecord).filter(TenantRecord.tenant_id == tid).first()
    if existing:
        raise HTTPException(status_code=409, detail="tenant already exists")
    try:
        clear = payload.quota_tokens is None or int(payload.quota_tokens or 0) <= 0
        item = upsert_tenant(
            db,
            tenant_id=tid,
            name=payload.name or tid,
            status=payload.status or "active",
            quota_tokens=None if clear else int(payload.quota_tokens),
            clear_quota=clear,
            operator=current.username,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(db, current, "tenant.create", "tenant", tid, payload.name or tid)
    return {"ok": True, "tenant": item}


@app.put("/api/tenants/{tenant_id}")
async def tenants_update(
    tenant_id: str,
    payload: TenantUpdateRequest,
    current: UserRecord = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/tenants/{tenant_id}", method="PUT").inc()
    try:
        item = upsert_tenant(
            db,
            tenant_id=tenant_id,
            name=payload.name,
            status=payload.status,
            quota_tokens=payload.quota_tokens,
            clear_quota=bool(payload.clear_quota) or (
                payload.quota_tokens is not None and int(payload.quota_tokens) <= 0
            ),
            operator=current.username,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        current,
        "tenant.update",
        "tenant",
        tenant_id,
        f"status={payload.status};quota={payload.quota_tokens};clear={payload.clear_quota}",
    )
    return {"ok": True, "tenant": item}


@app.put("/api/tenants/{tenant_id}/quota")
async def tenants_set_quota(
    tenant_id: str,
    payload: TenantQuotaUpdateRequest,
    current: UserRecord = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/tenants/{tenant_id}/quota", method="PUT").inc()
    out = set_tenant_quota(
        db,
        tenant_id=tenant_id,
        quota_tokens=payload.quota_tokens,
        operator=current.username,
    )
    write_audit(
        db,
        current,
        "tenant.quota.set",
        "tenant",
        tenant_id,
        f"quota={payload.quota_tokens}",
    )
    return {"ok": True, **out}


@app.get("/api/monitor/prometheus/alerts")
async def prometheus_alerts_proxy(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    """代理 Prometheus  firing 告警（需 extended 栈启用 Prometheus）。"""
    api_requests_total.labels(endpoint="/api/monitor/prometheus/alerts", method="GET").inc()
    try:
        data = _prom_fetch_json("/api/v1/alerts", {})
        return {"ok": True, "data": data}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc), "data": None}


@app.get("/api/internal/agent-endpoints")
async def internal_agent_endpoints(
    x_clawhive_internal_token: str | None = Header(default=None, alias="x-clawhive-internal-token"),
):
    verify_internal_token(x_clawhive_internal_token)
    return build_internal_agent_endpoints()


@app.get("/api/internal/agent-config")
async def internal_agent_config(
    x_clawhive_internal_token: str | None = Header(default=None, alias="x-clawhive-internal-token"),
    db: Session = Depends(get_db),
):
    verify_internal_token(x_clawhive_internal_token)
    return build_internal_agent_config(db)


@app.get("/api/agents/config")
async def agents_config_list(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/config", method="GET").inc()
    return {"ok": True, "agents": list_agent_configs(db)}


@app.get("/api/agents/config/profiles")
async def agents_config_profiles(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/agents/config/profiles", method="GET").inc()
    return {"ok": True, "profiles": list_model_profiles()}


@app.post("/api/agents/config/apply-profile")
async def agents_config_apply_profile(
    payload: ApplyModelProfileRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/config/apply-profile", method="POST").inc()
    try:
        result = apply_model_profile(db, payload, operator=current.username)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        current,
        "agent_config.apply_profile",
        "agent_config",
        payload.profile_id,
        f"agents={len(result.get('updated_agents') or [])}",
    )
    return result


@app.get("/api/agents/config/sync-status")
async def agents_config_sync_status(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/config/sync-status", method="GET").inc()
    return build_config_sync_status(db)


@app.post("/api/agents/config/bulk")
async def agents_config_bulk(
    payload: AgentConfigBulkUpdate,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/config/bulk", method="POST").inc()
    result = bulk_update_agent_configs(db, payload, operator=current.username)
    write_audit(
        db,
        current,
        "agent_config.bulk",
        "agent_config",
        "bulk",
        f"count={result.get('updated_count')} env_sync={len(result.get('env_synced') or [])}",
    )
    return result


@app.post("/api/agents/config/global-preset")
async def agents_config_global_preset(
    payload: GlobalModelPreset,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/config/global-preset", method="POST").inc()
    result = apply_global_model_preset(db, payload, operator=current.username)
    write_audit(
        db,
        current,
        "agent_config.global_preset",
        "agent_config",
        "preset",
        f"{payload.model_planner}/{payload.model_executor}",
    )
    return result


@app.get("/api/agents/config/capability-models")
async def agents_capability_models_get(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/config/capability-models", method="GET").inc()
    return get_capability_models(db)


@app.put("/api/agents/config/capability-models")
async def agents_capability_models_update(
    payload: CapabilityModelsUpdate,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/config/capability-models", method="PUT").inc()
    try:
        result = update_capability_models(db, payload, operator=current.username)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        current,
        "capability_models.update",
        "capability_models",
        "cluster",
        f"sync_agents={len(result.get('synced_agents') or [])}",
    )
    return result


@app.post("/api/agents/config/capability-models/apply")
async def agents_capability_models_apply(
    payload: CapabilityModelsApplyRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    """将当前能力层模型重新下发到全部 agent_configs，可选同步 .env。"""
    api_requests_total.labels(endpoint="/api/agents/config/capability-models/apply", method="POST").inc()
    cap = get_capability_models(db)
    models = cap.get("models") or {}
    synced = propagate_capability_to_agent_configs(db, models, operator=current.username)
    env_synced: list[str] = []
    if payload.sync_env_files:
        for name in synced:
            try:
                write_capability_env_for_agent(name, models)
                env_synced.append(name)
            except ValueError:
                continue
    write_audit(db, current, "capability_models.apply", "capability_models", "cluster", f"agents={len(synced)}")
    return {"ok": True, "synced_agents": synced, "env_synced": env_synced, "models": models}


@app.get("/api/agents/config/convergence-modes")
async def agents_convergence_modes_get(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/agents/config/convergence-modes", method="GET").inc()
    return get_convergence_modes()


@app.put("/api/agents/config/convergence-modes")
async def agents_convergence_modes_update(
    payload: ConvergenceModesUpdate,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/config/convergence-modes", method="PUT").inc()
    try:
        result = update_and_apply_convergence_modes(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        current,
        "convergence_modes.update",
        "convergence_modes",
        "cluster",
        f"env_synced={len(result.get('env_synced') or [])}",
    )
    return result


@app.post("/api/agents/config/convergence-modes/apply")
async def agents_convergence_modes_apply(
    payload: ConvergenceModesApplyRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/config/convergence-modes/apply", method="POST").inc()
    try:
        result = apply_convergence_modes(sync_env_files=bool(payload.sync_env_files))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(db, current, "convergence_modes.apply", "convergence_modes", "cluster", "apply")
    return result


@app.get("/api/agents/config/agents-lan")
async def agents_lan_config_get(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/agents/config/agents-lan", method="GET").inc()
    return get_agents_lan_config()


@app.put("/api/agents/config/agents-lan")
async def agents_lan_config_update(
    payload: AgentsLanUpdate,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/config/agents-lan", method="PUT").inc()
    try:
        result = update_agents_lan_config(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(db, current, "agents_lan.update", "agents_lan", "cluster", "save")
    return result


@app.get("/api/agents/config/{agent_name}/local-env")
async def agents_local_env_get(
    agent_name: str,
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/agents/config/{agent_name}/local-env", method="GET").inc()
    try:
        return get_agent_local_env(agent_name)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.put("/api/agents/config/{agent_name}/local-env")
async def agents_local_env_update(
    agent_name: str,
    payload: LocalEnvUpdate,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/config/{agent_name}/local-env", method="PUT").inc()
    try:
        result = update_agent_local_env(agent_name, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(db, current, "agent_local_env.update", "agent_config", agent_name, "local-env")
    return result


class DeployRollbackRequest(BaseModel):
    image_tag: str = Field(..., min_length=1)


class DeployRecreateRequest(BaseModel):
    agent_names: list[str] | None = None
    services: list[str] | None = None
    build: bool = False


class BackupRestoreRequest(BaseModel):
    filename: str = Field(..., min_length=1)
    confirm: bool = False


@app.get("/api/ops/deploy/status")
async def ops_deploy_status(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/ops/deploy/status", method="GET").inc()
    status = get_deploy_status()
    status["health"] = build_health_overview()
    return status


@app.post("/api/ops/deploy/recreate")
async def ops_deploy_recreate(
    payload: DeployRecreateRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/ops/deploy/recreate", method="POST").inc()
    try:
        result = run_recreate(
            agent_names=payload.agent_names,
            services=payload.services,
            build=bool(payload.build),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(
        db,
        current,
        "ops.deploy.recreate",
        "deploy",
        ",".join(payload.agent_names or payload.services or [])[:120],
        str(result.get("ok")),
    )
    return result


@app.post("/api/ops/deploy/rollback")
async def ops_deploy_rollback(
    payload: DeployRollbackRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/ops/deploy/rollback", method="POST").inc()
    try:
        result = run_rollback(payload.image_tag)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    write_audit(db, current, "ops.deploy.rollback", "deploy", payload.image_tag, str(result.get("ok")))
    return result


@app.get("/api/ops/backup/list")
async def ops_backup_list(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/ops/backup/list", method="GET").inc()
    return list_backups()


@app.post("/api/ops/backup/postgres")
async def ops_backup_postgres(
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/ops/backup/postgres", method="POST").inc()
    try:
        result = run_backup()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    write_audit(db, current, "ops.backup.postgres", "backup", "postgres", str(result.get("ok")))
    return result


@app.post("/api/ops/backup/restore")
async def ops_backup_restore(
    payload: BackupRestoreRequest,
    current: UserRecord = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/ops/backup/restore", method="POST").inc()
    try:
        result = run_restore(payload.filename, confirm=bool(payload.confirm))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    write_audit(db, current, "ops.backup.restore", "backup", payload.filename, str(result.get("ok")))
    return result


@app.post("/api/agents/config/{agent_name}/sync-env")
async def agents_config_sync_env(
    agent_name: str,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/config/{agent_name}/sync-env", method="POST").inc()
    rows = list_agent_configs(db)
    row = next((r for r in rows if r["agent_name"] == agent_name), None)
    if not row:
        raise HTTPException(status_code=404, detail="未知 Agent")
    try:
        out = write_model_keys_to_env(
            agent_name,
            {
                "planner": row.get("model_planner") or "",
                "executor": row.get("model_executor") or "",
                "embedding": row.get("model_embedding") or "",
            },
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_audit(db, current, "agent_config.sync_env", "agent_config", agent_name, out.get("env_file") or "")
    return {"ok": True, **out}


@app.put("/api/agents/config/{agent_name}")
async def agents_config_update(
    agent_name: str,
    payload: AgentConfigUpdate,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/config/{agent_name}", method="PUT").inc()
    try:
        result = update_agent_config(db, agent_name, payload, operator=current.username)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    write_audit(
        db,
        current,
        "agent_config.update",
        "agent_config",
        agent_name,
        ";".join(result.get("changes") or [])[:500],
    )
    return {"ok": True, "agent": result}


@app.get("/api/platform/env-snapshot")
async def platform_env_snapshot(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/platform/env-snapshot", method="GET").inc()
    return build_platform_env_snapshot()


@app.get("/api/manager/observability")
async def manager_observability(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/manager/observability", method="GET").inc()
    return build_manager_observability()


@app.get("/api/observability/trace-link")
async def observability_trace_link(
    trace_id: str = "",
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/observability/trace-link", method="GET").inc()
    tid = str(trace_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="trace_id required")
    return build_trace_link_payload(tid)


@app.get("/api/observability/log-link")
async def observability_log_link(
    run_id: str = "",
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/observability/log-link", method="GET").inc()
    rid = str(run_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="run_id required")
    return build_log_link_payload(rid)


@app.get("/api/monitor/charts")
async def monitor_charts_snapshot(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/monitor/charts", method="GET").inc()
    return build_monitor_charts_snapshot()


@app.get("/api/monitor/dashboard")
async def monitor_dashboard(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/monitor/dashboard", method="GET").inc()
    return build_monitor_dashboard()


@app.get("/api/monitor/summary")
async def monitor_summary(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/monitor/summary", method="GET").inc()
    health = build_health_overview()
    cluster = build_manager_cluster_status()
    down = [c for c in health.get("checks", []) if c.get("status") != "healthy"]
    metrics_data = cluster.get("metrics", {}).get("data") if isinstance(cluster.get("metrics"), dict) else None
    phases = metrics_data.get("phases") if isinstance(metrics_data, dict) else {}
    token_summary = metrics_data.get("tokenSummary") if isinstance(metrics_data, dict) else None
    evolution = metrics_data.get("evolution") if isinstance(metrics_data, dict) else None
    return {
        "ok": True,
        "overall_status": health.get("overall_status"),
        "checked_at": health.get("checked_at"),
        "down_agents": [{"name": c.get("name"), "target": c.get("target")} for c in down],
        "manager_reachable": bool(cluster.get("ok")),
        "manager_error": cluster.get("error"),
        "manager_runs": metrics_data.get("runs") if isinstance(metrics_data, dict) else None,
        "manager_phases": phases,
        "manager_token_summary": token_summary,
        "manager_evolution": {
            "firstPassSuccessRate": evolution.get("firstPassSuccessRate") if isinstance(evolution, dict) else None,
            "nluSampleCount": evolution.get("nluSampleCount") if isinstance(evolution, dict) else None,
            "searchHitRate": evolution.get("searchHitRate") if isinstance(evolution, dict) else None,
        }
        if isinstance(evolution, dict)
        else None,
        "audit": {
            "total_tokens": (token_summary or {}).get("totalTokens") if isinstance(token_summary, dict) else None,
            "first_pass_success_rate": evolution.get("firstPassSuccessRate") if isinstance(evolution, dict) else None,
            "down_count": len(down),
        },
        "registry_count": len(
            (cluster.get("registry", {}) or {}).get("data", {}).get("registry", {}).get("entries", [])
            if isinstance(cluster.get("registry"), dict)
            else []
        ),
    }


@app.post("/api/manager/run")
async def manager_run_proxy(
    payload: dict,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/manager/run", method="POST").inc()
    task = str(payload.get("task") or payload.get("text") or "").strip()
    if not task:
        raise HTTPException(status_code=400, detail="task 不能为空")
    user_id = str(payload.get("user_id") or current.username or "").strip() or None
    tenant_id = resolve_request_tenant_id(current, payload.get("tenant_id"))
    session_id = str(payload.get("session_id") or "").strip() or None
    trace_id = str(payload.get("trace_id") or uuid4()).strip()
    try:
        assert_tenant_quota_available(db, tenant_id)
    except QuotaExceededError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    try:
        result = await asyncio.to_thread(
            dispatch_manager_task_sync, task, user_id, tenant_id, trace_id, session_id
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    write_audit(db, current, "manager.run", "manager", result.get("run_id") or "n/a", task[:120])
    return result


@app.post("/api/auth/login", response_model=LoginResponse)
async def login(payload: LoginRequest, db: Session = Depends(get_db)):
    api_requests_total.labels(endpoint="/api/auth/login", method="POST").inc()
    user = db.query(UserRecord).filter(UserRecord.username == payload.username).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    tid = str(getattr(user, "tenant_id", None) or "default").strip() or "default"
    token = create_access_token(user.username, user.role, tid)
    write_audit(db, user, "auth.login", "user", user.username, "用户登录成功")
    return LoginResponse(access_token=token, role=user.role, tenant_id=tid)


@app.get("/api/auth/oidc/status")
async def auth_oidc_status():
    api_requests_total.labels(endpoint="/api/auth/oidc/status", method="GET").inc()
    from .oidc import oidc_status_payload

    return {"ok": True, **oidc_status_payload()}


@app.get("/api/auth/oidc/login")
async def auth_oidc_login():
    api_requests_total.labels(endpoint="/api/auth/oidc/login", method="GET").inc()
    from fastapi.responses import RedirectResponse

    from .oidc import begin_oidc_login, oidc_is_configured

    if not oidc_is_configured():
        raise HTTPException(status_code=404, detail="OIDC not enabled")
    try:
        url = begin_oidc_login()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"OIDC login failed: {exc}") from exc
    return RedirectResponse(url=url, status_code=302)


@app.get("/api/auth/oidc/callback")
async def auth_oidc_callback(
    code: str = "",
    state: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/auth/oidc/callback", method="GET").inc()
    from fastapi.responses import RedirectResponse
    from urllib.parse import quote

    from .oidc import exchange_oidc_code, oidc_is_configured
    from .tenant_usage import ensure_tenant

    if not oidc_is_configured():
        raise HTTPException(status_code=404, detail="OIDC not enabled")
    frontend = str(settings.oidc_frontend_callback_url or "").rstrip("/") or "/"
    if error:
        return RedirectResponse(url=f"{frontend}?oidc_error={quote(error)}", status_code=302)
    if not code or not state:
        raise HTTPException(status_code=400, detail="code and state required")
    try:
        identity = exchange_oidc_code(code=code, state=state)
    except Exception as exc:  # noqa: BLE001
        return RedirectResponse(url=f"{frontend}?oidc_error={quote(str(exc))}", status_code=302)

    username = str(identity.get("username") or "").strip()
    role = str(identity.get("role") or "viewer").strip() or "viewer"
    if role not in ("viewer", "operator", "admin"):
        role = "viewer"
    tenant_id = str(identity.get("tenant_id") or "default").strip() or "default"
    ensure_tenant(db, tenant_id, name=tenant_id, operator="oidc")
    user = db.query(UserRecord).filter(UserRecord.username == username).first()
    if not user:
        user = UserRecord(
            username=username,
            password_hash=hash_password(f"oidc:{username}:{uuid4()}"),
            role=role,
            tenant_id=tenant_id,
            auth_provider="oidc",
        )
        db.add(user)
    else:
        user.role = role if user.auth_provider == "oidc" else user.role
        user.tenant_id = tenant_id
        user.auth_provider = "oidc"
        db.add(user)
    db.commit()
    db.refresh(user)
    token = create_access_token(user.username, user.role, user.tenant_id)
    write_audit(db, user, "auth.oidc.login", "user", user.username, "OIDC SSO login")
    return RedirectResponse(
        url=f"{frontend}?access_token={quote(token)}&role={quote(user.role)}&tenant_id={quote(user.tenant_id)}",
        status_code=302,
    )


@app.get("/api/auth/me")
async def me(user: UserRecord = Depends(get_current_user)):
    api_requests_total.labels(endpoint="/api/auth/me", method="GET").inc()
    return {
        "username": user.username,
        "role": user.role,
        "tenant_id": getattr(user, "tenant_id", "default") or "default",
        "auth_provider": getattr(user, "auth_provider", "local") or "local",
    }

@app.get("/api/users")
async def list_users(
    _: UserRecord = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/users", method="GET").inc()
    rows = db.query(UserRecord).order_by(UserRecord.created_at.desc()).all()
    return [
        {
            "username": u.username,
            "role": u.role,
            "tenant_id": getattr(u, "tenant_id", "default") or "default",
            "created_at": u.created_at.isoformat(),
        }
        for u in rows
    ]


@app.post("/api/users")
async def create_user(
    payload: UserCreateRequest,
    current: UserRecord = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/users", method="POST").inc()
    exists = db.query(UserRecord).filter(UserRecord.username == payload.username).first()
    if exists:
        raise HTTPException(status_code=409, detail="用户已存在")
    tid = str(getattr(payload, "tenant_id", None) or "default").strip() or "default"
    from .tenant_usage import ensure_tenant

    ensure_tenant(db, tid, name=tid, operator=current.username)
    row = UserRecord(
        username=payload.username,
        password_hash=hash_password(payload.password),
        role=payload.role,
        tenant_id=tid,
        auth_provider="local",
    )
    db.add(row)
    db.commit()
    write_audit(db, current, "user.create", "user", payload.username, f"role={payload.role};tenant={tid}")
    return {"username": row.username, "role": row.role, "tenant_id": row.tenant_id}


@app.patch("/api/users/{username}/role")
async def update_user_role(
    username: str,
    payload: UserRoleUpdateRequest,
    current: UserRecord = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/users/{username}/role", method="PATCH").inc()
    row = db.query(UserRecord).filter(UserRecord.username == username).first()
    if not row:
        raise HTTPException(status_code=404, detail="用户不存在")
    row.role = payload.role
    db.add(row)
    db.commit()
    write_audit(db, current, "user.update_role", "user", username, f"role={payload.role}")
    return {"username": row.username, "role": row.role}


@app.get("/api/audit-logs")
async def list_audit_logs(
    limit: int = Query(default=100, ge=1, le=500),
    action: str | None = Query(default=None),
    actor: str | None = Query(default=None),
    since: str | None = Query(default=None, description="ISO datetime"),
    until: str | None = Query(default=None, description="ISO datetime"),
    _: UserRecord = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/audit-logs", method="GET").inc()
    q = db.query(AuditLogRecord)
    if action:
        q = q.filter(AuditLogRecord.action.ilike(f"%{action.strip()}%"))
    if actor:
        q = q.filter(AuditLogRecord.username.ilike(f"%{actor.strip()}%"))
    if since:
        try:
            q = q.filter(AuditLogRecord.created_at >= datetime.fromisoformat(since.replace("Z", "")))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"invalid since: {exc}") from exc
    if until:
        try:
            q = q.filter(AuditLogRecord.created_at <= datetime.fromisoformat(until.replace("Z", "")))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"invalid until: {exc}") from exc
    rows = q.order_by(AuditLogRecord.created_at.desc()).limit(limit).all()
    return [
        {
            "id": r.id,
            "username": r.username,
            "action": r.action,
            "target_type": r.target_type,
            "target_id": r.target_id,
            "detail": r.detail,
            "tenant_id": getattr(r, "tenant_id", "default"),
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@app.get("/api/audit-logs/export")
async def export_audit_logs(
    format: str = Query(default="csv"),
    limit: int = Query(default=1000, ge=1, le=5000),
    action: str | None = Query(default=None),
    actor: str | None = Query(default=None),
    since: str | None = Query(default=None),
    until: str | None = Query(default=None),
    current: UserRecord = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/audit-logs/export", method="GET").inc()
    q = db.query(AuditLogRecord)
    if action:
        q = q.filter(AuditLogRecord.action.ilike(f"%{action.strip()}%"))
    if actor:
        q = q.filter(AuditLogRecord.username.ilike(f"%{actor.strip()}%"))
    if since:
        try:
            q = q.filter(AuditLogRecord.created_at >= datetime.fromisoformat(since.replace("Z", "")))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"invalid since: {exc}") from exc
    if until:
        try:
            q = q.filter(AuditLogRecord.created_at <= datetime.fromisoformat(until.replace("Z", "")))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"invalid until: {exc}") from exc
    rows_db = q.order_by(AuditLogRecord.created_at.desc()).limit(limit).all()
    rows = [
        {
            "id": r.id,
            "username": r.username,
            "action": r.action,
            "target_type": r.target_type,
            "target_id": r.target_id,
            "detail": r.detail,
            "tenant_id": getattr(r, "tenant_id", "default"),
            "created_at": r.created_at.isoformat(),
        }
        for r in rows_db
    ]
    write_audit(db, current, "audit.export", "audit_logs", format, f"count={len(rows)}")
    if format.lower() == "json":
        return JSONResponse(content={"ok": True, "items": rows})
    import csv
    import io

    from starlette.responses import Response

    buf = io.StringIO()
    writer = csv.DictWriter(
        buf,
        fieldnames=["id", "created_at", "username", "action", "target_type", "target_id", "tenant_id", "detail"],
        extrasaction="ignore",
    )
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return Response(
        content=buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="audit-logs.csv"'},
    )


@app.get("/api/skills")
async def list_skills(
    status: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    skill_id: str | None = Query(default=None),
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills", method="GET").inc()
    q = db.query(SkillRecord)
    if status:
        q = q.filter(SkillRecord.status == status)
    if skill_id:
        q = q.filter(SkillRecord.skill_id == skill_id)
    rows = q.order_by(SkillRecord.created_at.desc()).all()
    if tag:
        rows = [r for r in rows if tag in [x for x in (r.tags or "").split(",") if x]]
    return [
        {
            "skill_id": r.skill_id,
            "name": r.name,
            "version": r.version,
            "description": r.description,
            "runtime": r.runtime,
            "entrypoint": r.entrypoint,
            "status": r.status,
            "tags": [x for x in (r.tags or "").split(",") if x],
            "owner": r.owner,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@app.get("/api/skills/{skill_id}/versions")
async def get_skill_versions(
    skill_id: str,
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/{skill_id}/versions", method="GET").inc()
    rows = (
        db.query(SkillRecord)
        .filter(SkillRecord.skill_id == skill_id)
        .order_by(SkillRecord.created_at.desc())
        .all()
    )
    return [
        {
            "skill_id": r.skill_id,
            "name": r.name,
            "version": r.version,
            "status": r.status,
            "runtime": r.runtime,
            "entrypoint": r.entrypoint,
            "owner": r.owner,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@app.post("/api/skills")
async def create_skill(
    payload: SkillCreateRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills", method="POST").inc()
    exists = (
        db.query(SkillRecord)
        .filter(SkillRecord.skill_id == payload.skill_id, SkillRecord.version == payload.version)
        .first()
    )
    if exists:
        raise HTTPException(status_code=409, detail="该技能版本已存在")

    row = SkillRecord(
        skill_id=payload.skill_id,
        name=payload.name,
        version=payload.version,
        description=payload.description,
        runtime=payload.runtime,
        entrypoint=payload.entrypoint,
        status="draft",
        tags=",".join(payload.tags),
        owner=payload.owner or current.username,
    )
    db.add(row)
    db.commit()
    write_audit(
        db,
        current,
        "skill.create",
        "skill",
        f"{payload.skill_id}@{payload.version}",
        payload.description[:120],
    )
    return {"ok": True, "skill_id": row.skill_id, "version": row.version}


@app.post("/api/skills/{skill_id}/publish")
async def publish_skill_version(
    skill_id: str,
    payload: SkillLifecycleRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/{skill_id}/publish", method="POST").inc()
    pipeline = _get_pipeline_status(db, skill_id, payload.version)
    if not pipeline["publish_ready"]:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "SKILL_PIPELINE_NOT_READY",
                "message": "发布前必须完成 review/scan/signature/smoke_test 且全部 passed",
                "pipeline": pipeline,
            },
        )
    return _transition_skill_status(
        db=db,
        skill_id=skill_id,
        version=payload.version,
        target_status="published",
        current=current,
        action="skill.publish",
        note=payload.note,
    )


@app.post("/api/skills/{skill_id}/release")
async def release_skill_version(
    skill_id: str,
    payload: SkillReleaseRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/{skill_id}/release", method="POST").inc()
    _ensure_skill_exists(db, skill_id, payload.version)
    pipeline = _get_pipeline_status(db, skill_id, payload.version)
    if not pipeline["publish_ready"]:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "SKILL_PIPELINE_NOT_READY",
                "message": "一键发布失败：请先完成自动流水线并通过全部阶段",
                "pipeline": pipeline,
            },
        )
    result = _auto_promote_for_publish(
        db=db,
        current=current,
        skill_id=skill_id,
        version=payload.version,
        note=payload.note,
    )
    write_audit(
        db,
        current,
        "skill.release",
        "skill",
        f"{skill_id}@{payload.version}",
        f"transitions={','.join(result['transitions']) or 'none'}",
    )
    return {"ok": result["status"] == "published", "release": result, "pipeline": pipeline}


@app.get("/api/skills/{skill_id}/pipeline")
async def get_skill_pipeline(
    skill_id: str,
    version: str = Query(..., min_length=1),
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/{skill_id}/pipeline", method="GET").inc()
    _ensure_skill_exists(db, skill_id, version)
    return _get_pipeline_status(db, skill_id, version)


@app.get("/api/skills/{skill_id}/pipeline/jobs")
async def list_skill_pipeline_jobs(
    skill_id: str,
    version: str = Query(..., min_length=1),
    limit: int = Query(default=20, ge=1, le=100),
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/{skill_id}/pipeline/jobs", method="GET").inc()
    _ensure_skill_exists(db, skill_id, version)
    rows = (
        db.query(SkillPipelineJobRecord)
        .filter(SkillPipelineJobRecord.skill_id == skill_id, SkillPipelineJobRecord.version == version)
        .order_by(SkillPipelineJobRecord.created_at.desc())
        .limit(limit)
        .all()
    )
    return [_pipeline_job_to_dict(r) for r in rows]


@app.post("/api/skills/{skill_id}/pipeline/jobs")
async def create_skill_pipeline_job(
    skill_id: str,
    payload: SkillPipelineJobRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/{skill_id}/pipeline/jobs", method="POST").inc()
    _ensure_skill_exists(db, skill_id, payload.version)
    if not payload.force_retry:
        running = (
            db.query(SkillPipelineJobRecord)
            .filter(
                SkillPipelineJobRecord.skill_id == skill_id,
                SkillPipelineJobRecord.version == payload.version,
                SkillPipelineJobRecord.status.in_(["queued", "running"]),
            )
            .first()
        )
        if running:
            return {"ok": True, "job": _pipeline_job_to_dict(running), "deduped": True}
    row = SkillPipelineJobRecord(
        skill_id=skill_id,
        version=payload.version,
        status="queued",
        started_by=current.username,
        detail_json=json.dumps({"stages": {}, "ok": False}, ensure_ascii=False),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    task = asyncio.create_task(_execute_pipeline_job(row.job_id))
    pipeline_jobs[row.job_id] = task
    write_audit(
        db,
        current,
        "skill.pipeline.job.create",
        "skill_pipeline_job",
        row.job_id,
        f"{skill_id}@{payload.version}",
    )
    return {"ok": True, "job": _pipeline_job_to_dict(row), "deduped": False}


@app.get("/api/skills/pipeline/jobs/{job_id}")
async def get_skill_pipeline_job(
    job_id: str,
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/pipeline/jobs/{job_id}", method="GET").inc()
    row = db.query(SkillPipelineJobRecord).filter(SkillPipelineJobRecord.job_id == job_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="流水线任务不存在")
    return _pipeline_job_to_dict(row)


@app.post("/api/skills/pipeline/jobs/{job_id}/retry")
async def retry_skill_pipeline_job(
    job_id: str,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/pipeline/jobs/{job_id}/retry", method="POST").inc()
    row = db.query(SkillPipelineJobRecord).filter(SkillPipelineJobRecord.job_id == job_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="流水线任务不存在")
    payload = SkillPipelineJobRequest(version=row.version, force_retry=True)
    result = await create_skill_pipeline_job(
        skill_id=row.skill_id,
        payload=payload,
        current=current,
        db=db,
    )
    write_audit(
        db,
        current,
        "skill.pipeline.job.retry",
        "skill_pipeline_job",
        job_id,
        f"retry->{result['job']['job_id']}",
    )
    return result


@app.post("/api/skills/{skill_id}/pipeline/review")
async def upsert_skill_pipeline_review(
    skill_id: str,
    payload: SkillPipelineStageRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/{skill_id}/pipeline/review", method="POST").inc()
    _ensure_skill_exists(db, skill_id, payload.version)
    row = SkillReviewRecord(
        skill_id=skill_id,
        version=payload.version,
        result=_normalize_pipeline_result(payload.result),
        reviewer=current.username,
        note=(payload.note or "").strip(),
    )
    db.add(row)
    db.commit()
    write_audit(
        db,
        current,
        "skill.pipeline.review",
        "skill",
        f"{skill_id}@{payload.version}",
        f"result={row.result};note={row.note[:100]}",
    )
    return {"ok": True, "pipeline": _get_pipeline_status(db, skill_id, payload.version)}


@app.post("/api/skills/{skill_id}/pipeline/scan")
async def upsert_skill_pipeline_scan(
    skill_id: str,
    payload: SkillPipelineStageRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/{skill_id}/pipeline/scan", method="POST").inc()
    _ensure_skill_exists(db, skill_id, payload.version)
    row = SkillScanReportRecord(
        skill_id=skill_id,
        version=payload.version,
        result=_normalize_pipeline_result(payload.result),
        scanner=current.username,
        note=(payload.note or "").strip(),
    )
    db.add(row)
    db.commit()
    write_audit(
        db,
        current,
        "skill.pipeline.scan",
        "skill",
        f"{skill_id}@{payload.version}",
        f"result={row.result};note={row.note[:100]}",
    )
    return {"ok": True, "pipeline": _get_pipeline_status(db, skill_id, payload.version)}


@app.post("/api/skills/{skill_id}/pipeline/signature")
async def upsert_skill_pipeline_signature(
    skill_id: str,
    payload: SkillPipelineStageRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/{skill_id}/pipeline/signature", method="POST").inc()
    _ensure_skill_exists(db, skill_id, payload.version)
    row = SkillSignatureRecord(
        skill_id=skill_id,
        version=payload.version,
        result=_normalize_pipeline_result(payload.result),
        signer=current.username,
        note=(payload.note or "").strip(),
        fingerprint=(payload.fingerprint or "").strip(),
    )
    db.add(row)
    db.commit()
    write_audit(
        db,
        current,
        "skill.pipeline.signature",
        "skill",
        f"{skill_id}@{payload.version}",
        f"result={row.result};fingerprint={row.fingerprint[:40]}",
    )
    return {"ok": True, "pipeline": _get_pipeline_status(db, skill_id, payload.version)}


@app.post("/api/skills/{skill_id}/pipeline/smoke-test")
async def upsert_skill_pipeline_smoke_test(
    skill_id: str,
    payload: SkillPipelineStageRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/{skill_id}/pipeline/smoke-test", method="POST").inc()
    _ensure_skill_exists(db, skill_id, payload.version)
    row = SkillSmokeTestRecord(
        skill_id=skill_id,
        version=payload.version,
        result=_normalize_pipeline_result(payload.result),
        runner=current.username,
        note=(payload.note or "").strip(),
    )
    db.add(row)
    db.commit()
    write_audit(
        db,
        current,
        "skill.pipeline.smoke_test",
        "skill",
        f"{skill_id}@{payload.version}",
        f"result={row.result};note={row.note[:100]}",
    )
    return {"ok": True, "pipeline": _get_pipeline_status(db, skill_id, payload.version)}


@app.post("/api/skills/{skill_id}/review")
async def review_skill_version(
    skill_id: str,
    payload: SkillLifecycleRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/{skill_id}/review", method="POST").inc()
    return _transition_skill_status(
        db=db,
        skill_id=skill_id,
        version=payload.version,
        target_status="review",
        current=current,
        action="skill.review",
        note=payload.note,
    )


@app.post("/api/skills/{skill_id}/sign")
async def sign_skill_version(
    skill_id: str,
    payload: SkillLifecycleRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/{skill_id}/sign", method="POST").inc()
    return _transition_skill_status(
        db=db,
        skill_id=skill_id,
        version=payload.version,
        target_status="signed",
        current=current,
        action="skill.sign",
        note=payload.note,
    )


@app.post("/api/skills/{skill_id}/deprecate")
async def deprecate_skill_version(
    skill_id: str,
    payload: SkillLifecycleRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/{skill_id}/deprecate", method="POST").inc()
    return _transition_skill_status(
        db=db,
        skill_id=skill_id,
        version=payload.version,
        target_status="deprecated",
        current=current,
        action="skill.deprecate",
        note=payload.note,
    )


@app.post("/api/skills/upload")
async def upload_skill_package(
    package: UploadFile = File(...),
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/upload", method="POST").inc()
    filename = package.filename or "skill-package.zip"
    if not filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="仅支持 zip 技能包")

    package_dir = _skill_package_dir()
    stored_name = f"{uuid4()}-{filename}"
    stored_path = package_dir / stored_name
    content = await package.read()
    stored_path.write_bytes(content)

    exists_probe = _parse_skill_manifest_from_zip(stored_path)
    fields_probe = _extract_manifest_fields(exists_probe[0], current.username)
    exists = (
        db.query(SkillRecord)
        .filter(
            SkillRecord.skill_id == fields_probe["skill_id"],
            SkillRecord.version == fields_probe["version"],
        )
        .first()
    )
    if exists:
        raise HTTPException(status_code=409, detail="该技能版本已存在")

    result = _persist_skill_zip(
        db,
        zip_path=stored_path,
        operator=current.username,
        filename=filename,
        target_status="draft",
    )
    skill_id = result["skill_id"]
    version = result["version"]
    manifest, _ = _parse_skill_manifest_from_zip(stored_path)

    write_audit(
        db,
        current,
        "skill.upload",
        "skill",
        f"{skill_id}@{version}",
        f"filename={filename}",
    )
    await ws_manager.broadcast(
        PlatformEvent(
            event_type="skill.uploaded",
            payload={"skill_id": skill_id, "version": version, "filename": filename},
        )
    )
    return {
        "ok": True,
        "skill_id": skill_id,
        "version": version,
        "filename": filename,
        "manifest": json.loads(json.dumps(manifest)),
    }


@app.post("/api/skills/import/workspace")
async def import_skills_from_workspace(
    root: str | None = Query(default=None),
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/import/workspace", method="POST").inc()
    scan_root = Path(root or settings.workspace_root)
    if not scan_root.exists() or not scan_root.is_dir():
        raise HTTPException(status_code=400, detail=f"扫描目录不存在: {scan_root}")

    imported: list[dict] = []
    skipped: list[dict] = []
    candidates = list(scan_root.rglob("skill.yaml")) + list(scan_root.rglob("skill.yml"))
    for manifest_path in candidates:
        try:
            manifest_text = manifest_path.read_text(encoding="utf-8")
            manifest = yaml.safe_load(manifest_text) or {}
            if not isinstance(manifest, dict):
                skipped.append({"path": str(manifest_path), "reason": "manifest_not_object"})
                continue
            fields = _extract_manifest_fields(manifest, current.username)
            exists = (
                db.query(SkillRecord)
                .filter(
                    SkillRecord.skill_id == fields["skill_id"],
                    SkillRecord.version == fields["version"],
                )
                .first()
            )
            if exists:
                skipped.append(
                    {
                        "path": str(manifest_path),
                        "skill_id": fields["skill_id"],
                        "version": fields["version"],
                        "reason": "already_exists",
                    }
                )
                continue

            db.add(
                SkillRecord(
                    skill_id=fields["skill_id"],
                    name=fields["name"],
                    version=fields["version"],
                    description=fields["description"],
                    runtime=fields["runtime"],
                    entrypoint=fields["entrypoint"],
                    status="draft",
                    tags=",".join(fields["tags"]),
                    owner=fields["owner"],
                )
            )
            db.add(
                SkillArtifactRecord(
                    skill_id=fields["skill_id"],
                    version=fields["version"],
                    filename=manifest_path.name,
                    storage_path=str(manifest_path),
                    uploaded_by=current.username,
                    manifest_text=manifest_text,
                )
            )
            imported.append(
                {
                    "path": str(manifest_path),
                    "skill_id": fields["skill_id"],
                    "version": fields["version"],
                }
            )
        except HTTPException as exc:
            skipped.append({"path": str(manifest_path), "reason": exc.detail})
        except Exception as exc:  # noqa: BLE001
            skipped.append({"path": str(manifest_path), "reason": str(exc)})

    db.commit()
    write_audit(
        db,
        current,
        "skill.import_workspace",
        "workspace",
        str(scan_root),
        f"imported={len(imported)};skipped={len(skipped)}",
    )
    await ws_manager.broadcast(
        PlatformEvent(
            event_type="skill.imported.workspace",
            payload={
                "root": str(scan_root),
                "imported_count": len(imported),
                "skipped_count": len(skipped),
            },
        )
    )
    return {
        "ok": True,
        "root": str(scan_root),
        "imported_count": len(imported),
        "skipped_count": len(skipped),
        "imported": imported[:100],
        "skipped": skipped[:100],
    }


@app.post("/api/skills/import/url")
async def import_skill_from_url(
    payload: SkillImportUrlRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/import/url", method="POST").inc()
    registry_ref = get_registry_ref(payload.registry_id) if payload.registry_id else ""
    target_status = "published" if payload.auto_publish else "draft"
    try:
        zip_path, digest = download_package(
            payload.package_url,
            expected_sha256=payload.sha256,
            registry_ref=registry_ref,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"下载技能包失败: {exc}") from exc

    result = _persist_skill_zip(
        db,
        zip_path=zip_path,
        operator=current.username,
        filename=zip_path.name,
        target_status=target_status,
    )
    write_audit(
        db,
        current,
        "skill.registry.import",
        "skill",
        f"{result['skill_id']}@{result['version']}",
        f"url={payload.package_url};sha256={digest}",
    )
    return {"ok": True, "sha256": digest, **result}


@app.post("/api/skills/import/registry")
async def import_skill_from_registry(
    payload: SkillImportRegistryRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/import/registry", method="POST").inc()
    entry = get_registry_skill(
        registry_id=payload.registry_id,
        skill_id=payload.skill_id,
        version=payload.version or None,
    )
    if not entry:
        raise HTTPException(status_code=404, detail="Registry 中未找到该技能")
    result = _ensure_catalog_skill_in_db(
        db,
        entry=entry,
        operator=current.username,
        auto_publish=payload.auto_publish or entry.get("status") == "published",
        registry_id=payload.registry_id,
    )
    write_audit(
        db,
        current,
        "skill.registry.import",
        "skill",
        f"{result['skill_id']}@{result['version']}",
        f"registry={payload.registry_id}",
    )
    return {"ok": True, "registry_id": payload.registry_id, **result}


@app.get("/api/skills/market/stats")
async def get_skill_market_stats(
    current: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/market/stats", method="GET").inc()
    tenant = "*" if current.role == "admin" else _user_tenant_id(current)
    return {"ok": True, **build_skill_market_stats(db, tenant_id=tenant)}


@app.get("/api/skills/registry/sources")
async def get_skill_registry_sources(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/skills/registry/sources", method="GET").inc()
    return {"ok": True, "sources": list_registry_sources()}


@app.get("/api/skills/registry/search")
async def search_skill_registry(
    registry_id: str = Query(default="builtin"),
    q: str = Query(default=""),
    tag: str = Query(default=""),
    kind: str = Query(default=""),
    agent: str = Query(default=""),
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/registry/search", method="GET").inc()
    local_rows = db.query(SkillRecord).all()
    local_index = {f"{r.skill_id}@{r.version}": r.status for r in local_rows}
    items = search_registry_skills(
        registry_id=registry_id,
        q=q,
        tag=tag,
        kind=kind,
        agent=agent,
        local_index=local_index,
    )
    return {"ok": True, "registry_id": registry_id, "count": len(items), "items": items}


@app.get("/api/skills/registry/{registry_id}/skills/{skill_id}")
async def get_registry_skill_detail(
    registry_id: str,
    skill_id: str,
    version: str | None = Query(default=None),
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/registry/{registry_id}/skills/{skill_id}", method="GET").inc()
    entry = get_registry_skill(registry_id=registry_id, skill_id=skill_id, version=version)
    if not entry:
        raise HTTPException(status_code=404, detail="Registry 中未找到该技能")
    local = (
        db.query(SkillRecord)
        .filter(
            SkillRecord.skill_id == skill_id,
            SkillRecord.version == (version or entry.get("latest") or entry.get("version")),
        )
        .first()
    )
    entry["local_status"] = local.status if local else ""
    entry["local_installed"] = bool(local)
    return {"ok": True, "skill": entry}


@app.post("/api/skills/catalog/install")
async def catalog_install_skill(
    payload: SkillCatalogInstallRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/catalog/install", method="POST").inc()
    if not payload.target_agents:
        raise HTTPException(status_code=400, detail="target_agents 不能为空")

    entry: dict | None = None
    version = (payload.version or "").strip()
    kind = ""

    if payload.source == "local":
        skill = (
            db.query(SkillRecord)
            .filter(SkillRecord.skill_id == payload.skill_id)
            .order_by(SkillRecord.created_at.desc())
            .first()
        )
        if not skill:
            raise HTTPException(status_code=404, detail="本地技能不存在")
        version = version or skill.version
    else:
        entry = get_registry_skill(
            registry_id=payload.registry_id,
            skill_id=payload.skill_id,
            version=version or None,
        )
        if not entry:
            raise HTTPException(status_code=404, detail="Registry 中未找到该技能")
        version = version or entry.get("version") or entry.get("latest")
        kind = str(entry.get("kind") or "")
        import_result = _ensure_catalog_skill_in_db(
            db,
            entry=entry,
            operator=current.username,
            auto_publish=payload.auto_publish or entry.get("status") == "published",
            registry_id=payload.registry_id,
        )
        kind = kind or str(import_result.get("kind") or "")

    _assert_skill_installable(
        db,
        payload.skill_id,
        version,
        auto_publish=payload.auto_publish or (entry or {}).get("status") == "published",
    )

    installs: list[dict] = []
    tenant_id = _user_tenant_id(current)
    for agent_id in payload.target_agents:
        agent = db.query(AgentRecord).filter(AgentRecord.agent_id == agent_id).first()
        if not agent:
            installs.append({"agent_id": agent_id, "ok": False, "error": "Agent 不存在"})
            skill_catalog_install_total.labels(
                registry_id=payload.registry_id or "local",
                result="failed",
            ).inc()
            continue
        _assert_agent_compatible(entry, agent.name or "")
        try:
            result = _install_skill_core(
                db=db,
                payload=SkillInstallRequest(
                    skill_id=payload.skill_id,
                    version=version,
                    agent_id=agent_id,
                    note=payload.note,
                    force_replace=payload.force_replace,
                ),
                operator=current.username,
                registry_id=payload.registry_id if payload.source != "local" else "local",
                kind=kind,
                do_sync=True,
                tenant_id=tenant_id,
            )
            installs.append({"agent_id": agent_id, "agent_name": agent.name, "ok": True, **result})
            skill_catalog_install_total.labels(
                registry_id=payload.registry_id or "local",
                result="success",
            ).inc()
        except HTTPException as exc:
            installs.append({"agent_id": agent_id, "agent_name": agent.name, "ok": False, "error": exc.detail})
            skill_catalog_install_total.labels(
                registry_id=payload.registry_id or "local",
                result="failed",
            ).inc()
        except Exception as exc:  # noqa: BLE001
            installs.append({"agent_id": agent_id, "agent_name": agent.name, "ok": False, "error": str(exc)})
            skill_catalog_install_total.labels(
                registry_id=payload.registry_id or "local",
                result="failed",
            ).inc()

    ok_count = len([x for x in installs if x.get("ok")])
    write_audit(
        db,
        current,
        "skill.catalog.install",
        "skill",
        f"{payload.skill_id}@{version}",
        f"registry={payload.registry_id};targets={len(payload.target_agents)};ok={ok_count}",
    )
    await ws_manager.broadcast(
        PlatformEvent(
            event_type="skill.catalog.installed",
            payload={
                "skill_id": payload.skill_id,
                "version": version,
                "registry_id": payload.registry_id,
                "ok_count": ok_count,
            },
        )
    )
    return {
        "ok": ok_count > 0,
        "skill_id": payload.skill_id,
        "version": version,
        "installs": installs,
        "message": f"赋能完成 {ok_count}/{len(payload.target_agents)}",
    }


@app.post("/api/skills/sync")
async def sync_installed_skill(
    payload: SkillSyncRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/sync", method="POST").inc()
    row = (
        db.query(SkillInstallRecord)
        .filter(
            SkillInstallRecord.skill_id == payload.skill_id,
            SkillInstallRecord.version == payload.version,
            SkillInstallRecord.agent_id == payload.agent_id,
            SkillInstallRecord.status == "installed",
        )
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="未找到已安装记录")
    result = sync_skill_to_agent(
        db,
        skill_id=payload.skill_id,
        version=payload.version,
        agent_id=payload.agent_id,
        kind=row.kind or "",
    )
    action = "skill.sync" if result.get("ok") else "skill.sync.failed"
    write_audit(
        db,
        current,
        action,
        "agent",
        row.agent_name,
        f"{payload.skill_id}@{payload.version}",
    )
    return {"ok": result.get("ok", False), "result": result}


@app.get("/api/skills/sync/status")
async def get_skill_sync_status(
    agent_id: str | None = Query(default=None),
    skill_id: str | None = Query(default=None),
    current: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/sync/status", method="GET").inc()
    q = _scope_skill_installs(
        db.query(SkillInstallRecord).filter(SkillInstallRecord.status == "installed"),
        current,
    )
    if agent_id:
        q = q.filter(SkillInstallRecord.agent_id == agent_id)
    if skill_id:
        q = q.filter(SkillInstallRecord.skill_id == skill_id)
    rows = q.order_by(SkillInstallRecord.created_at.desc()).all()
    return [_skill_install_to_dict(r) for r in rows]


@app.get("/api/agents/{agent_id}/skills/effective")
async def list_effective_skills(
    agent_id: str,
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/{agent_id}/skills/effective", method="GET").inc()
    agent = db.query(AgentRecord).filter(AgentRecord.agent_id == agent_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent 不存在")
    return {"ok": True, "agent_id": agent_id, "agent_name": agent.name, "skills": list_effective_agent_skills(db, agent_id)}


@app.get("/api/skills/installs")
async def list_skill_installs(
    agent_id: str | None = Query(default=None),
    current: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/installs", method="GET").inc()
    q = _scope_skill_installs(db.query(SkillInstallRecord), current)
    if agent_id:
        q = q.filter(SkillInstallRecord.agent_id == agent_id)
    rows = q.order_by(SkillInstallRecord.created_at.desc()).all()
    return [_skill_install_to_dict(r) for r in rows]


@app.get("/api/agents/{agent_id}/skills")
async def list_agent_skills(
    agent_id: str,
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/{agent_id}/skills", method="GET").inc()
    rows = (
        db.query(SkillInstallRecord)
        .filter(SkillInstallRecord.agent_id == agent_id, SkillInstallRecord.status == "installed")
        .order_by(SkillInstallRecord.created_at.desc())
        .all()
    )
    return [_skill_install_to_dict(r) for r in rows]


@app.get("/api/skills/rollouts")
async def list_skill_rollout_jobs(
    skill_id: str | None = Query(default=None),
    version: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/rollouts", method="GET").inc()
    q = db.query(SkillRolloutJobRecord)
    if skill_id:
        q = q.filter(SkillRolloutJobRecord.skill_id == skill_id)
    if version:
        q = q.filter(SkillRolloutJobRecord.version == version)
    rows = q.order_by(SkillRolloutJobRecord.created_at.desc()).limit(limit).all()
    return [_rollout_job_to_dict(r) for r in rows]


@app.post("/api/skills/rollouts")
async def create_skill_rollout_job(
    payload: SkillRolloutRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/rollouts", method="POST").inc()
    _ensure_skill_exists(db, payload.skill_id, payload.version)
    strategy = (payload.strategy or "single-agent").strip().lower()
    if strategy not in {"single-agent", "batch", "canary"}:
        raise HTTPException(status_code=400, detail="strategy 必须是 single-agent/batch/canary")
    if not payload.target_agents:
        raise HTTPException(status_code=400, detail="target_agents 不能为空")
    row = SkillRolloutJobRecord(
        skill_id=payload.skill_id,
        version=payload.version,
        strategy=strategy,
        status="queued",
        started_by=current.username,
        target_agents_json=json.dumps(payload.target_agents, ensure_ascii=False),
        detail_json=json.dumps(
            {
                "thresholds": {
                    "failure_rate": payload.failure_rate_threshold,
                    "timeout_rate": payload.timeout_rate_threshold,
                    "cost_tokens": payload.cost_threshold,
                    "total_cost": payload.total_cost_threshold,
                },
                "canary_percent": payload.canary_percent,
                "note": payload.note,
            },
            ensure_ascii=False,
        ),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    rollout_jobs[row.job_id] = asyncio.create_task(_execute_rollout_job(row.job_id))
    write_audit(
        db,
        current,
        "skill.rollout.create",
        "skill_rollout",
        row.job_id,
        f"{payload.skill_id}@{payload.version};strategy={strategy};targets={len(payload.target_agents)}",
    )
    return {"ok": True, "job": _rollout_job_to_dict(row)}


@app.get("/api/skills/rollouts/{job_id}")
async def get_skill_rollout_job(
    job_id: str,
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/rollouts/{job_id}", method="GET").inc()
    row = db.query(SkillRolloutJobRecord).filter(SkillRolloutJobRecord.job_id == job_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="rollout 任务不存在")
    return _rollout_job_to_dict(row)


@app.post("/api/skills/install")
async def install_skill(
    payload: SkillInstallRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/install", method="POST").inc()
    result = _install_skill_core(
        db=db,
        payload=payload,
        operator=current.username,
        tenant_id=_user_tenant_id(current),
    )
    write_audit(
        db,
        current,
        "skill.install",
        "agent",
        result["agent_name"],
        f"{payload.skill_id}@{payload.version}",
    )
    await ws_manager.broadcast(
        PlatformEvent(
            event_type="skill.installed",
            payload={
                "skill_id": payload.skill_id,
                "version": payload.version,
                "agent_id": payload.agent_id,
                "agent_name": result["agent_name"],
            },
        )
    )
    return {"ok": True, "message": result["message"]}


@app.post("/api/skills/uninstall")
async def uninstall_skill(
    payload: SkillUninstallRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/uninstall", method="POST").inc()
    row = (
        db.query(SkillInstallRecord)
        .filter(
            SkillInstallRecord.skill_id == payload.skill_id,
            SkillInstallRecord.version == payload.version,
            SkillInstallRecord.agent_id == payload.agent_id,
            SkillInstallRecord.status == "installed",
        )
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="未找到可卸载的安装记录")

    row.status = "uninstalled"
    if payload.note:
        row.note = payload.note
    db.add(row)
    db.commit()
    remove_synced_skill_from_agent(
        db,
        skill_id=payload.skill_id,
        agent_id=payload.agent_id,
        kind=row.kind or "",
    )
    write_audit(
        db,
        current,
        "skill.uninstall",
        "agent",
        row.agent_name,
        f"{payload.skill_id}@{payload.version}",
    )
    await ws_manager.broadcast(
        PlatformEvent(
            event_type="skill.uninstalled",
            payload={
                "skill_id": payload.skill_id,
                "version": payload.version,
                "agent_id": payload.agent_id,
                "agent_name": row.agent_name,
            },
        )
    )
    return {"ok": True, "message": "卸载成功"}


@app.post("/api/agents/{agent_id}/skills/rollback")
async def rollback_agent_skill(
    agent_id: str,
    payload: SkillRollbackRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/{agent_id}/skills/rollback", method="POST").inc()
    agent = db.query(AgentRecord).filter(AgentRecord.agent_id == agent_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="目标 Agent 不存在")

    target = (
        db.query(SkillRecord)
        .filter(SkillRecord.skill_id == payload.skill_id, SkillRecord.version == payload.to_version)
        .first()
    )
    if not target:
        raise HTTPException(status_code=404, detail="回滚目标版本不存在")

    current_installs = (
        db.query(SkillInstallRecord)
        .filter(
            SkillInstallRecord.skill_id == payload.skill_id,
            SkillInstallRecord.agent_id == agent_id,
            SkillInstallRecord.status == "installed",
        )
        .all()
    )
    for row in current_installs:
        row.status = "rolled_back"
        row.note = payload.note or f"rolled_back_to={payload.to_version}"
        db.add(row)

    db.add(
        SkillInstallRecord(
            skill_id=payload.skill_id,
            version=payload.to_version,
            agent_id=agent_id,
            agent_name=agent.name,
            status="installed",
            installed_by=current.username,
            note=f"rollback_install; {payload.note}".strip(),
        )
    )
    db.commit()
    write_audit(
        db,
        current,
        "skill.rollback",
        "agent",
        agent.name,
        f"{payload.skill_id}->{payload.to_version}",
    )
    return {"ok": True, "message": "回滚完成"}


@app.post("/api/skills/invoke")
async def invoke_skill(
    payload: SkillInvokeRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/invoke", method="POST").inc()
    tenant_id = resolve_request_tenant_id(current, None)
    try:
        assert_tenant_quota_available(db, tenant_id)
    except QuotaExceededError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    skill = (
        db.query(SkillRecord)
        .filter(SkillRecord.skill_id == payload.skill_id, SkillRecord.version == payload.version)
        .first()
    )
    if not skill:
        raise HTTPException(status_code=404, detail="技能版本不存在")

    install = None
    agent_name = ""
    if payload.agent_id:
        install = (
            db.query(SkillInstallRecord)
            .filter(
                SkillInstallRecord.skill_id == payload.skill_id,
                SkillInstallRecord.version == payload.version,
                SkillInstallRecord.agent_id == payload.agent_id,
                SkillInstallRecord.status == "installed",
            )
            .first()
        )
        if not install:
            raise HTTPException(status_code=409, detail="该 Agent 尚未安装此技能版本")
        agent_name = install.agent_name

    artifact = (
        db.query(SkillArtifactRecord)
        .filter(SkillArtifactRecord.skill_id == payload.skill_id, SkillArtifactRecord.version == payload.version)
        .order_by(SkillArtifactRecord.created_at.desc())
        .first()
    )
    if not artifact:
        raise HTTPException(status_code=400, detail="该技能版本缺少可执行 artifact（请先上传技能包）")

    trace_id = payload.trace_id.strip() if payload.trace_id else str(uuid4())
    input_payload = {"input_data": payload.input_data or {}, "context": payload.context or {}}
    manifest = _load_manifest_from_artifact(artifact)
    input_schema_ref, output_schema_ref = _extract_schema_refs(manifest)
    input_schema = _load_schema_from_artifact(artifact, input_schema_ref)
    output_schema = _load_schema_from_artifact(artifact, output_schema_ref)
    if input_schema:
        _validate_payload_against_schema(input_payload, input_schema, "input")
    run_input = {
        **input_payload,
        "_meta": {
            "trace_id": trace_id,
            "input_summary": _short_json_summary(input_payload),
            "output_summary": "",
            "error_code": "",
        },
    }
    run = SkillRunRecord(
        skill_id=payload.skill_id,
        version=payload.version,
        agent_id=payload.agent_id or "",
        agent_name=agent_name,
        status="running",
        input_json=json.dumps(run_input, ensure_ascii=False),
        started_by=current.username,
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    (
        status,
        output_json,
        error_text,
        logs,
        error_code,
        duration_ms,
        cost_tokens,
        external_api_cost,
        resource_cpu_ms,
        resource_mem_mb_ms,
        total_cost,
    ) = execute_skill_run(
        run=run,
        artifact=artifact,
        fallback_entrypoint=skill.entrypoint,
        input_payload=input_payload,
    )

    output_obj = {"status": status}
    if output_json:
        try:
            output_obj = json.loads(output_json)
        except json.JSONDecodeError:
            output_obj = {"raw": output_json[:240]}
    if status == "success" and output_schema:
        try:
            _validate_payload_against_schema(output_obj, output_schema, "output")
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            status = "failed"
            error_code = "SKILL_VALIDATION_ERROR"
            error_text = str(detail.get("message") or "SKILL_VALIDATION_ERROR")

    skill_invocations_total.labels(
        skill_id=payload.skill_id,
        version=payload.version,
        agent=payload.agent_id or "direct",
    ).inc()
    skill_duration_seconds.labels(skill_id=payload.skill_id, version=payload.version).observe(duration_ms / 1000)
    skill_cost_tokens_total.labels(skill_id=payload.skill_id, version=payload.version).inc(int(cost_tokens or 0))
    skill_external_api_cost_total.labels(skill_id=payload.skill_id, version=payload.version).inc(
        float(external_api_cost or 0.0)
    )
    skill_total_cost_total.labels(skill_id=payload.skill_id, version=payload.version).inc(float(total_cost or 0.0))
    if status == "success":
        skill_success_total.labels(skill_id=payload.skill_id, version=payload.version).inc()
    else:
        skill_failure_total.labels(skill_id=payload.skill_id, version=payload.version).inc()
    update_skill_derived_metrics(
        skill_id=payload.skill_id,
        version=payload.version,
        status=status,
        duration_ms=duration_ms,
    )
    if status != "success":
        skill_errors_total.labels(skill_id=payload.skill_id, version=payload.version, error_code=error_code).inc()

    run_input["_meta"]["output_summary"] = _short_json_summary(output_obj)
    run_input["_meta"]["error_code"] = error_code

    run.trace_id = trace_id
    run.input_summary = run_input["_meta"].get("input_summary", "")
    run.output_summary = run_input["_meta"].get("output_summary", "")
    run.error_code = run_input["_meta"].get("error_code", "")
    run.cost_tokens = int(cost_tokens or 0)
    run.external_api_cost = float(external_api_cost or 0.0)
    run.resource_cpu_ms = int(resource_cpu_ms or 0)
    run.resource_mem_mb_ms = int(resource_mem_mb_ms or 0)
    run.total_cost = float(total_cost or 0.0)

    run.status = status
    run.input_json = json.dumps(run_input, ensure_ascii=False)
    run.output_json = output_json
    run.error_text = error_text
    run.logs = (logs or "")[:8000]
    run.duration_ms = duration_ms
    run.finished_at = run.started_at + timedelta(milliseconds=duration_ms)
    db.add(run)
    db.commit()
    db.refresh(run)

    write_audit(
        db,
        current,
        "skill.invoke",
        "skill_run",
        run.run_id,
        (
            f"{payload.skill_id}@{payload.version};status={status};agent={payload.agent_id or '-'};"
            f"trace_id={trace_id};error_code={error_code or '-'}"
        ),
    )
    await ws_manager.broadcast(
        PlatformEvent(
            event_type="skill.run.finished",
            payload={
                "run_id": run.run_id,
                "skill_id": run.skill_id,
                "version": run.version,
                "status": run.status,
                "agent_id": run.agent_id,
                "duration_ms": run.duration_ms,
            },
        )
    )
    return {"ok": status == "success", "run": _skill_run_to_dict(run)}


@app.get("/api/skills/runs")
async def list_skill_runs(
    limit: int = Query(default=50, ge=1, le=200),
    skill_id: str | None = Query(default=None),
    agent_id: str | None = Query(default=None),
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/runs", method="GET").inc()
    q = db.query(SkillRunRecord)
    if skill_id:
        q = q.filter(SkillRunRecord.skill_id == skill_id)
    if agent_id:
        q = q.filter(SkillRunRecord.agent_id == agent_id)
    rows = q.order_by(SkillRunRecord.started_at.desc()).limit(limit).all()
    return [_skill_run_to_dict(r) for r in rows]


@app.get("/api/skills/costs/summary")
async def get_skill_cost_summary(
    skill_id: str | None = Query(default=None),
    version: str | None = Query(default=None),
    agent_id: str | None = Query(default=None),
    limit: int = Query(default=500, ge=1, le=5000),
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/costs/summary", method="GET").inc()
    q = db.query(SkillRunRecord)
    if skill_id:
        q = q.filter(SkillRunRecord.skill_id == skill_id)
    if version:
        q = q.filter(SkillRunRecord.version == version)
    if agent_id:
        q = q.filter(SkillRunRecord.agent_id == agent_id)
    rows = q.order_by(SkillRunRecord.started_at.desc()).limit(limit).all()
    summary = {
        "sample_size": len(rows),
        "cost_tokens_total": int(sum(int(r.cost_tokens or 0) for r in rows)),
        "external_api_cost_total": float(sum(float(r.external_api_cost or 0.0) for r in rows)),
        "resource_cpu_ms_total": int(sum(int(r.resource_cpu_ms or 0) for r in rows)),
        "resource_mem_mb_ms_total": int(sum(int(r.resource_mem_mb_ms or 0) for r in rows)),
        "total_cost_sum": float(sum(float(r.total_cost or 0.0) for r in rows)),
    }
    by_skill: dict[str, dict] = {}
    for r in rows:
        key = f"{r.skill_id}@{r.version}"
        if key not in by_skill:
            by_skill[key] = {
                "skill_id": r.skill_id,
                "version": r.version,
                "runs": 0,
                "cost_tokens_total": 0,
                "external_api_cost_total": 0.0,
                "resource_cpu_ms_total": 0,
                "resource_mem_mb_ms_total": 0,
                "total_cost_sum": 0.0,
            }
        item = by_skill[key]
        item["runs"] += 1
        item["cost_tokens_total"] += int(r.cost_tokens or 0)
        item["external_api_cost_total"] += float(r.external_api_cost or 0.0)
        item["resource_cpu_ms_total"] += int(r.resource_cpu_ms or 0)
        item["resource_mem_mb_ms_total"] += int(r.resource_mem_mb_ms or 0)
        item["total_cost_sum"] += float(r.total_cost or 0.0)
    return {"summary": summary, "by_skill": list(by_skill.values())}


@app.get("/api/skills/runs/{run_id}")
async def get_skill_run(
    run_id: str,
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/runs/{run_id}", method="GET").inc()
    row = db.query(SkillRunRecord).filter(SkillRunRecord.run_id == run_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="运行记录不存在")
    return _skill_run_to_dict(row)


@app.get("/api/skills/runs/{run_id}/logs")
async def get_skill_run_logs(
    run_id: str,
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/skills/runs/{run_id}/logs", method="GET").inc()
    row = db.query(SkillRunRecord).filter(SkillRunRecord.run_id == run_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="运行记录不存在")
    return {"run_id": run_id, "logs": row.logs, "error": row.error_text}


@app.get("/api/agents", response_model=list[AgentRegistration])
async def list_agents(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
) -> list[AgentRegistration]:
    api_requests_total.labels(endpoint="/api/agents", method="GET").inc()
    rows = db.query(AgentRecord).order_by(AgentRecord.created_at.desc()).all()
    return [
        AgentRegistration(
            agent_id=r.agent_id,
            name=r.name,
            category=r.category,
            endpoint=r.endpoint,
            status=r.status,
            metadata={},
            created_at=r.created_at,
        )
        for r in rows
    ]


@app.get("/api/agents/startup-specs")
async def get_agent_startup_specs(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
):
    api_requests_total.labels(endpoint="/api/agents/startup-specs", method="GET").inc()
    return {"workspace_root": settings.workspace_root, "apps": managed_agent_specs()}


@app.get("/api/agents/runtime")
async def get_agent_runtime(
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/runtime", method="GET").inc()
    meta = peek_config_package_meta(db)
    return build_agent_runtime_status(
        db,
        config_version=str(meta.get("config_version") or ""),
        config_signed=bool(meta.get("signed")),
    )


@app.post("/api/agents/{agent_name}/start")
async def start_agent(
    agent_name: str,
    _: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/{agent_name}/start", method="POST").inc()
    error_message = ""
    started = False
    try:
        started = start_agent_process(agent_name)
    except ValueError as exc:
        write_audit(db, _, "agent.start", "agent", agent_name, f"rejected={exc}")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        error_message = str(exc)
    row = db.query(AgentRecord).filter(AgentRecord.name == agent_name).first()
    if row and started:
        row.status = "online"
        db.add(row)
        db.commit()
    write_audit(
        db,
        _,
        "agent.start",
        "agent",
        agent_name,
        f"started={started};error={error_message}" if error_message else f"started={started}",
    )
    if started:
        await ws_manager.broadcast(
            PlatformEvent(event_type="agent.runtime", payload={"agent_name": agent_name, "running": True})
        )
    status = build_agent_runtime_status(db, config_version=peek_config_version(db), agent_name=agent_name)
    return {
        "agent_name": agent_name,
        "started": started,
        "control_mode": settings.agent_control_mode,
        "error": error_message,
        "runtime": status,
        "agent": (status.get("agents") or [None])[0],
    }


@app.post("/api/agents/{agent_name}/restart")
async def restart_agent(
    agent_name: str,
    build: bool = Query(default=False),
    force_recreate: bool = Query(default=False),
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/{agent_name}/restart", method="POST").inc()
    error_message = ""
    result: dict = {}
    try:
        result = restart_agent_process(agent_name, build=build, force_recreate=force_recreate)
    except ValueError as exc:
        write_audit(db, current, "agent.restart", "agent", agent_name, f"rejected={exc}")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        error_message = str(exc)
    write_audit(
        db,
        current,
        "agent.restart",
        "agent",
        agent_name,
        f"build={build};force_recreate={force_recreate};error={error_message}"[:500],
    )
    if error_message:
        raise HTTPException(status_code=500, detail=error_message)
    status = build_agent_runtime_status(db, config_version=peek_config_version(db), agent_name=agent_name)
    return {
        "agent_name": agent_name,
        "control_mode": settings.agent_control_mode,
        "runtime": status,
        "agent": (status.get("agents") or [None])[0],
        **result,
    }


@app.post("/api/agents/actions/restart-manager-stack")
async def restart_manager_stack_action(
    build: bool = Query(default=False),
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/actions/restart-manager-stack", method="POST").inc()
    error_message = ""
    result: dict = {}
    try:
        result = restart_manager_stack(build=build)
    except Exception as exc:  # noqa: BLE001
        error_message = str(exc)
    write_audit(
        db,
        current,
        "agent.restart_manager_stack",
        "agent_stack",
        "manager",
        f"build={build};error={error_message}"[:500],
    )
    if error_message:
        raise HTTPException(status_code=500, detail=error_message)
    return {"control_mode": settings.agent_control_mode, **result}


@app.post("/api/agents/{agent_name}/stop")
async def stop_agent(
    agent_name: str,
    _: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/{agent_name}/stop", method="POST").inc()
    error_message = ""
    stopped = False
    try:
        stopped = stop_agent_process(agent_name)
    except ValueError as exc:
        write_audit(db, _, "agent.stop", "agent", agent_name, f"rejected={exc}")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        error_message = str(exc)
    row = db.query(AgentRecord).filter(AgentRecord.name == agent_name).first()
    if row and stopped:
        row.status = "offline"
        db.add(row)
        db.commit()
    write_audit(
        db,
        _,
        "agent.stop",
        "agent",
        agent_name,
        f"stopped={stopped};error={error_message}" if error_message else f"stopped={stopped}",
    )
    if stopped:
        await ws_manager.broadcast(
            PlatformEvent(event_type="agent.runtime", payload={"agent_name": agent_name, "running": False})
        )
    status = build_agent_runtime_status(db, config_version=peek_config_version(db), agent_name=agent_name)
    return {
        "agent_name": agent_name,
        "stopped": stopped,
        "control_mode": settings.agent_control_mode,
        "error": error_message,
        "runtime": status,
        "agent": (status.get("agents") or [None])[0],
    }


@app.post("/api/agents/{agent_name}/drain")
async def drain_agent(
    agent_name: str,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    """摘流量：期望态 offline + 停止进程/容器。"""
    api_requests_total.labels(endpoint="/api/agents/{agent_name}/drain", method="POST").inc()
    try:
        result = drain_agent_process(agent_name)
    except ValueError as exc:
        write_audit(db, current, "agent.drain", "agent", agent_name, f"rejected={exc}")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        write_audit(db, current, "agent.drain", "agent", agent_name, f"error={exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    row = db.query(AgentRecord).filter(AgentRecord.name == agent_name).first()
    if row:
        row.status = "offline"
        db.add(row)
        db.commit()
    write_audit(
        db,
        current,
        "agent.drain",
        "agent",
        agent_name,
        f"ok={result.get('ok')};stopped={result.get('stopped')}",
    )
    await ws_manager.broadcast(
        PlatformEvent(event_type="agent.runtime", payload={"agent_name": agent_name, "running": False})
    )
    status = build_agent_runtime_status(db, config_version=peek_config_version(db), agent_name=agent_name)
    return {
        "agent_name": agent_name,
        "action": "drain",
        "result": result,
        "runtime": status,
        "agent": (status.get("agents") or [None])[0],
        "control_mode": settings.agent_control_mode,
    }


@app.post("/api/agents/{agent_name}/rolling-restart")
async def rolling_restart_agent(
    agent_name: str,
    timeout_sec: float = Query(default=120.0, ge=30.0, le=600.0),
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    """滚动重启：stop → wait down → start → wait ready。"""
    api_requests_total.labels(endpoint="/api/agents/{agent_name}/rolling-restart", method="POST").inc()
    try:
        result = rolling_restart_agent_process(agent_name, timeout_sec=timeout_sec)
    except ValueError as exc:
        write_audit(db, current, "agent.rolling_restart", "agent", agent_name, f"rejected={exc}")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        write_audit(db, current, "agent.rolling_restart", "agent", agent_name, f"error={exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    row = db.query(AgentRecord).filter(AgentRecord.name == agent_name).first()
    if row:
        row.status = "online" if result.get("ok") else row.status
        db.add(row)
        db.commit()
    write_audit(
        db,
        current,
        "agent.rolling_restart",
        "agent",
        agent_name,
        f"ok={result.get('ok')};steps={result.get('steps')}",
    )
    if result.get("ok"):
        await ws_manager.broadcast(
            PlatformEvent(event_type="agent.runtime", payload={"agent_name": agent_name, "running": True})
        )
    status = build_agent_runtime_status(db, config_version=peek_config_version(db), agent_name=agent_name)
    if not result.get("ok"):
        raise HTTPException(status_code=504, detail=result)
    return {
        "agent_name": agent_name,
        "action": "rolling_restart",
        "result": result,
        "runtime": status,
        "agent": (status.get("agents") or [None])[0],
        "control_mode": settings.agent_control_mode,
    }


@app.post("/api/agents/start-all")
async def start_all_agents(
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/start-all", method="POST").inc()
    results = start_all_agent_processes()
    errors: dict[str, str] = {}
    for name, running in results.items():
        row = db.query(AgentRecord).filter(AgentRecord.name == name).first()
        if row and running:
            row.status = "online"
            db.add(row)
        if not running:
            errors[name] = "启动失败或已运行"
    db.commit()
    write_audit(db, current, "agent.start_all", "agent", "all", f"results={results};errors={errors}")
    await ws_manager.broadcast(PlatformEvent(event_type="agent.runtime.bulk", payload={"action": "start", "results": results}))
    return {"action": "start", "results": results, "errors": errors, "control_mode": settings.agent_control_mode}


@app.post("/api/agents/stop-all")
async def stop_all_agents(
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/agents/stop-all", method="POST").inc()
    results = stop_all_agent_processes()
    errors: dict[str, str] = {}
    for name in results:
        row = db.query(AgentRecord).filter(AgentRecord.name == name).first()
        if row and results[name]:
            row.status = "offline"
            db.add(row)
        if not results[name]:
            errors[name] = "停止失败或已停止"
    db.commit()
    write_audit(db, current, "agent.stop_all", "agent", "all", f"results={results};errors={errors}")
    await ws_manager.broadcast(PlatformEvent(event_type="agent.runtime.bulk", payload={"action": "stop", "results": results}))
    return {"action": "stop", "results": results, "errors": errors, "control_mode": settings.agent_control_mode}


@app.post("/api/agents", response_model=AgentRegistration)
async def register_agent(
    registration: AgentRegistration,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
) -> AgentRegistration:
    api_requests_total.labels(endpoint="/api/agents", method="POST").inc()
    row = AgentRecord(
        agent_id=registration.agent_id,
        name=registration.name,
        category=registration.category,
        endpoint=registration.endpoint,
        status=registration.status,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    created = AgentRegistration(
        agent_id=row.agent_id,
        name=row.name,
        category=row.category,
        endpoint=row.endpoint,
        status=row.status,
        metadata={},
        created_at=row.created_at,
    )
    await ws_manager.broadcast(
        PlatformEvent(
            event_type="agent.registered",
            payload={"agent": created.model_dump(mode="json")},
        )
    )
    write_audit(db, current, "agent.register", "agent", created.name, created.endpoint)
    return created


@app.post("/api/tasks/execute", response_model=TaskResult)
async def execute_task(
    request: TaskRequest,
    current: UserRecord = Depends(require_roles("operator", "admin")),
    db: Session = Depends(get_db),
) -> TaskResult:
    api_requests_total.labels(endpoint="/api/tasks/execute", method="POST").inc()
    task_id = str(uuid4())
    trace_id = task_id
    tenant_id = resolve_request_tenant_id(current, None)
    try:
        assert_tenant_quota_available(db, tenant_id)
    except QuotaExceededError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    row = TaskRecord(
        task_id=task_id,
        task=request.task,
        target_agent_id=request.target_agent_id or "",
        priority=request.priority,
        status="queued",
        max_retries=settings.max_task_retries,
        tenant_id=tenant_id,
        created_by=current.username,
        trace_id=trace_id,
    )
    db.add(row)
    db.commit()
    await enqueue_task(task_id)
    result = TaskResult(
        task_id=task_id,
        status="queued",
        summary="任务已进入 Redis 队列，等待调度执行",
    )
    write_audit(db, current, "task.create", "task", task_id, request.task[:120])
    return result


@app.get("/api/tasks/{task_id}", response_model=TaskResult)
async def get_task(
    task_id: str,
    _: UserRecord = Depends(require_roles("viewer", "operator", "admin")),
    db: Session = Depends(get_db),
):
    api_requests_total.labels(endpoint="/api/tasks/{task_id}", method="GET").inc()
    row = db.query(TaskRecord).filter(TaskRecord.task_id == task_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="任务不存在")
    return TaskResult(
        task_id=row.task_id,
        status=row.status,
        summary=row.summary or "",
        planner_output=row.planner_output,
        execution_output=row.execution_output,
        cost_estimate_tokens=row.cost_estimate_tokens,
        raw={"retry_count": row.retry_count, "max_retries": row.max_retries, "last_error": row.last_error},
    )


@app.websocket("/ws/events")
async def events_ws(websocket: WebSocket):
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=1008)
        return
    try:
        payload = decode_access_token(token)
    except HTTPException:
        await websocket.close(code=1008)
        return
    db = SessionLocal()
    try:
        user = db.query(UserRecord).filter(UserRecord.username == payload.get("sub")).first()
        if not user:
            await websocket.close(code=1008)
            return
    finally:
        db.close()
    await ws_manager.connect(websocket)
    await ws_manager.broadcast(
        PlatformEvent(
            event_type="platform.ws_connected",
            payload={"message": "新的控制台客户端已连接"},
        )
    )
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
