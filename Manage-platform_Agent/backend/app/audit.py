from sqlalchemy.orm import Session

from .db_models import AuditLogRecord, UserRecord

# Re-export for callers that import from audit
from .governance import SENSITIVE_AUDIT_ACTIONS  # noqa: F401


def write_audit(
    db: Session,
    actor: UserRecord | None,
    action: str,
    target_type: str = "",
    target_id: str = "",
    detail: str = "",
) -> None:
    tenant_id = "default"
    if actor:
        tenant_id = str(getattr(actor, "tenant_id", None) or "default").strip() or "default"
    db.add(
        AuditLogRecord(
            username=actor.username if actor else "system",
            action=action,
            target_type=target_type,
            target_id=target_id,
            detail=detail,
            tenant_id=tenant_id,
        )
    )
    db.commit()
