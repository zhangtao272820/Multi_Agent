"""p2026 NL 契约评测：纯函数，不调 LLM、不连库。

用法：
  python scripts/eval_nl_contract.py
  python scripts/eval_nl_contract.py --tenant p2026
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.filter_gate import assert_plan_filters
from app.router import parse_router
from app.settings import ROOT as APP_ROOT


def load_nl_eval(tenant_id: str = "p2026") -> dict:
    path = APP_ROOT / "tenants" / tenant_id / "nl_eval.json"
    if not path.is_file():
        raise FileNotFoundError(f"missing {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def run_nl_eval(tenant_id: str = "p2026") -> list[str]:
    """返回失败消息列表；空列表表示全过。"""
    data = load_nl_eval(tenant_id)
    fails: list[str] = []
    for case in data.get("cases") or []:
        cid = str(case.get("id") or "?")
        mock = case.get("mock_router") or {}
        route = parse_router(mock, tenant=None)
        expect = str(case.get("expect_path") or "").strip()
        got = str(route.get("path") or "")
        if expect and got != expect:
            fails.append(f"{cid}: path want={expect} got={got}")
        ok_sql = str(case.get("sample_sql_ok") or "").strip()
        if ok_sql:
            gate = assert_plan_filters(ok_sql, route)
            if not gate.ok:
                fails.append(f"{cid}: sample_sql_ok should pass gate missing={gate.missing}")
        bad_sql = str(case.get("sample_sql_bad") or "").strip()
        if bad_sql:
            gate = assert_plan_filters(bad_sql, route)
            if gate.ok:
                fails.append(f"{cid}: sample_sql_bad should fail gate")
    return fails


def main() -> int:
    tenant = "p2026"
    if len(sys.argv) >= 3 and sys.argv[1] == "--tenant":
        tenant = sys.argv[2]
    fails = run_nl_eval(tenant)
    if fails:
        print("FAIL", len(fails))
        for f in fails:
            print(" -", f)
        return 1
    data = load_nl_eval(tenant)
    print(f"OK nl_eval {tenant} cases={len(data.get('cases') or [])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
