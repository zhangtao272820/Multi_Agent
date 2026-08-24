"""联机验收：模拟总管 HTTP 路径打 Vanna p2026（A1–A5 / D1 / D3）。

用法（宿主机，Docker 已起 vanna_db_agent）:
  set VANNA_SMOKE=0
  python scripts/live_p2026_manager_cases.py
  python scripts/live_p2026_manager_cases.py --base http://127.0.0.1:13121

契约 smoke（scripts/smoke_contract.py）默认 VANNA_SMOKE=1，禁止真 LLM。
本脚本会调 LLM + MySQL；不要放进 CI。不 down -v。
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Any

CASES = [
    ("A1", "老人一共有多少人"),
    ("A2", "查王建国的慢性病检测记录"),
    ("A3", "林雨欣做过几次足底压力检测"),
    ("A4", "河西区 70 到 79 岁老人男女各多少人"),
    ("A5", "龙奶奶的基本信息和联系方式"),
    ("D1", "统计各区域老人人数，按人数从高到低排"),
    ("D3", "情绪识别仪检测记录有多少条"),
]


def _get(url: str, timeout: float = 30) -> dict[str, Any]:
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _post(url: str, body: dict[str, Any], timeout: float = 180) -> dict[str, Any]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-agent-protocol": "manager",
            "x-manager-orchestrated": "1",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _sql_from(events: list[dict[str, Any]]) -> str:
    for e in events or []:
        if e.get("event") == "sql" and e.get("sql"):
            return str(e.get("sql") or "")[:200]
    return ""


def _has_checkpoint(events: list[dict[str, Any]]) -> bool:
    return any(e.get("event") == "checkpoint" for e in (events or []))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:13121")
    ap.add_argument("--db-id", default="p2026")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    db_id = args.db_id

    print(f"== probe {base} ==")
    try:
        ready = _get(f"{base}/api/ready", timeout=15)
        health = _get(f"{base}/api/health", timeout=15)
    except Exception as exc:
        print(f"FAIL ready/health: {exc}")
        return 1
    print("ready:", ready)
    tenants = health.get("tenants") or health.get("tenant") or []
    print("health tenants:", tenants)
    if isinstance(tenants, list) and tenants and db_id not in tenants:
        print(f"WARN: {db_id} not in health tenants")

    fails: list[str] = []
    for cid, q in CASES:
        print(f"\n-- {cid}: {q}")
        body = {
            "messages": [{"role": "user", "content": q}],
            "dbId": db_id,
            "managerTask": {"source": "manager", "refined_question": q},
        }
        try:
            data = _post(f"{base}/api/ask", body, timeout=240)
        except urllib.error.HTTPError as exc:
            text = exc.read().decode("utf-8", errors="replace")[:400]
            print(f"HTTP {exc.code}: {text}")
            fails.append(f"{cid}: http {exc.code}")
            continue
        except Exception as exc:
            print(f"ERR: {exc}")
            fails.append(f"{cid}: {exc}")
            continue
        events = list(data.get("events") or [])
        answer = str(data.get("answer") or "")
        empty = bool(data.get("empty"))
        sql = _sql_from(events)
        cp = _has_checkpoint(events)
        fg = next((e for e in events if e.get("event") == "filter_gate"), None)
        print(f"empty={empty} checkpoint={cp}")
        if fg is not None:
            print(f"filter_gate: ok={fg.get('ok')} missing={fg.get('missing')}")
        print(f"sql: {sql or '(none)'}")
        print(f"answer: {answer[:320]}")
        if cp:
            fails.append(f"{cid}: unexpected checkpoint on manager path")
        if cid in {"A1", "D3"} and (empty or not answer.strip()):
            fails.append(f"{cid}: expected non-empty count-like answer")
        if cid in {"A2", "A5"} and not answer.strip():
            fails.append(f"{cid}: empty answer")

    print("\n== summary ==")
    if fails:
        for f in fails:
            print("FAIL", f)
        return 1
    print(f"OK {len(CASES)} cases via manager-shaped /api/ask dbId={db_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
