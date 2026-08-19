"""Promote a verified SELECT into special_golden + golden.json + one Chroma upsert."""
from __future__ import annotations

import json
from typing import Any

from app.bootstrap import load_special_goldens, merge_goldens, plan_catalog, tenant_folder
from app.schema_link import load_schema
from app.scenes import get_scene
from app.sql_guard import guard_sql
from app.tenants import Tenant
from app.understand import normalize_question


def _write_json(path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def upsert_chroma_golden(tenant: Tenant, question: str, sql: str, tables: list[str]) -> dict[str, Any]:
    try:
        from app.catalog import _collection
        from app.llm import LlmMeter, embed_texts
        from app.settings import get_settings
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    try:
        coll = _collection(tenant.id)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    gid = "golden:promote:" + (normalize_question(question) or question)[:80]
    try:
        existing = coll.get(ids=[gid])
        old = list((existing or {}).get("ids") or [])
        if old:
            coll.delete(ids=old)
    except Exception:
        pass
    meter = LlmMeter(max_embed_calls=1)
    vecs = embed_texts([question], meter)
    if len(vecs) != 1:
        return {"ok": False, "error": "embed_unavailable", "meter": meter.as_dict()}
    coll.add(
        ids=[gid],
        documents=[question],
        metadatas=[
            {
                "kind": "golden",
                "tenant": tenant.id,
                "sql": sql,
                "tables": ",".join(tables),
            }
        ],
        embeddings=vecs,
    )
    return {"ok": True, "id": gid, "meter": meter.as_dict(), "budget": get_settings().vanna_max_ingest_embed_calls}


def promote_golden(
    tenant: Tenant,
    *,
    question: str,
    sql: str,
    tables: list[str] | None = None,
    scene_id: str = "assistant",
) -> dict[str, Any]:
    q = str(question or "").strip()
    s = str(sql or "").strip()
    if not q or not s:
        return {"ok": False, "error": "question_and_sql_required"}
    scene = get_scene(scene_id)
    guarded = guard_sql(s, tenant=tenant, scene=scene)
    if not guarded.ok:
        return {"ok": False, "error": guarded.reason, "sql": guarded.sql}
    folder = tenant_folder(tenant)
    folder.mkdir(parents=True, exist_ok=True)
    special = load_special_goldens(folder)
    nq = normalize_question(q)
    for item in special:
        if normalize_question(str(item.get("question") or "")) == nq:
            return {"ok": True, "deduped": True, "question": item["question"], "sql": item["sql"]}
    tables_n = list(tables or guarded.tables or [])
    entry = {"question": q, "sql": guarded.sql, "tables": tables_n}
    special.append(entry)
    _write_json(folder / "special_golden.json", special)
    snap = load_schema(tenant)
    planned = plan_catalog(tenant, snap)
    merged = merge_goldens(special, planned.get("golden") or [])
    _write_json(folder / "golden.json", merged)
    chroma = upsert_chroma_golden(tenant, q, guarded.sql, tables_n)
    return {
        "ok": True,
        "deduped": False,
        "question": q,
        "sql": guarded.sql,
        "tables": tables_n,
        "golden": len(merged),
        "chroma": chroma,
    }
