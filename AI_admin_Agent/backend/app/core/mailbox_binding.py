"""按用户绑定国内邮箱（IMAP/SMTP + 授权码）与凭据解析。"""
from __future__ import annotations

import datetime
import imaplib
import os
import re
import smtplib
from dataclasses import dataclass
from typing import Any

from app.core.mailbox_crypto import decrypt_secret, encrypt_secret
from app.db.database import MailboxBinding, SessionLocal

_EMAIL_RE = re.compile(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$")

PROVIDER_PRESETS: dict[str, dict[str, Any]] = {
    "qq": {
        "label": "QQ 邮箱",
        "imap_server": "imap.qq.com",
        "imap_port": 993,
        "smtp_server": "smtp.qq.com",
        "smtp_port": 465,
        "folders": {"inbox": "INBOX", "sent": "Sent Messages", "drafts": "Drafts", "trash": "Trash"},
    },
    "163": {
        "label": "网易 163",
        "imap_server": "imap.163.com",
        "imap_port": 993,
        "smtp_server": "smtp.163.com",
        "smtp_port": 465,
        "folders": {"inbox": "INBOX", "sent": "Sent Messages", "drafts": "Drafts", "trash": "Trash"},
    },
    "126": {
        "label": "网易 126",
        "imap_server": "imap.126.com",
        "imap_port": 993,
        "smtp_server": "smtp.126.com",
        "smtp_port": 465,
        "folders": {"inbox": "INBOX", "sent": "Sent Messages", "drafts": "Drafts", "trash": "Trash"},
    },
    "exmail": {
        "label": "腾讯企业邮",
        "imap_server": "imap.exmail.qq.com",
        "imap_port": 993,
        "smtp_server": "smtp.exmail.qq.com",
        "smtp_port": 465,
        "folders": {"inbox": "INBOX", "sent": "Sent Messages", "drafts": "Drafts", "trash": "Trash"},
    },
}

ALLOWED_PROVIDERS = frozenset(PROVIDER_PRESETS.keys())


@dataclass(frozen=True)
class MailCredentials:
    user_id: str
    email_address: str
    auth_code: str
    imap_server: str
    imap_port: int
    smtp_server: str
    smtp_port: int
    provider: str
    source: str  # binding | global_fallback


def sanitize_user_id(user_id: str | None) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "", str(user_id or "").strip())[:64]


def allow_global_fallback() -> bool:
    return str(os.getenv("ADMIN_MAIL_ALLOW_GLOBAL_FALLBACK") or "0").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def list_provider_presets() -> list[dict[str, Any]]:
    out = []
    for pid, meta in PROVIDER_PRESETS.items():
        out.append(
            {
                "id": pid,
                "label": meta["label"],
                "imap_server": meta["imap_server"],
                "imap_port": meta["imap_port"],
                "smtp_server": meta["smtp_server"],
                "smtp_port": meta["smtp_port"],
            }
        )
    return out


def folder_name(provider: str, kind: str = "inbox") -> str:
    preset = PROVIDER_PRESETS.get(str(provider or "").strip().lower()) or PROVIDER_PRESETS["qq"]
    folders = preset.get("folders") or {}
    return str(folders.get(kind) or folders.get("inbox") or "INBOX")


def _global_fallback_credentials() -> MailCredentials | None:
    from app.core.config import settings

    user = (settings.IMAP_USER or settings.SMTP_USER or "").strip()
    password = (settings.IMAP_PASS or settings.SMTP_PASS or "").strip()
    if not user or not password:
        return None
    imap_server = (settings.IMAP_SERVER or settings.SMTP_SERVER.replace("smtp.", "imap.") or "").strip()
    smtp_server = (settings.SMTP_SERVER or "").strip() or imap_server.replace("imap.", "smtp.")
    if not imap_server:
        return None
    return MailCredentials(
        user_id="",
        email_address=user,
        auth_code=password,
        imap_server=imap_server,
        imap_port=int(settings.IMAP_PORT or 993),
        smtp_server=smtp_server,
        smtp_port=int(settings.SMTP_PORT or 465),
        provider="global",
        source="global_fallback",
    )


