#!/usr/bin/env python3
"""Protocol smoke: health / ready / extract / async / WS (in-process TestClient)."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> int:
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)

    h = client.get("/api/health")
    assert h.status_code == 200, h.text
    assert h.json().get("agent") == "crawler"
    print("OK health", h.json())

    r = client.get("/api/ready")
    assert r.status_code == 200
    print("OK ready", list(r.json().keys()))

    manager_task = {
        "source": "manager",
        "crawl_strategy": "serp_only",
        "serp_hits": [
            {"title": "Example", "url": "https://example.com/", "snippet": "Example Domain"},
        ],
    }
    body = {
        "task": "smoke serp_only",
        "manager_task_json": json.dumps(manager_task),
        "options": {"maxItems": 5, "maxPages": 1},
        "trace_id": "smoke-protocol-1",
    }

    ex = client.post("/api/extract", json=body)
    assert ex.status_code == 200, ex.text
    data = ex.json()
    ar = data.get("agentResult") or {}
    assert ar.get("agent") == "crawler", ar
    assert ar.get("ok") is True, ar
    assert data.get("items"), data
    assert ar.get("structured", {}).get("content_trust") == "untrusted"
    print("OK http extract serp_only items=", len(data.get("items") or []))

    async_res = client.post("/api/extract/async", json=body)
    assert async_res.status_code == 200, async_res.text
    job_id = async_res.json().get("job_id")
    assert job_id
    job = None
    for _ in range(80):
        job = (client.get(f"/api/jobs/{job_id}").json() or {}).get("job") or {}
        if job.get("status") in ("done", "failed"):
            break
        time.sleep(0.05)
    assert job and job["status"] == "done", job
    assert (job.get("result") or {}).get("agentResult", {}).get("agent") == "crawler"
    print("OK async job", job_id)

    with client.websocket_connect("/_ws") as ws:
        open_msg = json.loads(ws.receive_text())
        assert open_msg.get("type") == "status" and open_msg.get("payload") == "open"
        ws.send_text(json.dumps({"type": "ping"}))
        pong = json.loads(ws.receive_text())
        assert pong.get("type") == "pong"
        ws.send_text(json.dumps({"type": "start", "payload": body}))
        got_result = False
        for _ in range(40):
            msg = json.loads(ws.receive_text())
            if msg.get("type") == "result":
                ar2 = (msg.get("payload") or {}).get("agentResult") or {}
                assert ar2.get("agent") == "crawler"
                got_result = True
            if msg.get("type") == "status" and msg.get("payload") in ("end", "error", "canceled"):
                break
        assert got_result, "no WS result"
    print("OK ws start -> result -> end")
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
