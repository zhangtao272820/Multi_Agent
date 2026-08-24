"""AM：邮箱动手契约（无真箱）— 工具注册 / RISKY / 收件人策略 / search·mark 签名 / metrics。"""
from __future__ import annotations

import inspect
import os
import sys
from pathlib import Path
from unittest import mock

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("ADMIN_PROMPT_EVOLUTION", "0")
os.environ["ADMIN_MAIL_ALLOW_GLOBAL_FALLBACK"] = "0"
os.environ.setdefault("ADMIN_MAIL_FERNET_KEY", "smoke-admin-mail-hands-test-key-32bytes!!")


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    from app.core.mailbox_binding import MailCredentials, delete_binding, upsert_binding
    from app.core.mail_metrics import mail_metric_inc, mail_metrics_snapshot
    from app.core.risky_hitl import requires_risky_hitl
    from app.tools.registry import AVAILABLE_TOOLS, RISKY_TOOLS
    from app.tools import email as email_mod

    for name in (
        "search_emails",
        "mark_email_read",
        "forward_email",
        "delete_email",
        "list_emails",
        "send_email",
        "reply_email",
    ):
        assert_true(name in AVAILABLE_TOOLS, f"tool registered: {name}")

    for name in ("send_email", "reply_email", "forward_email", "delete_email"):
        assert_true(name in RISKY_TOOLS, f"RISKY: {name}")
        assert_true(requires_risky_hitl(name, auto_confirm_risky=False), f"HITL: {name}")

    assert_true("draft_email_reply" not in RISKY_TOOLS, "draft not risky")
    assert_true("mark_email_read" not in RISKY_TOOLS, "mark read not risky")

    # recipient: explicit email allowed
    allowed, source, _ = email_mod._recipient_allowed("friend@example.com")
    assert_true(allowed and source == "explicit_email", "explicit email ok")

    # signatures include user_id
    for name in ("list_emails", "search_emails", "send_email", "mark_email_read"):
        params = inspect.signature(AVAILABLE_TOOLS[name]).parameters
        assert_true("user_id" in params, f"{name} has user_id")

    delete_binding("smoke_hands_u")
    upsert_binding(
        "smoke_hands_u",
        provider="qq",
        email_address="hands@qq.com",
        auth_code="hands-secret",
        test_first=False,
    )

    # mark_email_read / search without live IMAP: expect cache miss / connect fail, not unbound
    miss = email_mod.mark_email_read(email_id=1, session_id="s", user_id="smoke_hands_u")
    assert_true(isinstance(miss, dict) and miss.get("code") == "email_not_found_in_cache", "mark needs cache")

    # mock IMAP search path briefly
    fake = MailCredentials(
        user_id="smoke_hands_u",
        email_address="hands@qq.com",
        auth_code="hands-secret",
        imap_server="imap.qq.com",
        imap_port=993,
        smtp_server="smtp.qq.com",
        smtp_port=465,
        provider="qq",
        source="binding",
    )
    with mock.patch("app.tools.email.resolve_mail_credentials", return_value=(fake, "")):
        with mock.patch("app.tools.email.imaplib.IMAP4_SSL") as imap_cls:
            conn = mock.MagicMock()
            imap_cls.return_value = conn
            conn.search.return_value = ("OK", [b""])
            out = email_mod.search_emails(subject="报销", user_id="smoke_hands_u", session_id="s")
            assert_true(isinstance(out, dict) and out.get("ok"), f"search empty ok: {out}")
            assert_true(out.get("code") == "empty", "empty search")

    mail_metric_inc("mail_list")
    snap = mail_metrics_snapshot()
    assert_true(snap.get("mail_list", 0) >= 1, "metrics mail_list")

    # AM-4：发信 pending 预览含 to/subject/from，不再套日程模板
    from app.core.mail_pending_preview import format_mail_pending_preview

    send_prev = format_mail_pending_preview(
        "send_email",
        {
            "user_id": "smoke_hands_u",
            "to": "friend@example.com",
            "cc": "cc@example.com",
            "subject": "报销进度",
            "content": "张三你好，报销已提交。",
            "attachment_paths": [".data/a.pdf"],
        },
        from_address="hands@qq.com",
    )
    msg = str(send_prev.get("message") or "")
    assert_true("friend@example.com" in msg, "preview to")
    assert_true("报销进度" in msg, "preview subject")
    assert_true("hands@qq.com" in msg, "preview from")
    assert_true("cc@example.com" in msg, "preview cc")
    assert_true("a.pdf" in msg, "preview attachment")
    assert_true("将添加「" not in msg, "not calendar template")

    reply_prev = format_mail_pending_preview(
        "reply_email",
        {
            "user_id": "smoke_hands_u",
            "email_id": 2,
            "content": "收到，谢谢。",
            "to": "boss@example.com",
            "subject": "周报",
        },
        from_address="hands@qq.com",
    )
    rmsg = str(reply_prev.get("message") or "")
    assert_true("回复" in rmsg and "boss@example.com" in rmsg, "reply preview")
    assert_true("Re: 周报" in rmsg or "周报" in rmsg, "reply subject")

    del_prev = format_mail_pending_preview(
        "delete_email",
        {"user_id": "smoke_hands_u", "email_id": 9, "subject": "广告"},
        from_address="hands@qq.com",
    )
    assert_true("废纸篓" in str(del_prev.get("message") or ""), "delete trash semantics")

    delete_binding("smoke_hands_u")
    print("smoke_admin_mail_hands: OK")


if __name__ == "__main__":
    main()
