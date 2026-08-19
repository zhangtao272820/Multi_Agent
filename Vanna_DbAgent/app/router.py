"""廉价 LLM Router：读表目录元数据，决定 golden / llm_sql / chitchat / clarify。

对齐开源 NL2SQL（Vanna RAG + Judger 分流 + CHESS 式 schema 裁剪）：
- Router 只看「表名+注释」目录与少量黄金标题，不喂全列 DDL（控 token）。
- 写 SQL 另一次调用，只喂 Router 点名的表卡片。
- 禁止用问句正则当意图；schema_link 只做检索候选。
"""
from __future__ import annotations

import json
import re
from typing import Any

from app.catalog import load_golden
from app.llm import LlmMeter, chat_json
from app.schema_link import load_schema
from app.tenants import Tenant

_ROUTER_SYS = """你是只读库问数的路由裁判（Judger）。根据用户自然语言与「表目录元数据」决定下一跳。
只输出 JSON：
{"path":"golden|llm_sql|chitchat|clarify","intent":"count|list|aggregate|join|clarify|chitchat|meta","tables":["表名"],"golden_ok":false,"reason":"一句话","clarify":""}
规则：
- path=golden：仅当下方「候选黄金问句」与用户问题语义高度一致，可直接用那条 SQL；同时 golden_ok=true，tables 填该 SQL 涉及表。
- path=llm_sql：需要读列注释写 SQL。tables 填 1～4 张最相关表（必须来自表目录，大小写一致）。口语别称要映射（二层组/二战组/组里有谁→人员分组相关表；突发事件→考试/事件表；老人→老人库）。
- path=chitchat：与库无关（天气闲聊等），clarify 里中文直接答，tables=[]。
- path=clarify：通读表目录后仍完全无法对应任何业务表；禁止因「说法不标准」或「没撞上黄金原句」就澄清。
- 禁止编造表目录外的表名。
"""

_PATHS = frozenset({"golden", "llm_sql", "chitchat", "clarify"})


def table_catalog_index(tenant: Tenant, *, max_chars: int = 2800) -> str:
    """表名 + 注释一行一条（元数据，无列 DDL）。"""
    schema = load_schema(tenant)
    lines = ["表目录（名称 -- 注释）："]
    for table in schema.get("tables") or []:
        name = str(table.get("name") or "").strip()
        if not name:
            continue
        cmt = str(table.get("comment") or "").strip()
        lines.append(f"- {name}" + (f" -- {cmt}" if cmt else ""))
    text = "\n".join(lines)
    return text if len(text) <= max_chars else text[: max_chars - 1] + "…"


def catalog_nonempty(tenant: Tenant) -> bool:
    schema = load_schema(tenant)
    return any(str(t.get("name") or "").strip() for t in (schema.get("tables") or []))


def golden_titles_for_router(hits: list[dict[str, Any]], tenant: Tenant, *, limit: int = 3) -> list[dict[str, str]]:
    """给 Router 的黄金标题（不含整段 SQL，控 token）。"""
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for h in hits:
        if str(h.get("kind") or "") != "golden":
            continue
        title = str(h.get("document") or "").strip()[:120]
        if not title or title in seen:
            continue
        seen.add(title)
        tables = [str(t) for t in (h.get("tables") or []) if t][:6]
        if h.get("table") and str(h["table"]) not in tables:
            tables.insert(0, str(h["table"]))
        out.append({"question": title, "tables": ",".join(tables), "score": str(h.get("score") or "")})
        if len(out) >= limit:
            return out
    for g in load_golden(tenant)[:limit]:
        title = str(g.get("question") or "").strip()[:120]
        if not title or title in seen:
            continue
        seen.add(title)
        out.append(
            {
                "question": title,
                "tables": ",".join(str(t) for t in (g.get("tables") or [])[:6]),
                "score": "seed",
            }
        )
        if len(out) >= limit:
            break
    return out


def _history_brief(history: list[dict[str, str]] | None) -> str:
    if not history:
        return ""
    lines = []
    for m in history[-2:]:
        role = "用户" if m.get("role") == "user" else "助手"
        lines.append(f"{role}：{str(m.get('content') or '')[:80]}")
    return "近期：\n" + "\n".join(lines) + "\n\n"


def parse_router(raw: str | dict[str, Any]) -> dict[str, Any]:
    if isinstance(raw, dict):
        data = raw
    else:
        text = str(raw or "").strip()
        m = re.search(r"\{[\s\S]*\}", text)
        try:
            data = json.loads(m.group(0) if m else text)
        except json.JSONDecodeError:
            data = {}
    path = str(data.get("path") or "llm_sql").strip().lower()
    if path not in _PATHS:
        path = "llm_sql"
    intent = str(data.get("intent") or "list").strip().lower()
    tables = [str(t).strip() for t in (data.get("tables") or []) if str(t).strip()][:6]
    golden_ok = bool(data.get("golden_ok"))
    if path == "golden":
        golden_ok = True
    if path in {"chitchat", "clarify"}:
        tables = []
        golden_ok = False
    return {
        "path": path,
        "intent": intent,
        "tables": tables,
        "golden_ok": golden_ok,
        "reason": str(data.get("reason") or "").strip()[:200],
        "clarify": str(data.get("clarify") or "").strip()[:400],
        "need_clarify": path == "clarify",
    }


def run_router(
    tenant: Tenant,
    question: str,
    hits: list[dict[str, Any]],
    meter: LlmMeter,
    history: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    catalog = table_catalog_index(tenant)
    if catalog.count("\n") < 2 and not catalog_nonempty(tenant):
        return {
            "path": "clarify",
            "intent": "clarify",
            "tables": [],
            "golden_ok": False,
            "reason": "empty_catalog",
            "clarify": "没有在当前租户目录里找到对应的表。请说明要查的对象，或换一个说法。",
            "need_clarify": True,
        }
    titles = golden_titles_for_router(hits, tenant)
    gold_block = "\n".join(
        f"- {t['question']}" + (f" （表:{t['tables']}）" if t.get("tables") else "") for t in titles
    ) or "(无)"
    user = (
        f"{_history_brief(history)}"
        f"{catalog}\n\n"
        f"候选黄金问句（仅标题，语义高度一致才可 path=golden）：\n{gold_block}\n\n"
        f"用户问题：{question}"
    )
    raw = chat_json(_ROUTER_SYS, user, meter, max_tokens=280)
    return parse_router(raw)
