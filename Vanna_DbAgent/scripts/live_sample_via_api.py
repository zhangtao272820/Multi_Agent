"""Pull a few live answer samples via Vanna API (stdout only)."""
from __future__ import annotations

import json
import urllib.request

BASE = "http://127.0.0.1:13121"


def ask(q: str, *, confirm: bool = False, pending_id: str = "") -> dict:
    payload = {
        "question": q,
        "tenant": "p2604",
        "scene": "assistant",
        "confirm": confirm,
        "pending_id": pending_id,
    }
    req = urllib.request.Request(
        f"{BASE}/api/ask",
        data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req, timeout=60))


def main() -> None:
    qs = [
        "目前突发事件有几个，分别是什么",
        "人员分组有哪些",
        "题库有哪些",
        "护理级别分别有多少人",
        "各机构有多少床位",
        "分组里有哪些学生",
        "突发事件绑定了哪些题库",
        "系统用户分别是什么角色",
        "谁参加了突发事件考试",
        "老人库有哪些人",
        "学生档案有哪些",
        "系统有多少用户",
        "签约老人有多少",
    ]
    for q in qs:
        body = ask(q, confirm=False)
        ans = body.get("answer") or {}
        pid = str(ans.get("pending_id") or "")
        sql = str(ans.get("sql") or "")[:200]
        if not pid:
            print("---")
            print("Q:", q)
            print("FAIL:", ans.get("text"))
            continue
        ex_body = ask(q, confirm=True, pending_id=pid)
        ex = ex_body.get("answer") or {}
        rows = ex.get("rows") or []
        print("---")
        print("Q:", q)
        print("SQL:", sql)
        print("N:", len(rows))
        print("ROWS:", json.dumps(rows[:8], ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
