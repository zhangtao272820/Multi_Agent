"""Smoke: Admin turn_scope 主题切换隔离（无 LLM）。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("ADMIN_TURN_SCOPE_LLM", "0")


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    from app.core.admin_turn_scope import (
        classify_admin_turn_scope,
        dialogue_for_nlu,
    )
    from app.core.admin_nlu import build_admin_rag_query

    dialogue = "用户：明天10点开会\n助手：已添加日程"

    follow = classify_admin_turn_scope("详细说说", dialogue)
    assert_true(follow.turn_kind == "output_followup", f"output_followup got {follow.turn_kind}")
    assert_true(not follow.suppress_history, "output_followup keeps narrow history")

    refer = classify_admin_turn_scope("这个呢", dialogue)
    assert_true(refer.mode == "continuation", f"refer continuation got {refer.mode}")

    shift = classify_admin_turn_scope("帮我查一下明天杭州天气", dialogue)
    assert_true(shift.suppress_history is True, "self-contained task must suppress history")
    assert_true(
        shift.mode in ("topic_shift", "current_only"),
        f"must isolate not continuation: {shift.mode}",
    )
    dlg = dialogue_for_nlu(dialogue, shift)
    assert_true(dlg == "", "suppressed dialogue must be empty")
    q = build_admin_rag_query(dlg, "帮我查一下明天杭州天气")
    assert_true("开会" not in q, "rag query must not stick previous meeting topic")
    assert_true("天气" in q, "rag query keeps current utterance")

    # 短自洽新问（无办公关键词）也不应因长度被判 continuation
    short_new = classify_admin_turn_scope("口腔护理频次是多少", dialogue)
    assert_true(short_new.suppress_history is True, "short self-contained must isolate")
    assert_true(short_new.mode != "continuation", f"got {short_new.mode}")

    print(
        "smoke-admin-turn-scope: OK",
        {
            "follow": follow.turn_kind,
            "refer": refer.mode,
            "shift": shift.mode,
            "short_new": short_new.mode,
        },
    )


if __name__ == "__main__":
    main()
