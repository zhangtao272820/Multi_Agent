"""CP-Gov：内网运维合规 — RBAC 矩阵、敏感审计清单、通知/备份策略摘要。"""

from __future__ import annotations

import os
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from .config import get_settings
from .db_models import AuditLogRecord

settings = get_settings()

# 全量角色：user=仅 Agent 对话；viewer/operator/admin=控制面
ALLOWED_ROLES: tuple[str, ...] = ("user", "viewer", "operator", "admin")
# 可登录控制面的角色（user 禁止）
CONTROL_PLANE_ROLES: tuple[str, ...] = ("viewer", "operator", "admin")

# 控制面「域」× 角色（与 require_roles 执法对齐；可视化用）。user 全 False。
RBAC_DOMAINS: list[dict[str, Any]] = [
    {"id": "overview", "label": "总览只读", "user": False, "viewer": True, "operator": True, "admin": True},
    {"id": "monitor", "label": "监控与告警只读", "user": False, "viewer": True, "operator": True, "admin": True},
    {"id": "agents_control", "label": "Agent 启停 / Drain", "user": False, "viewer": False, "operator": True, "admin": True},
    {"id": "deploy", "label": "部署 / recreate / 回滚", "user": False, "viewer": False, "operator": True, "admin": True},
    {"id": "backup", "label": "PG 备份", "user": False, "viewer": False, "operator": True, "admin": True},
    {"id": "backup_restore", "label": "PG 恢复", "user": False, "viewer": False, "operator": False, "admin": True},
    {"id": "config_write", "label": "能力层 / MODE / agents-lan", "user": False, "viewer": False, "operator": True, "admin": True},
    {"id": "secrets", "label": "密钥 Vault 只读", "user": False, "viewer": False, "operator": True, "admin": True},
    {"id": "secrets_rotate", "label": "密钥轮换写回", "user": False, "viewer": False, "operator": False, "admin": True},
    {"id": "tenants", "label": "租户与配额", "user": False, "viewer": False, "operator": False, "admin": True},
    {"id": "users", "label": "用户与角色", "user": False, "viewer": False, "operator": False, "admin": True},
    {"id": "audit", "label": "审计浏览 / 导出", "user": False, "viewer": False, "operator": False, "admin": True},
]

# 敏感动作：合规验收必能在审计中出现（登录失败允许无用户）
SENSITIVE_AUDIT_ACTIONS: list[dict[str, str]] = [
    {"action": "auth.login", "label": "登录成功"},
    {"action": "auth.login_failed", "label": "登录失败"},
    {"action": "user.create", "label": "创建用户"},
    {"action": "user.update_role", "label": "变更角色"},
    {"action": "user.reset_password", "label": "重置密码"},
    {"action": "user.delete", "label": "删除用户"},
    {"action": "tenant.create", "label": "创建租户"},
    {"action": "tenant.quota.set", "label": "设置租户配额"},
    {"action": "capability_models.update", "label": "能力层模型变更"},
    {"action": "agents_lan.update", "label": "agents-lan 基建变更"},
    {"action": "agent.start", "label": "Agent 启动"},
    {"action": "agent.stop", "label": "Agent 停止"},
    {"action": "agent.drain", "label": "Agent Drain"},
    {"action": "ops.backup.postgres", "label": "PG 备份"},
    {"action": "ops.backup.restore", "label": "PG 恢复"},
    {"action": "ops.deploy.rollback", "label": "镜像回滚"},
    {"action": "secret.rotate", "label": "密钥轮换"},
    {"action": "audit.export", "label": "审计导出"},
]


def rbac_matrix_payload() -> dict[str, Any]:
    return {
        "ok": True,
        "roles": list(ALLOWED_ROLES),
        "control_plane_roles": list(CONTROL_PLANE_ROLES),
        "domains": RBAC_DOMAINS,
        "note": "user=仅 Agent 对话（无控制面域）；viewer 只读旁观；operator 运维；admin 治理。细粒度 ACL / MFA 非本期",
    }


def audit_checklist_payload(db: Session, *, lookback_days: int = 90) -> dict[str, Any]:
    since = datetime.utcnow() - timedelta(days=max(1, int(lookback_days)))
    rows = (
        db.query(AuditLogRecord.action, AuditLogRecord.created_at)
        .filter(AuditLogRecord.created_at >= since)
        .all()
    )
    latest: dict[str, datetime] = {}
    for action, created_at in rows:
        key = str(action or "")
        if not key:
            continue
        prev = latest.get(key)
        if prev is None or (created_at and created_at > prev):
            latest[key] = created_at

    items = []
    for spec in SENSITIVE_AUDIT_ACTIONS:
        act = spec["action"]
        ts = latest.get(act)
        items.append(
            {
                "action": act,
                "label": spec["label"],
                "seen": ts is not None,
                "last_at": ts.isoformat() if ts else None,
            }
        )
    covered = sum(1 for i in items if i["seen"])
    return {
        "ok": True,
        "lookback_days": lookback_days,
        "required_count": len(items),
        "covered_count": covered,
        "items": items,
    }


def notify_status_payload() -> dict[str, Any]:
    webhook = (
        str(os.getenv("CLAWHIVE_ALERT_WEBHOOK_URL") or "").strip()
        or str(getattr(settings, "clawhive_alert_webhook_url", "") or "").strip()
    )
    vault_key = bool(str(os.getenv("CLAWHIVE_VAULT_KEY") or "").strip())
    return {
        "ok": True,
        "alert_webhook_configured": bool(webhook),
        "alert_webhook_hint": "CLAWHIVE_ALERT_WEBHOOK_URL（企微/钉钉/自定义）；不明文回显 URL",
        "vault_at_rest_enabled": vault_key,
        "vault_hint": "CLAWHIVE_VAULT_KEY → Fernet 封套写回 sealed_ciphertext；非真 KMS",
    }


def backup_policy_payload(*, backup_items: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    retain = int(os.getenv("CLAWHIVE_BACKUP_RETAIN_COUNT", "14") or "14")
    items = list(backup_items or [])
    latest = None
    if items:
        # items already sorted newest-first by list_backups when provided
        latest = items[0]
    return {
        "ok": True,
        "retain_count": retain,
        "retention_note": f"建议保留最近 {retain} 份（CLAWHIVE_BACKUP_RETAIN_COUNT）；脚本侧按文件名/mtime 人工清理",
        "latest": latest,
        "backup_count": len(items),
        "health_gate": "恢复后验收 GET /health/ready（或 /api/health/overview）",
        "rpo_note": "LAN 试点：按需/控制台触发备份，非流式复制 RPO=0",
    }
