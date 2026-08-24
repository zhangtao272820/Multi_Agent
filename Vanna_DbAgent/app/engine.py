from __future__ import annotations

import time
from typing import Any, Iterator

from app.audit import write_audit
from app.catalog import pick_golden_sql, prune_hits_for_sql, retrieve
from app.chart import infer_chart
from app.db import apply_value_maps, run_select
from app.domain_patch import blueprint_prompt_block
from app.filter_gate import assert_plan_filters, values_from_must_filter_lines
from app.format_answer import format_answer
from app.llm import LlmMeter, chat_json, chat_text
from app.metrics_catalog import metrics_prompt_block
from app.pending import drop_pending, save_pending
from app.present import empty_message, present_rows, select_hint
from app.router import catalog_nonempty, plan_to_must_filters, run_router
from app.scenes import Scene, get_scene
from app.schema_link import cards_for, join_prompt_for
from app.settings import get_settings
from app.skills import skill_prompt_block
from app.sql_guard import GUARD_REASONS, guard_sql
from app.tenants import Tenant
from app.understand import parse_plan

_PLAN_SYS = """你是只读数据库助手。先理解用户问题与「查询计划/必须过滤」，再写一条 MySQL SELECT/WITH。
只输出 JSON：
{"intent":"count|list|aggregate|join|trend|clarify|chitchat|meta","tables":["表名"],"need_clarify":false,"clarify":"","reason":"一句话","sql":"SELECT ..."}
规则：
- intent：计数 count；名单 list；分组/同比/分布 aggregate；趋势 trend；两表以上 join；缺关键对象 clarify；闲聊 chitchat；库结构 meta。
- 只用「库表元数据」里出现的表和列，表名大小写一致。列含义以注释为准。
- 「必须过滤 / 查询计划」里的每一条（姓名、时间、枚举 sql_match_value）必须写入 WHERE 或 JOIN，禁止忽略。
- 人名用卡片注释标明的姓名列；枚举/编码以领域蓝图或列注释为准。
- 时间条件必须用卡片注释标明的时间列（如 create_time）；相对时间按「最近一周/本月」写成区间。
- 选出的列必须是注释上可展示的业务字段；不要 SELECT 主键、创建人/修改时间、密码证件。
- 涉及两个业务对象必须 JOIN，JOIN 只能用提供的关系，禁止无 ON 的笛卡尔积。
- 禁止 INSERT/UPDATE/DELETE/DDL、多语句、INTO OUTFILE、SLEEP、UserPwd/password/id_card。
- need_clarify=true 的唯一条件：通读元数据后仍找不到任何可对上的业务表。禁止因说法不标准就澄清。
- 闲聊/天气等与库无关：intent=chitchat，sql 为空，clarify 里用中文直接回答。
"""

_REPAIR_SYS = """你是只读 SQL 修复器。根据 MySQL 报错或「缺失过滤」提示改写一条 SELECT/WITH。
只输出 JSON：{"sql":"SELECT ...","reason":"一句话"}
规则：
- 只用提供的表和列，表名大小写一致。
- JOIN 必须有 ON，禁止笛卡尔积。
- 若提示缺失过滤值，必须把这些字面量写入 WHERE/JOIN。
- 相对时间须写成 DATE_SUB / INTERVAL / 日期区间。
- 禁止写操作、多语句、INTO OUTFILE、SLEEP、敏感列。
- 不要编造不存在的列。报错是未知列就换成 DDL 里的列。
"""

_ANSWER_SYS = """你是数据库问数助手。根据查询结果用中文自然回复用户。
规则：
- 只使用提供的行数据与数字，禁止编造。0 行就说库里按当前条件没有记录，并提示可能是过滤过严或确实没数据。
- 像同事口头汇报：先答结论，再补关键细节；不要复述 SQL。
- 表头已是字段注释，直接用这些中文列名。
- 若行数很多，概括并举 3～8 个例子。
- 枚举值若已是中文（如文本/视频）直接用。
"""


def _need_checkpoint(scene: Scene, confirm: bool, *, manager_path: bool = False) -> bool:
    if manager_path or confirm:
        return False
    if scene.force_checkpoint:
        return True
    return bool(get_settings().vanna_checkpoint_default)


