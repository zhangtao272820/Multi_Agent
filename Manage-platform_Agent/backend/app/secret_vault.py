"""平台密钥托管：对外仅暴露 ref id，明文仅 internal API 下发。

E5 / CP-G3：可选 at-rest — 设 CLAWHIVE_VAULT_KEY 时，rotate 可 Fernet 写回 sealed_ciphertext（非 KMS）。
"""

from __future__ import annotations

import base64
import hashlib
import os
from typing import Any

from sqlalchemy.orm import Session

from .config import get_settings
from .db_models import SecretRefRecord

settings = get_settings()


def _vault_fernet():
    """CLAWHIVE_VAULT_KEY → Fernet；未设置则 None（仍走 env 明文路径）。"""
    raw = (os.getenv("CLAWHIVE_VAULT_KEY") or "").strip()
    if not raw:
        return None
    try:
        from cryptography.fernet import Fernet
    except ImportError:
        return None
    key = base64.urlsafe_b64encode(hashlib.sha256(raw.encode("utf-8")).digest())
    return Fernet(key)


def seal_secret_value(plaintext: str) -> str | None:
    """加密明文；失败或未配置 vault 返回 None。"""
    f = _vault_fernet()
    if not f or not plaintext:
        return None
    try:
        return f.encrypt(plaintext.encode("utf-8")).decode("ascii")
    except Exception:
        return None


def open_secret_value(ciphertext: str) -> str | None:
    f = _vault_fernet()
    if not f or not ciphertext:
        return None
    try:
        return f.decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except Exception:
        return None


# 内置 ref → 环境变量映射（不落库明文）
_BUILTIN_REF_ENV: dict[str, str] = {
    "openai_api_key": "QWEN_API_KEY",
    "qwen_api_key": "QWEN_API_KEY",
    "openai_base_url": "QWEN_BASE_URL",
    "tavily_api_key": "TAVILY_API_KEY",
    "clawhive_internal_token": "CLAWHIVE_INTERNAL_TOKEN",
}


def seed_secret_refs(db: Session) -> None:
    defaults = [
        ("openai_api_key", "LLM API Key", "llm"),
        ("openai_base_url", "LLM Base URL", "llm"),
        ("clawhive_internal_token", "集群内部令牌", "platform"),
    ]
    for ref_id, label, category in defaults:
        exists = db.query(SecretRefRecord).filter(SecretRefRecord.ref_id == ref_id).first()
        if exists:
            continue
        db.add(
            SecretRefRecord(
                ref_id=ref_id,
                label=label,
                category=category,
                env_var=_BUILTIN_REF_ENV.get(ref_id, ref_id.upper()),
                updated_by="seed",
            )
        )
    db.commit()


def list_secret_refs_public(db: Session) -> list[dict[str, Any]]:
    seed_secret_refs(db)
    rows = db.query(SecretRefRecord).order_by(SecretRefRecord.ref_id.asc()).all()
    vault_on = _vault_fernet() is not None
    out: list[dict[str, Any]] = []
    for r in rows:
        sealed = bool(str(getattr(r, "sealed_ciphertext", None) or "").strip())
        configured = bool(_resolve_ref_value(r.ref_id, r.env_var, sealed_ciphertext=getattr(r, "sealed_ciphertext", None)))
        out.append(
            {
                "ref_id": r.ref_id,
                "label": r.label,
                "category": r.category,
                "env_var": r.env_var or _BUILTIN_REF_ENV.get(r.ref_id, ""),
                "configured": configured,
                "sealed_stored": sealed,
                "vault_at_rest_enabled": vault_on,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
                "updated_by": r.updated_by,
                "rotated_at": getattr(r, "rotated_at", None).isoformat()
                if getattr(r, "rotated_at", None)
                else None,
            }
        )
    return out


