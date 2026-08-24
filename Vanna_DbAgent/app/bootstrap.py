"""通用租户目录：连库 snapshot 或已有 snapshot → 精简 COUNT/LIST 黄金 + docs。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.settings import ROOT
from app.tenants import Tenant, load_tenants
from app.understand import load_joins

LIST_COLS = (
    "Name",
    "name",
    "UserTrueName",
    "MenuName",
    "RoleName",
    "DepartmentName",
    "DicName",
    "RoomName",
    "StudentName",
    "StudentTrueName",
    "ExperimentalName",
    "OperatingCycleName",
    "PlotName",
    "GroupKey",
    "Code",
    "SemesterName",
    "person_name",
    "cus_name",
)

AUDIT_COLS = {
    "modifier",
    "modifydate",
    "modifyid",
    "createid",
    "creator",
    "createdate",
}


def tenant_folder(tenant: Tenant) -> Path:
    if tenant.docs_path:
        return tenant.docs_path.parent
    if tenant.golden_path:
        return tenant.golden_path.parent
    return ROOT / "tenants" / tenant.id


def load_snapshot(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        return {"tables": [], "skipped": []}
    return raw


def load_special_goldens(folder: Path) -> list[dict[str, Any]]:
    path = folder / "special_golden.json"
    if not path.is_file():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        raw = raw.get("items") or raw.get("golden") or []
    out: list[dict[str, Any]] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        q = str(item.get("question") or "").strip()
        sql = str(item.get("sql") or "").strip()
        if not q or not sql:
            continue
        tables = item.get("tables") or []
        out.append(
            {
                "question": q,
                "sql": sql,
                "tables": [str(t) for t in tables] if isinstance(tables, list) else [],
                "source": "special",
            }
        )
    return out


def _label(table: dict[str, Any]) -> str:
    cmt = str(table.get("comment") or "").strip()
    return cmt or str(table.get("name") or "")


def _list_cols(table: dict[str, Any]) -> list[str]:
    names = [str(c.get("name") or "") for c in table.get("cols") or []]
    picked = [c for c in LIST_COLS if c in names]
    if str(table.get("name") or "") == "Cultivate_Examination" and "Type" in names and "Type" not in picked:
        picked.append("Type")
    return picked[:4]


def template_goldens(tables: list[dict[str, Any]], skip_list: set[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for table in tables:
        name = str(table.get("name") or "")
        if not name:
            continue
        label = _label(table)
        count_q = f"{label}有多少"
        if count_q not in seen:
            seen.add(count_q)
            out.append(
                {
                    "question": count_q,
                    "sql": f"SELECT COUNT(*) AS count FROM {name}",
                    "tables": [name],
                    "source": "template",
                }
            )
        cols = _list_cols(table)
        if not cols or name in skip_list:
            continue
        list_q = f"{label}有哪些"
        if list_q in seen:
            continue
        seen.add(list_q)
        out.append(
            {
                "question": list_q,
                "sql": f"SELECT {', '.join(cols)} FROM {name}",
                "tables": [name],
                "source": "template",
            }
        )
    return out


def merge_goldens(special: list[dict[str, Any]], templates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item, default_src in [(x, "special") for x in special] + [(x, "template") for x in templates]:
        q = str(item.get("question") or "").strip()
        if not q or q in seen:
            continue
        seen.add(q)
        row = dict(item)
        src = str(row.get("source") or "").strip().lower()
        if src not in {"special", "template"}:
            row["source"] = default_src
        out.append(row)
    return out


def build_docs(
    tenant: Tenant,
    snapshot: dict[str, Any],
    *,
    preamble: str = "",
) -> str:
    tables = list(snapshot.get("tables") or [])
    skipped = list(snapshot.get("skipped") or [])
    lines: list[str] = []
    title = tenant.title or tenant.id
    if preamble.strip():
        lines.append(preamble.strip())
        lines.append("")
    else:
        allow = ", ".join(
            f"`{p}`" for p in (tenant.table_whitelist_prefixes + tenant.table_whitelist) if p
        )
        lines += [
            f"# {title}",
            "",
            f"默认只读表白名单：{allow or '（未配置）'}。禁止密码列。",
            "",
        ]
    lines += ["## 表目录（白名单）", ""]
    for table in tables:
        cols = ", ".join(
            str(c.get("name") or "")
            + (f"（{c['comment']}）" if c.get("comment") else "")
            for c in (table.get("cols") or [])[:14]
            if str(c.get("name") or "").lower() not in AUDIT_COLS
        )
        lines.append(f"- `{table.get('name')}` {table.get('comment') or ''}。列：{cols}")
    joins = load_joins(tenant)
    lines += ["", "## 常用 JOIN", ""]
    if joins:
        for j in joins:
            tables_s = ", ".join(f"`{t}`" for t in (j.get("tables") or []))
            lines.append(f"- {j.get('when') or ''}：{tables_s}。`{j.get('sql')}`")
    else:
        lines.append("（无预置 JOIN）")
    lines += ["", "## 不在默认范围", "", "、".join(f"`{n}`" for n in skipped), ""]
    return "\n".join(lines).rstrip() + "\n"


def plan_catalog(tenant: Tenant, snapshot: dict[str, Any]) -> dict[str, Any]:
    folder = tenant_folder(tenant)
    special = load_special_goldens(folder)
    skip = set(tenant.skip_list_tables)
    templates = template_goldens(list(snapshot.get("tables") or []), skip)
    goldens = merge_goldens(special, templates)
    preamble_path = folder / "docs_preamble.md"
    preamble = preamble_path.read_text(encoding="utf-8") if preamble_path.is_file() else ""
    docs = build_docs(tenant, snapshot, preamble=preamble)
    return {
        "golden": goldens,
        "docs": docs,
        "special": len(special),
        "templates": len(templates),
        "tables": len(snapshot.get("tables") or []),
    }


def seed_joins_from_fks(folder: Path, snapshot: dict[str, Any]) -> bool:
    """Write joins.json from FK snapshot only when missing; never overwrite hand joins."""
    path = folder / "joins.json"
    if path.is_file():
        return False
    recipes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for fk in snapshot.get("fks") or []:
        ft = str(fk.get("from_table") or "")
        fc = str(fk.get("from_col") or "")
        tt = str(fk.get("to_table") or "")
        tc = str(fk.get("to_col") or "")
        if not ft or not tt or not fc or not tc:
            continue
        sql = f"{ft}.{fc} = {tt}.{tc}"
        key = sql.lower()
        if key in seen:
            continue
        seen.add(key)
        recipes.append({"when": "", "sql": sql, "tables": [ft, tt]})
    if not recipes:
        return False
    path.write_text(json.dumps(recipes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True


def write_tenant_catalog(tenant: Tenant, *, from_snapshot: bool = True) -> dict[str, Any]:
    folder = tenant_folder(tenant)
    folder.mkdir(parents=True, exist_ok=True)
    snap_path = folder / "schema_snapshot.json"
    if from_snapshot:
        if not snap_path.is_file():
            raise FileNotFoundError(f"missing snapshot: {snap_path}")
        snapshot = load_snapshot(snap_path)
    else:
        from app.db import snapshot_allowed_schema

        snapshot = snapshot_allowed_schema(tenant)
        snap_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    seeded_joins = seed_joins_from_fks(folder, snapshot)
    planned = plan_catalog(tenant, snapshot)
    (folder / "docs.md").write_text(planned["docs"], encoding="utf-8")
    (folder / "golden.json").write_text(
        json.dumps(planned["golden"], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {
        "ok": True,
        "tenant": tenant.id,
        "folder": str(folder),
        "from_snapshot": from_snapshot,
        "golden": len(planned["golden"]),
        "special": planned["special"],
        "templates": planned["templates"],
        "tables": planned["tables"],
        "seeded_joins": seeded_joins,
    }


def bootstrap_tenant(tenant_id: str, *, from_snapshot: bool = True) -> dict[str, Any]:
    tenants = load_tenants()
    tenant = tenants.get(tenant_id)
    if not tenant:
        raise KeyError(f"unknown tenant: {tenant_id}")
    return write_tenant_catalog(tenant, from_snapshot=from_snapshot)
