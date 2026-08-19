from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")

from app.llm import LlmMeter, embed_texts
from app.schema_link import (
    cards_for,
    expand_join_tables as expand_related_tables,
    format_card,
    link_tables,
    load_schema,
    snapshot_path,
)
from app.settings import data_dir, get_settings
from app.tenants import Tenant
from app.understand import normalize_question

_KIND_DDL = "ddl"
_KIND_DOC = "doc"
_KIND_GOLDEN = "golden"
_KIND_SKILL = "skill"


def load_golden(tenant: Tenant) -> list[dict[str, Any]]:
    if not tenant.golden_path or not tenant.golden_path.is_file():
        return []
    raw = json.loads(tenant.golden_path.read_text(encoding="utf-8"))
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
            }
        )
    return out


def load_docs(tenant: Tenant) -> str:
    if not tenant.docs_path or not tenant.docs_path.is_file():
        return ""
    return tenant.docs_path.read_text(encoding="utf-8").strip()


def _chunks_docs(text: str) -> list[str]:
    if not text:
        return []
    parts: list[str] = []
    buf: list[str] = []
    for line in text.splitlines():
        if line.startswith("## ") and buf:
            parts.append("\n".join(buf).strip())
            buf = [line]
        else:
            buf.append(line)
    if buf:
        parts.append("\n".join(buf).strip())
    return [p for p in parts if p]


_CHROMA = None
_CHROMA_ERR: str | None = None


def _client():
    global _CHROMA, _CHROMA_ERR
    if _CHROMA is not None:
        return _CHROMA
    if _CHROMA_ERR:
        raise RuntimeError(_CHROMA_ERR)
    try:
        import chromadb
    except Exception as exc:
        _CHROMA_ERR = f"chromadb_unavailable: {exc}"
        raise RuntimeError(_CHROMA_ERR) from exc
    path = data_dir() / "chroma"
    path.mkdir(parents=True, exist_ok=True)
    _CHROMA = chromadb.PersistentClient(path=str(path))
    return _CHROMA


def _collection(tenant_id: str):
    return _client().get_or_create_collection(
        name=f"vanna_{tenant_id}",
        metadata={"hnsw:space": "cosine"},
    )


def collection_count(tenant_id: str) -> int:
    try:
        return int(_collection(tenant_id).count() or 0)
    except Exception:
        return 0


