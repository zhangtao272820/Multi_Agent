"""Safe write SQL preview + HITL decide (DML + limited DDL)."""

from __future__ import annotations

import json
import re
from typing import Any, Iterator

from app.db import run_select, run_write, run_writes
from app.llm import LlmMeter, chat_json
from app.pending import drop_pending, load_pending, save_pending
from app.scenes import Scene
from app.schema_link import cards_for, link_tables
from app.sql_guard import GUARD_REASONS, guard_write_sql
from app.tenants import Tenant
from app.write_impact import (
    build_count_sql_for_write,
    build_impact_estimate,
    run_count_estimate,
)

_WRITE_PLAN_SYS = """你是数据库写助手。用户要改表结构或改数据时，写一条安全的 MySQL 写语句。
只输出 JSON：
{"intent":"insert|update|delete|create_table|alter_add|alter_modify|clarify|refuse","need_clarify":false,"clarify":"","reason":"一句话","sql":"..."}
规则：
- 允许：INSERT / UPDATE / DELETE；CREATE TABLE；ALTER TABLE ADD/MODIFY COLUMN。
- 禁止：DROP TABLE/COLUMN/DATABASE、TRUNCATE、GRANT/REVOKE、多语句、REPLACE INTO、CALL、LOAD、SLEEP、敏感列。
- 只用「库表元数据」里的表/列；CREATE TABLE 可新建表名（合理英文/下划线；演示表建议 agent_hands_ 前缀）。
- UPDATE/DELETE 必须带 WHERE；没有可靠过滤条件时 need_clarify=true、sql 为空。
- 与写库无关或危险请求：intent=refuse，sql 为空，clarify 说明原因。
- 缺关键槽位：need_clarify=true。
"""

_CLASSIFY_SYS = """判断用户是否在请求改库（建表/改字段/插入更新删除数据），还是只读查数。
只输出 JSON：{"mode":"read|write","confidence":0.0,"reason":"一句话"}
规则：
- 查人数、名单、指标、趋势、表结构只读浏览 → read
- 新建表、加列、改列、插入/更新/删除行 → write
- 不确定 → read（宁可只读）
"""


def parse_llm_json(raw: str | dict[str, Any] | None) -> dict[str, Any]:
    """chat_json 返回 str；兼容已解析 dict。"""
    if isinstance(raw, dict):
        return raw
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return {}
    try:
        data = json.loads(m.group(0))
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def classify_read_or_write(*, question: str, meter: LlmMeter | None = None) -> str:
    """LLM 判定 read|write；失败默认 read。"""
    meter = meter or LlmMeter()
    q = str(question or "").strip()
    if not q:
        return "read"
    try:
        raw = parse_llm_json(chat_json(_CLASSIFY_SYS, f"用户：{q}", meter, max_tokens=120))
    except Exception:
        return "read"
    mode = str(raw.get("mode") or "").strip().lower()
    try:
        conf = float(raw.get("confidence") or 0)
    except (TypeError, ValueError):
        conf = 0.0
    if mode == "write" and conf >= 0.5:
        return "write"
    return "read"


def plan_write_sql(
    *,
    tenant: Tenant,
    scene: Scene,
    question: str,
    meter: LlmMeter,
    hint_tables: list[str] | None = None,
) -> dict[str, Any]:
    hits = link_tables(tenant, question, n=6)
    tables = [str(h.get("name") or h.get("table") or "") for h in hits if (h.get("name") or h.get("table"))]
    for t in hint_tables or []:
        if t and t not in tables:
            tables.append(t)
    cards = cards_for(tenant, tables[:6]) if tables else ""
    user = (
        f"用户请求：{question}\n\n"
        f"库表元数据：\n{cards or '(无卡片，仅可 CREATE TABLE 或澄清)'}\n"
    )
    raw = parse_llm_json(chat_json(_WRITE_PLAN_SYS, user, meter, max_tokens=600))
    intent = str(raw.get("intent") or "").strip().lower()
    sql = str(raw.get("sql") or "").strip()
    return {
        "intent": intent,
        "need_clarify": bool(raw.get("need_clarify")),
        "clarify": str(raw.get("clarify") or "").strip(),
        "reason": str(raw.get("reason") or "").strip(),
        "sql": sql,
        "tables": tables,
    }


