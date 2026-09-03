"""LLM Understand：意图 + 槽位 + 选表（主控查什么），再交二次调用写 SQL。

对齐开源 NL2SQL / DB_Agent QueryPlan 精简契约：
- 一次小 JSON：path / intent / data_domain / tables / entities / filters.slots / time_range
- 只喂表目录元数据 + 蓝图短文 + 黄金标题（不喂全列 DDL）
- 禁止用问句正则当意图；schema_link 只做检索候选
"""
from __future__ import annotations

import json
import re
from typing import Any

from app.catalog import load_golden
from app.domain_patch import blueprint_prompt_block
from app.llm import LlmMeter, chat_json
from app.schema_link import load_schema
from app.settings import get_settings
from app.tenants import Tenant

_ROUTER_SYS = """你是只读库问数的 Understand（意图与槽位裁判）。根据用户自然语言、表目录与领域蓝图决定怎么查。
只输出 JSON：
{"path":"golden|llm_sql|chitchat|clarify","intent":"count|list|aggregate|join|trend|clarify|chitchat|meta","data_domain":"general","tables":["表名"],"entities":{"names":[],"locations":[]},"filters":{"time_range":{"relative":"","start":"","end":""},"slots":[{"field_hint":"姓名","value":"陈明宇","sql_match_value":"陈明宇"}]},"join_needed":false,"golden_ok":false,"confidence":0.8,"reason":"一句话","clarify":""}
规则：
- path 由你判定：golden=可直接复用候选黄金 SQL；llm_sql=需自行写 SQL；chitchat=与库无关；clarify=表目录完全对不上。
- path=golden：仅当候选黄金与问题语义高度一致且无额外姓名/时间/地区过滤；golden_ok=true。一旦有额外过滤必须 path=llm_sql 并抽出 slots。
- path=llm_sql：tables 填 1～4 张最相关表（必须来自表目录，大小写一致）。口语别称与选表以「领域蓝图」为准，勿臆造表名。
- data_domain：短 slug（字母数字下划线），可按蓝图自定义；无把握用 general。
- confidence：0～1，把握不足时降低；低置信不要硬选 golden。
- entities.names / locations 必须进 filters.slots；sql_match_value 用蓝图或列注释中的库内真实值。
- 地点（区县/省市区）：sql_match_value 用用户说的短地名（如「河西区」）；后续 SQL 须 LIKE '%短名%' 包含匹配，禁止对复合省市区列做短字符串精确等值。
- 时间：relative 或 start/end（YYYY-MM-DD），供后续 SQL 写入，勿省略。
- join_needed：需多表关联时为 true；蓝图要求附带明细表时须一并写入 tables。
- 禁止编造表目录外的表名；禁止因说法不标准就 clarify。
"""

_PATHS = frozenset({"golden", "llm_sql", "chitchat", "clarify"})
_INTENTS = frozenset({"count", "list", "aggregate", "join", "trend", "clarify", "chitchat", "meta"})
_DOMAIN_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


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


def allowed_table_names(tenant: Tenant) -> set[str]:
    names: set[str] = set()
    lower_map: dict[str, str] = {}
    for table in load_schema(tenant).get("tables") or []:
        name = str(table.get("name") or "").strip()
        if not name or not tenant.allow_table(name):
            continue
        names.add(name)
        lower_map[name.lower()] = name
    # 也接受白名单前缀外的显式 whitelist
    for w in tenant.table_whitelist:
        if w:
            lower_map[w.lower()] = w
            names.add(w)
    return names | set(lower_map.values())


def _canon_tables(tenant: Tenant, tables: list[str], *, cap: int = 4) -> list[str]:
    allowed = {n.lower(): n for n in allowed_table_names(tenant)}
    # schema 大小写为准
    for table in load_schema(tenant).get("tables") or []:
        name = str(table.get("name") or "").strip()
        if name:
            allowed[name.lower()] = name
    out: list[str] = []
    seen: set[str] = set()
    for t in tables or []:
        k = str(t or "").strip()
        if not k:
            continue
        real = allowed.get(k.lower())
        if not real or real.lower() in seen:
            continue
        seen.add(real.lower())
        out.append(real)
        if len(out) >= cap:
            break
    return out


