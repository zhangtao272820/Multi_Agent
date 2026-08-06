"""A0：按用户邮箱绑定契约（无真箱）。加密 round-trip / A-B 隔离 / 未绑定错误码 / fallback 开关。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("ADMIN_PROMPT_EVOLUTION", "0")
os.environ["ADMIN_MAIL_ALLOW_GLOBAL_FALLBACK"] = "0"
os.environ.setdefault("ADMIN_MAIL_FERNET_KEY", "smoke-admin-mailbox-binding-test-key-32b")


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    from app.core.mailbox_crypto import decrypt_secret, encrypt_secret
    from app.core.mailbox_binding import (
        ALLOWED_PROVIDERS,
        binding_public_status,
        delete_binding,
        resolve_mail_credentials,
        upsert_binding,
    )
    from app.db.database import MailboxBinding, SessionLocal
    from app.tools.email import list_emails
    from app.tools.common import mail_cache_key, set_mail_cache, get_mail_cache

    # crypto round-trip
    cipher = encrypt_secret("auth-code-secret")
    assert_true("auth-code-secret" not in cipher, "cipher must not contain plaintext")
    assert_true(decrypt_secret(cipher) == "auth-code-secret", "decrypt round-trip")

    assert_true("qq" in ALLOWED_PROVIDERS and "163" in ALLOWED_PROVIDERS, "provider whitelist")

    # clean fixtures
    for uid in ("smoke_user_a", "smoke_user_b"):
        delete_binding(uid)

    # unbound
    creds, err = resolve_mail_credentials("smoke_user_a")
    assert_true(creds is None and err == "email_not_bound", "unbound -> email_not_bound")
    listed = list_emails(session_id="s1", user_id="smoke_user_a")
    assert_true(isinstance(listed, dict) and listed.get("code") == "email_not_bound", "list unbound code")

    # upsert without live IMAP: test_first=False
    bound = upsert_binding(
        "smoke_user_a",
        provider="qq",
        email_address="a@qq.com",
        auth_code="code-a-secret",
        test_first=False,
    )
    assert_true(bound.get("ok") and bound.get("bound"), f"bind A failed: {bound}")
    status = binding_public_status("smoke_user_a")
    assert_true(status.get("email_address") == "a@qq.com", "public status email")
    assert_true("code-a-secret" not in str(status), "status must not leak auth code")

    db = SessionLocal()
    try:
        row = db.query(MailboxBinding).filter(MailboxBinding.user_id == "smoke_user_a").first()
        assert_true(row is not None, "row exists")
        assert_true("code-a-secret" not in (row.auth_code_cipher or ""), "db cipher no plaintext")
    finally:
        db.close()

    creds_a, err_a = resolve_mail_credentials("smoke_user_a")
    assert_true(err_a == "" and creds_a is not None, "resolve A")
    assert_true(creds_a.auth_code == "code-a-secret", "decrypt A auth")
    assert_true(creds_a.imap_server == "imap.qq.com", "qq imap host")

    upsert_binding(
        "smoke_user_b",
        provider="163",
        email_address="b@163.com",
        auth_code="code-b-secret",
        test_first=False,
    )
    creds_b, err_b = resolve_mail_credentials("smoke_user_b")
    assert_true(err_b == "" and creds_b is not None, "resolve B")
    assert_true(creds_b.auth_code == "code-b-secret", "decrypt B")
    assert_true(creds_a.auth_code != creds_b.auth_code, "A/B isolation secrets")
    assert_true(creds_b.imap_server == "imap.163.com", "163 host")

    # mail cache isolation
    set_mail_cache("smoke_user_a", "sess", {1: {"subject": "A"}})
    set_mail_cache("smoke_user_b", "sess", {1: {"subject": "B"}})
    assert_true(get_mail_cache("smoke_user_a", "sess")[1]["subject"] == "A", "cache A")
    assert_true(get_mail_cache("smoke_user_b", "sess")[1]["subject"] == "B", "cache B")
    assert_true(
        mail_cache_key("smoke_user_a", "sess") != mail_cache_key("smoke_user_b", "sess"),
        "cache keys differ",
    )

    # unsupported provider
    bad = upsert_binding(
        "smoke_user_a",
        provider="gmail",
        email_address="x@gmail.com",
        auth_code="x",
        test_first=False,
    )
    assert_true(not bad.get("ok") and bad.get("code") == "unsupported_mail_provider", "block gmail")

    # global fallback off
    os.environ["ADMIN_MAIL_ALLOW_GLOBAL_FALLBACK"] = "0"
    delete_binding("smoke_user_c")
    c_creds, c_err = resolve_mail_credentials("smoke_user_c")
    assert_true(c_creds is None and c_err == "email_not_bound", "no fallback")

    # cleanup
    delete_binding("smoke_user_a")
    delete_binding("smoke_user_b")
    print("smoke_admin_mailbox_binding: OK")


if __name__ == "__main__":
    main()
