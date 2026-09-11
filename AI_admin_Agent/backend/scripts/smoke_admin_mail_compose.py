"""P0/P1：mail_compose 契约 + HITL override + 批量草稿装配（不真发 SMTP、不调 LLM）。"""
from __future__ import annotations

import inspect
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("ADMIN_PROMPT_EVOLUTION", "0")


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    from app.core.mail_compose import (
        apply_mail_compose_override,
        assemble_batch_draft_composes,
        build_mail_compose,
        compose_prefills_from_minutes_actions,
        compose_prefills_from_report_body,
        compose_prefills_from_upstream_handoff,
        mail_compose_digest,
        resolve_recipient_to_email,
    )
    from app.core.mail_pending_preview import format_mail_pending_preview
    from app.core.risky_hitl import requires_risky_hitl

    compose = build_mail_compose(
        "send_email",
        {
            "to": "a@example.com",
            "cc": "cc@example.com",
            "subject": "周报",
            "content": "本周完成三项。",
        },
        from_address="me@qq.com",
    )
    assert_true(compose["to"] == "a@example.com", "compose to")
    assert_true(compose["subject"] == "周报", "compose subject")
    assert_true(compose["content"] == "本周完成三项。", "compose content")
    assert_true(compose["editable"] is True, "compose editable")
    assert_true(str(compose["digest"]).startswith("sha256:"), "compose digest")
    assert_true(mail_compose_digest(compose) == compose["digest"], "digest stable")

    delete_c = build_mail_compose("delete_email", {"email_id": 3}, from_address="me@qq.com")
    assert_true(delete_c.get("editable") is False, "delete not editable")
    assert_true(delete_c.get("content") == "", "delete no body edit")

    prev = format_mail_pending_preview(
        "send_email",
        {
            "user_id": "smoke_compose_u",
            "to": "a@example.com",
            "subject": "周报",
            "content": "本周完成三项。",
        },
        from_address="me@qq.com",
    )
    mc = prev.get("mail_compose") or {}
    assert_true(isinstance(mc, dict) and mc.get("to") == "a@example.com", "preview mail_compose")
    assert_true("Compose" in str(prev.get("message") or "") or "确认" in str(prev.get("message") or ""), "preview msg")

    edited = apply_mail_compose_override(
        {"to": "a@example.com", "subject": "周报", "content": "旧正文"},
        {"to": "b@example.com", "subject": "更新主题", "content": "新正文", "cc": ""},
        tool_name="send_email",
    )
    assert_true(edited["to"] == "b@example.com", "override to")
    assert_true(edited["subject"] == "更新主题", "override subject")
    assert_true(edited["content"] == "新正文", "override content")
    assert_true("__mail_compose_commit_digest__" in edited, "commit digest")

    batch = assemble_batch_draft_composes(
        [
            {"email_id": 1, "to": "x@ex.com", "subject": "A", "draft_content": "收到"},
            {"email_id": 2, "to": "y@ex.com", "subject": "B", "content": "谢谢"},
            {"email_id": 3, "to": "z@ex.com", "subject": "C"},  # no body → skip
        ]
    )
    assert_true(len(batch) == 2, "batch assemble count")
    assert_true(batch[0]["tool"] == "reply_email", "batch reply tool")
    assert_true(batch[0]["content"] == "收到", "batch content")

    prefill = compose_prefills_from_report_body(
        "## 周报\n- 完成 A",
        to="boss@ex.com",
        subject="本周周报",
        from_address="me@qq.com",
    )
    assert_true(prefill["to"] == "boss@ex.com", "weekly prefill to")
    assert_true("完成 A" in prefill["content"], "weekly prefill body")

    minutes_prefill = compose_prefills_from_minutes_actions(
        [
            {"title": "推进需求评审", "assignee": "张三", "due_expression": "周五"},
            {"title": "补齐测试用例"},
        ],
        to="boss@ex.com",
    )
    assert_true(minutes_prefill["to"] == "boss@ex.com", "minutes prefill to")
    assert_true("推进需求评审" in minutes_prefill["content"], "minutes prefill body")
    assert_true(minutes_prefill.get("editable") is True, "minutes compose editable")

    up = compose_prefills_from_upstream_handoff(
        {
            "summary": "库表查询：在院人数 42",
            "entities": [{"name": "张三", "kind": "person"}],
            "metrics": [{"name": "在院人数", "value": "42"}],
            "to": "zhangsan@ex.com",
        },
        subject="人数同步",
    )
    assert_true(up["to"] == "zhangsan@ex.com", "upstream handoff to")
    assert_true("42" in up["content"] or "张三" in up["content"], "upstream handoff body")
    assert_true(up.get("editable") is True, "upstream compose editable")

    from app.core.outbound_email_compose import enrich_send_email_args

    enriched = enrich_send_email_args(
        {"to": "boss@ex.com", "content": ""},
        user_message="把结果发给老板",
        upstream_handoff={
            "summary": "db 查询完成：人数 42",
            "metrics": [{"name": "人数", "value": "42"}],
        },
    )
    assert_true("42" in str(enriched.get("content") or ""), "enrich uses upstream handoff")

    email, reason = resolve_recipient_to_email("alice@ex.com", lambda _n: "nope")
    assert_true(email == "alice@ex.com" and reason == "email_literal", "literal email")
    email2, reason2 = resolve_recipient_to_email("张三", lambda n: "zhangsan@ex.com" if n == "张三" else "")
    assert_true(email2 == "zhangsan@ex.com" and reason2 == "contact_resolved", "contact resolve")
    email3, reason3 = resolve_recipient_to_email("李四", lambda _n: "CONTACT_NOT_FOUND")
    assert_true(email3 is None and reason3 == "contact_not_found", "contact missing")

    assert_true(
        requires_risky_hitl("send_email", auto_confirm_risky=False),
        "send still HITL",
    )
    assert_true(
        not requires_risky_hitl("draft_batch_email_replies", auto_confirm_risky=False),
        "batch draft not forced HITL by name alone if not RISKY",
    )
    from app.tools.registry import RISKY_TOOLS, AVAILABLE_TOOLS

    assert_true("draft_batch_email_replies" in AVAILABLE_TOOLS, "batch tool registered")
    assert_true("draft_batch_email_replies" not in RISKY_TOOLS, "batch draft not RISKY")
    assert_true("send_email" in RISKY_TOOLS, "send still RISKY")

    # 工具装配路径（无 LLM）
    from app.tools.email import draft_batch_email_replies

    packed = draft_batch_email_replies(
        items=[
            {"email_id": 9, "to": "a@ex.com", "subject": "Hi", "draft_content": "OK"},
        ],
        session_id="smoke-compose",
    )
    assert_true(packed.get("ok"), "batch tool ok")
    assert_true((packed.get("data") or {}).get("count") == 1, "batch tool count")

    # 确认口令：不得把「待确认/改写草稿」当成 bare confirm
    from app.core.pending_confirm_parse import (
        detect_confirmation_without_id,
        extract_direct_confirmation,
    )
    from app.core.admin_nlu import normalize_mail_outbound_understanding
    from app.core.outbound_email_compose import needs_outbound_body_compose
    from app.core.mail_pending_preview import format_mail_pending_preview as _fmt_empty_body

    # P1：有收件人、无正文 → 不澄清；仍可进 mail_compose pending
    send_ok = normalize_mail_outbound_understanding(
        {
            "intent": "邮件",
            "needs_clarification": True,
            "clarification_questions": ["请提供邮件正文"],
            "slots": {
                "mail_action": "send",
                "email_to_name_or_email": "张三",
                "email_subject": "",
                "email_content": "",
            },
        }
    )
    assert_true(send_ok.get("needs_clarification") is False, "send with to: no body clarify")
    assert_true(not send_ok.get("clarification_questions"), "send clears body questions")

    send_need_to = normalize_mail_outbound_understanding(
        {
            "intent": "邮件",
            "needs_clarification": False,
            "clarification_questions": [],
            "slots": {"mail_action": "send", "email_to_name_or_email": "", "email_content": ""},
        }
    )
    assert_true(send_need_to.get("needs_clarification") is True, "send missing to clarifies")

    reply_ok = normalize_mail_outbound_understanding(
        {
            "intent": "邮件",
            "needs_clarification": True,
            "clarification_questions": ["请提供正文"],
            "slots": {"mail_action": "reply", "email_id": "", "email_content": ""},
        }
    )
    assert_true(reply_ok.get("needs_clarification") is False, "reply: empty body not clarify")

    empty_prev = _fmt_empty_body(
        "send_email",
        {"user_id": "smoke_compose_u", "to": "a@example.com", "subject": "", "content": ""},
        from_address="me@qq.com",
    )
    empty_mc = empty_prev.get("mail_compose") or {}
    assert_true(isinstance(empty_mc, dict) and empty_mc.get("to") == "a@example.com", "empty body still compose")
    assert_true(empty_mc.get("editable") is True, "empty body compose editable")

    # playbook 契约：SlotFill 禁止因缺正文澄清
    from app.core.admin_playbook_prompts import get_slot_fill_rules

    slot_rules = get_slot_fill_rules("邮件")
    assert_true("禁止" in slot_rules and "正文" in slot_rules, "slot fill forbids body clarify")
    assert_true("Compose" in slot_rules or "收件人" in slot_rules, "slot fill mentions Compose/recipient")

    refine = "请改写邮件草稿正文（不要发送）。语气：更正式。当前正文：\n说明本周进度已完成，语气正式"
    assert_true(
        not detect_confirmation_without_id(refine).get("is_confirmation_intent"),
        "refine must not be bare confirm",
    )
    assert_true(
        not detect_confirmation_without_id("请只改写待确认邮件草稿正文").get("is_confirmation_intent"),
        "待确认 substring must not bare-confirm",
    )
    assert_true(
        detect_confirmation_without_id("确认").get("is_confirmation_intent"),
        "bare 确认 still works",
    )
    assert_true(
        extract_direct_confirmation("确认 42").get("is_confirmation")
        and extract_direct_confirmation("确认 42").get("action_id") == 42,
        "确认 42 ok",
    )
    assert_true(
        not extract_direct_confirmation(refine).get("is_confirmation"),
        "refine not direct confirm",
    )

    user = "给张三发一封邮件，说明本周进度已完成，语气正式"
    intent_body = "说明本周进度已完成，语气正式"
    assert_true(needs_outbound_body_compose(intent_body, user), "intent fragment needs compose")
    assert_true(needs_outbound_body_compose("", user), "empty needs compose")
    assert_true(
        not needs_outbound_body_compose(
            "张三您好：\n\n本周各项工作进度均已完成，特此告知。\n\n此致\n敬礼",
            user,
        ),
        "real letter body no expand",
    )

    from app.core.outbound_email_compose import refine_outbound_email_body
    from app.tools import pending as pending_mod
    from app.tools.pending import patch_pending_mail_compose

    assert_true(callable(refine_outbound_email_body), "refine fn")
    assert_true(callable(patch_pending_mail_compose), "patch pending fn")
    # 空正文不改写（不调 LLM）
    assert_true(refine_outbound_email_body("", "缩短") == "", "empty refine")
    # 契约：close 前拷贝标量，避免 DetachedInstanceError 导致 refine 500
    src = inspect.getsource(pending_mod.patch_pending_mail_compose)
    assert_true("DetachedInstanceError" in src or "拷贝标量" in src, "patch docs detached fix")
    assert_true("tool_name = \"\"" in src or "tool_name = ''" in src, "patch predeclare tool_name")
    assert_true("err is not None" in src or "if err is not None" in src, "patch err path after close")

    print("smoke_admin_mail_compose: ok")


if __name__ == "__main__":
    main()
