"""邮箱授权码 Fernet 加解密（禁止入库明文）。"""
from __future__ import annotations

import base64
import hashlib
import logging
import os

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)


def _derive_fernet_key() -> bytes:
    raw = str(os.getenv("ADMIN_MAIL_FERNET_KEY") or "").strip()
    if raw:
        try:
            key_bytes = raw.encode("utf-8")
            Fernet(key_bytes)
            return key_bytes
        except Exception:
            return base64.urlsafe_b64encode(hashlib.sha256(raw.encode("utf-8")).digest())
    seed = (
        str(os.getenv("CLAWHIVE_INTERNAL_TOKEN") or "").strip()
        or str(os.getenv("AGENT_INTERNAL_TOKEN") or "").strip()
        or str(os.getenv("DASHSCOPE_API_KEY") or "").strip()
        or "admin-mail-dev-insecure"
    )
    if seed == "admin-mail-dev-insecure":
        logger.warning("ADMIN_MAIL_FERNET_KEY unset; using insecure dev derivation")
    else:
        logger.warning("ADMIN_MAIL_FERNET_KEY unset; deriving from internal token / API key")
    return base64.urlsafe_b64encode(hashlib.sha256(seed.encode("utf-8")).digest())


def get_fernet() -> Fernet:
    return Fernet(_derive_fernet_key())


def encrypt_secret(plain: str) -> str:
    text = str(plain or "")
    if not text:
        raise ValueError("empty_secret")
    return get_fernet().encrypt(text.encode("utf-8")).decode("utf-8")


def decrypt_secret(cipher: str) -> str:
    token = str(cipher or "").strip()
    if not token:
        raise ValueError("empty_cipher")
    try:
        return get_fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken as e:
        raise ValueError("decrypt_failed") from e
