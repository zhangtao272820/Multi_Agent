from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class UserRecord(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(128))
    role: Mapped[str] = mapped_column(String(16), default="viewer")
    tenant_id: Mapped[str] = mapped_column(String(64), default="default", index=True)
    auth_provider: Mapped[str] = mapped_column(String(32), default="local")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class TenantRecord(Base):
    """租户实体 SSOT（P1b-3）：配额跨月保留，不挂在月度 usage 行。"""

    __tablename__ = "tenants"

    tenant_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(128), default="")
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | disabled
    quota_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    updated_by: Mapped[str] = mapped_column(String(64), default="system")


class AgentRecord(Base):
    __tablename__ = "agents"

    agent_id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(32), default="general")
    endpoint: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(16), default="online")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AgentConfigRecord(Base):
    """集群 Agent 统一配置（模型 / 端口 / 端点 / 特性开关）。"""

    __tablename__ = "agent_configs"

    agent_name: Mapped[str] = mapped_column(String(120), primary_key=True)
    category: Mapped[str] = mapped_column(String(32), default="general")
    port: Mapped[str] = mapped_column(String(16), default="")
    endpoint: Mapped[str] = mapped_column(String(255), default="")
    model_planner: Mapped[str] = mapped_column(String(64), default="")
    model_executor: Mapped[str] = mapped_column(String(64), default="")
    model_embedding: Mapped[str] = mapped_column(String(64), default="")
    model_profile: Mapped[str] = mapped_column(String(32), default="standard")
    feature_flags_json: Mapped[str] = mapped_column(Text, default="{}")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    updated_by: Mapped[str] = mapped_column(String(64), default="system")


class PlatformCapabilityRecord(Base):
    """全集群能力层模型 SSOT（单行 id=1）。"""

    __tablename__ = "platform_capability_models"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    models_json: Mapped[str] = mapped_column(Text, default="{}")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    updated_by: Mapped[str] = mapped_column(String(64), default="seed")


