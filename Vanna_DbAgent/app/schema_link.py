"""用库表/列注释做 schema linking（检索，不是意图路由）。

成熟 Text2SQL（Vanna / Dataherald 一类）先按元数据召回相关表，再一次生成 SQL。
不连库、不调 LLM；快路径只读 snapshot。
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.sql_guard import SECRET_FIELD_NAMES
from app.tenants import Tenant
from app.understand import load_joins, normalize_question, tenant_dir

_AUDIT = {
    "modifier",
    "modifydate",
    "modifyid",
    "createid",
    "creator",
    "createdate",
}
_WEAK_COMMENTS = {
    "名称",
    "状态",
    "描述",
    "备注",
    "创建人",
    "修改人",
    "修改时间",
    "创建时间",
    "主键",
    "是否启用",
    "排序",
    "编号",
    "信息",
}
_STOP_BIGRAMS = {
    "多少",
    "有多",
    "哪些",
    "什么",
    "分别",
    "目前",
    "几个",
    "一下",
    "帮我",
}


def snapshot_path(tenant: Tenant):
    folder = tenant_dir(tenant)
    if not folder:
        return None
    path = folder / "schema_snapshot.json"
    return path if path.is_file() else None


@lru_cache(maxsize=8)
def load_schema_cached(path_str: str) -> dict[str, Any]:
    raw = json.loads(Path(path_str).read_text(encoding="utf-8"))
    return raw if isinstance(raw, dict) else {"tables": [], "skipped": [], "fks": []}


def load_schema(tenant: Tenant) -> dict[str, Any]:
    path = snapshot_path(tenant)
    if not path:
        return {"tables": [], "skipped": [], "fks": []}
    return load_schema_cached(str(path))


def _grams(text: str) -> set[str]:
    s = re.sub(r"\s+", "", str(text or ""))
    if len(s) < 2:
        return {s} if s else set()
    grams = {s[i : i + 2] for i in range(len(s) - 1)}
    return {g for g in grams if g not in _STOP_BIGRAMS and not re.fullmatch(r"[0-9A-Za-z_]{2}", g)}


def _comment_score(question: str, comment: str, *, weak_ok: bool) -> int:
    cmt = str(comment or "").strip()
    if len(cmt) < 2:
        return 0
    if cmt in _WEAK_COMMENTS and not weak_ok:
        return 1 if cmt in question else 0
    if cmt in question:
        return 10 if cmt not in _WEAK_COMMENTS else 2
    overlap = _grams(question) & _grams(cmt)
    if not overlap:
        return 0
    return min(6, 2 * len(overlap))


def score_table(
    question: str,
    table: dict[str, Any],
    value_maps: dict[str, dict[str, str]] | None = None,
) -> tuple[int, list[str]]:
    q = normalize_question(question)
    if not q:
        return 0, []
    name = str(table.get("name") or "")
    comment = str(table.get("comment") or "").strip()
    score = 0
    matched_cols: list[str] = []
    if name and name.lower() in q.lower():
        score += 12
    score += _comment_score(q, comment, weak_ok=True)
    maps = value_maps or {}
    for col in table.get("cols") or []:
        cname = str(col.get("name") or "")
        if not cname or cname.lower() in SECRET_FIELD_NAMES or cname.lower() in _AUDIT:
            continue
        cmt = str(col.get("comment") or "").strip()
        col_s = _comment_score(q, cmt, weak_ok=score > 0)
        if col_s:
            score += col_s
            if cmt and cmt not in _WEAK_COMMENTS:
                matched_cols.append(cname)
        elif len(cname) >= 4 and cname.lower() in q.lower():
            score += 4
            matched_cols.append(cname)
        samples = [str(x) for x in (col.get("samples") or []) if x is not None]
        if any(s and s in q for s in samples):
            score += 8
            if cname not in matched_cols:
                matched_cols.append(cname)
        spec = maps.get(f"{name}.{cname}") or {}
        if any(str(v) and str(v) in q for v in spec.values()):
            score += 8
            if cname not in matched_cols:
                matched_cols.append(cname)
    return score, matched_cols


def link_tables(tenant: Tenant, question: str, n: int = 8) -> list[dict[str, Any]]:
    schema = load_schema(tenant)
    ranked: list[tuple[int, dict[str, Any], list[str]]] = []
    for table in schema.get("tables") or []:
        score, matched = score_table(question, table, tenant.value_maps)
        if score <= 0:
            continue
        ranked.append((score, table, matched))
    ranked.sort(key=lambda x: x[0], reverse=True)
    if not ranked:
        return []
    # 仅在存在「压倒性强命中」时丢掉弱噪声，避免把单对象问句扩成整库。
    # 弱多表场景（如老人+房间都只有中低分）仍保留 top-n，交给 JOIN 扩表补全。
    top = int(ranked[0][0])
    if top >= 24:
        floor = max(12, int(top * 0.35))
        strong = [item for item in ranked if item[0] >= floor]
        if not strong:
            strong = ranked[:1]
        ranked = strong
    out: list[dict[str, Any]] = []
    for score, table, matched in ranked[: max(1, n)]:
        item = dict(table)
        item["_score"] = score
        item["_matched_cols"] = matched
        out.append(item)
    return out


def format_card(table: dict[str, Any], value_maps: dict[str, dict[str, str]] | None = None) -> str:
    name = str(table.get("name") or "")
    comment = str(table.get("comment") or "").strip()
    matched = {str(x) for x in (table.get("_matched_cols") or [])}
    lines = [f"TABLE {name}" + (f" -- {comment}" if comment else "")]
    cols = list(table.get("cols") or [])
    cols.sort(key=lambda c: (str(c.get("name") or "") not in matched, str(c.get("name") or "")))
    shown = 0
    for col in cols:
        cname = str(col.get("name") or "")
        if not cname or cname.lower() in SECRET_FIELD_NAMES:
            continue
        if cname.lower() in _AUDIT:
            continue
        cmt = str(col.get("comment") or "").strip()
        typ = str(col.get("type") or col.get("col_type") or "").strip()
        bit = f"  {cname}"
        if typ:
            bit += f" {typ}"
        if cmt:
            bit += f" -- {cmt}"
        spec = (value_maps or {}).get(f"{name}.{cname}")
        if spec:
            bit += " [" + ",".join(f"{k}={v}" for k, v in list(spec.items())[:6]) + "]"
        samples = [str(x) for x in (col.get("samples") or []) if x is not None]
        if samples:
            bit += " samples=" + ",".join(samples[:8])
        if cname in matched:
            bit += " *"
        lines.append(bit)
        shown += 1
        if shown >= 22:
            break
    return "\n".join(lines)


def cards_for(
    tenant: Tenant,
    names: list[str],
    *,
    question: str = "",
) -> str:
    schema = load_schema(tenant)
    want = [n for n in names if n]
    by = {str(t.get("name") or "").lower(): t for t in schema.get("tables") or []}
    if question:
        linked = {str(t.get("name") or "").lower(): t for t in link_tables(tenant, question, n=16)}
        by.update(linked)
    blocks: list[str] = []
    seen: set[str] = set()
    for name in want:
        table = by.get(name.lower())
        if not table or name.lower() in seen:
            continue
        seen.add(name.lower())
        blocks.append(format_card(table, tenant.value_maps))
    return "\n\n".join(blocks)


def fk_recipes(tenant: Tenant) -> list[dict[str, Any]]:
    schema = load_schema(tenant)
    out: list[dict[str, Any]] = []
    for fk in schema.get("fks") or []:
        ft = str(fk.get("from_table") or "")
        fc = str(fk.get("from_col") or "")
        tt = str(fk.get("to_table") or "")
        tc = str(fk.get("to_col") or "")
        if not ft or not tt:
            continue
        out.append(
            {
                "when": "",
                "sql": f"{ft}.{fc} = {tt}.{tc}",
                "tables": [ft, tt],
            }
        )
    return out


def all_join_recipes(tenant: Tenant) -> list[dict[str, Any]]:
    return list(load_joins(tenant)) + fk_recipes(tenant)


_JOIN_INTENT = ("参加", "报名", "考生", "成员", "名单", "学号", "姓名")


def when_matches_question(question: str, when: str) -> bool:
    """JOIN 配方的 when 与问题是否同指一类业务（不是用户原话路由表）。"""
    q = normalize_question(question)
    w = str(when or "").strip()
    if not q or not w:
        return False
    for part in re.split(r"[/、,，]", w):
        part = part.strip()
        if len(part) < 2:
            continue
        if part in q:
            return True
        intents = [tok for tok in _JOIN_INTENT if tok in part]
        if intents and any(tok in q for tok in intents):
            return True
    return False


def expand_join_tables(tenant: Tenant, question: str, tables: list[str], n: int = 12) -> list[str]:
    """只从当前已选表扩 JOIN；when 未命中时不因单表 overlap 把旁支表全拖进来。"""
    selected: list[str] = []
    seen: set[str] = set()
    for t in tables:
        k = str(t or "").lower()
        if not k or k in seen:
            continue
        seen.add(k)
        selected.append(str(t))
    if not selected:
        return selected
    scored = {str(t.get("name") or "").lower() for t in link_tables(tenant, question, n=n)}
    for recipe in all_join_recipes(tenant):
        rtables = [str(x) for x in (recipe.get("tables") or []) if x]
        overlap = [t for t in rtables if t.lower() in seen]
        when_hit = when_matches_question(question, str(recipe.get("when") or ""))
        if not overlap:
            if when_hit:
                for t in rtables:
                    k = t.lower()
                    if k in seen:
                        continue
                    seen.add(k)
                    selected.append(t)
            continue
        # 已有表命中配方：仅当 when 命中、或对方也已 schema 打分、或双方都已选中时才扩
        for t in rtables:
            k = t.lower()
            if k in seen:
                continue
            if when_hit or k in scored or len(overlap) >= 2:
                seen.add(k)
                selected.append(t)
    return selected


def join_prompt_for(
    tenant: Tenant,
    tables: list[str] | None = None,
    *,
    question: str = "",
) -> str:
    want = {t.lower() for t in (tables or []) if t}
    lines: list[str] = []
    for j in all_join_recipes(tenant):
        jts = [str(x) for x in (j.get("tables") or [])]
        when = str(j.get("when") or "").strip()
        if want and not any(t.lower() in want for t in jts) and not (
            question and when_matches_question(question, when)
        ):
            continue
        prefix = f"当问题涉及「{when}」" if when else "外键"
        lines.append(f"- {prefix} 用表 {', '.join(jts)}，JOIN {j.get('sql')}")
    return "\n".join(lines) if lines else "(无预置 JOIN)"