def get_binding_row(user_id: str) -> MailboxBinding | None:
    uid = sanitize_user_id(user_id)
    if not uid:
        return None
    db = SessionLocal()
    try:
        return db.query(MailboxBinding).filter(MailboxBinding.user_id == uid).first()
    finally:
        db.close()


def binding_public_status(user_id: str) -> dict[str, Any]:
    uid = sanitize_user_id(user_id)
    if not uid:
        return {"bound": False, "user_id": "", "code": "email_not_bound"}
    row = get_binding_row(uid)
    if not row:
        return {"bound": False, "user_id": uid, "code": "email_not_bound"}
    return {
        "bound": True,
        "user_id": uid,
        "provider": row.provider,
        "email_address": row.email_address,
        "imap_server": row.imap_server,
        "smtp_server": row.smtp_server,
        "verified_at": row.verified_at.isoformat() if row.verified_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "code": "ok",
    }


def resolve_mail_credentials(user_id: str | None) -> tuple[MailCredentials | None, str]:
    """
    Returns (creds, error_code). error_code empty on success.
    """
    uid = sanitize_user_id(user_id)
    row = get_binding_row(uid) if uid else None
    if row:
        try:
            auth = decrypt_secret(row.auth_code_cipher)
        except Exception:
            return None, "mailbox_decrypt_failed"
        return (
            MailCredentials(
                user_id=uid,
                email_address=row.email_address,
                auth_code=auth,
                imap_server=row.imap_server,
                imap_port=int(row.imap_port or 993),
                smtp_server=row.smtp_server,
                smtp_port=int(row.smtp_port or 465),
                provider=row.provider or "qq",
                source="binding",
            ),
            "",
        )
    if allow_global_fallback():
        fb = _global_fallback_credentials()
        if fb:
            return fb, ""
    if not uid:
        return None, "email_not_bound"
    return None, "email_not_bound"


def test_imap_smtp(creds: MailCredentials) -> tuple[bool, str]:
    try:
        mailbox = imaplib.IMAP4_SSL(creds.imap_server, int(creds.imap_port))
        mailbox.login(creds.email_address, creds.auth_code)
        mailbox.select("INBOX", readonly=True)
        mailbox.logout()
    except Exception as e:
        return False, f"IMAP 连通失败: {e}"
    try:
        with smtplib.SMTP_SSL(creds.smtp_server, int(creds.smtp_port), timeout=20) as server:
            server.login(creds.email_address, creds.auth_code)
    except Exception as e:
        return False, f"SMTP 连通失败: {e}"
    return True, "连通成功"