def ingest_tenant(tenant: Tenant, *, skip_if_ready: bool = False) -> dict[str, Any]:
    if skip_if_ready and collection_count(tenant.id) > 0:
        return {"ok": True, "skipped": True, "count": collection_count(tenant.id)}
    try:
        _client()
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    ids: list[str] = []
    docs: list[str] = []
    metas: list[dict[str, Any]] = []

    for i, chunk in enumerate(_chunks_docs(load_docs(tenant))):
        ids.append(f"doc:{i}")
        docs.append(chunk[:4000])
        metas.append({"kind": _KIND_DOC, "tenant": tenant.id})

    for i, g in enumerate(load_golden(tenant)):
        ids.append(f"golden:{i}")
        docs.append(g["question"])
        metas.append(
            {
                "kind": _KIND_GOLDEN,
                "tenant": tenant.id,
                "sql": g["sql"],
                "tables": ",".join(g.get("tables") or []),
            }
        )

    try:
        from app.metrics_catalog import load_metrics

        for i, m in enumerate(load_metrics(tenant)):
            aliases = " ".join(m.get("aliases") or [])
            ids.append(f"metric:{i}")
            docs.append(f"{m['name']} {aliases}".strip())
            metas.append(
                {
                    "kind": _KIND_GOLDEN,
                    "tenant": tenant.id,
                    "sql": m["sql"],
                    "tables": ",".join(m.get("tables") or []),
                    "metric": m["name"],
                }
            )
    except Exception:
        pass

    try:
        from app.skills import load_scene_skill, load_tenant_skills

        for scene_id in ("assistant", "analyst", "exec", "dba", "audit"):
            text = load_scene_skill(scene_id)
            if not text:
                continue
            ids.append(f"skill:scene:{scene_id}")
            docs.append(f"场景 {scene_id}\n{text}"[:4000])
            metas.append({"kind": _KIND_SKILL, "tenant": tenant.id, "skill": scene_id})
        for sk in load_tenant_skills(tenant):
            ids.append(f"skill:tenant:{sk['id']}")
            docs.append(f"{sk['title']}\n{sk['text']}"[:4000])
            metas.append({"kind": _KIND_SKILL, "tenant": tenant.id, "skill": sk["id"]})
    except Exception:
        pass

    ddl_n = 0
    seen_ddl: set[str] = set()
    for table in load_schema(tenant).get("tables") or []:
        name = str(table.get("name") or "")
        if not name or name.lower() in seen_ddl:
            continue
        ids.append(f"ddl:{name}")
        docs.append(format_card(table, tenant.value_maps)[:4000])
        metas.append(
            {
                "kind": _KIND_DDL,
                "tenant": tenant.id,
                "table": name,
                "comment": table.get("comment") or "",
            }
        )
        ddl_n += 1
        seen_ddl.add(name.lower())
    try:
        from app.db import list_allowed_tables, table_ddl

        for t in list_allowed_tables(tenant):
            name = str(t.get("name") or "")
            if not name or name.lower() in seen_ddl:
                continue
            ddl = table_ddl(tenant, name)
            if not ddl:
                continue
            ids.append(f"ddl:{name}")
            docs.append(ddl[:4000])
            metas.append(
                {
                    "kind": _KIND_DDL,
                    "tenant": tenant.id,
                    "table": name,
                    "comment": t.get("comment") or "",
                }
            )
            ddl_n += 1
            seen_ddl.add(name.lower())
        ddl_err = ""
    except Exception as exc:
        ddl_err = str(exc)

    if not docs:
        return {"ok": False, "error": "nothing_to_ingest", "ddl_error": ddl_err}

    meter = LlmMeter(max_embed_calls=int(get_settings().vanna_max_ingest_embed_calls))
    embeddings: list[list[float]] = []
    # 百炼 text-embedding-v1：单次 batch ≤10
    batch = 10
    for i in range(0, len(docs), batch):
        chunk = docs[i : i + batch]
        vecs = embed_texts(chunk, meter)
        if len(vecs) != len(chunk):
            return {
                "ok": False,
                "error": "embed_count_mismatch",
                "expected": len(docs),
                "got": len(embeddings) + len(vecs),
                "batch_at": i,
                "ddl_error": ddl_err,
                "meter": meter.as_dict(),
            }
        embeddings.extend(vecs)

    coll = _collection(tenant.id)
    existing = coll.get()
    old_ids = list(existing.get("ids") or [])
    if old_ids:
        coll.delete(ids=old_ids)
    coll.add(ids=ids, documents=docs, metadatas=metas, embeddings=embeddings)
    return {
        "ok": True,
        "skipped": False,
        "count": len(ids),
        "ddl": ddl_n,
        "docs": sum(1 for m in metas if m.get("kind") == _KIND_DOC),
        "golden": sum(1 for m in metas if m.get("kind") == _KIND_GOLDEN),
        "ddl_error": ddl_err,
        "meter": meter.as_dict(),
    }