def _estimate_for_guarded(
    tenant: Tenant,
    *,
    sql: str,
    write_kind: str,
) -> dict[str, Any]:
    count_sql = build_count_sql_for_write(sql, write_kind)
    rows: int | None = None
    if count_sql:
        rows = run_count_estimate(tenant.mysql, count_sql)
    return build_impact_estimate(
        sql=sql,
        write_kind=write_kind,
        estimated_rows=rows,
        count_sql=count_sql,
    )


def preview_write_turn(
    *,
    tenant: Tenant,
    scene: Scene,
    question: str,
    meter: LlmMeter | None = None,
    hint_tables: list[str] | None = None,
    sql_override: str = "",
    sql_batch: list[str] | None = None,
) -> Iterator[dict[str, Any]]:
    """Generate + guard write SQL; always pending (never execute)."""
    meter = meter or LlmMeter()
    q = str(question or "").strip()
    batch = [str(s).strip() for s in (sql_batch or []) if str(s).strip()]
    if batch:
        plan = {
            "intent": "sql_batch",
            "need_clarify": False,
            "clarify": "",
            "reason": "caller batch",
            "sql": batch[0],
            "sqls": batch,
            "tables": [],
        }
    elif sql_override.strip():
        plan = {
            "intent": "sql_override",
            "need_clarify": False,
            "clarify": "",
            "reason": "caller sql",
            "sql": sql_override.strip(),
            "sqls": [sql_override.strip()],
            "tables": [],
        }
    else:
        plan = plan_write_sql(
            tenant=tenant, scene=scene, question=q, meter=meter, hint_tables=hint_tables
        )
        if plan.get("sql"):
            plan["sqls"] = [str(plan["sql"])]
    yield {"event": "write_plan", **{k: plan[k] for k in ("intent", "need_clarify", "clarify", "reason") if k in plan}}

    if plan.get("need_clarify") or plan.get("intent") in {"clarify", "refuse"} or not plan.get("sql"):
        text = str(plan.get("clarify") or plan.get("reason") or "需要更多信息才能写库，或请求被拒绝。")
        yield {
            "event": "answer",
            "text": text,
            "sql": "",
            "ok": True,
            "needs_human_confirm": False,
            "error_code": "needs_clarify" if plan.get("need_clarify") or plan.get("intent") == "clarify" else "",
        }
        return

    sqls = [str(s).strip() for s in (plan.get("sqls") or [plan["sql"]]) if str(s).strip()]
    guarded_list = []
    for sql in sqls:
        g = guard_write_sql(sql, tenant=tenant, scene=scene)
        yield {
            "event": "guard",
            "ok": g.ok,
            "reason": g.reason,
            "reason_text": GUARD_REASONS.get(g.reason, g.reason),
            "sql": g.sql,
            "tables": g.tables,
            "write_kind": g.write_kind,
        }
        if not g.ok:
            yield {
                "event": "answer",
                "text": f"写 SQL 未通过安全闸：{GUARD_REASONS.get(g.reason, g.reason)}",
                "sql": g.sql,
                "ok": False,
                "error_code": "business",
                "needs_human_confirm": False,
            }
            return
        guarded_list.append(g)

    primary = guarded_list[0]
    impacts = [
        _estimate_for_guarded(tenant, sql=g.sql, write_kind=g.write_kind) for g in guarded_list
    ]
    # aggregate: max requires_ack, sum estimated when all known
    est_sum = 0
    known = True
    requires_ack = False
    for imp in impacts:
        requires_ack = requires_ack or bool(imp.get("requires_ack"))
        if imp.get("estimated_rows") is None:
            known = False
        else:
            est_sum += int(imp["estimated_rows"] or 0)
    impact = {
        "items": impacts,
        "estimated_rows": est_sum if known else None,
        "requires_ack": requires_ack or (not known and any(g.write_kind in {"update", "delete"} for g in guarded_list)),
        "threshold": impacts[0].get("threshold") if impacts else 500,
        "statement_count": len(guarded_list),
    }

    all_tables: list[str] = []
    for g in guarded_list:
        for t in g.tables or []:
            if t not in all_tables:
                all_tables.append(t)

    pid = save_pending(
        {
            "kind": "write",
            "tenant": tenant.id,
            "scene": scene.id,
            "question": q,
            "sql": primary.sql,
            "sqls": [g.sql for g in guarded_list],
            "tables": all_tables,
            "write_kind": primary.write_kind if len(guarded_list) == 1 else "batch",
            "write_kinds": [g.write_kind for g in guarded_list],
            "risk": "t2",
            "impact_estimate": impact,
            "preview": {
                "sql": primary.sql,
                "sqls": [g.sql for g in guarded_list],
                "write_kind": primary.write_kind if len(guarded_list) == 1 else "batch",
                "tables": all_tables,
                "reason": plan.get("reason") or "",
                "impact_estimate": impact,
            },
        }
    )
    yield {
        "event": "checkpoint",
        "pending_id": pid,
        "sql": primary.sql,
        "sqls": [g.sql for g in guarded_list],
        "tables": all_tables,
        "write_kind": primary.write_kind if len(guarded_list) == 1 else "batch",
        "kind": "write",
        "impact_estimate": impact,
    }
    impact_note = ""
    if impact.get("estimated_rows") is not None:
        impact_note = f" 预估影响约 {impact['estimated_rows']} 行。"
    if impact.get("requires_ack"):
        impact_note += " 影响较大或无法预估，确认时须 impact_ack。"
    yield {
        "event": "answer",
        "text": (
            f"已生成待确认写操作（{primary.write_kind if len(guarded_list) == 1 else f'{len(guarded_list)} 条'}）。"
            f"{impact_note}"
            "请核对 SQL 后确认执行；取消则不会改库。"
        ),
        "sql": primary.sql,
        "ok": True,
        "checkpoint": True,
        "pending_id": pid,
        "needs_human_confirm": True,
        "pending_actions": [
            {
                "id": pid,
                "tool": "confirm_write_sql",
                "write_kind": primary.write_kind if len(guarded_list) == 1 else "batch",
                "sql": primary.sql,
                "sqls": [g.sql for g in guarded_list],
                "tables": all_tables,
                "impact_estimate": impact,
            }
        ],
        "meta": {
            "write_kind": primary.write_kind if len(guarded_list) == 1 else "batch",
            "blast_radius": "t2",
            "impact_estimate": impact,
            "has_mysql_write": tenant.mysql_write is not None,
        },
    }


