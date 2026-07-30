#!/usr/bin/env python3
"""Protocol smoke: health / ready / compute (offline mock) / WS ping / FS."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> int:
    from fastapi.testclient import TestClient
    from app.main import app
    from app.tools.fs_sandbox import list_dir, read_file, write_file
    from app.tools.search_replace import preview_search_replace, apply_single
    from app.protocol.agent_result import build_code_compute_agent_result
    from app.protocol.incoming import parse_manager_task, resolve_task_kind

    client = TestClient(app)

    h = client.get("/api/health")
    assert h.status_code == 200, h.text
    assert h.json().get("agent") == "code"
    print("OK health", h.json())

    r = client.get("/api/ready")
    assert r.status_code == 200
    print("OK ready", list(r.json().keys()))

    ar = build_code_compute_agent_result(answer='{"answer":"ok","facts":[]}', task_kind="compute", ms=1)
    assert ar["agent"] == "code" and ar["ok"] is True
    print("OK agentResult shape")

    mt = parse_manager_task(
        {
            "source": "manager",
            "task_kind": "compute",
            "upstream_facts": [{"key": "a", "value": 1}],
            "upstream_context": "a=1",
        }
    )
    assert resolve_task_kind(manager=mt) == "compute"
    print("OK task_kind resolve")

    # FS sandbox against CodePy_Agent itself
    import os

    os.environ["PROJECT_DIR"] = str(ROOT)
    os.environ["ALLOWED_ROOTS"] = str(ROOT)
    os.environ["WRITE_TOOL_ENABLED"] = "1"
    from app.config import reload_settings

    reload_settings()

    entries = list_dir("")
    assert any(e["name"] == "app" for e in entries), entries[:5]
    cfg = read_file("requirements.txt")
    assert "fastapi" in cfg["content"]
    print("OK fs list/read")

    tmp = ROOT / ".data" / "smoke_tmp.txt"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    write_file(".data/smoke_tmp.txt", "hello\nworld\n", require_write_enabled=True)
    updated = apply_single("hello\nworld\n", "world", "codepy")
    assert updated == "hello\ncodepy\n"
# smoke_protocol: ensure search_replace path works for .txt
    patch = ".data/smoke_tmp.txt\n<<<<<<< SEARCH\nworld\n=======\ncodepy\n>>>>>>> REPLACE\n"
    prev = preview_search_replace(patch)
    assert prev.get("ok"), prev
    print("OK search_replace preview")

    with client.websocket_connect("/_ws") as ws:
        ws.send_text(json.dumps({"type": "ping"}))
        pong = json.loads(ws.receive_text())
        assert pong.get("type") == "pong"
    print("OK ws ping")

    # compute without API key should return structured fail (not 500)
    os.environ.pop("OPENAI_API_KEY", None)
    os.environ.pop("QWEN_API_KEY", None)
    reload_settings()
    comp = client.post(
        "/api/compute",
        json={
            "message": "汇总 facts",
            "managerTask": {
                "source": "manager",
                "task_kind": "compute",
                "upstream_facts": [{"key": "x", "value": 2}],
            },
        },
    )
    assert comp.status_code == 200, comp.text
    data = comp.json()
    assert data.get("agentResult", {}).get("agent") == "code"
    assert data.get("ok") is False
    print("OK compute fail envelope without key")

    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