def upsert_binding(
    user_id: str,
    *,
    provider: str,
    email_address: str,
    auth_code: str,
    test_first: bool = True,
) -> dict[str, Any]:
    uid = sanitize_user_id(user_id)
    if not uid:
        return {"ok": False, "code": "email_not_bound", "human_message": "缺少 user_id，无法绑定邮箱。"}
    pid = str(provider or "").strip().lower()
    if pid not in ALLOWED_PROVIDERS:
        return {
            "ok": False,
            "code": "unsupported_mail_provider",
            "human_message": f"不支持的邮箱厂商：{provider}。可选：{', '.join(sorted(ALLOWED_PROVIDERS))}",
        }
    email_addr = str(email_address or "").strip()
    code = str(auth_code or "").strip()
    if not _EMAIL_RE.match(email_addr):
        return {"ok": False, "code": "invalid_mailbox_email", "human_message": "邮箱地址格式无效。"}
    if not code:
        return {"ok": False, "code": "missing_auth_code", "human_message": "请填写授权码（勿填登录密码）。"}
    preset = PROVIDER_PRESETS[pid]
    creds = MailCredentials(
        user_id=uid,
        email_address=email_addr,
        auth_code=code,
        imap_server=str(preset["imap_server"]),
        imap_port=int(preset["imap_port"]),
        smtp_server=str(preset["smtp_server"]),
        smtp_port=int(preset["smtp_port"]),
        provider=pid,
        source="binding",
    )
    if test_first:
        ok, msg = test_imap_smtp(creds)
        if not ok:
            return {"ok": False, "code": "mailbox_connect_failed", "human_message": msg}
    cipher = encrypt_secret(code)
    now = datetime.datetime.utcnow()
    db = SessionLocal()
    try:
        row = db.query(MailboxBinding).filter(MailboxBinding.user_id == uid).first()
        if row is None:
            row = MailboxBinding(user_id=uid)
            db.add(row)
        row.provider = pid
        row.email_address = email_addr
        row.auth_code_cipher = cipher
        row.imap_server = creds.imap_server
        row.imap_port = creds.imap_port
        row.smtp_server = creds.smtp_server
        row.smtp_port = creds.smtp_port
        row.verified_at = now if test_first else row.verified_at
        row.updated_at = now
        db.commit()
    except Exception as e:
        db.rollback()
        return {"ok": False, "code": "mailbox_bind_failed", "human_message": f"绑定保存失败: {e}"}
    finally:
        db.close()
    status = binding_public_status(uid)
    status["ok"] = True
    status["human_message"] = "邮箱绑定成功。" if test_first else "邮箱绑定已保存。"
    return status


def delete_binding(user_id: str) -> dict[str, Any]:
    uid = sanitize_user_id(user_id)
    if not uid:
        return {"ok": False, "code": "email_not_bound", "human_message": "缺少 user_id。"}
    db = SessionLocal()
    try:
        row = db.query(MailboxBinding).filter(MailboxBinding.user_id == uid).first()
        if not row:
            return {"ok": True, "bound": False, "user_id": uid, "code": "ok", "human_message": "当前未绑定。"}
        db.delete(row)
        db.commit()
        return {"ok": True, "bound": False, "user_id": uid, "code": "ok", "human_message": "已解绑并删除密文。"}
    except Exception as e:
        db.rollback()
        return {"ok": False, "code": "mailbox_unbind_failed", "human_message": str(e)}
    finally:
        db.close()


def test_binding_input(
    user_id: str,
    *,
    provider: str,
    email_address: str,
    auth_code: str,
) -> dict[str, Any]:
    uid = sanitize_user_id(user_id)
    pid = str(provider or "").strip().lower()
    if pid not in ALLOWED_PROVIDERS:
        return {"ok": False, "code": "unsupported_mail_provider", "human_message": "不支持的邮箱厂商。"}
    email_addr = str(email_address or "").strip()
    code = str(auth_code or "").strip()
    if not code and uid:
        # Re-test stored binding
        creds, err = resolve_mail_credentials(uid)
        if err or not creds or creds.source != "binding":
            return {"ok": False, "code": err or "email_not_bound", "human_message": "未绑定或无法解密凭据。"}
        ok, msg = test_imap_smtp(creds)
        return {"ok": ok, "code": "ok" if ok else "mailbox_connect_failed", "human_message": msg}
    if not _EMAIL_RE.match(email_addr) or not code:
        return {"ok": False, "code": "missing_auth_code", "human_message": "请提供邮箱与授权码。"}
    preset = PROVIDER_PRESETS[pid]
    creds = MailCredentials(
        user_id=uid,
        email_address=email_addr,
        auth_code=code,
        imap_server=str(preset["imap_server"]),
        imap_port=int(preset["imap_port"]),
        smtp_server=str(preset["smtp_server"]),
        smtp_port=int(preset["smtp_port"]),
        provider=pid,
        source="binding",
    )
    ok, msg = test_imap_smtp(creds)
    return {"ok": ok, "code": "ok" if ok else "mailbox_connect_failed", "human_message": msg}