def golden_titles_for_router(hits: list[dict[str, Any]], tenant: Tenant, *, limit: int = 3) -> list[dict[str, str]]:
    """给 Understand 的黄金标题（不含整段 SQL，控 token）。优先 special。"""
    out: list[dict[str, str]] = []
    seen: set[str] = set()

    def _push(title: str, tables: list[str], score: str, source: str = "") -> bool:
        if not title or title in seen:
            return False
        seen.add(title)
        out.append(
            {
                "question": title,
                "tables": ",".join(tables[:6]),
                "score": score,
                "source": source or "",
            }
        )
        return len(out) >= limit

    # hits：special 先
    ordered_hits = sorted(
        [h for h in hits if str(h.get("kind") or "") == "golden"],
        key=lambda h: 0 if str(h.get("source") or "") == "special" else 1,
    )
    for h in ordered_hits:
        title = str(h.get("document") or "").strip()[:120]
        tables = [str(t) for t in (h.get("tables") or []) if t][:6]
        if h.get("table") and str(h["table"]) not in tables:
            tables.insert(0, str(h["table"]))
        if _push(title, tables, str(h.get("score") or ""), str(h.get("source") or "")):
            return out
    goldens = load_golden(tenant)
    goldens = sorted(goldens, key=lambda g: 0 if str(g.get("source") or "") == "special" else 1)
    for g in goldens:
        title = str(g.get("question") or "").strip()[:120]
        if _push(
            title,
            [str(t) for t in (g.get("tables") or [])],
            "seed",
            str(g.get("source") or ""),
        ):
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


def _parse_slots(raw: Any) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    if not isinstance(raw, list):
        return out
    for item in raw[:12]:
        if not isinstance(item, dict):
            continue
        hint = str(item.get("field_hint") or "").strip()[:40]
        value = str(item.get("value") or "").strip()[:80]
        sql_v = str(item.get("sql_match_value") or value or "").strip()[:80]
        if not hint and not value:
            continue
        out.append({"field_hint": hint or "条件", "value": value, "sql_match_value": sql_v or value})
    return out


