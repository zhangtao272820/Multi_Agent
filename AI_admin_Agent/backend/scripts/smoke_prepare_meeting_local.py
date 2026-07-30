"""prepare_meeting：禁止走 RAG，仅本地办公源。"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    from app.core.config import settings
    from app.tools import briefing

    td = tempfile.mkdtemp(prefix="admin_prep_")
    settings.WORKSPACE_DIR = td

    src = (BACKEND / "app/tools/briefing.py").read_text(encoding="utf-8")
    assert_true("knowledge_retrieval" not in src, "source must not call knowledge_retrieval")
    assert_true("from app.tools import calendar" in src, "imports calendar")
    assert_true("knowledge" not in src.split("def prepare_meeting")[0], "no knowledge import before prepare_meeting")

    out = briefing.prepare_meeting(query="产品评审会材料")
    assert_true(isinstance(out, dict) and out.get("ok"), f"ok: {out}")
    human = str(out.get("human_message") or "")
    assert_true("未检索知识库" in human, "must declare no RAG")
    assert_true("会前准备" in human, "has title")
    data = out.get("data") or {}
    assert_true("calendar" in (data.get("sources") or []), "sources include calendar")
    assert_true("workspace" in (data.get("sources") or []), "sources include workspace")
    assert_true("rag" not in str(data.get("sources") or []).lower(), "no rag source")

    print("smoke_prepare_meeting_local OK")


if __name__ == "__main__":
    main()