def rotate_secret_ref(
    db: Session,
    ref_id: str,
    *,
    operator: str,
    new_value: str | None = None,
) -> dict[str, Any]:
    """轮换：标记 rotated_at；可选写入进程环境 + Fernet 落库（CP-G3）。"""
    from datetime import datetime

    seed_secret_refs(db)
    row = db.query(SecretRefRecord).filter(SecretRefRecord.ref_id == ref_id).first()
    if not row:
        raise ValueError(f"未知密钥引用: {ref_id}")
    env_key = str(row.env_var or _BUILTIN_REF_ENV.get(ref_id) or ref_id.upper()).strip()
    applied_env = False
    sealed_stored = False
    plain = str(new_value).strip() if new_value is not None and str(new_value).strip() else ""
    if plain:
        os.environ[env_key] = plain
        applied_env = True
        sealed = seal_secret_value(plain)
        if sealed:
            row.sealed_ciphertext = sealed
            sealed_stored = True
    now = datetime.utcnow()
    row.updated_at = now
    row.updated_by = operator or "system"
    if hasattr(row, "rotated_at"):
        row.rotated_at = now
    db.add(row)
    db.commit()
    db.refresh(row)
    note = "明文不进审计；applied_env 影响当前后端进程"
    if sealed_stored:
        note += "；已 Fernet 写回 sealed_ciphertext（Agent pull 可读）"
    elif plain and _vault_fernet() is None:
        note += "；未设 CLAWHIVE_VAULT_KEY，仅进程 env（持久化请同步宿主 .env）"
    return {
        "ok": True,
        "ref_id": row.ref_id,
        "env_var": env_key,
        "configured": bool(
            _resolve_ref_value(row.ref_id, row.env_var, sealed_ciphertext=getattr(row, "sealed_ciphertext", None))
        ),
        "applied_env": applied_env,
        "sealed_stored": sealed_stored,
        "vault_at_rest_enabled": _vault_fernet() is not None,
        "rotated_at": row.rotated_at.isoformat() if getattr(row, "rotated_at", None) else now.isoformat(),
        "updated_by": row.updated_by,
        "note": note,
    }


def _resolve_ref_value(
    ref_id: str,
    env_var: str | None = None,
    *,
    sealed_ciphertext: str | None = None,
) -> str:
    key = str(env_var or _BUILTIN_REF_ENV.get(ref_id) or ref_id.upper()).strip()
    val = os.getenv(key, "").strip()
    if val:
        if ref_id == "openai_base_url" and settings.litellm_enabled:
            return str(settings.litellm_base_url or "").strip()
        return val
    if sealed_ciphertext:
        opened = open_secret_value(str(sealed_ciphertext))
        if opened:
            return opened
    if ref_id == "openai_api_key" or ref_id == "qwen_api_key":
        if settings.litellm_enabled and settings.litellm_master_key:
            return str(settings.litellm_master_key).strip()
        return str(getattr(settings, "qwen_api_key", "") or "").strip()
    if ref_id == "openai_base_url":
        if settings.litellm_enabled:
            return str(settings.litellm_base_url or "").strip()
        return str(getattr(settings, "qwen_base_url", "") or "").strip()
    if ref_id == "clawhive_internal_token":
        return str(getattr(settings, "clawhive_internal_token", "") or "").strip()
    return ""


def build_internal_secrets(db: Session) -> dict[str, Any]:
    """供 Manager / 子 Agent internal 拉取；禁止暴露给前端 JWT 用户。"""
    seed_secret_refs(db)
    rows = db.query(SecretRefRecord).all()
    secrets: dict[str, str] = {}
    for r in rows:
        val = _resolve_ref_value(
            r.ref_id,
            r.env_var,
            sealed_ciphertext=getattr(r, "sealed_ciphertext", None),
        )
        if val:
            secrets[r.ref_id] = val
    if settings.litellm_enabled:
        secrets["openai_base_url"] = str(settings.litellm_base_url or "").strip()
        if settings.litellm_master_key:
            secrets["openai_api_key"] = str(settings.litellm_master_key).strip()
            secrets["qwen_api_key"] = str(settings.litellm_master_key).strip()
    return {
        "ok": True,
        "secrets": secrets,
        "openai_api_key_ref": "openai_api_key" if secrets.get("openai_api_key") else None,
        "internal_token_ref": "clawhive_internal_token" if secrets.get("clawhive_internal_token") else None,
        "litellm_enabled": bool(settings.litellm_enabled),
        "vault_at_rest_enabled": _vault_fernet() is not None,
    }