def merge_write_pending(
    pending_id: str,
    *,
    sql: str,
    tenant: Tenant,
    scene: Scene,
) -> dict[str, Any] | None:
    """Append another guarded SQL into an existing write pending (plan-level batch)."""
    pending = load_pending(pending_id)
    if not pending or str(pending.get("kind") or "") != "write":
        return None
    guarded = guard_write_sql(sql, tenant=tenant, scene=scene)
    if not guarded.ok:
        return None
    sqls = list(pending.get("sqls") or [])
    if pending.get("sql") and not sqls:
        sqls = [str(pending["sql"])]
    sqls.append(guarded.sql)
    kinds = list(pending.get("write_kinds") or [])
    if pending.get("write_kind") and not kinds:
        kinds = [str(pending["write_kind"])]
    kinds.append(guarded.write_kind)
    tables = list(pending.get("tables") or [])
    for t in guarded.tables or []:
        if t not in tables:
            tables.append(t)
    impacts = list((pending.get("impact_estimate") or {}).get("items") or [])
    impacts.append(
        build_impact_estimate(
            sql=guarded.sql,
            write_kind=guarded.write_kind,
            estimated_rows=None,
            count_sql=build_count_sql_for_write(guarded.sql, guarded.write_kind),
        )
    )
    est_sum = 0
    known = True
    requires_ack = False
    for imp in impacts:
        requires_ack = requires_ack or bool(imp.get("requires_ack"))
        if imp.get("estimated_rows") is None:
            known = False
        else:
            est_sum += int(imp["estimated_rows"] or 0)
    impact = {
        "items": impacts,
        "estimated_rows": est_sum if known else None,
        "requires_ack": requires_ack,
        "threshold": impacts[0].get("threshold") if impacts else 500,
        "statement_count": len(sqls),
    }
    pending["id"] = pending_id
    pending["sql"] = sqls[0]
    pending["sqls"] = sqls
    pending["write_kinds"] = kinds
    pending["write_kind"] = "batch" if len(sqls) > 1 else kinds[0]
    pending["tables"] = tables
    pending["impact_estimate"] = impact
    pending["preview"] = {
        **(pending.get("preview") if isinstance(pending.get("preview"), dict) else {}),
        "sql": sqls[0],
        "sqls": sqls,
        "write_kind": pending["write_kind"],
        "tables": tables,
        "impact_estimate": impact,
    }
    save_pending(pending)
    return load_pending(pending_id)