class TaskRecord(Base):
    __tablename__ = "tasks"

    task_id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    task: Mapped[str] = mapped_column(Text)
    target_agent_id: Mapped[str] = mapped_column(String(64), default="")
    priority: Mapped[str] = mapped_column(String(16), default="normal")
    status: Mapped[str] = mapped_column(String(16), default="queued")
    summary: Mapped[str] = mapped_column(Text, default="")
    planner_output: Mapped[str] = mapped_column(Text, default="")
    execution_output: Mapped[str] = mapped_column(Text, default="")
    cost_estimate_tokens: Mapped[int] = mapped_column(Integer, default=0)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    max_retries: Mapped[int] = mapped_column(Integer, default=2)
    last_error: Mapped[str] = mapped_column(Text, default="")
    tenant_id: Mapped[str] = mapped_column(String(64), default="default", index=True)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    trace_id: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class AuditLogRecord(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), default="system")
    action: Mapped[str] = mapped_column(String(64))
    target_type: Mapped[str] = mapped_column(String(64), default="")
    target_id: Mapped[str] = mapped_column(String(128), default="")
    detail: Mapped[str] = mapped_column(Text, default="")
    tenant_id: Mapped[str] = mapped_column(String(64), default="default", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class SecretRefRecord(Base):
    __tablename__ = "secret_refs"

    ref_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    label: Mapped[str] = mapped_column(String(128), default="")
    category: Mapped[str] = mapped_column(String(32), default="general")
    env_var: Mapped[str] = mapped_column(String(128), default="")
    # CP-G3：Fernet 封套（需 CLAWHIVE_VAULT_KEY）；明文不进日志
    sealed_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    updated_by: Mapped[str] = mapped_column(String(64), default="system")
    rotated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class TenantUsageRecord(Base):
    __tablename__ = "tenant_usage"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    period: Mapped[str] = mapped_column(String(7), index=True)  # YYYY-MM
    tokens_used: Mapped[int] = mapped_column(Integer, default=0)
    task_count: Mapped[int] = mapped_column(Integer, default=0)
    quota_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_by: Mapped[str] = mapped_column(String(64), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class SkillRecord(Base):
    __tablename__ = "skills"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    skill_id: Mapped[str] = mapped_column(String(128), index=True)
    name: Mapped[str] = mapped_column(String(128))
    version: Mapped[str] = mapped_column(String(32), default="0.1.0")
    description: Mapped[str] = mapped_column(Text, default="")
    runtime: Mapped[str] = mapped_column(String(32), default="python3.11")
    entrypoint: Mapped[str] = mapped_column(String(255), default="")
    status: Mapped[str] = mapped_column(String(32), default="draft")
    tags: Mapped[str] = mapped_column(String(255), default="")
    owner: Mapped[str] = mapped_column(String(64), default="platform")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class SkillInstallRecord(Base):
    __tablename__ = "skill_installs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    skill_id: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[str] = mapped_column(String(32), default="0.1.0")
    agent_id: Mapped[str] = mapped_column(String(64), index=True)
    agent_name: Mapped[str] = mapped_column(String(128), default="")
    status: Mapped[str] = mapped_column(String(32), default="installed")
    installed_by: Mapped[str] = mapped_column(String(64), default="system")
    note: Mapped[str] = mapped_column(Text, default="")
    sync_status: Mapped[str] = mapped_column(String(32), default="pending")
    sync_path: Mapped[str] = mapped_column(Text, default="")
    sync_error: Mapped[str] = mapped_column(Text, default="")
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    registry_id: Mapped[str] = mapped_column(String(64), default="")
    kind: Mapped[str] = mapped_column(String(32), default="")
    tenant_id: Mapped[str] = mapped_column(String(64), default="default", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class SkillRegistryCacheRecord(Base):
    __tablename__ = "skill_registry_cache"

    registry_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload_json: Mapped[str] = mapped_column(Text, default="{}")
    fetched_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class SkillArtifactRecord(Base):
    __tablename__ = "skill_artifacts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    skill_id: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[str] = mapped_column(String(32), default="0.1.0")
    filename: Mapped[str] = mapped_column(String(255), default="")
    storage_path: Mapped[str] = mapped_column(Text, default="")
    uploaded_by: Mapped[str] = mapped_column(String(64), default="system")
    manifest_text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class SkillRunRecord(Base):
    __tablename__ = "skill_runs"

    run_id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    skill_id: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[str] = mapped_column(String(32), default="0.1.0")
    agent_id: Mapped[str] = mapped_column(String(64), index=True, default="")
    agent_name: Mapped[str] = mapped_column(String(128), default="")
    status: Mapped[str] = mapped_column(String(32), default="queued")
    trace_id: Mapped[str] = mapped_column(String(64), default="")
    input_summary: Mapped[str] = mapped_column(String(255), default="")
    output_summary: Mapped[str] = mapped_column(String(255), default="")
    error_code: Mapped[str] = mapped_column(String(64), default="")
    cost_tokens: Mapped[int] = mapped_column(Integer, default=0)
    external_api_cost: Mapped[float] = mapped_column(Float, default=0.0)
    resource_cpu_ms: Mapped[int] = mapped_column(Integer, default=0)
    resource_mem_mb_ms: Mapped[int] = mapped_column(Integer, default=0)
    total_cost: Mapped[float] = mapped_column(Float, default=0.0)
    input_json: Mapped[str] = mapped_column(Text, default="{}")
    output_json: Mapped[str] = mapped_column(Text, default="")
    error_text: Mapped[str] = mapped_column(Text, default="")
    logs: Mapped[str] = mapped_column(Text, default="")
    started_by: Mapped[str] = mapped_column(String(64), default="system")
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)


class MonitorAlertRecord(Base):
    __tablename__ = "monitor_alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    severity: Mapped[str] = mapped_column(String(16), default="warning")
    source: Mapped[str] = mapped_column(String(128), default="global")
    message: Mapped[str] = mapped_column(Text, default="")
    fingerprint: Mapped[str] = mapped_column(String(128), default="", index=True)
    acked: Mapped[int] = mapped_column(Integer, default=0)  # 0/1 for sqlite compatibility
    notify_status: Mapped[str] = mapped_column(String(32), default="none")  # none/delivered/failed
    notify_detail: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    acked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SkillReviewRecord(Base):
    __tablename__ = "skill_reviews"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    skill_id: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[str] = mapped_column(String(32), default="0.1.0")
    result: Mapped[str] = mapped_column(String(32), default="pending")  # pending/passed/failed
    reviewer: Mapped[str] = mapped_column(String(64), default="system")
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class SkillScanReportRecord(Base):
    __tablename__ = "skill_scan_reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    skill_id: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[str] = mapped_column(String(32), default="0.1.0")
    result: Mapped[str] = mapped_column(String(32), default="pending")  # pending/passed/failed
    scanner: Mapped[str] = mapped_column(String(64), default="system")
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class SkillSignatureRecord(Base):
    __tablename__ = "skill_signatures"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    skill_id: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[str] = mapped_column(String(32), default="0.1.0")
    result: Mapped[str] = mapped_column(String(32), default="pending")  # pending/passed/failed
    signer: Mapped[str] = mapped_column(String(64), default="system")
    note: Mapped[str] = mapped_column(Text, default="")
    fingerprint: Mapped[str] = mapped_column(String(128), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class SkillSmokeTestRecord(Base):
    __tablename__ = "skill_smoke_tests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    skill_id: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[str] = mapped_column(String(32), default="0.1.0")
    result: Mapped[str] = mapped_column(String(32), default="pending")  # pending/passed/failed
    runner: Mapped[str] = mapped_column(String(64), default="system")
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class SkillPipelineJobRecord(Base):
    __tablename__ = "skill_pipeline_jobs"

    job_id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    skill_id: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[str] = mapped_column(String(32), default="0.1.0", index=True)
    status: Mapped[str] = mapped_column(String(32), default="queued")  # queued/running/success/failed
    started_by: Mapped[str] = mapped_column(String(64), default="system")
    detail_json: Mapped[str] = mapped_column(Text, default="{}")
    error_text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SkillRolloutJobRecord(Base):
    __tablename__ = "skill_rollout_jobs"

    job_id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    skill_id: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[str] = mapped_column(String(32), default="0.1.0", index=True)
    strategy: Mapped[str] = mapped_column(String(16), default="single-agent")  # single-agent/batch/canary
    status: Mapped[str] = mapped_column(String(32), default="queued")  # queued/running/success/failed/rolled_back
    started_by: Mapped[str] = mapped_column(String(64), default="system")
    target_agents_json: Mapped[str] = mapped_column(Text, default="[]")
    detail_json: Mapped[str] = mapped_column(Text, default="{}")
    error_text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
