"""契约 smoke：不调 LLM、不连业务库、不发副作用。

默认 VANNA_SMOKE=1：app.llm 拒绝真实 chat/embed，漏 mock 会立刻失败而非烧 token。
联机脚本：scripts/live_p2026_manager_cases.py（须显式 VANNA_SMOKE=0）。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["VANNA_SMOKE"] = "1"
os.environ["VANNA_AUTO_INGEST"] = "false"
os.environ["VANNA_CHECKPOINT_DEFAULT"] = "true"
os.environ["VANNA_POLISH"] = "true"
os.environ["AGENT_DATABASE_URL"] = ""
os.environ["CLAWHIVE_DATABASE_URL"] = ""
os.environ["DATABASE_URL"] = ""
os.environ["AGENT_BROWSER_AUTH"] = "0"
os.environ["EVO_ALLOW_EXPERT_AUTO_PROMOTE"] = "0"
os.environ.setdefault("VANNA_DATA_DIR", str(ROOT / ".data" / "smoke"))

from app.engine import run_turn
from app.scenes import SCENES, get_scene, scene_public
from app.sql_guard import enforce_select_limit, extract_tables, guard_sql
from app.tenants import MysqlConf, Tenant, load_tenants


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def sample_tenant() -> Tenant:
    loaded = load_tenants()
    if "p2604" in loaded:
        return loaded["p2604"]
    return Tenant(
        id="p2604",
        title="test",
        mysql=MysqlConf("127.0.0.1", 3306, "root", "", "P2604"),
        table_whitelist_prefixes=["PC_", "Cultivate_"],
        table_whitelist=["Sys_Student", "Sys_User"],
    )


_P2604_GOLDEN_Q = "目前突发事件有几个，分别是什么"
_P2604_GOLDEN_SQL = (
    "SELECT Name, Type FROM Cultivate_Examination WHERE deleted = 0 ORDER BY id LIMIT 50"
)


def _p2604_golden_route() -> dict:
    return {
        "path": "golden",
        "intent": "list",
        "data_domain": "general",
        "tables": ["Cultivate_Examination"],
        "entities": {"names": [], "locations": []},
        "filters": {"time_range": {"relative": "", "start": "", "end": ""}, "slots": []},
        "join_needed": False,
        "golden_ok": True,
        "confidence": 0.95,
        "reason": "smoke mock golden",
        "clarify": "",
        "need_clarify": False,
    }


def _p2604_golden_hit() -> dict:
    return {
        "kind": "golden",
        "score": 1.0,
        "document": _P2604_GOLDEN_Q,
        "sql": _P2604_GOLDEN_SQL,
        "tables": ["Cultivate_Examination"],
        "source": "special",
    }


def _patch_ask_no_llm():
    """HTTP ask / mcp preview 共用：禁止真 LLM/embed。"""
    from contextlib import contextmanager
    from unittest.mock import patch

    @contextmanager
    def _ctx():
        with (
            patch("app.engine.retrieve", return_value=[_p2604_golden_hit()]),
            patch("app.engine.run_router", return_value=_p2604_golden_route()),
            patch("app.engine.catalog_nonempty", return_value=True),
            patch("app.engine.pick_golden_sql", return_value=_p2604_golden_hit()),
        ):
            yield

    return _ctx()


def test_guard() -> None:
    tenant = sample_tenant()
    assistant = get_scene("assistant")
    dba = get_scene("dba")
    audit = get_scene("audit")

    not_sel = guard_sql("DELETE FROM PC_OldPeople", tenant=tenant, scene=assistant)
    assert_true(not not_sel.ok and not_sel.reason == "not_select", "delete must fail")

    bad = guard_sql("SELECT Name FROM PC_OldPeople FOR UPDATE", tenant=tenant, scene=assistant)
    assert_true(not bad.ok and bad.reason == "write_keyword", "write must fail")

    multi = guard_sql("SELECT 1; SELECT 2", tenant=tenant, scene=assistant)
    assert_true(not multi.ok and multi.reason == "multi_statement", "multi-statement must fail")

    sleep = guard_sql("SELECT SLEEP(10)", tenant=tenant, scene=assistant)
    assert_true(not sleep.ok and sleep.reason == "time_bomb", "sleep must fail")

    outfile = guard_sql("SELECT Name FROM PC_OldPeople INTO OUTFILE '/tmp/x'", tenant=tenant, scene=assistant)
    assert_true(not outfile.ok and outfile.reason == "file_io", "outfile must fail")

    secret = guard_sql("SELECT UserPwd FROM Sys_User", tenant=tenant, scene=assistant)
    assert_true(not secret.ok and secret.reason == "secret_column", "password column must fail")

    idcard = guard_sql("SELECT id_card FROM PC_OldPeople", tenant=tenant, scene=assistant)
    assert_true(not idcard.ok and idcard.reason == "secret_column", "id_card must fail")

    bank = guard_sql("SELECT bank_card FROM Sys_User", tenant=tenant, scene=audit)
    assert_true(not bank.ok and bank.reason == "secret_column", "audit secrets must be stricter")

    sys_blocked = guard_sql(
        "SELECT table_name FROM information_schema.tables",
        tenant=tenant,
        scene=assistant,
    )
    assert_true(not sys_blocked.ok and sys_blocked.reason == "system_schema", "assistant cannot read system schema")

    sys_ok = guard_sql(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()",
        tenant=tenant,
        scene=dba,
    )
    assert_true(sys_ok.ok, f"dba may read information_schema, got {sys_ok.reason}")

    log_tbl = guard_sql("SELECT * FROM Sys_Log", tenant=tenant, scene=assistant)
    assert_true(not log_tbl.ok and log_tbl.reason == "table_not_allowed", "Sys_Log not in whitelist")

    ok = guard_sql("SELECT Name, Type FROM Cultivate_Examination", tenant=tenant, scene=assistant)
    assert_true(ok.ok, f"business select must pass, got {ok.reason}")
    assert_true("LIMIT" in ok.sql.upper(), "LIMIT must be enforced")
    assert_true("Cultivate_Examination" in extract_tables(ok.sql), "extract tables")

    capped = enforce_select_limit("SELECT Name FROM PC_OldPeople LIMIT 9999", max_limit=50)
    assert_true("LIMIT 50" in capped.upper(), "cap oversized LIMIT")


def test_scenes() -> None:
    ids = {s["id"] for s in scene_public()}
    assert_true(ids == set(SCENES), "all scenes must be listed")
    assert_true(get_scene(None).id == "auto", "default scene is auto")
    assert_true(get_scene("auto").auto_deliverables and get_scene("auto").allow_chart, "auto deliverables")
    assert_true(get_scene("smart").id == "auto", "smart alias")
    assert_true(get_scene("assistant").force_checkpoint, "assistant checkpoint on")
    assert_true(get_scene("dba").allow_sys_schema, "dba sys schema")
    assert_true(get_scene("audit").strict_secrets, "audit strict secrets")
    assert_true(get_scene("analyst").allow_chart, "analyst chart")
    assert_true(get_scene("embed").stub and get_scene("etl").stub, "embed/etl stub")
    assert_true(get_scene("saas").id == "embed", "saas alias")
    from app.scenes import scene_with_sys_meta

    auto = get_scene("auto")
    bumped = scene_with_sys_meta(auto, sys_meta=True)
    assert_true(bumped.allow_sys_schema and bumped.id == "auto", "sys_meta turn bump")
    assert_true(not auto.allow_sys_schema, "original auto unchanged")


def _mock_golden_route(*, tables: list[str] | None = None, intent: str = "count") -> dict:
    return {
        "path": "golden",
        "intent": intent,
        "data_domain": "general",
        "tables": tables or ["Cultivate_Examination"],
        "entities": {"names": [], "locations": []},
        "filters": {"time_range": {"relative": "", "start": "", "end": ""}, "slots": []},
        "join_needed": intent == "join",
        "golden_ok": True,
        "confidence": 0.95,
        "reason": "语义一致",
        "clarify": "",
        "need_clarify": False,
    }


def test_stub_and_checkpoint() -> None:
    from unittest.mock import patch

    tenant = sample_tenant()
    stub_events = list(
        run_turn(tenant=tenant, scene=get_scene("embed"), question="按商户查老人", confirm=False)
    )
    kinds = [e.get("event") for e in stub_events]
    answer = next(e for e in stub_events if e.get("event") == "answer")
    assert_true("retrieve" in kinds and "answer" in kinds, "stub still routes")
    assert_true("建设中" in str(answer.get("text") or ""), "stub message")
    assert_true(answer.get("cost", {}).get("llm_calls", 1) == 0, "stub uses no LLM")

    with patch("app.engine.run_router", return_value=_mock_golden_route()) as mock_route:
        events = list(
            run_turn(
                tenant=tenant,
                scene=get_scene("assistant"),
                question="目前突发事件有几个，分别是什么",
                confirm=False,
            )
        )
    assert_true(mock_route.called, "Understand runs before golden SQL")
    kinds = [e.get("event") for e in events]
    sql_ev = next(e for e in events if e.get("event") == "sql")
    answer = next(e for e in events if e.get("event") == "answer")
    assert_true("checkpoint" in kinds, "checkpoint must block execute")
    assert_true("execute" not in kinds, "must not execute before confirm")
    assert_true(sql_ev.get("source") == "golden", "golden SQL after Understand")
    assert_true("Cultivate_Examination" in str(sql_ev.get("sql") or ""), "emergency table")
    assert_true(answer.get("checkpoint") is True, "answer flags checkpoint")
    assert_true(answer.get("cost", {}).get("llm_calls", 1) == 0, "smoke mocks Understand (no real LLM)")
    assert_true(bool(answer.get("pending_id")), "pending id issued")

    from app.catalog import exact_golden, pick_golden_sql, retrieve, schema_table_hits
    from app.llm import LlmMeter
    from app.understand import normalize_question, parse_plan

    polite = exact_golden(tenant, "请问目前突发事件有几个，分别是什么呢")
    assert_true(polite is not None, "normalized exact golden")
    assert_true("Cultivate_Examination" in str(polite.get("sql") or ""), "normalized emergency sql")
    assert_true(
        normalize_question("请问目前突发事件有几个，分别是什么呢")
        == normalize_question("目前突发事件有几个，分别是什么"),
        "particle strip equals golden",
    )

    with patch("app.engine.run_router", return_value=_mock_golden_route()) as mock_polite:
        polite_events = list(
            run_turn(
                tenant=tenant,
                scene=get_scene("assistant"),
                question="请问目前突发事件有几个，分别是什么呢",
                confirm=False,
            )
        )
    assert_true(mock_polite.called, "polite question still runs Understand")
    polite_sql = next(e for e in polite_events if e.get("event") == "sql")
    polite_ans = next(e for e in polite_events if e.get("event") == "answer")
    assert_true(polite_sql.get("source") == "golden", "polite question golden after Understand")
    assert_true(polite_ans.get("cost", {}).get("llm_calls", 1) == 0, "smoke mocks Understand")

    with patch(
        "app.engine.run_router",
        return_value=_mock_golden_route(
            tables=["PC_PersonGroup", "PC_PersonGroupItem"], intent="join"
        ),
    ):
        join_ev = list(
            run_turn(
                tenant=tenant,
                scene=get_scene("assistant"),
                question="分组里有哪些学生",
                confirm=False,
            )
        )
    join_sql = next(e for e in join_ev if e.get("event") == "sql")
    assert_true(join_sql.get("source") == "golden", "join golden after Understand")
    assert_true("JOIN" in str(join_sql.get("sql") or "").upper(), "join golden has JOIN")

    mixed = retrieve(tenant, "人员分组有哪些以及每个分组的学生", LlmMeter())
    assert_true(pick_golden_sql(mixed) is None, "substring must not reuse list golden")

    vec_hit = pick_golden_sql(
        [
            {"kind": "ddl", "score": 0.99, "sql": "", "document": "t"},
            {
                "kind": "golden",
                "score": 0.82,
                "sql": "SELECT Name FROM Cultivate_Examination",
                "document": "突发事件现在几场",
            },
        ]
    )
    assert_true(vec_hit is not None and "Cultivate_Examination" in str(vec_hit.get("sql")), "vector golden above threshold")
    assert_true(
        pick_golden_sql([{"kind": "golden", "score": 0.5, "sql": "SELECT 1", "document": "q"}]) is None,
        "vector golden below threshold is ignored",
    )

    schema = schema_table_hits(tenant, "题库有哪些")
    names = {h.get("table") for h in schema}
    assert_true("PC_QuestionBank" in names or not schema, "schema comment can hint question bank")

    plan = parse_plan(
        '{"intent":"join","tables":["PC_PersonGroup","PC_PersonGroupItem"],'
        '"need_clarify":false,"clarify":"","reason":"组内学生","sql":"SELECT 1 FROM PC_PersonGroup g JOIN PC_PersonGroupItem i ON g.PersonGroupId=i.PersonGroupId"}'
    )
    assert_true(plan["intent"] == "join" and "JOIN" in plan["sql"].upper(), "plan parse join")
    clarify = parse_plan('{"intent":"clarify","tables":[],"need_clarify":true,"clarify":"要查哪张表？","sql":""}')
    assert_true(clarify["need_clarify"] and not clarify["sql"], "clarify has no sql")


def test_api_ready() -> None:
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        ready = client.get("/api/ready").json()
        assert_true(ready.get("ready") is True, "ready")
        assert_true(ready.get("manager") is False, "not registered to manager")
        assert_true("p2604" in ready.get("tenants", []), "p2604 tenant")
        scenes = set(ready.get("scenes") or [])
        assert_true({"assistant", "analyst", "exec", "dba", "audit", "embed", "etl"} <= scenes, "six scenes")
        meta = client.get("/api/meta").json()
        assert_true(len(meta.get("scenes") or []) >= 7, "meta scenes")
        page = client.get("/")
        assert_true(page.status_code == 200 and "Vanna" in page.text, "frontend index")
        with _patch_ask_no_llm():
            ask = client.post(
                "/api/ask",
                json={
                    "question": _P2604_GOLDEN_Q,
                    "tenant": "p2604",
                    "scene": "assistant",
                    "confirm": False,
                },
            )
        body = ask.json()
        events = [e.get("event") for e in body.get("events") or []]
        assert_true("checkpoint" in events, "ask checkpoint")
        assert_true("execute" not in events, "ask does not execute")
        assert_true(isinstance(body.get("answer"), str) and body.get("answer"), "ask answer is string")
        sql = str(body.get("sql") or "")
        assert_true("Cultivate_Examination" in sql, "golden sql in answer")
        ar = body.get("agentResult") or {}
        assert_true(ar.get("agent") == "db", "agentResult.agent db")
        assert_true(ar.get("ok") is True, "preview still ok")
        health = client.get("/api/health").json()
        assert_true(health.get("ok") is True, "health")
        bad_db = client.post("/api/ask", json={"question": _P2604_GOLDEN_Q, "dbId": "no-such-tenant"})
        assert_true(bad_db.status_code == 400, "unknown dbId is 400")
        sess = client.post("/api/sessions", json={"tenant": "p2604", "scene": "assistant"})
        assert_true(sess.status_code == 200 and sess.json().get("id"), "create session")
        sid = sess.json()["id"]
        listed = client.get("/api/sessions").json()
        assert_true(any(x.get("id") == sid for x in listed.get("items") or []), "session listed")
        got = client.get(f"/api/sessions/{sid}").json()
        assert_true(got.get("messages") == [], "new session empty")
        with _patch_ask_no_llm():
            ask_mem = client.post(
                "/api/ask",
                json={
                    "question": _P2604_GOLDEN_Q,
                    "tenant": "p2604",
                    "scene": "assistant",
                    "session_id": sid,
                    "confirm": False,
                },
            )
        body_mem = ask_mem.json()
        assert_true("checkpoint" in [e.get("event") for e in body_mem.get("events") or []], "session ask checkpoint")
        stored = client.get(f"/api/sessions/{sid}").json()
        roles = [m.get("role") for m in stored.get("messages") or []]
        assert_true(roles[:2] == ["user", "assistant"], "session stores user and assistant")
        msgs = stored.get("messages") or []
        uid = str((msgs[0] or {}).get("id") or "")
        assert_true(bool(uid), "user message id")
        assert_true(bool((msgs[1] or {}).get("meta", {}).get("checkpoint")), "assistant checkpoint meta")
        # 合并确认轮：纯函数覆盖 checkpoint 助手消息（不连库）
        from app.sessions import replace_checkpoint_assistant, truncate_from_message

        replace_checkpoint_assistant(
            sid,
            content="已查到 4 行。",
            meta={"checkpoint": False, "executed": True, "row_count": 4, "sql": "SELECT 1"},
        )
        after = client.get(f"/api/sessions/{sid}").json()
        after_msgs = after.get("messages") or []
        assert_true(len(after_msgs) == 2, "confirm merges into one assistant turn")
        assert_true(not (after_msgs[1].get("meta") or {}).get("checkpoint"), "merged turn clears checkpoint")
        assert_true((after_msgs[1].get("meta") or {}).get("executed") is True, "merged turn marked executed")
        # 撤回 API：删掉该轮及之后
        cut = client.post(f"/api/sessions/{sid}/truncate", json={"message_id": uid})
        assert_true(cut.status_code == 200, "truncate ok")
        empty = client.get(f"/api/sessions/{sid}").json()
        assert_true((empty.get("messages") or []) == [], "truncate clears from user")
        with _patch_ask_no_llm():
            append_again = client.post(
                "/api/ask",
                json={
                    "question": _P2604_GOLDEN_Q,
                    "tenant": "p2604",
                    "scene": "assistant",
                    "session_id": sid,
                    "confirm": False,
                },
            )
        assert_true(append_again.status_code == 200, "re-ask after truncate")
        again = client.get(f"/api/sessions/{sid}").json().get("messages") or []
        assert_true(len(again) >= 2, "messages after re-ask")
        truncate_from_message(sid, str(again[0]["id"]))
        assert_true((client.get(f"/api/sessions/{sid}").json().get("messages") or []) == [], "direct truncate clears")
        gone = client.delete(f"/api/sessions/{sid}")
        assert_true(gone.status_code == 200, "delete session")


def test_budget_and_ui() -> None:
    from app.llm import LlmMeter, chat_json, chat_text, embed_texts
    from app.settings import get_settings

    settings = get_settings()
    assert_true(settings.vanna_max_llm_calls == 2, "default llm cap is 2 (router+sql)")
    assert_true(settings.vanna_max_embed_calls == 1, "default embed cap is 1")
    assert_true(settings.vanna_max_ingest_embed_calls >= 50, "ingest embed cap is separate and larger")
    assert_true(settings.vanna_max_repair_llm_calls == 1, "one repair llm after execute fail")
    assert_true(settings.vanna_max_answer_llm_calls == 1, "answer polish uses a separate llm cap")
    assert_true(settings.vanna_polish is True, "assistant reply polish on after execute")
    assert_true(settings.vanna_scene_detect is False, "scene detect off so no extra llm")
    assert_true(LlmMeter().embed_cap() == 1, "query meter embed cap is 1")
    assert_true(LlmMeter(max_embed_calls=500).embed_cap() == 500, "ingest meter can raise embed cap")

    meter = LlmMeter()
    meter.llm_calls = settings.vanna_max_llm_calls
    raised = False
    try:
        chat_text("s", "u", meter)
    except RuntimeError as exc:
        raised = "llm_budget" in str(exc)
    assert_true(raised, "chat_text must stop at llm cap")
    raised = False
    try:
        chat_json("s", "u", meter)
    except RuntimeError as exc:
        raised = "llm_budget" in str(exc)
    assert_true(raised, "chat_json must stop at llm cap on success path")
    from app.llm import _check_llm_budget

    _check_llm_budget(meter, repair=True)
    meter.repair_calls = settings.vanna_max_repair_llm_calls
    raised = False
    try:
        _check_llm_budget(meter, repair=True)
    except RuntimeError as exc:
        raised = "llm_budget" in str(exc)
    assert_true(raised, "repair llm also capped")
    raised = False
    try:
        chat_json("s", "u", meter, repair=True)
    except RuntimeError as exc:
        raised = "llm_budget" in str(exc)
    assert_true(raised, "chat_json repair stops at repair cap")

    meter.answer_calls = 0
    _check_llm_budget(meter, answer=True)
    meter.answer_calls = settings.vanna_max_answer_llm_calls
    raised = False
    try:
        _check_llm_budget(meter, answer=True)
    except RuntimeError as exc:
        raised = "llm_budget" in str(exc)
    assert_true(raised, "answer polish has its own cap")
    raised = False
    try:
        chat_text("s", "u", meter, answer=True)
    except RuntimeError as exc:
        raised = "llm_budget" in str(exc)
    assert_true(raised, "chat_text answer stops at answer cap, not plan cap")

    embed_meter = LlmMeter()
    embed_meter.embed_calls = settings.vanna_max_embed_calls
    assert_true(embed_texts(["x"], embed_meter) == [], "over-budget embed returns empty")

    tenant = sample_tenant()
    long_q = "突发事件" * 120
    assert_true(len(long_q) > settings.vanna_max_question_chars, "fixture exceeds cap")
    events = list(run_turn(tenant=tenant, scene=get_scene("assistant"), question=long_q))
    answer = next(e for e in events if e.get("event") == "answer")
    assert_true("最长" in str(answer.get("text") or ""), "long question blocked")
    assert_true(answer.get("cost", {}).get("llm_calls", 1) == 0, "long question uses no llm")
    assert_true("execute" not in [e.get("event") for e in events], "long question does not query")

    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        page = client.get("/")
        html = page.text
        assert_true("scene-advanced" in html and "id=\"scene\"" in html, "advanced scene override")
        assert_true("智能问数" in html or "currentScene" in html, "auto deliverables ui")
        assert_true("buildChart" in html and "chart-wrap" in html, "chart render helpers")
        assert_true("color-scheme: light" in html, "selects use light color-scheme")
        assert_true("目前突发事件有几个，分别是什么" in html, "real golden example")
        meta = client.get("/api/meta").json()
        budget = meta.get("budget") or {}
        assert_true(budget.get("max_llm_calls") == 2, "meta exposes llm cap (router+sql)")
        assert_true(budget.get("max_embed_calls") == 1, "meta exposes embed cap")
        assert_true(budget.get("max_ingest_embed_calls") >= 50, "meta exposes ingest embed cap")
        assert_true(budget.get("max_repair_llm_calls") == 1, "meta exposes repair cap")
        assert_true(budget.get("max_answer_llm_calls") == 1, "meta exposes answer cap")
        assert_true(budget.get("polish") is True, "meta polish on")
        assert_true("新对话" in html and "历史会话" in html and "查询记录" in html, "agent session ui")
        assert_true("msg-action-btn" in html and "撤回" in html and "重新生成" in html, "message actions ui")
        assert_true("agent-process" in html and ("已思考" in html or "思考过程" in html), "collapsible agent process")
        assert_true("收入黄金" in html, "promote golden button")
        assert_true("字段说明" in html and "有用" in html and "无用" in html, "field details and feedback ui")
        too_long = client.post(
            "/api/ask",
            json={"question": "x" * 401, "tenant": "p2604", "scene": "assistant"},
        )
        assert_true(too_long.status_code == 422, "api rejects oversized question")


def test_not_in_manager() -> None:
    """总管已切 Vanna：compose 指向 vanna_db_agent；契约 smoke 仍禁止烧 token。"""
    repo = ROOT.parent
    compose = (repo / "Manage-platform_Agent/docker-compose.agents-lan.yml").read_text(encoding="utf-8")
    assert_true("vanna_db_agent:13121" in compose, "manager DB leg points at vanna")
    assert_true("MANAGER_DB_ID: ${MANAGER_DB_ID:-p2026}" in compose or "MANAGER_DB_ID:-p2026" in compose, "default dbId p2026")
    assert_true("vanna_db_agent" in compose, "vanna service present")
    assert_true("VANNA_MAX_INGEST_EMBED_CALLS" in compose, "compose splits ingest embed budget")
    assert_true("VANNA_MAX_REPAIR_LLM_CALLS" in compose, "compose allows execute-fail repair")
    assert_true("AGENT_BROWSER_AUTH: \"1\"" in compose or "AGENT_BROWSER_AUTH: '1'" in compose, "vanna browser auth on")
    assert_true("DB_AGENT_HOST: vanna_db_agent" in compose, "platform backend probes vanna")
    lan_ex = (repo / "Manage-platform_Agent/.env.agents-lan.example").read_text(encoding="utf-8")
    assert_true("MANAGER_DB_ID=p2026" in lan_ex, "agents-lan example pins manager dbId p2026")
    # 勿用 split("manager_agent:")：image 行也含该子串
    start = compose.find("\n  manager_agent:\n")
    end = compose.find("\n  multimodal_agent:\n", start + 1) if start >= 0 else -1
    mgr = compose[start:end] if start >= 0 and end > start else ""
    assert_true("DB_AGENT_HTTP_URL: http://vanna_db_agent:13121" in mgr, "manager env uses vanna http")
    assert_true("db_agent:13101" not in mgr, "manager env must not use old db_agent")
    assert_true("MANAGER_DB_ID: ${MANAGER_DB_ID:-p2026}" in mgr or "MANAGER_DB_ID:-p2026" in mgr, "manager service dbId p2026")
    nginx = (ROOT / "frontend/nginx.conf").read_text(encoding="utf-8")
    assert_true("resolver 127.0.0.11" in nginx, "web nginx re-resolves docker DNS")
    assert_true("$vanna_upstream" in nginx, "proxy_pass uses variable upstream")
    managed = (repo / "Manage-platform_Agent/backend/app/managed_agents.py").read_text(encoding="utf-8")
    assert_true('docker_service": "vanna_db_agent"' in managed, "console manages vanna_db_agent")


def test_ingest_embed_budget() -> None:
    from unittest.mock import patch

    from app.catalog import ingest_tenant

    tenant = sample_tenant()
    calls: list[int] = []

    def fake_embed(texts, meter=None):
        cap = meter.embed_cap() if meter else 1
        if meter and meter.embed_calls >= cap:
            return []
        if meter:
            meter.embed_calls += 1
        calls.append(len(texts))
        return [[0.01, 0.02, 0.03] for _ in texts]

    class Coll:
        def __init__(self) -> None:
            self.count_n = 0

        def get(self):
            return {"ids": []}

        def delete(self, ids=None):
            return None

        def add(self, ids, documents, metadatas, embeddings):
            assert_true(len(ids) == len(embeddings), "chroma add embeddings must match docs")
            self.count_n = len(ids)

        def count(self):
            return self.count_n

    coll = Coll()
    with (
        patch("app.catalog._client", return_value=True),
        patch("app.catalog._collection", return_value=coll),
        patch("app.catalog.embed_texts", side_effect=fake_embed),
    ):
        out = ingest_tenant(tenant, skip_if_ready=False)
    assert_true(out.get("ok") is True, f"ingest ok, got {out}")
    assert_true(len(calls) >= 2, f"ingest must use multiple embed batches, got {calls}")
    assert_true(coll.count_n == out.get("count"), "ingested count matches add")


def test_repair_only_on_execute_error() -> None:
    from unittest.mock import patch

    from app.engine import repair_sql
    from app.llm import LlmMeter

    tenant = sample_tenant()
    scene = get_scene("assistant")
    blocked = LlmMeter(max_repair_llm_calls=0)
    blocked.llm_calls = 1
    none = repair_sql(
        tenant=tenant,
        scene=scene,
        question="老人库有哪些人",
        sql="SELECT Foo FROM PC_OldPeople",
        error="Unknown column 'Foo'",
        hits=[],
        meter=blocked,
    )
    assert_true(none is None, "repair cap 0 skips second llm")

    meter = LlmMeter()
    meter.llm_calls = 1
    with patch(
        "app.engine.chat_json",
        return_value='{"sql":"SELECT Name FROM PC_OldPeople","reason":"unknown column"}',
    ) as mocked:
        fixed = repair_sql(
            tenant=tenant,
            scene=scene,
            question="老人库有哪些人",
            sql="SELECT Foo FROM PC_OldPeople",
            error="Unknown column 'Foo'",
            hits=[],
            meter=meter,
        )
    assert_true(fixed is not None and "Name" in fixed["sql"], "repair returns new select")
    assert_true(mocked.call_args.kwargs.get("repair") is True, "repair flag set so plan cap is skipped")


def test_bootstrap_and_maps() -> None:
    from app.bootstrap import merge_goldens, plan_catalog, template_goldens
    from app.db import apply_value_maps

    tenant = sample_tenant()
    snap = {
        "tables": [
            {
                "name": "T1",
                "comment": "测试表",
                "cols": [{"name": "Name", "comment": "名称"}],
            }
        ],
        "skipped": ["Sys_Log"],
    }
    templates = template_goldens(snap["tables"], skip_list=set())
    questions = [i["question"] for i in templates]
    assert_true(questions.count("测试表有多少") == 1, "one count template")
    assert_true("测试表有哪些" in questions, "one list template")
    assert_true(not any("有几条" in q or "有多少行" in q for q in questions), "no duplicate count templates")
    special = [{"question": "测试表有多少", "sql": "SELECT 1", "tables": ["T1"]}]
    merged = merge_goldens(special, templates)
    assert_true(sum(1 for i in merged if i["question"] == "测试表有多少") == 1, "special wins over template")

    planned = plan_catalog(tenant, {"tables": [{"name": "PC_OldPeople", "comment": "老人库", "cols": [{"name": "Name"}]}]})
    gold_qs = [g["question"] for g in planned["golden"]]
    assert_true("分组里有哪些学生" in gold_qs, "special join golden kept")
    assert_true("护理级别分别有多少人" in gold_qs, "nursing distribution golden")
    assert_true("各机构有多少床位" in gold_qs, "beds join golden")
    assert_true(planned["special"] >= 10, "hand-written goldens not dropped")

    mapped = apply_value_maps(
        [{"Type": 1, "Name": "x"}, {"Type": "2", "Name": "y"}],
        tenant,
        ["Cultivate_Examination"],
    )
    assert_true(mapped[0]["Type"] == "文本" and mapped[1]["Type"] == "视频", "examination type map")
    status = apply_value_maps([{"Status": 1, "Name": "一组"}], tenant, ["PC_PersonGroup"])
    assert_true(status[0]["Status"] == "筹建", "person group status map")


def test_schema_link_from_comments() -> None:
    from app.catalog import schema_table_hits
    from app.engine import _PLAN_SYS, _sql_prompt
    from app.schema_link import cards_for, expand_join_tables, format_card, join_prompt_for, link_tables
    from app.scenes import get_scene
    from app.understand import parse_plan

    tenant = sample_tenant()
    assert_true("PC_OldPeople" not in _PLAN_SYS, "sys prompt must not lock a person table")

    nursing = link_tables(tenant, "按护理级别统计老人", n=8)
    nursing_names = [t.get("name") for t in nursing]
    assert_true("PC_OldPeople" in nursing_names, f"column comment 护理级别 must link old people, got {nursing_names}")

    room = link_tables(tenant, "老人住哪个房间", n=8)
    room_names = [t.get("name") for t in room]
    assert_true("PC_OldPeople" in room_names, f"老人库 comment must link, got {room_names}")
    assert_true("Sys_Room" in room_names, f"房间号/房间 comment must link Sys_Room, got {room_names}")
    expanded = expand_join_tables(tenant, "老人住哪个房间", room_names)
    assert_true("PC_OldPeople" in expanded and "Sys_Room" in expanded, "join graph keeps both room tables")

    beds = [t.get("name") for t in link_tables(tenant, "各机构有多少床位", n=8)]
    assert_true(
        "PC_CompanyBuild" in beds or "PC_CompanyItem" in beds or "PC_Company" in beds,
        f"床位 comment must link company/build, got {beds}",
    )

    count_only = [t.get("name") for t in link_tables(tenant, "老人库有多少人", n=6)]
    assert_true("PC_OldPeople" in count_only, "table comment 老人库")
    assert_true("Sys_Room" not in count_only[:3], "count-only must not drag room join")

    hits = schema_table_hits(tenant, "按护理级别统计老人")
    blob = "\n".join(str(h.get("document") or "") for h in hits)
    assert_true("PC_OldPeople" in blob and "护理级别" in blob, "schema cards include column comments")

    card = format_card(
        {"name": "Cultivate_Examination", "comment": "突发事件", "cols": [{"name": "Type", "comment": "事件类型"}]},
        tenant.value_maps,
    )
    assert_true("1=文本" in card or "1=文本" in card.replace(" ", ""), "value map on schema card")
    # maps render as 1=文本
    assert_true("文本" in card, "examination type legend")

    prompt = _sql_prompt(
        tenant,
        get_scene("assistant"),
        "按护理级别统计老人",
        hits,
    )
    assert_true("库表元数据" in prompt, "prompt is metadata-first")
    assert_true("护理级别" in prompt, "prompt carries column comments")
    assert_true("PC_OldPeople" in prompt, "linked table in prompt")

    jp = join_prompt_for(tenant, ["PC_OldPeople", "Sys_Room"])
    assert_true("Sys_Room" in jp and "RoomId" in jp, "join prompt filtered to retrieved tables")
    cards = cards_for(tenant, ["PC_OldPeople"], question="按护理级别统计老人")
    assert_true("Nursinglevel" in cards and "护理级别" in cards, "cards_for keeps comments")

    who_q = "谁报名或参加了「测试视频类」？把姓名和学号列出来。"
    who_tables = expand_join_tables(tenant, who_q, ["Cultivate_Examination"])
    assert_true(
        "Cultivate_ExaminationUser" in who_tables,
        f"参加/报名 must expand examination user join, got {who_tables}",
    )
    count_exam = expand_join_tables(tenant, "现在系统里挂着几场突发事件练习", ["Cultivate_Examination"])
    assert_true(
        "Cultivate_ExaminationUser" not in count_exam,
        f"exam count must not drag participants, got {count_exam}",
    )

    noisy_q = "现在系统里共有几场突发事件练习，分别叫什么，是文本还是视频？"
    noisy_linked = [t.get("name") for t in link_tables(tenant, noisy_q, n=10)]
    assert_true(
        noisy_linked == ["Cultivate_Examination"] or noisy_linked[0] == "Cultivate_Examination",
        f"strong exam hit must dominate weak noise tables, got {noisy_linked}",
    )
    assert_true(
        "Sys_Student" not in noisy_linked and "Sys_User" not in noisy_linked,
        f"list-exam question must not drag user/student tables, got {noisy_linked}",
    )
    noisy_expand = expand_join_tables(tenant, noisy_q, noisy_linked)
    assert_true(
        "Cultivate_ExaminationUser" not in noisy_expand
        and "PC_Question" not in noisy_expand
        and "Sys_Student" not in noisy_expand,
        f"list-exam must not expand side branches, got {noisy_expand}",
    )

    clarify_with_sql = parse_plan(
        '{"intent":"clarify","tables":["Cultivate_Examination"],"need_clarify":true,'
        '"clarify":"请说明","sql":"SELECT Name, Type FROM Cultivate_Examination","reason":"误报"}'
    )
    assert_true(
        not clarify_with_sql["need_clarify"] and clarify_with_sql["sql"],
        "sql present must cancel false clarify",
    )


def test_present_from_comments() -> None:
    from app.format_answer import format_answer
    from app.present import classify_column, empty_message, present_rows, select_hint

    tenant = sample_tenant()
    assert_true(classify_column("UserPwd", "密码") == "hide_secret", "pwd hidden")
    assert_true(classify_column("Creator", "创建人") == "hide_audit", "audit hidden")
    assert_true(classify_column("Id", "") == "hide_useless", "bare id hidden")
    assert_true(classify_column("StudentTrueName", "学生姓名") == "show", "name shown")

    raw = [
        {
            "StudentTrueName": "张一",
            "StudentName": "1001",
            "Creator": "admin",
            "Id": 9,
            "UserPwd": "x",
        }
    ]
    shown = present_rows(
        tenant,
        question="把姓名和学号列出来",
        rows=raw,
        tables=["Cultivate_ExaminationUser"],
    )
    keys = list((shown["rows"][0] or {}).keys())
    assert_true("创建人" not in keys and "Creator" not in keys, "audit col stripped")
    assert_true("Id" not in keys, "pk stripped")
    blob = " ".join(keys)
    assert_true("姓名" in blob or "学号" in blob, f"comment labels, got {keys}")
    assert_true(shown["rows"][0].get("学生姓名") == "张一" or shown["rows"][0].get("姓名") == "张一" or "张一" in shown["rows"][0].values(), "name value kept")
    details = shown.get("field_details") or []
    assert_true(len(details) >= 1, "field_details present")
    assert_true(all(d.get("label") for d in details), "field_details have labels")
    assert_true("创建人" not in " ".join(d.get("label", "") for d in details), "field_details skip audit")

    exam_raw = [
        {
            "Name": "测试文本类",
            "Type": 1,
            "Creator": "admin",
            "Id": 1,
            "IsOpen": 1,
            "Score": 100,
        }
    ]
    exam_shown = present_rows(
        tenant,
        question="现在系统里共有几场突发事件练习，分别叫什么，是文本还是视频？",
        rows=exam_raw,
        tables=["Cultivate_Examination"],
    )
    exam_keys = list((exam_shown["rows"][0] or {}).keys())
    assert_true(
        any("名称" in k or k == "Name" for k in exam_keys),
        f"name col kept, got {exam_keys}",
    )
    assert_true(
        any("类型" in k or k == "Type" for k in exam_keys),
        f"type col kept, got {exam_keys}",
    )
    # 注释判为有用的业务列（如总分）必须保留；审计/开关仍隐藏
    assert_true(
        any("总分" in k or k == "Score" for k in exam_keys),
        f"useful Score kept by comment, got {exam_keys}",
    )
    assert_true("创建人" not in exam_keys, f"audit still stripped, got {exam_keys}")
    assert_true(len(exam_shown.get("field_details") or []) == len(exam_keys), "details match shown cols")

    rich = present_rows(
        tenant,
        question="王建国的基本信息",
        rows=[
            {
                "cus_name": "王建国",
                "cus_birth": "1958-07-23",
                "cus_sex": "男",
                "cus_nation": "汉",
                "cus_address": "北京",
                "report_time": "2025-11-17",
                "service_doc_name": "陈医",
                "height": 170,
                "weight": 70,
                "heart_rate": 72,
                "systolic_bp": 130,
                "diastolic_bp": 80,
                "Creator": "admin",
                "Id": 1,
            }
        ],
        tables=["Cultivate_Examination"],
    )
    rich_keys = list((rich["rows"][0] or {}).keys())
    assert_true(len(rich_keys) >= 8, f"all useful cols kept (not capped at 6), got {rich_keys}")
    assert_true("创建人" not in rich_keys and "Id" not in rich_keys, f"audit/pk stripped, got {rich_keys}")
    rich_text = format_answer("王建国的基本信息", rich["rows"], "SELECT 1")
    assert_true("已查到" in rich_text and "1 条" in rich_text, f"summarizes single row, got {rich_text}")
    assert_true("你可以接着问" in rich_text, f"includes follow-up tips, got {rich_text}")
    assert_true("见下方表格" not in rich_text or "完整字段见下方" in rich_text, "assistant-style close")
    from app.format_answer import suggest_followups
    tips = suggest_followups("王建国的基本信息", rich["rows"])
    assert_true(len(tips) >= 1, f"suggestions nonempty, got {tips}")

    zero = format_answer("谁参加", [], "SELECT 1 WHERE IsOpen=1", empty_note=empty_message("SELECT 1 WHERE IsOpen=1"))
    assert_true("0 行" in zero and "编造" in zero, "empty db still replies")
    assert_true("开关" in zero or "过滤" in zero, "mentions tight filters")
    hint = select_hint(tenant, ["Cultivate_ExaminationUser"], "把姓名和学号列出来")
    assert_true("StudentTrueName" in hint and "学生姓名" in hint, "select hint from comments")


def test_samples_on_cards() -> None:
    from app.db import should_sample_column
    from app.schema_link import format_card, score_table

    table = {
        "name": "PC_OldPeople",
        "comment": "老人库",
        "cols": [
            {
                "name": "Nursinglevel",
                "comment": "护理级别",
                "type": "varchar(16)",
                "samples": ["一级", "二级"],
            }
        ],
    }
    card = format_card(table)
    assert_true("samples=" in card and "一级" in card, "card shows column samples")
    score, matched = score_table("一级护理有多少人", table)
    assert_true(score >= 8, f"sample hit must score, got {score}")
    assert_true("Nursinglevel" in matched, "sample col matched")
    assert_true(
        should_sample_column(
            {"name": "Nursinglevel", "type": "tinyint", "comment": "护理级别"},
            table="PC_OldPeople",
        ),
        "tinyint+级别 should sample",
    )
    assert_true(
        not should_sample_column({"name": "UserPwd", "type": "varchar(32)", "comment": "密码"}),
        "secret col must not sample",
    )


def test_skills_metrics_prompt() -> None:
    from app.engine import _sql_prompt
    from app.metrics_catalog import exact_metric, load_metrics

    tenant = sample_tenant()
    metrics = load_metrics(tenant)
    names = {m["name"] for m in metrics}
    assert_true("老人库人数" in names and "突发事件场次" in names, "p2604 metrics loaded")
    hit = exact_metric(tenant, "老人库有多少人")
    assert_true(hit is not None and "PC_OldPeople" in str(hit.get("sql") or ""), "metric alias exact")
    prompt = _sql_prompt(tenant, get_scene("exec"), "经营情况", [])
    assert_true("老人库人数" in prompt and "护理级别分布" in prompt, "exec prompt lists metrics")
    assist = _sql_prompt(tenant, get_scene("assistant"), "分组里有哪些学生", [])
    assert_true("场景技能" in assist or "后台助手" in assist, "assistant skill injected")


def test_empty_clarify_zero_llm() -> None:
    """租户目录本身为空时才允许 0-LLM 澄清；有目录时必须走 Router。"""
    from unittest.mock import patch

    tenant = sample_tenant()
    with (
        patch("app.engine.retrieve", return_value=[]),
        patch("app.engine.catalog_nonempty", return_value=False),
    ):
        events = list(
            run_turn(
                tenant=tenant,
                scene=get_scene("assistant"),
                question="今天天气怎么样",
                confirm=False,
            )
        )
    kinds = [e.get("event") for e in events]
    answer = next(e for e in events if e.get("event") == "answer")
    assert_true("execute" not in kinds, "clarify must not execute")
    assert_true(answer.get("needs_clarify") is True, "needs_clarify")
    assert_true(answer.get("error_code") == "needs_clarify", "clarify error_code")
    assert_true(answer.get("cost", {}).get("llm_calls", 1) == 0, "empty-catalog clarify is 0-LLM")
    understand = next(e for e in events if e.get("event") == "understand")
    assert_true(understand.get("reason") == "empty_catalog", "empty_catalog reason")


def test_understand_always_for_exact_golden() -> None:
    """精确黄金问句也必须先走 Understand LLM，禁止 0-LLM exact_golden 短路。"""
    from unittest.mock import patch

    tenant = sample_tenant()
    golden_hit = {
        "kind": "golden",
        "score": 1.0,
        "document": "老人库有多少人",
        "sql": "SELECT COUNT(*) AS count FROM PC_OldPeople",
        "tables": ["PC_OldPeople"],
    }
    route = {
        "path": "golden",
        "intent": "count",
        "data_domain": "general",
        "tables": ["PC_OldPeople"],
        "entities": {"names": [], "locations": []},
        "filters": {"time_range": {"relative": "", "start": "", "end": ""}, "slots": []},
        "join_needed": False,
        "golden_ok": True,
        "reason": "语义一致",
        "clarify": "",
        "need_clarify": False,
    }
    with (
        patch("app.engine.retrieve", return_value=[golden_hit]),
        patch("app.engine.run_router", return_value=route) as mock_route,
        patch("app.engine.catalog_nonempty", return_value=True),
        patch("app.engine.run_select", return_value=[{"count": 922}]),
        patch("app.engine.chat_text", return_value="老人库共有 922 人。"),
    ):
        events = list(
            run_turn(
                tenant=tenant,
                scene=get_scene("assistant"),
                question="老人库有多少人",
                confirm=True,
            )
        )
    assert_true(mock_route.called, "Understand must run even for exact golden")
    answer = next(e for e in events if e.get("event") == "answer")
    sql_ev = next(e for e in events if e.get("event") == "sql")
    assert_true(sql_ev.get("source") == "golden", "golden path after Understand")


def test_plan_slots_in_sql_prompt() -> None:
    """Understand 槽位必须注入 SQL prompt 的必须过滤块。"""
    from app.engine import _sql_prompt
    from app.scenes import get_scene

    tenant = sample_tenant()
    route = {
        "path": "llm_sql",
        "intent": "list",
        "data_domain": "person_health",
        "tables": ["person_info", "person_health_records"],
        "entities": {"names": ["龙奶奶"], "locations": []},
        "filters": {
            "time_range": {"relative": "最近一周", "start": "", "end": ""},
            "slots": [{"field_hint": "姓名", "value": "龙奶奶", "sql_match_value": "龙奶奶"}],
        },
        "join_needed": True,
    }
    from app.router import plan_to_must_filters

    prompt = _sql_prompt(
        tenant,
        get_scene("assistant"),
        "龙奶奶最近一周健康指标怎么样",
        [],
        must_filters=plan_to_must_filters(route),
    )
    assert_true("必须过滤" in prompt, "must_filters block present")
    assert_true("龙奶奶" in prompt, "name slot in prompt")
    assert_true("最近一周" in prompt, "time range in prompt")


def test_weak_schema_link_uses_router() -> None:
    """词表链不上时仍走 LLM Understand，再裁剪卡片写 SQL；禁止 no_schema_link。"""
    from unittest.mock import patch

    tenant = sample_tenant()
    route = {
        "path": "llm_sql",
        "intent": "list",
        "data_domain": "general",
        "tables": ["PC_PersonGroup", "PC_PersonGroupItem"],
        "entities": {"names": [], "locations": []},
        "filters": {"time_range": {"relative": "", "start": "", "end": ""}, "slots": []},
        "join_needed": True,
        "golden_ok": False,
        "reason": "口语二层组→人员分组",
        "clarify": "",
        "need_clarify": False,
    }
    plan_json = (
        '{"intent":"list","tables":["PC_PersonGroup","PC_PersonGroupItem"],"need_clarify":false,'
        '"clarify":"","reason":"二层组映射人员分组",'
        '"sql":"SELECT g.Name AS group_name, i.StudentName, i.StudentCode '
        "FROM PC_PersonGroup g JOIN PC_PersonGroupItem i ON g.PersonGroupId=i.PersonGroupId "
        'WHERE g.Name LIKE \'%二层%\'"}'
    )
    with (
        patch("app.engine.retrieve", return_value=[]),
        patch("app.engine.run_router", return_value=route) as mock_route,
        patch("app.engine.catalog_nonempty", return_value=True),
        patch("app.engine.chat_json", return_value=plan_json) as mock_plan,
        patch("app.engine.prune_hits_for_sql", return_value=[
            {
                "kind": "ddl",
                "score": 0.9,
                "table": "PC_PersonGroup",
                "tables": ["PC_PersonGroup"],
                "document": "TABLE PC_PersonGroup -- 人员分组",
            },
            {
                "kind": "ddl",
                "score": 0.9,
                "table": "PC_PersonGroupItem",
                "tables": ["PC_PersonGroupItem"],
                "document": "TABLE PC_PersonGroupItem -- 分组成员",
            },
        ]),
        patch("app.engine.run_select", return_value=[]),
        patch("app.engine.chat_text", return_value="二层组目前没有成员记录。"),
    ):
        events = list(
            run_turn(
                tenant=tenant,
                scene=get_scene("assistant"),
                question="我想看一下二层组都有谁",
                confirm=True,
            )
        )
    assert_true(mock_route.called, "Router must be called")
    assert_true(mock_plan.called, "SQL LLM must be called after Router")
    route_ev = next((e for e in events if e.get("event") == "route"), {})
    assert_true(route_ev.get("path") == "llm_sql", "route path llm_sql")
    understand = next((e for e in events if e.get("event") == "understand"), {})
    assert_true(understand.get("reason") != "no_schema_link", "must not short-circuit no_schema_link")
    assert_true(understand.get("need_clarify") is not True, "LLM path should not force clarify")
    assert_true(understand.get("path") == "llm_sql", "understand path llm_sql")
    sql_ev = next(e for e in events if e.get("event") == "sql")
    assert_true(sql_ev.get("source") == "llm", "SQL source is llm")
    assert_true("PC_PersonGroup" in str(sql_ev.get("sql") or ""), "SQL uses person group")
    retrieve_evs = [e for e in events if e.get("event") == "retrieve"]
    assert_true(not any(e.get("fallback") == "catalog" for e in retrieve_evs), "no full-catalog SQL fallback")


def test_promote_golden_dedup() -> None:
    import tempfile
    from pathlib import Path
    from unittest.mock import patch

    from app.golden_store import promote_golden

    tenant = sample_tenant()
    with tempfile.TemporaryDirectory() as raw:
        folder = Path(raw)
        with (
            patch("app.golden_store.tenant_folder", return_value=folder),
            patch("app.golden_store.load_schema", return_value={"tables": []}),
            patch("app.golden_store.plan_catalog", return_value={"golden": []}),
            patch("app.golden_store.upsert_chroma_golden", return_value={"ok": True}),
        ):
            first = promote_golden(
                tenant,
                question="测问黄金收录",
                sql="SELECT Name FROM PC_OldPeople",
                tables=["PC_OldPeople"],
            )
            assert_true(first.get("ok") is True and not first.get("deduped"), f"first promote, got {first}")
            again = promote_golden(
                tenant,
                question="测问黄金收录",
                sql="SELECT Name FROM PC_OldPeople",
                tables=["PC_OldPeople"],
            )
            assert_true(again.get("ok") is True and again.get("deduped") is True, "second promote deduped")
            bad = promote_golden(
                tenant,
                question="删库",
                sql="DELETE FROM PC_OldPeople",
                tables=["PC_OldPeople"],
            )
            assert_true(not bad.get("ok") and bad.get("error") == "not_select", "write sql cannot promote")


def test_manager_path_skips_checkpoint() -> None:
    from unittest.mock import patch

    tenant = sample_tenant()
    with (
        patch("app.engine.retrieve", return_value=[_p2604_golden_hit()]),
        patch("app.engine.run_router", return_value=_p2604_golden_route()),
        patch("app.engine.catalog_nonempty", return_value=True),
        patch("app.engine.pick_golden_sql", return_value=_p2604_golden_hit()),
        patch("app.engine.run_select", return_value=[{"Name": "事件A"}]),
        patch("app.engine.chat_text", return_value="目前有 1 场突发事件。"),
    ):
        events = list(
            run_turn(
                tenant=tenant,
                scene=get_scene("assistant"),
                question="目前突发事件有几个，分别是什么",
                confirm=False,
                manager_path=True,
            )
        )
    kinds = [e.get("event") for e in events]
    answer = next(e for e in events if e.get("event") == "answer")
    assert_true("checkpoint" not in kinds, "manager path skips preview")
    assert_true("execute" in kinds, "manager path executes readonly")
    assert_true(answer.get("executed") is True, "executed flag")
    assert_true(answer.get("checkpoint") is not True, "answer not checkpoint")


def test_chart_types() -> None:
    from app.chart import infer_chart

    analyst = get_scene("analyst")
    line = infer_chart(
        [{"月": "2024-01", "人数": 3}, {"月": "2024-02", "人数": 5}],
        analyst,
    )
    assert_true(line and line.get("type") == "line", f"temporal -> line, got {line}")
    pie = infer_chart(
        [{"级别": "一级", "人数": 3}, {"级别": "二级", "人数": 5}],
        analyst,
    )
    assert_true(pie and pie.get("type") == "pie", f"few classes -> pie, got {pie}")
    bar = infer_chart(
        [{"组": f"g{i}", "人数": i} for i in range(8)],
        analyst,
    )
    assert_true(bar and bar.get("type") == "bar", f"many classes -> bar, got {bar}")
    auto = get_scene("auto")
    blocked = infer_chart(
        [{"级别": "一级", "人数": 3}, {"级别": "二级", "人数": 5}],
        auto,
        want_chart=False,
    )
    assert_true(blocked is None, "want_chart false blocks even on auto")
    allowed = infer_chart(
        [{"级别": "一级", "人数": 3}, {"级别": "二级", "人数": 5}],
        auto,
        want_chart=True,
    )
    assert_true(allowed and allowed.get("type") == "pie", "want_chart true on auto")
    assist = get_scene("assistant")
    assert_true(
        infer_chart([{"级别": "一级", "人数": 3}, {"级别": "二级", "人数": 5}], assist) is None,
        "assistant scene still no chart without want",
    )


def test_router_deliverables_and_polish_gate() -> None:
    from app.router import parse_router, should_polish

    trend = parse_router(
        {
            "path": "llm_sql",
            "intent": "trend",
            "tables": ["Cultivate_Examination"],
            "confidence": 0.9,
            "reason": "趋势",
        }
    )
    assert_true(trend.get("need_chart") is True and trend.get("need_interpret") is True, "trend defaults")
    assert_true(trend.get("sys_meta") is False, "trend not sys_meta")
    listing = parse_router(
        {
            "path": "llm_sql",
            "intent": "list",
            "tables": ["Cultivate_Examination"],
            "confidence": 0.9,
            "need_chart": False,
            "need_interpret": False,
            "reason": "名单",
        }
    )
    assert_true(listing.get("need_chart") is False and listing.get("need_interpret") is False, "list explicit")
    meta = parse_router(
        {
            "path": "llm_sql",
            "intent": "meta",
            "tables": [],
            "confidence": 0.9,
            "reason": "表结构",
        }
    )
    assert_true(meta.get("sys_meta") is True, "meta forces sys_meta")
    chitchat = parse_router({"path": "chitchat", "intent": "chitchat", "clarify": "你好"})
    assert_true(
        not chitchat.get("need_chart") and not chitchat.get("need_interpret") and not chitchat.get("sys_meta"),
        "chitchat no deliverables",
    )
    assert_true(should_polish(need_interpret=True, polish_enabled=True, exec_ok=True), "polish when needed")
    assert_true(
        not should_polish(need_interpret=False, polish_enabled=True, exec_ok=True),
        "skip polish when not interpret",
    )
    assert_true(
        not should_polish(need_interpret=True, polish_enabled=False, exec_ok=True),
        "respect polish off",
    )


def test_fk_seed_joins_and_template() -> None:
    import json
    import tempfile
    from pathlib import Path

    from app.bootstrap import seed_joins_from_fks
    from app.tenants import load_tenants

    tenants = load_tenants()
    assert_true(all(not k.startswith("_") for k in tenants), "underscore yml is not a tenant")
    assert_true("_template" not in tenants and "example" not in tenants, "template skipped")
    with tempfile.TemporaryDirectory() as raw:
        folder = Path(raw)
        snap = {
            "fks": [
                {
                    "from_table": "PC_PersonGroupItem",
                    "from_col": "PersonGroupId",
                    "to_table": "PC_PersonGroup",
                    "to_col": "PersonGroupId",
                }
            ]
        }
        assert_true(seed_joins_from_fks(folder, snap) is True, "seed writes missing joins")
        again = seed_joins_from_fks(folder, snap)
        assert_true(again is False, "never overwrite hand joins")
        data = json.loads((folder / "joins.json").read_text(encoding="utf-8"))
        assert_true(any("PersonGroupId" in str(x.get("sql") or "") for x in data), "fk sql kept")


def test_browser_jwt_not_blocked_by_service_auth() -> None:
    """企业档 AGENT_SERVICE_AUTH=require 时，浏览器 JWT 不得再被 _require_auth 二次拦截。"""
    import base64
    import hashlib
    import hmac
    import json
    import time

    from app.browser_auth import require_browser_or_internal
    from app.main import _require_auth
    from app.protocol import verify_agent_service_auth
    from fastapi import Request
    from starlette.datastructures import Headers

    secret = "smoke-jwt-secret"
    os.environ["JWT_SECRET"] = secret
    os.environ["CLAWHIVE_JWT_SECRET"] = secret
    os.environ["AGENT_BROWSER_AUTH"] = "1"
    os.environ["AGENT_SERVICE_AUTH"] = "require"
    os.environ["CLAWHIVE_INTERNAL_TOKEN"] = "svc-token-smoke"

    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": "admin", "role": "admin", "exp": int(time.time()) + 3600}).encode()
    ).decode().rstrip("=")
    sig = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    jwt = f"{header}.{payload}.{sig}"

    auth = require_browser_or_internal({"authorization": f"Bearer {jwt}"})
    assert_true(auth.get("mode") == "browser", "browser jwt accepted by browser auth")
    ok, reason = verify_agent_service_auth({"authorization": f"Bearer {jwt}"})
    assert_true(not ok and reason == "agent_service_token_missing", "service-only gate rejects jwt-only")
    req = Request({"type": "http", "headers": [(b"authorization", f"Bearer {jwt}".encode())]})
    try:
        _require_auth(req)
        passed = True
    except Exception:
        passed = False
    assert_true(passed, "_require_auth accepts browser jwt under enterprise require")


def test_protocol_envelope() -> None:
    from app.protocol import (
        build_db_agent_result,
        is_manager_request,
        last_user_message,
        parse_manager_task,
        parse_turn_scope,
    )

    env = {
        "version": "2",
        "source": "manager",
        "target_agent": "db",
        "trace_id": "t1",
        "session_id": "s1",
        "utterance": "目前突发事件有几个，分别是什么",
        "payload": {
            "kind": "db",
            "data": {
                "source": "manager",
                "refined_question": "目前突发事件有几个，分别是什么",
                "turn_scope": {
                    "mode": "current_only",
                    "suppress_history": True,
                    "suppress_experience_replay": True,
                },
            },
        },
    }
    mgr = parse_manager_task(env)
    assert_true(mgr.source == "manager" and mgr.is_manager, "envelope source manager")
    assert_true(mgr.refined_question.startswith("目前突发事件"), "refined_question wins")
    assert_true(mgr.turn_scope and mgr.turn_scope.suppress_history, "suppress_history")
    scope = parse_turn_scope({"mode": "current_only"})
    assert_true(scope is not None and scope.suppress_history, "current_only suppresses history")
    q = last_user_message(
        [{"role": "assistant", "content": "hi"}, {"role": "user", "content": "末轮原文"}],
        "fallback",
    )
    assert_true(q == "末轮原文", "last user message")
    assert_true(
        is_manager_request(messages=[{"role": "user", "content": "x"}]),
        "messages means manager dbClient",
    )
    assert_true(
        not is_manager_request(headers=None, messages=None, mgr=parse_manager_task(None)),
        "standalone question-only is not manager",
    )
    fail = build_db_agent_result(answer="按这条查询在库里查到 0 行。", empty=True, error_code="empty_result")
    assert_true(fail.get("agent") == "db" and fail.get("ok") is True, "soft empty ok=true")
    assert_true(fail.get("error_code") == "empty_result", "empty keeps error_code")
    assert_true(fail.get("structured", {}).get("empty") is True, "structured.empty")
    clar = build_db_agent_result(answer="请说明对象", needs_clarify=True)
    assert_true(clar.get("needs_clarify") is True and clar.get("error_code") == "needs_clarify", "clarify code")
    assert_true(clar.get("ok") is False, "clarify still fails")
    charted = build_db_agent_result(
        answer="分布如下",
        chart={"type": "pie", "points": [{"label": "A", "value": 1}, {"label": "B", "value": 2}]},
        deliverables={"need_chart": True, "need_interpret": True, "sys_meta": False},
        rows=[{"级别": "A", "人数": 1}],
    )
    st = charted.get("structured") or {}
    assert_true(st.get("chart", {}).get("type") == "pie", "structured.chart")
    assert_true(st.get("deliverables", {}).get("need_chart") is True, "structured.deliverables")


def test_sql_match_normalize_and_location_filters() -> None:
    from app.filter_gate import assert_plan_filters, required_location_values
    from app.router import parse_router, plan_to_must_filters
    from app.sql_match_normalize import normalize_substring_equality
    from app.tenants import load_tenants

    eq = "SELECT is_gender, COUNT(*) AS count FROM person_info WHERE deleted = 0 AND provinces_and_cities = '河西区' AND age BETWEEN 70 AND 79 GROUP BY is_gender LIMIT 50"
    like = normalize_substring_equality(eq, {"person_info.provinces_and_cities": "substring"})
    assert_true("LIKE '%河西区%'" in like, "equality rewritten to LIKE")
    assert_true("= '河西区'" not in like, "no bare equality left")
    already = "WHERE provinces_and_cities LIKE '%河西区%'"
    assert_true(
        normalize_substring_equality(already, {"person_info.provinces_and_cities": "substring"}) == already,
        "LIKE unchanged",
    )
    tenants = load_tenants()
    t = tenants.get("p2026")
    assert_true(t is not None and t.column_match.get("person_info.provinces_and_cities") == "substring", "p2026 column_match")

    route = parse_router(
        {
            "path": "llm_sql",
            "intent": "aggregate",
            "tables": ["person_info"],
            "entities": {"names": [], "locations": ["河西区"]},
            "filters": {"slots": [], "time_range": {}},
            "confidence": 0.9,
        },
        t,
    )
    assert_true(
        any(s.get("field_hint") == "地区" and "河西区" in s.get("sql_match_value", "") for s in route["filters"]["slots"]),
        "locations promoted to slots",
    )
    lines = plan_to_must_filters(route)
    blob = "\n".join(lines)
    assert_true("LIKE" in blob and "包含" in blob, "must_filters use LIKE/包含")
    assert_true("地区 = 河西区" not in blob, "must_filters must not steer equality")

    plan = {
        "entities": {"names": [], "locations": ["河西区"]},
        "filters": {"slots": [{"field_hint": "地区", "value": "河西区", "sql_match_value": "河西区"}]},
    }
    assert_true(required_location_values(plan) == ["河西区"], "required location")
    bad = assert_plan_filters("SELECT 1 FROM person_info WHERE deleted=0", plan)
    assert_true(not bad.ok and "河西区" in bad.missing, "filter_gate catches missing location")
    good = assert_plan_filters(
        "SELECT 1 FROM person_info WHERE provinces_and_cities LIKE '%河西区%'",
        plan,
    )
    assert_true(good.ok, "filter_gate accepts LIKE location")

    from unittest.mock import patch

    from fastapi.testclient import TestClient

    from app.main import app
    from app.manager_compat import build_unified_task_plan, resolve_manager_session_id

    assert_true(
        resolve_manager_session_id("mgr-run1-db-step1", manager_path=True, exists=False) == "",
        "unknown mgr session -> stateless",
    )
    assert_true(
        resolve_manager_session_id("real-session", manager_path=True, exists=True) == "real-session",
        "existing session kept",
    )
    assert_true(
        resolve_manager_session_id("missing-ui", manager_path=False, exists=False) == "missing-ui",
        "standalone missing session unchanged for caller 404",
    )
    plan = build_unified_task_plan(
        question="查王建国的慢性病检测记录",
        tables=["remote_nursing_chronic"],
        hits=[{"document": "TABLE remote_nursing_chronic -- 慢病检测"}],
    )
    assert_true(plan.get("intent") == "db", "unified intent db")
    hints = plan.get("hints") or {}
    assert_true("remote_nursing_chronic" in (hints.get("suggested_tables") or []), "unified tables")
    assert_true(plan.get("prefetch_ready") is True, "prefetch_ready when tables")

    with TestClient(app) as client:
        plan_res = client.post(
            "/api/plan",
            json={"question": _P2604_GOLDEN_Q, "tenant": "p2604"},
        ).json()
        assert_true(bool(plan_res.get("unified_task_plan")), "plan returns unified_task_plan")
        utp = plan_res.get("unified_task_plan") or {}
        assert_true(
            isinstance(utp.get("hints"), dict) and isinstance(utp.get("entities"), dict),
            "unified_task_plan shape",
        )
        with (
            patch("app.engine.retrieve", return_value=[_p2604_golden_hit()]),
            patch("app.engine.run_router", return_value=_p2604_golden_route()),
            patch("app.engine.catalog_nonempty", return_value=True),
            patch("app.engine.pick_golden_sql", return_value=_p2604_golden_hit()),
            patch("app.engine.run_select", return_value=[{"Name": "事件A"}]),
            patch("app.engine.chat_text", return_value="目前有 1 场突发事件。"),
        ):
            ask = client.post(
                "/api/ask",
                json={
                    "messages": [{"role": "user", "content": _P2604_GOLDEN_Q}],
                    "session_id": "mgr-smoke-run-db-step1",
                    "tenant": "p2604",
                    "confirm": False,
                },
            )
        assert_true(ask.status_code == 200, f"manager ephemeral session ask: {ask.text}")
        assert_true(bool(ask.json().get("answer")), "manager ephemeral session answer")


def test_mcp_and_learning_http() -> None:
    from fastapi.testclient import TestClient

    from app.learning import auto_promote_allowed, curate, promote_patch
    from app.main import app

    assert_true(auto_promote_allowed() is False, "auto promote off")
    curated = curate(auto_promote=True)
    assert_true(curated.get("ok") is True, "curate ok")
    assert_true(curated.get("report", {}).get("autoPromote") is False, "curate does not promote")
    assert_true(curated.get("report", {}).get("promoted") == [], "no promoted patches")
    missing = promote_patch("")
    assert_true(not missing.get("ok") and missing.get("reason") == "missing_patch_id", "promote needs id")

    with TestClient(app) as client:
        listed = client.post("/api/mcp", json={"method": "tools/list", "id": 1}).json()
        tools = ((listed.get("result") or {}).get("tools") or [])
        names = {t.get("name") for t in tools}
        assert_true(
            names == {"schema_search", "preview_sql", "confirm_sql", "promote_golden"},
            f"four mcp tools, got {names}",
        )
        with _patch_ask_no_llm():
            preview = client.post(
                "/api/mcp",
                json={
                    "method": "tools/call",
                    "id": 2,
                    "params": {
                        "name": "preview_sql",
                        "arguments": {
                            "question": _P2604_GOLDEN_Q,
                            "tenant": "p2604",
                        },
                    },
                },
            )
        result = preview.json().get("result") or {}
        assert_true(result.get("checkpoint") is True, "mcp preview still checkpoints")
        assert_true(bool(result.get("pending_id")), "mcp preview pending")
        assert_true("Cultivate_Examination" in str(result.get("sql") or ""), "mcp preview sql")
        learn = client.get("/api/learning?tenant=p2604").json()
        assert_true("promptPatches" in learn and "promotablePatches" in learn, "learning hub shape")
        assert_true((learn.get("evolution") or {}).get("autoPromote") is False, "hub autoPromote false")
        cur = client.post("/api/learning/curate", json={"autoPromote": True}).json()
        assert_true(cur.get("report", {}).get("autoPromote") is False, "http curate no promote")
        bad = client.post("/api/learning/promote", json={})
        assert_true(bad.status_code == 400, "promote without id rejected")
        plan = client.post(
            "/api/plan",
            json={"question": _P2604_GOLDEN_Q, "tenant": "p2604"},
        ).json()
        assert_true(plan.get("path") == "golden", "plan golden candidate")
        probe = client.post(
            "/api/probe",
            json={"question": _P2604_GOLDEN_Q, "tenant": "p2604"},
        ).json()
        assert_true(probe.get("golden") is True, "probe golden hit")
        assert_true(probe.get("llm") is True, "full ask path needs Understand LLM")


def test_experience_no_pg() -> None:
    from unittest.mock import patch

    from app.experience import (
        _is_confirmed,
        may_recall_row,
        recall_experience,
        resolve_experience_path_conflicts,
    )
    from app.learning import record_feedback

    with patch("app.experience._database_url", return_value=""):
        rows = recall_experience("目前突发事件有几个，分别是什么", tenant_id="p2604")
    assert_true(rows == [], "no pg returns empty")

    assert_true(
        _is_confirmed({"source": "vanna_feedback|useful|sid:x", "userConfirmed": False}),
        "vanna useful recallable",
    )
    assert_true(
        _is_confirmed({"source": "manager_feedback_confirmed", "userConfirmed": False}),
        "manager thumbs-up recallable",
    )
    assert_true(
        not _is_confirmed({"source": "manager_finalize_sync", "status": "confirmed"}),
        "finalize auto sync not recallable",
    )
    assert_true(
        not _is_confirmed({"source": "voided|vanna_feedback|useful"}),
        "voided not recallable",
    )
    assert_true(
        not _is_confirmed({"source": "vanna_golden_promote"}),
        "golden promote not recallable as useful",
    )
    with patch("app.experience._confirmed_only", return_value=True):
        assert_true(
            not may_recall_row({"source": "manager_finalize_sync"}, manager_path=False),
            "confirmed_only blocks finalize",
        )
        assert_true(
            may_recall_row({"source": "vanna_feedback|useful"}, manager_path=False),
            "confirmed_only allows useful",
        )

    resolved = resolve_experience_path_conflicts(
        [
            {
                "question_norm": "突发事件个数",
                "path": "sql_direct",
                "source": "shadow",
                "ts": "2026-01-01T00:00:00+00:00",
            },
            {
                "question_norm": "突发事件个数",
                "path": "golden",
                "source": "manager_feedback_confirmed",
                "ts": "2026-08-01T00:00:00+00:00",
            },
        ]
    )
    assert_true(len(resolved) == 1, "path conflict collapses to one")
    assert_true(resolved[0].get("path") == "golden", "confirmed/newer path wins")

    bad = record_feedback(question="", score=1)
    assert_true(not bad.get("ok"), "feedback needs question")
    pos = record_feedback(
        question="目前突发事件有几个，分别是什么",
        score=1,
        sql="SELECT Name, Type FROM Cultivate_Examination",
        tables=["Cultivate_Examination"],
    )
    assert_true(pos.get("ok") is True and pos.get("autoPromote") is False, "useful feedback ok")
    neg = record_feedback(question="目前突发事件有几个，分别是什么", score=-1, comment="列太多")
    assert_true(neg.get("ok") is True and neg.get("status") == "shadow", "useless goes shadow")
    assert_true(bool(neg.get("patchId")), "shadow patch id")


def test_feedback_void_on_withdraw() -> None:
    """撤回/重生：反馈与 shadow patch 作废，不进学习面（对齐总管）。"""
    from app.learning import (
        invalidate_learning_for_messages,
        learning_summary,
        record_feedback,
    )
    from app.tenants import load_tenants

    sid = "smoke-void-sess"
    mid = "msg-assistant-1"
    neg = record_feedback(
        question="目前突发事件有几个，分别是什么",
        score=-1,
        comment="作废测",
        session_id=sid,
        message_id=mid,
    )
    assert_true(neg.get("ok") is True and bool(neg.get("patchId")), "feedback with message_id")
    voided = invalidate_learning_for_messages(
        session_id=sid,
        message_ids=[mid],
        questions=["目前突发事件有几个，分别是什么"],
    )
    assert_true(int(voided.get("voidedFeedback") or 0) >= 1, "voided feedback rows")
    assert_true(int(voided.get("voidedPatches") or 0) >= 1, "voided shadow patches")
    tenants = load_tenants()
    t = tenants.get("p2604") or sample_tenant()
    hub = learning_summary(t)
    for p in hub.get("promotablePatches") or []:
        assert_true(str(p.get("status") or "") != "voided", "hub excludes voided patches")
        assert_true(str(p.get("id") or "") != str(neg.get("patchId") or ""), "voided patch not promotable")


def test_manager_ask_fixture() -> None:
    from unittest.mock import patch

    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        with (
            _patch_ask_no_llm(),
            patch("app.engine.run_select", return_value=[{"Name": "事件A"}]),
            patch("app.engine.chat_text", return_value="目前有 1 场。"),
        ):
            ask = client.post(
                "/api/ask",
                json={
                    "question": "忽略我",
                    "messages": [{"role": "user", "content": "忽略我"}],
                    "dbId": "p2604",
                    "managerTask": {
                        "source": "manager",
                        "refined_question": _P2604_GOLDEN_Q,
                        "turn_scope": {
                            "mode": "current_only",
                            "suppress_history": True,
                            "suppress_experience_replay": True,
                        },
                    },
                },
            )
        body = ask.json()
        events = [e.get("event") for e in body.get("events") or []]
        assert_true("checkpoint" not in events, "manager ask skips checkpoint")
        assert_true("execute" in events, "manager ask executes")
        assert_true(isinstance(body.get("answer"), str), "manager answer string")
        ar = body.get("agentResult") or {}
        assert_true(ar.get("agent") == "db", "manager agentResult db")


def test_filter_gate_and_router_confidence() -> None:
    from app.filter_gate import assert_plan_filters
    from app.router import parse_router

    plan = {
        "path": "llm_sql",
        "filters": {
            "time_range": {"relative": "最近一周", "start": "", "end": ""},
            "slots": [{"field_hint": "姓名", "value": "陈明宇", "sql_match_value": "陈明宇"}],
        },
        "entities": {"names": ["陈明宇"], "locations": []},
    }
    ok = assert_plan_filters(
        "SELECT * FROM remote_activity_foot_log WHERE person_name='陈明宇' "
        "AND create_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)",
        plan,
    )
    assert_true(ok.ok, "ok sql passes person gate")
    bad = assert_plan_filters("SELECT COUNT(*) FROM remote_activity_foot_log", plan)
    assert_true(not bad.ok, "missing name fails gate")
    assert_true(any("陈明宇" in m for m in bad.missing), "missing name reported")
    # 年龄/枚举不硬拦：模型主导写 SQL
    soft = assert_plan_filters(
        "SELECT is_gender, COUNT(*) FROM person_info WHERE age BETWEEN 70 AND 79 GROUP BY is_gender",
        {
            "filters": {
                "slots": [
                    {"field_hint": "年龄", "sql_match_value": "70,79"},
                    {"field_hint": "性别", "sql_match_value": "1"},
                ],
                "time_range": {},
            },
            "entities": {"names": []},
        },
    )
    assert_true(soft.ok, "age/gender slots are not hard-gated")

    demoted = parse_router(
        {
            "path": "golden",
            "intent": "count",
            "tables": ["person_info"],
            "confidence": 0.5,
            "golden_ok": True,
            "filters": {"time_range": {}, "slots": []},
            "entities": {"names": [], "locations": []},
        },
        tenant=None,
    )
    assert_true(demoted["path"] == "llm_sql", "low confidence demotes golden")
    clarify = parse_router(
        {
            "path": "llm_sql",
            "intent": "list",
            "tables": [],
            "confidence": 0.1,
            "filters": {"time_range": {}, "slots": []},
            "entities": {"names": [], "locations": []},
        },
        tenant=None,
    )
    assert_true(clarify["path"] == "clarify", "low conf empty tables → clarify")


def test_nl_eval_contract() -> None:
    import importlib.util

    path = ROOT / "scripts" / "eval_nl_contract.py"
    spec = importlib.util.spec_from_file_location("eval_nl_contract", path)
    assert_true(spec is not None and spec.loader is not None, "eval_nl_contract loadable")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    fails = mod.run_nl_eval("p2026")
    assert_true(not fails, "nl_eval failures: " + "; ".join(fails[:5]))


def test_golden_source_metering() -> None:
    from app.bootstrap import merge_goldens

    merged = merge_goldens(
        [{"question": "a", "sql": "SELECT 1", "tables": ["t"], "source": "special"}],
        [{"question": "b", "sql": "SELECT 2", "tables": ["t"]}],
    )
    by_q = {g["question"]: g for g in merged}
    assert_true(by_q["a"]["source"] == "special", "special tagged")
    assert_true(by_q["b"]["source"] == "template", "template tagged")


def main() -> None:
    test_guard()
    test_scenes()
    test_stub_and_checkpoint()
    test_budget_and_ui()
    test_ingest_embed_budget()
    test_repair_only_on_execute_error()
    test_bootstrap_and_maps()
    test_schema_link_from_comments()
    test_present_from_comments()
    test_samples_on_cards()
    test_skills_metrics_prompt()
    test_understand_always_for_exact_golden()
    test_plan_slots_in_sql_prompt()
    test_empty_clarify_zero_llm()
    test_weak_schema_link_uses_router()
    test_promote_golden_dedup()
    test_manager_path_skips_checkpoint()
    test_filter_gate_and_router_confidence()
    test_nl_eval_contract()
    test_golden_source_metering()
    test_chart_types()
    test_router_deliverables_and_polish_gate()
    test_fk_seed_joins_and_template()
    test_browser_jwt_not_blocked_by_service_auth()
    test_protocol_envelope()
    test_sql_match_normalize_and_location_filters()
    test_manager_compat_session_and_plan()
    test_mcp_and_learning_http()
    test_experience_no_pg()
    test_feedback_void_on_withdraw()
    test_manager_ask_fixture()
    test_api_ready()
    test_not_in_manager()
    print("smoke_vanna_contract: ok")


if __name__ == "__main__":
    main()
