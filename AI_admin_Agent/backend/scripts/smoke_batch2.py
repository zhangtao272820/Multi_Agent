"""Batch 2 smoke: prompt evolution, audit learning, learning API."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("ADMIN_PROMPT_EVOLUTION", "1")


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    from app.core.prompt_evolution import (
        append_prompt_patch,
        auto_promote_eligible_patches,
        clear_evolved_hints,
        clear_prompt_patches,
        get_prompt_evolution_summary,
        get_prompt_patches_for_stage,
        list_promotable_patches,
        list_prompt_patches,
        promote_prompt_patch,
    )

    with tempfile.TemporaryDirectory() as tmp:
        data = Path(tmp)
        shadow = data / "admin-prompt-patches.shadow.json"
        evolved = data / "admin-evolved-playbook.json"

        import app.core.prompt_evolution as pe

        pe._shadow_file = lambda: shadow  # type: ignore
        pe._evolved_file = lambda: evolved  # type: ignore

        clear_prompt_patches()
        clear_evolved_hints()

        append_prompt_patch(
            stage="planning",
            text="测试补丁：时间必须填用户原话",
            source="manual",
            tool_name="add_event",
            code="time_parse_failed",
        )
        append_prompt_patch(
            stage="planning",
            text="测试补丁：时间必须填用户原话",
            source="manual",
            tool_name="add_event",
            code="time_parse_failed",
        )
        patches = list_prompt_patches()
        assert_true(len(patches) == 1 and patches[0]["hits"] == 2, "dedupe hits")

        block = get_prompt_patches_for_stage("planning")
        assert_true("进化提示" in block and "用户原话" in block, "patch injection block")

        from app.core.prompt_evolution import learn_from_tool_failure

        learn_from_tool_failure("reply_email", "email_not_found_in_cache")
        assert_true(any("list_emails" in p.get("text", "") for p in list_prompt_patches()), "rule patch")

        # promote with min hits 2（convergence 下 routing 不可晋级，用 planning）
        for _ in range(2):
            append_prompt_patch(
                stage="planning",
                text="确认必须带编号",
                source="manual",
                code="pending_not_found",
            )

        os.environ["ADMIN_PROMOTE_MIN_HITS"] = "2"
        promotable = list_promotable_patches(2)
        assert_true(len(promotable) >= 1, "promotable planning patch")
        pid = promotable[0]["id"]
        res = promote_prompt_patch(pid)
        assert_true(res.get("ok"), f"promote failed: {res}")
        assert_true(evolved.is_file(), "evolved file should exist")

        # routing 读侧门禁：execution_only 下不得注入意图路由 prompt
        append_prompt_patch(stage="routing", text="不应注入的路由补丁", source="manual")
        assert_true(get_prompt_patches_for_stage("routing") == "", "routing patch blocked on read")

        summary = get_prompt_evolution_summary()
        assert_true(summary.get("evolvedHintCount", 0) >= 1, "evolved count")

        # 撤回/重生：反馈影子补丁作废，不进学习面
        from app.core.prompt_evolution import supersede_prompt_patches_for_revision

        append_prompt_patch(
            stage="planning",
            text="用户标记无用：日程写错了",
            source="feedback",
            session_id="adm-sess-1",
            user_message_index=2,
        )
        voided = supersede_prompt_patches_for_revision(
            session_id="adm-sess-1",
            user_message_index=2,
            reason="regenerate",
        )
        assert_true(int(voided.get("voided") or 0) >= 1, "feedback patch voided on regen")
        assert_true(
            not any(
                p.get("session_id") == "adm-sess-1" and p.get("user_message_index") == 2
                for p in list_prompt_patches()
            ),
            "voided feedback patch excluded from list",
        )

    from app.core.audit_learning import scan_audit_logs, get_audit_learning_summary

    stats = scan_audit_logs(limit=10)
    assert_true("sampleSize" in stats, "audit scan shape")
    learn_sum = get_audit_learning_summary()
    assert_true("audit" in learn_sum, "audit summary")

    from app.core.learning_curator import get_learning_payload, run_learning_curator

    payload = get_learning_payload()
    assert_true("evolution" in payload and "promptPatches" in payload, "learning payload")
    report = run_learning_curator(auto_promote=False, ingest_audit=False)
    assert_true(report.get("ts"), "curator report")

    from app.core.admin_playbook_prompts import get_planning_rules

    rules = get_planning_rules()
    assert_true(isinstance(rules, str) and len(rules) > 10, "planning rules with evolution")

    print("smoke: admin-batch2 ok")


if __name__ == "__main__":
    main()