def decide_write_pending(
    *,
    pending_id: str,
    decision: str,
    tenant: Tenant | None = None,
    confirm_token: str = "",
    impact_ack: bool = False,
    verify_sql: str = "",
) -> dict[str, Any]:
    """Approve/reject a write pending. Approve requires confirm_token (T2)."""
    pending = load_pending(pending_id)
    if not pending:
        return {"ok": False, "error_code": "pending_not_found", "text": "待确认写操作不存在或已过期。"}
    if str(pending.get("kind") or "") != "write":
        return {"ok": False, "error_code": "not_write_pending", "text": "该 pending 不是写库操作。"}
    dec = str(decision or "").strip().lower()
    approve = dec in {"确认", "approve", "confirm", "yes", "y", "ok", "同意"}
    reject = dec in {"取消", "reject", "cancel", "no", "n", "拒绝"}
    if reject or not approve:
        drop_pending(pending_id)
        return {
            "ok": True,
            "text": "已取消写库操作，未改动数据库。",
            "executed": False,
            "pending_id": pending_id,
        }
    if not str(confirm_token or "").strip():
        return {
            "ok": False,
            "error_code": "blast_radius_confirm_required",
            "text": "T2 写库需要 HITL confirm_token，禁止静默执行。",
            "needs_human_confirm": True,
            "pending_id": pending_id,
        }
    impact = pending.get("impact_estimate") if isinstance(pending.get("impact_estimate"), dict) else {}
    if impact.get("requires_ack") and not impact_ack:
        return {
            "ok": False,
            "error_code": "impact_ack_required",
            "text": "预估影响行数较大或无法预估，须 impact_ack=true 后才能执行。",
            "needs_human_confirm": True,
            "pending_id": pending_id,
            "impact_estimate": impact,
        }
    tid = str(pending.get("tenant") or "")
    if tenant and tenant.id != tid:
        return {"ok": False, "error_code": "tenant_mismatch", "text": "pending 租户不匹配。"}
    from app.tenants import load_tenants

    t = tenant or load_tenants().get(tid)
    if not t:
        return {"ok": False, "error_code": "unknown_tenant", "text": f"未知租户：{tid}"}
    from app.scenes import get_scene

    scene = get_scene(str(pending.get("scene") or "assistant"))
    sqls = [str(s).strip() for s in (pending.get("sqls") or []) if str(s).strip()]
    if not sqls:
        sqls = [str(pending.get("sql") or "").strip()]
    guarded_sqls: list[str] = []
    write_kinds: list[str] = []
    tables: list[str] = []
    for sql in sqls:
        guarded = guard_write_sql(sql, tenant=t, scene=scene)
        if not guarded.ok:
            drop_pending(pending_id)
            return {
                "ok": False,
                "error_code": "business",
                "text": f"执行前复检失败：{GUARD_REASONS.get(guarded.reason, guarded.reason)}",
                "sql": guarded.sql,
            }
        guarded_sqls.append(guarded.sql)
        write_kinds.append(guarded.write_kind)
        for tb in guarded.tables or []:
            if tb not in tables:
                tables.append(tb)

    write_cfg = t.write_mysql()
    result = run_writes(write_cfg, guarded_sqls) if len(guarded_sqls) > 1 else run_write(write_cfg, guarded_sqls[0])
    drop_pending(pending_id)
    if not result.get("ok"):
        return {
            "ok": False,
            "error_code": "exec_failed",
            "text": f"写库失败（已回滚）：{result.get('error') or 'unknown'}",
            "sql": guarded_sqls[0] if guarded_sqls else "",
            "sqls": guarded_sqls,
            "executed": False,
        }

    verify_meta: dict[str, Any] | None = None
    vs = str(verify_sql or "").strip()
    if vs:
        try:
            # post-write verify on readonly connection
            rows = run_select(t.mysql, vs, max_rows=20)
            verify_meta = {"ok": True, "rows": rows, "sql": vs}
        except Exception as exc:  # noqa: BLE001
            verify_meta = {"ok": False, "error": str(exc)[:300], "sql": vs}

    kind_label = write_kinds[0] if len(write_kinds) == 1 else f"batch:{len(write_kinds)}"
    return {
        "ok": True,
        "text": f"写库已执行（{kind_label}），影响行数约 {result.get('rowcount', 0)}。",
        "sql": guarded_sqls[0] if guarded_sqls else "",
        "sqls": guarded_sqls,
        "executed": True,
        "rowcount": result.get("rowcount", 0),
        "rowcounts": result.get("rowcounts"),
        "write_kind": kind_label,
        "tables": tables,
        "pending_id": pending_id,
        "used_write_role": t.mysql_write is not None,
        "verify": verify_meta,
        "impact_estimate": impact,
    }
