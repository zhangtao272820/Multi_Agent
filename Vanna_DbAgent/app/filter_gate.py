"""轻量约束闸：只拦「实体人名」漏写，其余过滤交给 Understand + SQL 模型。

设计原则（LLM-first）：
- path=golden / llm_sql 由 Router 模型判定，本模块不解析用户原话
- 枚举、年龄区间、相对时间靠 prompt must_filters，不用正则猜语义
- 硬闸仅：entities.names / 姓名槽位的 sql_match_value 须作为子串出现在 SQL
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class FilterGateResult:
    ok: bool
    missing: list[str] = field(default_factory=list)


def _is_person_slot(hint: str) -> bool:
    h = str(hint or "").strip().lower()
    return h in {"姓名", "name", "人名", "人员"} or "姓名" in h


def required_person_names(plan: dict[str, Any] | None) -> list[str]:
    """只收集应写入 SQL 的人名（不做意图/区间解析）。"""
    if not plan:
        return []
    out: list[str] = []
    seen: set[str] = set()

    def _add(v: str) -> None:
        s = str(v or "").strip().strip("'\"`")
        if not s or len(s) < 2:
            return
        # 纯数字/枚举不是人名，交给模型
        if s.isdigit():
            return
        key = s.lower()
        if key in seen:
            return
        seen.add(key)
        out.append(s)

    for n in (plan.get("entities") or {}).get("names") or []:
        _add(str(n))
    filters = plan.get("filters") if isinstance(plan.get("filters"), dict) else {}
    for slot in filters.get("slots") or []:
        if not isinstance(slot, dict):
            continue
        if not _is_person_slot(str(slot.get("field_hint") or "")):
            continue
        _add(str(slot.get("sql_match_value") or slot.get("value") or ""))
    return out


def sql_has_value(sql: str, value: str) -> bool:
    """简单子串包含（去空白、大小写不敏感）；无业务正则。"""
    v = str(value or "").strip().strip("'\"`")
    if not v:
        return True
    blob = "".join(str(sql or "").split()).lower()
    needle = "".join(v.split()).lower()
    return bool(needle) and needle in blob


def values_from_must_filter_lines(lines: list[str] | None) -> list[str]:
    """仅从 Manager 下发的「姓名 = xxx」行抽出人名；其它行忽略。"""
    out: list[str] = []
    seen: set[str] = set()
    for line in lines or []:
        text = str(line or "").strip()
        if "姓名" not in text and "name" not in text.lower():
            continue
        if "=" not in text:
            continue
        val = text.split("=", 1)[1]
        for stop in ("（", "("):
            if stop in val:
                val = val.split(stop, 1)[0]
        val = val.strip().strip("'\"`")
        if not val or val.isdigit():
            continue
        key = val.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(val)
    return out


def assert_plan_filters(
    sql: str,
    plan: dict[str, Any] | None = None,
    *,
    extra_values: list[str] | None = None,
) -> FilterGateResult:
    names = required_person_names(plan)
    for v in extra_values or []:
        s = str(v or "").strip().strip("'\"`")
        if s and not s.isdigit() and s.lower() not in {x.lower() for x in names}:
            names.append(s)
    missing = [n for n in names if not sql_has_value(sql, n)]
    return FilterGateResult(ok=not missing, missing=missing)
