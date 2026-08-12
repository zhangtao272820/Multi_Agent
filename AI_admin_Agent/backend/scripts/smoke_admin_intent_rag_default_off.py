"""意图 Playbook RAG 默认关；ToolCatalog 含 get_email_detail。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
# 确保未显式开启时默认关
os.environ.pop("ADMIN_INTENT_RAG", None)
os.environ.setdefault("ADMIN_LOAD_PLAYBOOK", "1")


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    from app.core.admin_env_modes import is_admin_intent_rag_enabled
    from app.core.admin_nlu import recall_admin_scenario
    from app.core.admin_playbook_prompts import get_tool_catalog

    assert_true(not is_admin_intent_rag_enabled(), "intent RAG default off")
    assert_true(recall_admin_scenario("读取未读第一封邮件正文") is None, "no recall when off")

    catalog = get_tool_catalog()
    assert_true("get_email_detail" in catalog, "ToolCatalog lists get_email_detail")
    assert_true("search_emails" in catalog, "ToolCatalog lists search_emails")

    os.environ["ADMIN_INTENT_RAG"] = "1"
    # reload check via re-import flag function reading env
    from importlib import reload
    import app.core.admin_env_modes as m

    reload(m)
    assert_true(m.is_admin_intent_rag_enabled(), "explicit ADMIN_INTENT_RAG=1 enables")
    os.environ.pop("ADMIN_INTENT_RAG", None)
    reload(m)

    print("smoke_admin_intent_rag_default_off OK")


if __name__ == "__main__":
    main()