def _parse_time_range(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {"relative": "", "start": "", "end": ""}
    return {
        "relative": str(raw.get("relative") or "").strip()[:40],
        "start": str(raw.get("start") or "").strip()[:32],
        "end": str(raw.get("end") or "").strip()[:32],
    }


def parse_router(raw: str | dict[str, Any], tenant: Tenant | None = None) -> dict[str, Any]:
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
    if intent not in _INTENTS:
        intent = "list"
    domain = str(data.get("data_domain") or "general").strip().lower()
    if not _DOMAIN_RE.match(domain):
        domain = "general"
    tables_raw = [str(t).strip() for t in (data.get("tables") or []) if str(t).strip()]
    cap = max(1, int(get_settings().vanna_router_max_tables or 4))
    tables = _canon_tables(tenant, tables_raw, cap=cap) if tenant else tables_raw[:cap]
    golden_ok = bool(data.get("golden_ok"))
    if path == "golden":
        golden_ok = True
    entities_raw = data.get("entities") if isinstance(data.get("entities"), dict) else {}
    names = [str(x).strip() for x in (entities_raw.get("names") or []) if str(x).strip()][:8]
    locations = [str(x).strip() for x in (entities_raw.get("locations") or []) if str(x).strip()][:8]
    filters_raw = data.get("filters") if isinstance(data.get("filters"), dict) else {}
    slots = _parse_slots(filters_raw.get("slots"))
    time_range = _parse_time_range(filters_raw.get("time_range"))
    # 人名进 slots（若模型只写了 entities）
    have_name = any("姓名" in s.get("field_hint", "") or s.get("field_hint") == "name" for s in slots)
    if names and not have_name:
        for n in names:
            slots.append({"field_hint": "姓名", "value": n, "sql_match_value": n})
    have_loc = any(_is_location_slot(s.get("field_hint", "")) for s in slots)
    if locations and not have_loc:
        for loc in locations:
            slots.append({"field_hint": "地区", "value": loc, "sql_match_value": loc})
    if path in {"chitchat", "clarify"}:
        tables = []
        golden_ok = False
        slots = []
    # 有额外过滤时不允许偷用无参黄金
    if path == "golden" and (slots or time_range.get("relative") or time_range.get("start")):
        path = "llm_sql"
        golden_ok = False
    conf_raw = data.get("confidence")
    try:
        confidence = float(conf_raw) if conf_raw is not None and str(conf_raw).strip() != "" else 0.6
    except (TypeError, ValueError):
        confidence = 0.6
    confidence = max(0.0, min(1.0, confidence))
    settings = get_settings()
    min_golden = float(settings.vanna_router_min_confidence_golden or 0.72)
    min_conf = float(settings.vanna_router_min_confidence or 0.35)
    if path == "golden" and confidence < min_golden:
        path = "llm_sql"
        golden_ok = False
    if path == "llm_sql" and confidence < min_conf and not tables:
        path = "clarify"
        intent = "clarify"
        golden_ok = False
        slots = []
        if not str(data.get("clarify") or "").strip():
            data = {**data, "clarify": "问题不够明确，请补充要查的对象（表/名单/人员/时间）。"}
    return {
        "path": path,
        "intent": intent,
        "data_domain": domain,
        "tables": tables,
        "entities": {"names": names, "locations": locations},
        "filters": {"time_range": time_range, "slots": slots},
        "join_needed": bool(data.get("join_needed")),
        "golden_ok": golden_ok,
        "confidence": confidence,
        "reason": str(data.get("reason") or "").strip()[:200],
        "clarify": str(data.get("clarify") or "").strip()[:400],
        "need_clarify": path == "clarify",
    }


def _is_location_slot(hint: str) -> bool:
    h = str(hint or "").strip().lower()
    if not h:
        return False
    keys = ("地区", "省市区", "区县", "城市", "location", "region", "province", "city")
    return any(k in h for k in keys) or h in {"addr", "address", "area"}


def plan_to_must_filters(plan: dict[str, Any] | None) -> list[str]:
    """把 Understand 槽位变成 SQL prompt 的必须过滤行。"""
    if not plan:
        return []
    lines: list[str] = []
    filters = plan.get("filters") if isinstance(plan.get("filters"), dict) else {}
    time_range = filters.get("time_range") if isinstance(filters.get("time_range"), dict) else {}
    rel = str(time_range.get("relative") or "").strip()
    start = str(time_range.get("start") or "").strip()
    end = str(time_range.get("end") or "").strip()
    if rel:
        lines.append(f"时间范围（相对）：{rel} —— 用事实表时间列写区间")
    if start or end:
        lines.append(f"时间范围：{start or '…'} ~ {end or '…'}")
    for slot in filters.get("slots") or []:
        if not isinstance(slot, dict):
            continue
        hint = str(slot.get("field_hint") or "").strip()
        val = str(slot.get("sql_match_value") or slot.get("value") or "").strip()
        if not val:
            continue
        if _is_location_slot(hint):
            lines.append(
                f"{hint or '地区'} 包含 {val}（WHERE 用 LIKE '%{val}%'，禁止对省市区复合列做短字符串 =）"
            )
        else:
            lines.append(f"{hint or '条件'} = {val}（必须写入 WHERE/JOIN，禁止忽略）")
    for n in (plan.get("entities") or {}).get("names") or []:
        n = str(n).strip()
        if n and not any(n in x for x in lines):
            lines.append(f"姓名 = {n}（必须写入 WHERE/JOIN，禁止忽略）")
    for loc in (plan.get("entities") or {}).get("locations") or []:
        loc = str(loc).strip()
        if loc and not any(loc in x for x in lines):
            lines.append(
                f"地区 包含 {loc}（WHERE 用 LIKE '%{loc}%'，禁止对省市区复合列做短字符串 =）"
            )
    domain = str(plan.get("data_domain") or "")
    if domain and domain != "general":
        lines.append(f"数据域 data_domain={domain}")
    if plan.get("join_needed"):
        lines.append("需要多表 JOIN（按提供的 JOIN 关系）")
    return lines[:16]


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
            "data_domain": "general",
            "tables": [],
            "entities": {"names": [], "locations": []},
            "filters": {"time_range": {"relative": "", "start": "", "end": ""}, "slots": []},
            "join_needed": False,
            "golden_ok": False,
            "confidence": 1.0,
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
        f"{blueprint_prompt_block(tenant)}"
        f"{catalog}\n\n"
        f"候选黄金问句（仅标题，语义高度一致且无额外过滤才可 path=golden）：\n{gold_block}\n\n"
        f"用户问题：{question}"
    )
    raw = chat_json(_ROUTER_SYS, user, meter, max_tokens=450)
    route = parse_router(raw, tenant)
    # 表名非法时回退检索命中 DDL
    if route["path"] == "llm_sql" and not route["tables"]:
        fallback: list[str] = []
        seen: set[str] = set()
        for h in hits:
            t = str(h.get("table") or "").strip()
            if t and t.lower() not in seen and str(h.get("kind") or "") == "ddl":
                seen.add(t.lower())
                fallback.append(t)
            if len(fallback) >= 4:
                break
        route["tables"] = _canon_tables(tenant, fallback, cap=4)
    return route