def _history_block(history: list[dict[str, str]] | None) -> str:
    if not history:
        return ""
    lines = []
    for m in history[-8:]:
        role = "用户" if m.get("role") == "user" else "助手"
        lines.append(f"{role}：{m.get('content')}")
    return "近期对话：\n" + "\n".join(lines) + "\n\n"


def _sql_prompt(
    tenant: Tenant,
    scene: Scene,
    question: str,
    hits: list[dict[str, Any]],
    history: list[dict[str, str]] | None = None,
    *,
    hint_tables: list[str] | None = None,
    hint_fields: list[str] | None = None,
    must_filters: list[str] | None = None,
    experience_block: str = "",
) -> str:
    tables = _tables_from_hits(hits)
    for t in hint_tables or []:
        if t and t.lower() not in {x.lower() for x in tables}:
            tables.append(t)
    # 只使用传入 hits 中的 DDL 卡片（应由 Router prune）；禁止整库 docs/golden dump。
    cards = cards_for(tenant, tables, question=question)
    if not cards:
        fallback = [h["document"] for h in hits if h.get("kind") == "ddl"][:8]
        cards = "\n\n".join(fallback) or "(无)"
    doc_bits = [h["document"] for h in hits if h.get("kind") == "doc"][:2]
    gold_bits = [
        f"Q: {h.get('document')}\nSQL: {h.get('sql')}"
        for h in hits
        if h.get("kind") == "golden" and h.get("sql")
    ][:2]
    allow = ", ".join(tenant.table_whitelist_prefixes + tenant.table_whitelist) or "(none)"
    hint = select_hint(tenant, tables, question)
    skill_block = skill_prompt_block(scene.id, tenant, hits)
    metric_block = ""
    if scene.id in {"exec", "analyst"}:
        metric_block = metrics_prompt_block(tenant)
    mgr_bits: list[str] = []
    if hint_tables:
        mgr_bits.append("提示表：" + ", ".join(hint_tables))
    if hint_fields:
        mgr_bits.append("提示字段：" + ", ".join(hint_fields))
    if must_filters:
        mgr_bits.append("必须过滤：\n- " + "\n- ".join(must_filters))
    body = (
        f"租户 {tenant.id} {tenant.title}\n"
        f"场景 {scene.id}：{scene.prompt_extra}\n"
        f"表白名单前缀/表：{allow}\n\n"
        f"{blueprint_prompt_block(tenant)}"
        f"{(skill_block + chr(10) + chr(10)) if skill_block else ''}"
        f"{(metric_block + chr(10) + chr(10)) if metric_block else ''}"
        f"{(chr(10).join(mgr_bits) + chr(10) + chr(10)) if mgr_bits else ''}"
        f"{(experience_block + chr(10) + chr(10)) if experience_block else ''}"
        f"{_history_block(history)}"
        f"库表元数据（名称与注释，只能用这些表列）：\n{cards or '(无)'}\n\n"
        f"{(hint + chr(10) + chr(10)) if hint else ''}"
        f"JOIN 关系：\n{join_prompt_for(tenant, tables, question=question)}\n\n"
        f"文档：\n{chr(10).join(doc_bits) or '(无)'}\n\n"
        f"示例：\n{chr(10).join(gold_bits) or '(无)'}\n\n"
        f"用户问题：{question}"
    )
    cap = int(get_settings().vanna_max_prompt_chars)
    return body if len(body) <= cap else body[:cap]


