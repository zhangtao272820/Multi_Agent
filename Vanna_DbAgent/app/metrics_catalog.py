"""Tenant metric aliases: 0-LLM exact hit, otherwise listed in analyst/exec prompt."""
from __future__ import annotations

import json
from typing import Any

from app.tenants import Tenant
from app.understand import normalize_question, tenant_dir


def load_metrics(tenant: Tenant) -> list[dict[str, Any]]:
    folder = tenant_dir(tenant)
    if not folder:
        return []
    path = folder / "metrics.json"
    if not path.is_file():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        raw = raw.get("items") or raw.get("metrics") or []
    out: list[dict[str, Any]] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        sql = str(item.get("sql") or "").strip()
        if not name or not sql:
            continue
        aliases = item.get("aliases") or []
        tables = item.get("tables") or []
        out.append(
            {
                "name": name,
                "sql": sql,
                "aliases": [str(a).strip() for a in aliases if str(a).strip()]
                if isinstance(aliases, list)
                else [],
                "tables": [str(t) for t in tables] if isinstance(tables, list) else [],
            }
        )
    return out


def exact_metric(tenant: Tenant, question: str) -> dict[str, Any] | None:
    q = str(question or "").strip()
    nq = normalize_question(q)
    if not nq:
        return None
    for m in load_metrics(tenant):
        names = [m["name"], *(m.get("aliases") or [])]
        for alias in names:
            if alias == q or normalize_question(alias) == nq:
                return m
    return None


def metrics_prompt_block(tenant: Tenant, *, cap: int = 900) -> str:
    items = load_metrics(tenant)
    if not items:
        return ""
    lines = ["经营口径（禁止编造漏斗表；只用这些指标或库表元数据）："]
    for m in items:
        aliases = " / ".join(m.get("aliases") or [])
        tables = ",".join(m.get("tables") or [])
        extra = f"（别名 {aliases}）" if aliases else ""
        lines.append(f"- {m['name']}{extra} 表 {tables} SQL: {m['sql']}")
    text = "\n".join(lines)
    return text[:cap] if len(text) > cap else text
