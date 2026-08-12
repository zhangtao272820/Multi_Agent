"""邮件兜底规划：read ≠ triage；slots/scenario 驱动；多 paraphrase 同链。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("ADMIN_LOAD_PLAYBOOK", "0")


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def _names(plan: list) -> list[str]:
    return [p["name"] for p in plan]


def main() -> None:
    from app.core.admin_mail_plan import (
        build_mail_fallback_plan,
        resolve_mail_action,
        unread_only_from_slots,
    )
    from app.core.admin_slot_inject import inject_slots_into_plan

    # 多种说法 → 同一 read 链（契约绑 slots，不绑单一问句）
    read_paraphrases = [
        "读取未读第一封正文并翻译",
        "把这封邮件翻译成中文",
        "帮我摘要一下这封邮件",
        "抽出这封邮件的要点",
        "translate this email body into Chinese",
        "summarize the first unread email",
    ]
    for msg in read_paraphrases:
        u = {
            "admin_scenario": "email_read",
            "slots": {"mail_action": "read", "email_id": "1"},
        }
        plan = build_mail_fallback_plan(msg, u)
        assert_true(_names(plan) == ["list_emails", "get_email_detail"], f"read paraphrase: {msg!r} → {_names(plan)}")
        assert_true(plan[0]["args"].get("unread_only") is True, f"default unread for {msg!r}")
        assert_true(plan[1]["args"].get("email_id") == 1, "email_id=1")
        assert_true(resolve_mail_action(u) == "read", "resolve read")

    # 已读 / 指定封号：mail_unread_only=false
    read_all = {
        "admin_scenario": "email_read",
        "slots": {"mail_action": "read", "email_id": "3", "mail_unread_only": "false"},
    }
    plan_all = build_mail_fallback_plan("打开已读第3封看看内容", read_all)
    assert_true(_names(plan_all) == ["list_emails", "get_email_detail"], "read with id=3")
    assert_true(plan_all[0]["args"].get("unread_only") is False, "unread_only false from slots")
    assert_true(plan_all[1]["args"].get("email_id") == 3, "email_id=3")
    assert_true(unread_only_from_slots(read_all["slots"], default=True) is False, "helper false")

    # slots 优先于错误的 triage 场景
    mixed = {
        "admin_scenario": "email_triage",
        "slots": {"mail_action": "read", "email_id": "2"},
    }
    plan2 = build_mail_fallback_plan("读第2封", mixed)
    assert_true(
        _names(plan2) == ["list_emails", "get_email_detail"],
        "slots.read beats triage scenario",
    )
    assert_true(plan2[1]["args"].get("email_id") == 2, "email_id from slots")

    triage_u = {"admin_scenario": "email_triage", "slots": {"mail_action": "triage"}}
    plan3 = build_mail_fallback_plan("分拣收件箱", triage_u)
    assert_true(_names(plan3) == ["triage_emails"], "triage only")

    # 附件 / 分类确定性映射
    att_u = {
        "admin_scenario": "email_attachments",
        "slots": {"mail_action": "list_attachments", "email_id": "1"},
    }
    plan_att = build_mail_fallback_plan("这封邮件有哪些附件", att_u)
    assert_true(
        _names(plan_att) == ["list_emails", "list_email_attachments"],
        f"attachments got {_names(plan_att)}",
    )
    save_u = {
        "admin_scenario": "email_attachments",
        "slots": {"mail_action": "save_attachment", "email_id": "1", "attachment_index": "2"},
    }
    plan_save = build_mail_fallback_plan("保存第2个附件", save_u)
    assert_true(
        _names(plan_save) == ["list_emails", "save_email_attachment"],
        f"save attachment got {_names(plan_save)}",
    )
    assert_true(plan_save[1]["args"].get("attachment_index") == 2, "attachment_index=2")

    cls_u = {"admin_scenario": "email_classify", "slots": {"mail_action": "classify"}}
    plan_cls = build_mail_fallback_plan("给收件箱邮件打标签分类", cls_u)
    assert_true(_names(plan_cls) == ["classify_emails"], "classify only")
    assert_true(resolve_mail_action({"admin_scenario": "email_classify", "slots": {}}) == "classify", "scenario classify")

    # 无明确动作：返回空，交给规划 LLM（禁止默认 list 假装成功）
    empty = {"admin_scenario": "", "slots": {}}
    plan4 = build_mail_fallback_plan("邮件", empty)
    assert_true(plan4 == [], "empty action → no fake list")

    # slot inject：mail_unread_only / attachment 工具 email_id
    injected = inject_slots_into_plan(
        [{"name": "list_emails", "args": {}}, {"name": "list_email_attachments", "args": {}}],
        {"slots": {"mail_unread_only": "false", "email_id": "4"}},
    )
    assert_true(injected[0]["args"].get("unread_only") is False, "inject unread_only")
    assert_true(injected[1]["args"].get("email_id") == 4, "inject email_id for attachments")

    print("smoke_admin_mail_plan OK")


if __name__ == "__main__":
    main()
