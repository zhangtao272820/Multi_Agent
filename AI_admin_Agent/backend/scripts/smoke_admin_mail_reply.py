"""读信回复：用户原话优先；翻译须交连贯译文，禁止字段卡片顶替。"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("ADMIN_LOAD_PLAYBOOK", "0")


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def _has_field_card_prefixes(text: str) -> bool:
    for prefix in ("仓库：", "工作流：", "标题："):
        if prefix in text:
            return True
    return False


def main() -> None:
    from app.core.admin_mail_reply import (
        assemble_translation_narrative,
        compose_mail_read_reply,
        extract_mail_detail_payload,
        format_mail_read_fallback,
    )

    res = {
        "ok": True,
        "human_message": "邮件 #1：Run failed\n\nbody here",
        "data": {
            "email_id": 1,
            "subject": "Run failed: Manager Agent E2E Nightly",
            "from_email": "notifications@github.com",
            "from_name": "github",
            "body": "Repository: Multi_Agent\nWorkflow: Manager Agent E2E Nightly\nci-gate failed\ne2e-golden failed",
        },
    }
    detail = extract_mail_detail_payload(res)
    assert_true(detail is not None and detail["email_id"] == 1, "extract detail")

    fb = format_mail_read_fallback(detail)
    assert_true("工具结果" in fb or "邮件 #" in fb, "neutral fallback")
    assert_true("ci-gate" in fb, "keeps body")

    narrative = assemble_translation_narrative(detail)
    assert_true("主题为" in narrative or "正文" in narrative, f"narrative assemble: {narrative!r}")
    assert_true(not _has_field_card_prefixes(narrative), f"narrative must not be field card: {narrative!r}")

    # --- path: rewrite succeeds after field-card first turn ---
    calls: list[list] = []

    def _fake_llm_rewrite_ok(messages):
        calls.append(messages)
        flat = "\n".join(str(m.get("content") or "") for m in messages)
        if "合格译文" in flat or "首轮不合格" in flat:
            return json.dumps(
                {"text": "仓库 Multi_Agent 上的 Manager Agent E2E Nightly 工作流已失败：ci-gate 与 e2e-golden 均未通过。"},
                ensure_ascii=False,
            )
        if '"ok"' in flat or "ok=true" in flat or "判断助理回复是否满足" in flat:
            # first card → not ok; rewritten prose → ok
            if "连贯中文" in flat and "工作流已失败" in flat:
                return '{"ok":true,"reason":"coherent"}'
            return '{"ok":false,"reason":"field card"}'
        assert_true("deliverable" in flat, "compose prompt asks for deliverable JSON")
        assert_true("翻译成简体中文" in flat or "只给我译文" in flat, "user ask in prompt")
        return json.dumps(
            {
                "deliverable": "translation",
                "text": "仓库：Multi_Agent\n工作流：Nightly\n任务执行情况：ci-gate 失败",
            },
            ensure_ascii=False,
        )

    out = compose_mail_read_reply(
        user_message="读取第一封并翻译成简体中文，只给我译文",
        detail=detail,
        understanding={"slots": {"mail_action": "read", "email_id": "1"}},
        llm_chat=_fake_llm_rewrite_ok,
    )
    assert_true("<<<UNTRUSTED" not in out, "no untrusted leak")
    assert_true(not _has_field_card_prefixes(out), f"rewrite path must not leak field card: {out!r}")
    assert_true("失败" in out or "ci-gate" in out, f"got deliverable: {out!r}")
    assert_true(len(calls) >= 2, "compose + judge/rewrite called")

    # --- path: judge/rewrite keep failing → deterministic narrative, no field-card prefixes ---
    def _fake_llm_all_bad(messages):
        flat = "\n".join(str(m.get("content") or "") for m in messages)
        if "合格译文" in flat or "首轮不合格" in flat:
            return json.dumps(
                {"text": "标题：Run failed\n仓库：Multi_Agent\n工作流：Nightly"},
                ensure_ascii=False,
            )
        if "判断助理回复是否满足" in flat or '"ok"' in flat:
            return '{"ok":false,"reason":"still card"}'
        return json.dumps(
            {
                "deliverable": "translation",
                "text": "标题：Run failed\n仓库：Multi_Agent\n工作流：Nightly",
            },
            ensure_ascii=False,
        )

    out_fb = compose_mail_read_reply(
        user_message="读取未读第一封邮件正文，翻译成简体中文，只给我译文",
        detail=detail,
        llm_chat=_fake_llm_all_bad,
    )
    assert_true(not _has_field_card_prefixes(out_fb), f"deterministic fallback must not be field card: {out_fb!r}")
    assert_true("主题为" in out_fb or "正文" in out_fb or "是" in out_fb, f"fallback narrative: {out_fb!r}")

    # --- path: invalid JSON → neutral fallback ---
    def _fake_llm_garbage(_messages):
        return "not-json"

    out_parse = compose_mail_read_reply(
        user_message="翻译这封邮件",
        detail=detail,
        llm_chat=_fake_llm_garbage,
    )
    assert_true("工具结果" in out_parse or "邮件 #" in out_parse, f"parse fail → fallback: {out_parse!r}")

    from app.core.admin_turn_scope import classify_admin_turn_scope

    os.environ.setdefault("ADMIN_TURN_SCOPE_LLM", "0")
    follow = classify_admin_turn_scope(
        "翻译",
        "用户：读取第一封邮件正文\n助手：已读取邮件 #1：……",
    )
    assert_true(
        follow.turn_kind == "output_followup",
        f"short 翻译 → output_followup, got {follow.turn_kind!r}",
    )

    print("smoke_admin_mail_reply OK")


if __name__ == "__main__":
    main()