def _hit(kind: str, document: str, score: float, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    meta = meta or {}
    tables_raw = meta.get("tables") or ""
    tables = [t for t in str(tables_raw).split(",") if t] if tables_raw else []
    if meta.get("table"):
        tables = [str(meta["table"])]
    return {
        "kind": kind,
        "document": document,
        "score": round(float(score), 4),
        "sql": str(meta.get("sql") or ""),
        "tables": tables,
        "table": str(meta.get("table") or ""),
    }


def exact_golden(tenant: Tenant, question: str) -> dict[str, Any] | None:
    q = str(question or "").strip()
    if not q:
        return None
    nq = normalize_question(q)
    if not nq:
        return None
    from app.metrics_catalog import exact_metric

    metric = exact_metric(tenant, q)
    if metric:
        return _hit(
            _KIND_GOLDEN,
            metric["name"],
            1.0,
            {"sql": metric["sql"], "tables": ",".join(metric.get("tables") or [])},
        )
    for g in load_golden(tenant):
        gq = str(g.get("question") or "").strip()
        if gq == q or normalize_question(gq) == nq:
            return _hit(
                _KIND_GOLDEN,
                g["question"],
                1.0,
                {"sql": g["sql"], "tables": ",".join(g.get("tables") or [])},
            )
    return None


def _schema_path(tenant: Tenant) -> Path | None:
    return snapshot_path(tenant)


def schema_table_hits(tenant: Tenant, question: str, n: int = 6) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    for table in link_tables(tenant, question, n=n):
        name = str(table.get("name") or "")
        score = float(table.get("_score") or 0)
        doc = format_card(table, tenant.value_maps)
        hits.append(
            _hit(
                _KIND_DDL,
                doc,
                min(0.99, 0.62 + score / 40),
                {"table": name, "tables": name},
            )
        )
    return hits


def catalog_fallback_hits(tenant: Tenant, n: int = 16) -> list[dict[str, Any]]:
    """Lexical schema-link 未命中时的目录兜底：把表白名单卡片 + 技能 + 文档交给 LLM 选表。

    这不是意图正则；意图 / 是否澄清由模型决定。
    """
    from app.schema_link import format_card, load_schema
    from app.skills import load_tenant_skills

    hits: list[dict[str, Any]] = []
    schema = load_schema(tenant)
    tables = [t for t in (schema.get("tables") or []) if str(t.get("name") or "").strip()]
    if not tables and not load_docs(tenant) and not load_tenant_skills(tenant):
        return []

    # 全表「名称+注释」目录，避免 top-N 卡片漏掉口语对应表（如人员分组）
    index_lines = ["表目录（口语问题请对照注释自行选表，再写 SQL）："]
    for table in tables:
        name = str(table.get("name") or "")
        cmt = str(table.get("comment") or "").strip()
        index_lines.append(f"- {name}" + (f" -- {cmt}" if cmt else ""))
    hits.append(_hit(_KIND_DOC, "\n".join(index_lines)[:3500], 0.56, {}))

    skills = load_tenant_skills(tenant)
    skill_text = "\n".join(s["text"] for s in skills)
    prefer: list[dict[str, Any]] = []
    rest: list[dict[str, Any]] = []
    for table in tables:
        name = str(table.get("name") or "")
        if name and name in skill_text:
            prefer.append(table)
        else:
            rest.append(table)
    rest.sort(key=lambda t: (0 if str(t.get("comment") or "").strip() else 1, str(t.get("name") or "")))
    chosen = (prefer + rest)[: max(6, n)]
    for table in chosen:
        name = str(table.get("name") or "")
        hits.append(
            _hit(
                _KIND_DDL,
                format_card(table, tenant.value_maps),
                0.52,
                {"table": name, "tables": name},
            )
        )
    docs = load_docs(tenant)
    if docs:
        hits.append(_hit(_KIND_DOC, docs[:2200], 0.48, {}))
    for sk in skills[:5]:
        hits.append(
            _hit(
                _KIND_SKILL,
                f"技能 {sk['id']}：\n{sk['text'][:900]}",
                0.5,
                {"skill": sk["id"]},
            )
        )
    return hits


def ddl_for_tables(tenant: Tenant, names: list[str]) -> list[dict[str, Any]]:
    if not names:
        return []
    text = cards_for(tenant, names)
    if not text:
        return []
    hits: list[dict[str, Any]] = []
    for block in text.split("\n\n"):
        first = block.splitlines()[0] if block else ""
        name = first.replace("TABLE ", "", 1).split(" --", 1)[0].strip()
        if not name:
            continue
        hits.append(_hit(_KIND_DDL, block, 0.92, {"table": name, "tables": name}))
    return hits


def expand_join_tables(tenant: Tenant, question: str, tables: list[str]) -> list[str]:
    return expand_related_tables(tenant, question, tables)


def retrieve(tenant: Tenant, question: str, meter: LlmMeter, n: int = 8) -> list[dict[str, Any]]:
    exact = exact_golden(tenant, question)
    if exact:
        return [exact]

    hits = schema_table_hits(tenant, question, n=n)
    vecs = embed_texts([question], meter) if collection_count(tenant.id) > 0 else []
    if vecs:
        vec = vecs[0]
        coll = _collection(tenant.id)
        res = coll.query(
            query_embeddings=[vec],
            n_results=max(12, n),
            include=["documents", "metadatas", "distances"],
        )
        docs = (res.get("documents") or [[]])[0]
        metas = (res.get("metadatas") or [[]])[0]
        dists = (res.get("distances") or [[]])[0]
        seen_sql = {h.get("sql") for h in hits if h.get("sql")}
        seen_table = {h.get("table") for h in hits if h.get("table")}
        for doc, meta, dist in zip(docs, metas, dists):
            score = 1.0 - float(dist or 0)
            kind = str((meta or {}).get("kind") or _KIND_DOC)
            item = _hit(kind, str(doc or ""), score, dict(meta or {}))
            if item.get("sql") and item.get("sql") in seen_sql:
                continue
            if item.get("table") and item.get("table") in seen_table and kind == _KIND_DDL:
                continue
            hits.append(item)
            if item.get("sql"):
                seen_sql.add(item.get("sql"))
            if item.get("table"):
                seen_table.add(item.get("table"))
    hits.sort(key=lambda x: float(x.get("score") or 0), reverse=True)
    tables = []
    seen_t: set[str] = set()
    for h in hits:
        for t in [h.get("table"), *(h.get("tables") or [])]:
            if t and str(t).lower() not in seen_t:
                seen_t.add(str(t).lower())
                tables.append(str(t))
    extra = expand_join_tables(tenant, question, tables)
    for h in ddl_for_tables(tenant, extra):
        if h.get("table") and str(h["table"]).lower() not in seen_t:
            hits.append(h)
            seen_t.add(str(h["table"]).lower())
    hits.sort(key=lambda x: float(x.get("score") or 0), reverse=True)
    return hits[: max(n, 12)]


def pick_golden_sql(hits: list[dict[str, Any]]) -> dict[str, Any] | None:
    threshold = float(get_settings().vanna_golden_min_score)
    for h in hits:
        if h.get("kind") == _KIND_GOLDEN and float(h.get("score") or 0) >= threshold and h.get("sql"):
            return h
    return None


def is_exact_golden_hit(hit: dict[str, Any] | None) -> bool:
    """精确黄金 / 指标（score=1.0）可 0-LLM；语义相似黄金需 Router 确认。"""
    if not hit:
        return False
    return str(hit.get("kind") or "") == _KIND_GOLDEN and float(hit.get("score") or 0) >= 0.999 and bool(hit.get("sql"))


def prune_hits_for_sql(
    tenant: Tenant,
    question: str,
    hits: list[dict[str, Any]],
    router_tables: list[str],
) -> list[dict[str, Any]]:
    """写 SQL 只带 Router 点名表 + JOIN 一跳卡片，禁止整库 fallback。"""
    cap = max(2, int(get_settings().vanna_sql_card_tables))
    names: list[str] = []
    seen: set[str] = set()
    for t in router_tables or []:
        k = str(t or "").strip()
        if k and k.lower() not in seen:
            seen.add(k.lower())
            names.append(k)
    if not names:
        # 回退：检索命中的 DDL 表，仍限 cap
        for h in hits:
            t = str(h.get("table") or "").strip()
            if t and t.lower() not in seen and str(h.get("kind") or "") == _KIND_DDL:
                seen.add(t.lower())
                names.append(t)
            if len(names) >= cap:
                break
    names = expand_join_tables(tenant, question, names)[:cap]
    out = ddl_for_tables(tenant, names)
    # 附带少量相关黄金示例（含 SQL），控数量
    gold_n = 0
    for h in hits:
        if str(h.get("kind") or "") != _KIND_GOLDEN or not h.get("sql"):
            continue
        out.append(h)
        gold_n += 1
        if gold_n >= 2:
            break
    return out
