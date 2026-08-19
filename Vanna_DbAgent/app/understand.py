from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from app.tenants import Tenant

INTENTS = ("count", "list", "aggregate", "join", "clarify", "chitchat", "meta")

_PARTICLE_PREFIX = re.compile(
    r"^(请问一下|请问|请帮我查一下|请帮我查|请帮我|帮我查一下|帮我查|帮我|查一下|麻烦|我想问)"
)
_PARTICLE_SUFFIX = re.compile(r"[呢啊呀吗？?。.！!\s]+$")


def normalize_question(q: str) -> str:
    s = re.sub(r"\s+", "", str(q or "").strip())
    s = _PARTICLE_PREFIX.sub("", s)
    s = _PARTICLE_SUFFIX.sub("", s)
    return s


def tenant_dir(tenant: Tenant) -> Path | None:
    if tenant.docs_path:
        return tenant.docs_path.parent
    if tenant.golden_path:
        return tenant.golden_path.parent
    from app.settings import ROOT

    folder = ROOT / "tenants" / tenant.id
    return folder if folder.is_dir() else None


def load_joins(tenant: Tenant) -> list[dict[str, Any]]:
    folder = tenant_dir(tenant)
    if not folder:
        return []
    path = folder / "joins.json"
    if not path.is_file():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    return list(raw or []) if isinstance(raw, list) else []


def join_prompt(tenant: Tenant) -> str:
    lines = []
    for j in load_joins(tenant):
        tables = ", ".join(j.get("tables") or [])
        lines.append(f"- 当问题涉及「{j.get('when')}」用表 {tables}，JOIN {j.get('sql')}")
    return "\n".join(lines) if lines else "(无预置 JOIN)"


def parse_plan(raw: str) -> dict[str, Any]:
    text = str(raw or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
    text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        data = json.loads(text[start : end + 1]) if start >= 0 and end > start else {}
    if not isinstance(data, dict):
        data = {}
    intent = str(data.get("intent") or "list").strip().lower()
    if intent not in INTENTS:
        intent = "list"
    tables = data.get("tables") if isinstance(data.get("tables"), list) else []
    sql = str(data.get("sql") or "").strip()
    clarify = str(data.get("clarify") or "").strip()
    need = bool(data.get("need_clarify")) or intent == "clarify" or (not sql and clarify)
    if intent == "chitchat":
        need = False
        sql = ""
    # 已给出可用 SQL 时，不允许再以 clarify 吞掉（模型常见误报）
    if sql and need and intent != "chitchat":
        need = False
        if intent == "clarify":
            intent = "list"
    return {
        "intent": intent,
        "tables": [str(t) for t in tables if str(t).strip()],
        "sql": sql,
        "need_clarify": need,
        "clarify": clarify,
        "reason": str(data.get("reason") or "").strip(),
    }