def _tables_from_hits(hits: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for h in hits:
        for t in h.get("tables") or []:
            k = str(t)
            if k and k.lower() not in seen:
                seen.add(k.lower())
                out.append(k)
        if h.get("table"):
            k = str(h["table"])
            if k.lower() not in seen:
                seen.add(k.lower())
                out.append(k)
    return out


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _answer_event(
    *,
    text: str,
    rows: list[dict[str, Any]] | None = None,
    sql: str = "",
    chart: Any = None,
    meter: LlmMeter,
    started: float,
    checkpoint: bool = False,
    pending_id: str = "",
    needs_clarify: bool = False,
    empty: bool = False,
    error_code: str = "",
    executed: bool = False,
    field_details: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    return {
        "event": "answer",
        "text": text,
        "rows": rows or [],
        "sql": sql,
        "chart": chart,
        "cost": {**meter.as_dict(), "elapsed_ms": _elapsed_ms(started)},
        "checkpoint": checkpoint,
        "pending_id": pending_id,
        "needs_clarify": needs_clarify,
        "empty": empty,
        "error_code": error_code,
        "executed": executed,
        "field_details": field_details or [],
    }


def repair_sql(
    *,
    tenant: Tenant,
    scene: Scene,
    question: str,
    sql: str,
    error: str,
    hits: list[dict[str, Any]],
    meter: LlmMeter,
    hint_tables: list[str] | None = None,
    hint_fields: list[str] | None = None,
    must_filters: list[str] | None = None,
    experience_block: str = "",
) -> dict[str, str] | None:
    if not error or not sql:
        return None
    if meter.repair_calls >= meter.repair_cap():
        return None
    try:
        raw = chat_json(
            _REPAIR_SYS,
            (
                f"{_sql_prompt(tenant, scene, question, hits, hint_tables=hint_tables, hint_fields=hint_fields, must_filters=must_filters, experience_block=experience_block)}\n\n"
                f"失败 SQL：{sql}\n"
                f"MySQL 错误：{error[:800]}"
            ),
            meter,
            max_tokens=700,
            repair=True,
        )
    except RuntimeError as exc:
        if "llm_budget" in str(exc):
            return None
        raise
    plan = parse_plan(raw)
    fixed = str(plan.get("sql") or "").strip()
    if not fixed or fixed.strip().rstrip(";") == sql.strip().rstrip(";"):
        return None
    return {"sql": fixed, "reason": str(plan.get("reason") or "repaired")}


def _audit(
    *,
    tenant: Tenant,
    scene: Scene,
    question: str,
    sql: str,
    executed: bool,
    row_count: int,
    meter: LlmMeter,
    started: float,
    tables: list[str],
    error: str = "",
    pending_id: str = "",
) -> None:
    write_audit(
        {
            "tenant": tenant.id,
            "scene": scene.id,
            "question": question,
            "tables": tables,
            "sql": sql,
            "executed": executed,
            "row_count": row_count,
            "elapsed_ms": _elapsed_ms(started),
            "llm_calls": meter.llm_calls,
            "embed_calls": meter.embed_calls,
            "prompt_tokens": meter.prompt_tokens,
            "completion_tokens": meter.completion_tokens,
            "error": error,
            "pending_id": pending_id,
        }
    )


def run_turn(
    *,
    tenant: Tenant,
    scene: Scene | None,
    question: str,
    confirm: bool = False,
    pending: dict[str, Any] | None = None,
    sql_override: str | None = None,
    history: list[dict[str, str]] | None = None,
    manager_path: bool = False,
    hint_tables: list[str] | None = None,
    hint_fields: list[str] | None = None,
    must_filters: list[str] | None = None,
    experience_block: str = "",
    experience_hits: int = 0,
) -> Iterator[dict[str, Any]]:
    started = time.perf_counter()
    scene = scene or get_scene(None)
    meter = LlmMeter()
    settings = get_settings()
    q = str(question or "").strip()
    max_q = int(settings.vanna_max_question_chars)
    if len(q) > max_q:
        msg = f"问题最长 {max_q} 字，请缩短后重试。本轮未调用模型。"
        yield {"event": "retrieve", "tables": [], "hits": [], "scene": scene.id}
        yield _answer_event(
            text=msg,
            meter=meter,
            started=started,
            error_code="business",
        )
        _audit(
            tenant=tenant,
            scene=scene,
            question=q[:240],
            sql="",
            executed=False,
            row_count=0,
            meter=meter,
            started=started,
            tables=[],
            error="question_too_long",
        )
        return

    if scene.stub:
        msg = scene.stub_message
        yield {"event": "retrieve", "tables": [], "hits": [], "scene": scene.id}
        yield {"event": "sql", "sql": "", "source": "stub"}
        yield {
            "event": "guard",
            "ok": True,
            "reason": "stub",
            "reason_text": "场景已路由，能力建设中，不执行业务 SQL",
        }
        yield _answer_event(text=msg, meter=meter, started=started, error_code="business")
        _audit(
            tenant=tenant,
            scene=scene,
            question=q,
            sql="",
            executed=False,
            row_count=0,
            meter=meter,
            started=started,
            tables=[],
        )
        return

    hits: list[dict[str, Any]] = []
    source = "llm"
    sql = ""
    plan: dict[str, Any] = {}

    if pending:
        sql = str(sql_override or pending.get("sql") or "").strip()
        hits = list(pending.get("hits") or [])
        source = str(pending.get("source") or "pending")
        yield {
            "event": "retrieve",
            "tables": _tables_from_hits(hits),
            "hits": [{"kind": h.get("kind"), "score": h.get("score"), "table": h.get("table")} for h in hits],
            "scene": scene.id,
        }
        yield {"event": "sql", "sql": sql, "source": source}
    else:
        hits = retrieve(tenant, q, meter)
        if hint_tables:
            from app.catalog import ddl_for_tables

            extra = ddl_for_tables(tenant, hint_tables)
            seen = {str(h.get("table") or "").lower() for h in hits if h.get("table")}
            for h in extra:
                if str(h.get("table") or "").lower() not in seen:
                    hits.append(h)
        tables_hit = _tables_from_hits(hits)
        yield {
            "event": "retrieve",
            "tables": tables_hit,
            "hits": [
                {
                    "kind": h.get("kind"),
                    "score": h.get("score"),
                    "table": h.get("table"),
                    "document": str(h.get("document") or "")[:240],
                }
                for h in hits
            ],
            "scene": scene.id,
        }
        golden = pick_golden_sql(hits)
        plan = {
            "intent": "list",
            "tables": tables_hit,
            "need_clarify": False,
            "clarify": "",
            "reason": "",
            "sql": "",
            "path": "",
        }
        route: dict[str, Any] | None = None
        if not catalog_nonempty(tenant):
            text = "没有在当前租户目录里找到对应的表。请说明要查的对象（例如老人、分组、突发事件），或换一个说法。"
            yield {
                "event": "understand",
                "intent": "clarify",
                "tables": [],
                "reason": "empty_catalog",
                "need_clarify": True,
                "path": "clarify",
            }
            yield {"event": "sql", "sql": "", "source": "clarify"}
            yield _answer_event(
                text=text,
                meter=meter,
                started=started,
                needs_clarify=True,
                error_code="needs_clarify",
            )
            _audit(
                tenant=tenant,
                scene=scene,
                question=q,
                sql="",
                executed=False,
                row_count=0,
                meter=meter,
                started=started,
                tables=[],
                error="empty_catalog",
            )
            return
        else:
            try:
                route = run_router(tenant, q, hits, meter, history=history)
            except RuntimeError as exc:
                if "llm_budget" not in str(exc):
                    raise
                yield {
                    "event": "understand",
                    "intent": "clarify",
                    "tables": tables_hit,
                    "reason": "llm_budget_exceeded",
                    "need_clarify": False,
                    "path": "clarify",
                }
                yield _answer_event(
                    text="本轮模型调用已达上限（默认 Router+SQL 共 2 次）。请改用左侧黄金示例，或缩短问题后再问。",
                    meter=meter,
                    started=started,
                    error_code="business",
                )
                _audit(
                    tenant=tenant,
                    scene=scene,
                    question=q,
                    sql="",
                    executed=False,
                    row_count=0,
                    meter=meter,
                    started=started,
                    tables=tables_hit,
                    error="llm_budget_exceeded",
                )
                return
            path = str(route.get("path") or "llm_sql")
            plan["path"] = path
            plan["intent"] = route.get("intent") or plan["intent"]
            plan["data_domain"] = route.get("data_domain") or "general"
            plan["filters"] = route.get("filters") or {}
            plan["entities"] = route.get("entities") or {}
            plan["join_needed"] = bool(route.get("join_needed"))
            plan["tables"] = list(route.get("tables") or tables_hit)
            plan["reason"] = str(route.get("reason") or "")
            plan["clarify"] = str(route.get("clarify") or "")
            plan["need_clarify"] = bool(route.get("need_clarify"))
            plan["confidence"] = float(route.get("confidence") or 0.6)
            slots = (plan.get("filters") or {}).get("slots") or []
            yield {
                "event": "route",
                "path": path,
                "intent": plan["intent"],
                "data_domain": plan.get("data_domain"),
                "tables": plan["tables"],
                "golden_ok": bool(route.get("golden_ok")),
                "confidence": plan["confidence"],
                "reason": plan["reason"],
                "slots": [
                    {"field_hint": s.get("field_hint"), "value": s.get("value")}
                    for s in slots
                    if isinstance(s, dict)
                ][:8],
            }
            if path == "chitchat" or path == "clarify":
                text = plan["clarify"] or plan["reason"] or (
                    "问题不够明确，请补充要查的对象（表/名单/时间）。"
                    if path == "clarify"
                    else "好的。"
                )
                source = path
                yield {
                    "event": "understand",
                    "intent": plan["intent"],
                    "tables": plan["tables"],
                    "reason": plan["reason"],
                    "need_clarify": path == "clarify",
                    "path": path,
                }
                yield {"event": "sql", "sql": "", "source": source}
                yield _answer_event(
                    text=text,
                    meter=meter,
                    started=started,
                    needs_clarify=path == "clarify",
                    error_code="needs_clarify" if path == "clarify" else "",
                )
                _audit(
                    tenant=tenant,
                    scene=scene,
                    question=q,
                    sql="",
                    executed=False,
                    row_count=0,
                    meter=meter,
                    started=started,
                    tables=list(plan["tables"]),
                    error=path,
                )
                return
            if path == "golden" and route.get("golden_ok") and golden and golden.get("sql"):
                sql = str(golden.get("sql") or "")
                source = "golden"
                plan["sql"] = sql
                plan["intent"] = "join" if " join " in sql.lower() else (plan.get("intent") or "list")
            else:
                # llm_sql：只喂 Understand 点名表 + JOIN 一跳卡片；槽位强制进 SQL prompt
                plan_filters = plan_to_must_filters(route)
                combined_filters: list[str] = list(must_filters or [])
                for line in plan_filters:
                    if line not in combined_filters:
                        combined_filters.append(line)
                sql_hits = prune_hits_for_sql(
                    tenant, q, hits, list(plan.get("tables") or []), plan=route
                )
                if hint_tables:
                    from app.catalog import ddl_for_tables

                    seen = {str(h.get("table") or "").lower() for h in sql_hits if h.get("table")}
                    for h in ddl_for_tables(tenant, hint_tables):
                        if str(h.get("table") or "").lower() not in seen:
                            sql_hits.append(h)
                hits = sql_hits
                tables_hit = _tables_from_hits(hits)
                plan["tables"] = tables_hit or plan["tables"]
                try:
                    raw = chat_json(
                        _PLAN_SYS,
                        _sql_prompt(
                            tenant,
                            scene,
                            q,
                            hits,
                            history=history,
                            hint_tables=hint_tables,
                            hint_fields=hint_fields,
                            must_filters=combined_filters or None,
                            experience_block=experience_block,
                        ),
                        meter,
                        max_tokens=900,
                    )
                    plan_llm = parse_plan(raw)
                    sql = str(plan_llm.get("sql") or "")
                    source = "llm"
                    plan["intent"] = plan_llm.get("intent") or plan["intent"]
                    plan["tables"] = list(plan_llm.get("tables") or plan["tables"])
                    plan["reason"] = str(plan_llm.get("reason") or plan["reason"])
                    plan["clarify"] = str(plan_llm.get("clarify") or "")
                    plan["need_clarify"] = bool(plan_llm.get("need_clarify"))
                    plan["sql"] = sql
                    plan["path"] = "llm_sql"
                except RuntimeError as exc:
                    if "llm_budget" not in str(exc):
                        raise
                    yield {
                        "event": "understand",
                        "intent": "clarify",
                        "tables": tables_hit,
                        "reason": "llm_budget_exceeded",
                        "need_clarify": False,
                        "path": "llm_sql",
                    }
                    yield _answer_event(
                        text="本轮模型调用已达上限（默认 Router+SQL 共 2 次）。请改用左侧黄金示例，或缩短问题后再问。",
                        meter=meter,
                        started=started,
                        error_code="business",
                    )
                    _audit(
                        tenant=tenant,
                        scene=scene,
                        question=q,
                        sql="",
                        executed=False,
                        row_count=0,
                        meter=meter,
                        started=started,
                        tables=tables_hit,
                        error="llm_budget_exceeded",
                    )
                    return
        yield {
            "event": "understand",
            "intent": plan.get("intent"),
            "tables": plan.get("tables") or tables_hit,
            "reason": plan.get("reason") or "",
            "need_clarify": bool(plan.get("need_clarify")),
            "path": plan.get("path") or source,
            "data_domain": plan.get("data_domain"),
            "slots": [
                {"field_hint": s.get("field_hint"), "value": s.get("value")}
                for s in ((plan.get("filters") or {}).get("slots") or [])
                if isinstance(s, dict)
            ][:8],
        }
        if plan.get("need_clarify") or (plan.get("intent") == "chitchat" and not sql):
            text = str(plan.get("clarify") or plan.get("reason") or "问题不够明确，请补充要查的对象（表/名单/时间）。")
            yield {"event": "sql", "sql": "", "source": source}
            clarify = bool(plan.get("need_clarify"))
            yield _answer_event(
                text=text,
                meter=meter,
                started=started,
                needs_clarify=clarify,
                error_code="needs_clarify" if clarify else "",
            )
            _audit(
                tenant=tenant,
                scene=scene,
                question=q,
                sql="",
                executed=False,
                row_count=0,
                meter=meter,
                started=started,
                tables=list(plan.get("tables") or tables_hit),
                error="clarify" if clarify else "chitchat",
            )
            return
        yield {"event": "sql", "sql": sql, "source": source}

    if sql_override and not pending:
        sql = sql_override

    # 约束硬闸：仅人名漏写时拦（年龄/枚举/时间交给 SQL 模型）；pending 跳过
    if sql and not pending:
        extra_vals = values_from_must_filter_lines(must_filters)
        gate = assert_plan_filters(sql, plan or None, extra_values=extra_vals)
        if not gate.ok:
            yield {
                "event": "filter_gate",
                "ok": False,
                "missing": gate.missing,
                "sql": sql,
            }
            plan_filters = plan_to_must_filters(plan) if plan else []
            combined: list[str] = list(must_filters or [])
            for line in plan_filters:
                if line not in combined:
                    combined.append(line)
            miss_msg = "缺失人名过滤：" + "、".join(gate.missing)
            fixed = repair_sql(
                tenant=tenant,
                scene=scene,
                question=q,
                sql=sql,
                error=miss_msg,
                hits=hits,
                meter=meter,
                hint_tables=hint_tables,
                hint_fields=hint_fields,
                must_filters=combined or None,
                experience_block=experience_block,
            )
            if fixed:
                yield {
                    "event": "repair",
                    "sql": fixed["sql"],
                    "reason": fixed.get("reason") or "filter_gate",
                    "error": miss_msg,
                }
                gate2 = assert_plan_filters(fixed["sql"], plan or None, extra_values=extra_vals)
                gate = gate2
                if gate2.ok:
                    sql = fixed["sql"]
                    source = "repair"
                    yield {
                        "event": "filter_gate",
                        "ok": True,
                        "missing": [],
                        "sql": sql,
                    }
            if not gate.ok:
                text = (
                    "查询未写入必要人名条件（"
                    + "、".join(gate.missing)
                    + "）。请改写问题后再试。"
                )
                yield _answer_event(
                    text=text,
                    sql=sql,
                    meter=meter,
                    started=started,
                    error_code="business",
                )
                _audit(
                    tenant=tenant,
                    scene=scene,
                    question=q,
                    sql=sql,
                    executed=False,
                    row_count=0,
                    meter=meter,
                    started=started,
                    tables=list((plan or {}).get("tables") or _tables_from_hits(hits)),
                    error="filter_gate",
                )
                return

    guarded = guard_sql(
        sql,
        tenant=tenant,
        scene=scene,
        max_limit=settings.vanna_default_limit,
        default_limit=settings.vanna_default_limit,
    )
    yield {
        "event": "guard",
        "ok": guarded.ok,
        "reason": guarded.reason,
        "reason_text": GUARD_REASONS.get(guarded.reason, guarded.reason),
        "sql": guarded.sql,
        "tables": guarded.tables,
    }
    if not guarded.ok:
        yield _answer_event(
            text=f"SQL 未通过安全闸：{GUARD_REASONS.get(guarded.reason, guarded.reason)}",
            sql=guarded.sql,
            meter=meter,
            started=started,
            error_code="business",
        )
        _audit(
            tenant=tenant,
            scene=scene,
            question=q,
            sql=guarded.sql,
            executed=False,
            row_count=0,
            meter=meter,
            started=started,
            tables=guarded.tables,
            error=guarded.reason,
        )
        return

    if _need_checkpoint(scene, confirm, manager_path=manager_path):
        pid = save_pending(
            {
                "tenant": tenant.id,
                "scene": scene.id,
                "question": q,
                "sql": guarded.sql,
                "hits": hits,
                "source": source,
                "tables": guarded.tables,
            }
        )
        yield {
            "event": "checkpoint",
            "pending_id": pid,
            "sql": guarded.sql,
            "tables": guarded.tables,
            "steps": ["tables", "sql", "result"],
            "current": "sql",
        }
        yield _answer_event(
            text="我写好了一条只读查询。请先核对 SQL，确认后我再去查库。",
            sql=guarded.sql,
            meter=meter,
            started=started,
            checkpoint=True,
            pending_id=pid,
        )
        _audit(
            tenant=tenant,
            scene=scene,
            question=q,
            sql=guarded.sql,
            executed=False,
            row_count=0,
            meter=meter,
            started=started,
            tables=guarded.tables,
            pending_id=pid,
        )
        return

    try:
        rows = run_select(tenant.mysql, guarded.sql)
        rows = apply_value_maps(rows, tenant, guarded.tables)
        exec_ok = True
        exec_err = ""
    except Exception as exc:
        rows = []
        exec_ok = False
        exec_err = str(exc)
        if scene.id == "dba" and any(
            x in exec_err.lower() for x in ("denied", "access", "privilege", "1142", "1227")
        ):
            exec_err = f"目标库没有该元数据权限，未放开写操作。原始错误：{exc}"

    if not exec_ok and exec_err:
        fixed = repair_sql(
            tenant=tenant,
            scene=scene,
            question=q,
            sql=guarded.sql,
            error=exec_err,
            hits=hits,
            meter=meter,
            hint_tables=hint_tables,
            hint_fields=hint_fields,
            must_filters=must_filters,
            experience_block=experience_block,
        )
        if fixed:
            yield {
                "event": "repair",
                "sql": fixed["sql"],
                "reason": fixed["reason"],
                "error": exec_err,
            }
            repaired = guard_sql(
                fixed["sql"],
                tenant=tenant,
                scene=scene,
                max_limit=settings.vanna_default_limit,
                default_limit=settings.vanna_default_limit,
            )
            yield {
                "event": "guard",
                "ok": repaired.ok,
                "reason": repaired.reason,
                "reason_text": GUARD_REASONS.get(repaired.reason, repaired.reason),
                "sql": repaired.sql,
                "tables": repaired.tables,
            }
            if repaired.ok:
                try:
                    rows = run_select(tenant.mysql, repaired.sql)
                    rows = apply_value_maps(rows, tenant, repaired.tables)
                    guarded = repaired
                    exec_ok = True
                    exec_err = ""
                except Exception as exc:
                    rows = []
                    exec_ok = False
                    exec_err = str(exc)

    yield {
        "event": "execute",
        "ok": exec_ok,
        "row_count": len(rows),
        "error": exec_err,
    }

    if exec_ok:
        shown = present_rows(tenant, question=q, rows=rows, tables=guarded.tables)
        rows = shown.get("rows") or []
        field_details = list(shown.get("field_details") or [])
        text = format_answer(q, rows, guarded.sql, empty_note=empty_message(guarded.sql))
    else:
        text = exec_err
        field_details = []
    if settings.vanna_polish and exec_ok:
        try:
            polished = chat_text(
                _ANSWER_SYS,
                (
                    f"用户问题：{q}\n"
                    f"行数：{len(rows)}\n"
                    f"样例（最多 12 行）：{rows[:12]}\n"
                    f"模板摘要：{text}"
                ),
                meter,
                max_tokens=320,
                answer=True,
            )
            if polished:
                text = polished
        except RuntimeError as exc:
            if "llm_budget" not in str(exc):
                raise
    chart = infer_chart(rows, scene) if exec_ok else None
    empty = bool(exec_ok and len(rows) == 0)
    yield _answer_event(
        text=text,
        rows=rows,
        sql=guarded.sql,
        chart=chart,
        meter=meter,
        started=started,
        empty=empty,
        error_code="empty_result" if empty else ("" if exec_ok else "business"),
        executed=exec_ok,
        field_details=field_details,
    )
    if pending:
        drop_pending(str(pending.get("id") or ""))
    _audit(
        tenant=tenant,
        scene=scene,
        question=q,
        sql=guarded.sql,
        executed=exec_ok,
        row_count=len(rows),
        meter=meter,
        started=started,
        tables=guarded.tables,
        error=exec_err,
    )
    _ = experience_hits  # surfaced via main agentResult
