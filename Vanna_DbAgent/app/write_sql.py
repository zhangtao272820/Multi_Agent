"""Safe write SQL preview + HITL decide (DML + limited DDL)."""

from __future__ import annotations

from typing import Any, Iterator

from app.db import run_write
from app.llm import LlmMeter, chat_json
from app.pending import drop_pending, load_pending, save_pending
from app.scenes import Scene
from app.schema_link import cards_for, link_tables
from app.sql_guard import GUARD_REASONS, guard_write_sql
from app.tenants import Tenant

_WRITE_PLAN_SYS = """你是数据库写助手。用户要改表结构或改数据时，写一条安全的 MySQL 写语句。
只输出 JSON：
{"intent":"insert|update|delete|create_table|alter_add|alter_modify|clarify|refuse","need_clarify":false,"clarify":"","reason":"一句话","sql":"..."}
规则：
- 允许：INSERT / UPDATE / DELETE；CREATE TABLE；ALTER TABLE ADD/MODIFY COLUMN。
- 禁止：DROP TABLE/COLUMN/DATABASE、TRUNCATE、GRANT/REVOKE、多语句、REPLACE INTO、CALL、LOAD、SLEEP、敏感列。
- 只用「库表元数据」里的表/列；CREATE TABLE 可新建表名（合理英文/下划线）。
- UPDATE/DELETE 必须带 WHERE；没有可靠过滤条件时 need_clarify=true、sql 为空。
- 与写库无关或危险请求：intent=refuse，sql 为空，clarify 说明原因。
- 缺关键槽位：need_clarify=true。
"""


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
    raw = chat_json(_WRITE_PLAN_SYS, user, meter, max_tokens=600) or {}
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


def preview_write_turn(
    *,
    tenant: Tenant,
    scene: Scene,
    question: str,
    meter: LlmMeter | None = None,
    hint_tables: list[str] | None = None,
    sql_override: str = "",
) -> Iterator[dict[str, Any]]:
    """Generate + guard write SQL; always pending (never execute)."""
    meter = meter or LlmMeter()
    q = str(question or "").strip()
    if sql_override.strip():
        plan = {
            "intent": "sql_override",
            "need_clarify": False,
            "clarify": "",
            "reason": "caller sql",
            "sql": sql_override.strip(),
            "tables": [],
        }
    else:
        plan = plan_write_sql(
            tenant=tenant, scene=scene, question=q, meter=meter, hint_tables=hint_tables
        )
    yield {"event": "write_plan", **{k: plan[k] for k in ("intent", "need_clarify", "clarify", "reason")}}

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

    guarded = guard_write_sql(plan["sql"], tenant=tenant, scene=scene)
    yield {
        "event": "guard",
        "ok": guarded.ok,
        "reason": guarded.reason,
        "reason_text": GUARD_REASONS.get(guarded.reason, guarded.reason),
        "sql": guarded.sql,
        "tables": guarded.tables,
        "write_kind": guarded.write_kind,
    }
    if not guarded.ok:
        yield {
            "event": "answer",
            "text": f"写 SQL 未通过安全闸：{GUARD_REASONS.get(guarded.reason, guarded.reason)}",
            "sql": guarded.sql,
            "ok": False,
            "error_code": "business",
            "needs_human_confirm": False,
        }
        return

    pid = save_pending(
        {
            "kind": "write",
            "tenant": tenant.id,
            "scene": scene.id,
            "question": q,
            "sql": guarded.sql,
            "tables": guarded.tables,
            "write_kind": guarded.write_kind,
            "risk": "t2",
            "preview": {
                "sql": guarded.sql,
                "write_kind": guarded.write_kind,
                "tables": guarded.tables,
                "reason": plan.get("reason") or "",
            },
        }
    )
    yield {
        "event": "checkpoint",
        "pending_id": pid,
        "sql": guarded.sql,
        "tables": guarded.tables,
        "write_kind": guarded.write_kind,
        "kind": "write",
    }
    yield {
        "event": "answer",
        "text": (
            f"已生成待确认写操作（{guarded.write_kind}）。"
            "请核对 SQL 后确认执行；取消则不会改库。"
        ),
        "sql": guarded.sql,
        "ok": True,
        "checkpoint": True,
        "pending_id": pid,
        "needs_human_confirm": True,
        "pending_actions": [
            {
                "id": pid,
                "tool": "confirm_write_sql",
                "write_kind": guarded.write_kind,
                "sql": guarded.sql,
                "tables": guarded.tables,
            }
        ],
        "meta": {
            "write_kind": guarded.write_kind,
            "blast_radius": "t2",
        },
    }


def decide_write_pending(
    *,
    pending_id: str,
    decision: str,
    tenant: Tenant | None = None,
    confirm_token: str = "",
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
    tid = str(pending.get("tenant") or "")
    if tenant and tenant.id != tid:
        return {"ok": False, "error_code": "tenant_mismatch", "text": "pending 租户不匹配。"}
    from app.tenants import load_tenants

    t = tenant or load_tenants().get(tid)
    if not t:
        return {"ok": False, "error_code": "unknown_tenant", "text": f"未知租户：{tid}"}
    from app.scenes import get_scene

    scene = get_scene(str(pending.get("scene") or "assistant"))
    sql = str(pending.get("sql") or "")
    guarded = guard_write_sql(sql, tenant=t, scene=scene)
    if not guarded.ok:
        drop_pending(pending_id)
        return {
            "ok": False,
            "error_code": "business",
            "text": f"执行前复检失败：{GUARD_REASONS.get(guarded.reason, guarded.reason)}",
            "sql": guarded.sql,
        }
    result = run_write(t.mysql, guarded.sql)
    drop_pending(pending_id)
    if not result.get("ok"):
        return {
            "ok": False,
            "error_code": "exec_failed",
            "text": f"写库失败：{result.get('error') or 'unknown'}",
            "sql": guarded.sql,
            "executed": False,
        }
    return {
        "ok": True,
        "text": f"写库已执行（{guarded.write_kind}），影响行数约 {result.get('rowcount', 0)}。",
        "sql": guarded.sql,
        "executed": True,
        "rowcount": result.get("rowcount", 0),
        "write_kind": guarded.write_kind,
        "tables": guarded.tables,
        "pending_id": pending_id,
    }
