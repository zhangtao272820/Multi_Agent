"""Admin 用户私有隔离契约 smoke：联系人/记忆按 (tenant_id,user_id) 互不可见。不调 LLM。"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

td = tempfile.mkdtemp(prefix="admin_scope_smoke_")
os.environ["ADMIN_DATA_DIR"] = td
os.environ["WORKSPACE_DIR"] = str(Path(td) / "workspace")

from app.core.tenant_scope import set_request_scope, reset_request_scope, user_workspace_dir
from app.tools.contacts import add_contact, list_contacts
from app.tools.memory_tools import add_memory, get_memories


def _items(result) -> list:
    if isinstance(result, dict):
        data = result.get("data")
        if isinstance(data, dict) and isinstance(data.get("items"), list):
            return data["items"]
        if isinstance(data, list):
            return data
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
            return _items(parsed)
        except Exception:
            return []
    return []


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    t1 = set_request_scope("tenant_a", "user_alice")
    try:
        add_contact("张三", "zhangsan@example.com", "alice contact")
        add_memory("alice likes tea")
        alice_contacts = _items(list_contacts())
        alice_mem = get_memories()
    finally:
        reset_request_scope(t1)

    t2 = set_request_scope("tenant_a", "user_tianai")
    try:
        bob_contacts = _items(list_contacts())
        bob_mem = get_memories()
        add_contact("李四", "lisi@example.com")
        after = _items(list_contacts())
    finally:
        reset_request_scope(t2)

    _assert(any(c.get("name") == "张三" for c in alice_contacts), "alice sees own contact")
    _assert(not any(c.get("name") == "张三" for c in bob_contacts), "tianai must not see alice contact")
    _assert("alice likes tea" in alice_mem, "alice memory present")
    _assert("alice likes tea" not in bob_mem, "tianai must not see alice memory")
    _assert(any(c.get("name") == "李四" for c in after), "tianai sees own contact")

    wa = user_workspace_dir(os.environ["WORKSPACE_DIR"], "tenant_a", "user_alice")
    wb = user_workspace_dir(os.environ["WORKSPACE_DIR"], "tenant_a", "user_tianai")
    _assert(wa != wb, "workspace paths isolated")
    _assert("tenants" in wa.replace("\\", "/") and "user_alice" in wa, "workspace layout")

    print("smoke_admin_user_isolation: ok")


if __name__ == "__main__":
    main()
