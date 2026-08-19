"""用字段注释决定结果表展示：有意义列回显，敏感/审计/无用列隐藏。

不调 LLM。分类依据 schema snapshot 的列注释 + 列名，不是用户原话正则路由。
"""
from __future__ import annotations

import re
from typing import Any

from app.schema_link import load_schema
from app.sql_guard import SECRET_FIELD_NAMES
from app.tenants import Tenant
from app.understand import normalize_question

AUDIT_FIELD_NAMES = {
    "modifier",
    "modifydate",
    "modifyid",
    "createid",
    "creator",
    "createdate",
}

_USELESS_COMMENTS = {
    "主键",
    "创建人",
    "修改人",
    "修改时间",
    "创建时间",
    "创建人id",
    "修改人id",
    "是否删除",
    "排序",
    "guid",
}

_SENSITIVE_COMMENT = re.compile(
    r"密码|口令|证件|身份证|银行卡|卡号|手机号|电话号码|薪资|工资|密钥|token|userpwd",
    re.I,
)
_ID_NAME = re.compile(r"(^id$|_id$|id$)", re.I)
_SWITCH_COL = re.compile(r"^(isopen|isclosed|isenable|isdelete|deleted)$", re.I)
_TIGHT_FILTER = re.compile(r"\b(IsOpen|IsClosed|IsEnable|IsDelete)\b", re.I)

_DISPLAY_HINT = ("姓名", "学号", "名称", "标题", "类型", "级别", "角色", "账号", "房间", "分组")


def empty_message(sql: str) -> str:
    extra = (
        "当前 SQL 带了开关/关闭类条件，有可能把有效记录滤掉。"
        if _TIGHT_FILTER.search(sql or "")
        else "可能是库里确实没有匹配记录，或 WHERE/JOIN 与对象对不上。"
    )
    return f"按这条查询在库里查到 0 行。{extra}没有编造数据；请核对 SQL 里的表和过滤条件。"


def _index_cols(tenant: Tenant, tables: list[str]) -> list[dict[str, str]]:
    schema = load_schema(tenant)
    want = {str(t).split(".")[-1].lower() for t in tables if t}
    out: list[dict[str, str]] = []
    for table in schema.get("tables") or []:
        tname = str(table.get("name") or "")
        if want and tname.lower() not in want:
            continue
        for col in table.get("cols") or []:
            cname = str(col.get("name") or "")
            if not cname:
                continue
            out.append(
                {
                    "table": tname,
                    "name": cname,
                    "comment": str(col.get("comment") or "").strip(),
                }
            )
    return out


def _meta_for_key(key: str, catalog: list[dict[str, str]]) -> dict[str, str] | None:
    raw = str(key or "").strip()
    if not raw:
        return None
    low = raw.lower()
    for col in catalog:
        if col["name"].lower() == low:
            return col
    for col in catalog:
        if col["comment"] and col["comment"] == raw:
            return col
    return None


def classify_column(name: str, comment: str) -> str:
    """show | hide_secret | hide_audit | hide_useless"""
    n = str(name or "")
    cmt = str(comment or "").strip()
    if n.lower() in SECRET_FIELD_NAMES or _SENSITIVE_COMMENT.search(cmt) or _SENSITIVE_COMMENT.search(n):
        return "hide_secret"
    cmt_l = cmt.lower().replace(" ", "")
    if n.lower() in AUDIT_FIELD_NAMES or cmt in _USELESS_COMMENTS or cmt_l in {"主键", "考试id", "学生id", "用户id", "团队主键"}:
        return "hide_audit"
    if _SWITCH_COL.match(n) and not cmt:
        return "hide_useless"
    if not cmt and _ID_NAME.search(n):
        return "hide_useless"
    if cmt in {"主键", "考试id", "学生id", "用户id", "团队主键"}:
        return "hide_useless"
    return "show"


def _prefer(key: str, comment: str, question: str) -> int:
    q = normalize_question(question)
    blob = f"{comment}{key}"
    score = 0
    for hint in _DISPLAY_HINT:
        if hint in q and hint in blob:
            score += 8
    if comment and comment in q:
        score += 10
    # 问「叫什么 / 分别是什么」→ 名称列；问文本/视频 → 类型列（展示裁剪，不是路由）
    if any(tok in q for tok in ("叫什么", "分别是什么", "分别叫", "是什么")) and any(
        h in blob for h in ("名称", "标题", "Name", "name")
    ):
        score += 8
    if any(tok in q for tok in ("文本", "视频", "类型")) and "类型" in blob:
        score += 8
    return score


def present_rows(
    tenant: Tenant,
    *,
    question: str,
    rows: list[dict[str, Any]],
    tables: list[str],
) -> dict[str, Any]:
    if not rows:
        return {"rows": [], "hidden": [], "labels": {}, "field_details": []}
    catalog = _index_cols(tenant, tables)
    keys = list(rows[0].keys())
    keep: list[tuple[int, str, str, dict[str, str]]] = []
    hidden: list[str] = []
    labels: dict[str, str] = {}
    used_labels: set[str] = set()
    for key in keys:
        meta = _meta_for_key(key, catalog) or {}
        comment = str(meta.get("comment") or "")
        name = str(meta.get("name") or key)
        kind = classify_column(name, comment)
        if kind != "show":
            hidden.append(key)
            continue
        label = comment or key
        if label in used_labels:
            label = f"{comment}({name})" if comment else key
        used_labels.add(label)
        labels[key] = label
        keep.append((_prefer(key, comment, question), key, label, dict(meta)))
    keep.sort(key=lambda x: (-x[0], x[1]))
    if not keep:
        # 全被藏了就退回原列，避免空白表
        keep = [(0, k, k, {}) for k in keys]
        hidden = []
        labels = {k: k for k in keys}
    preferred = [x for x in keep if x[0] > 0]
    # 问句已点名姓名/名称/类型等时，只展示贴合列，避免 SELECT * 铺一长串
    if preferred:
        keep = preferred[:6]
    else:
        keep = keep[:6]
    out_rows: list[dict[str, Any]] = []
    for row in rows:
        item: dict[str, Any] = {}
        for _, key, label, _meta in keep:
            item[label] = row.get(key)
        out_rows.append(item)
    field_details: list[dict[str, str]] = []
    seen_labels: set[str] = set()
    for _score, key, label, meta in keep:
        if label in seen_labels:
            continue
        seen_labels.add(label)
        field_details.append(
            {
                "label": label,
                "column": str(meta.get("name") or key),
                "comment": str(meta.get("comment") or label),
                "table": str(meta.get("table") or ""),
            }
        )
    return {
        "rows": out_rows,
        "hidden": hidden,
        "labels": labels,
        "field_details": field_details,
    }


def select_hint(tenant: Tenant, tables: list[str], question: str) -> str:
    catalog = _index_cols(tenant, tables)
    if not catalog:
        return ""
    q = normalize_question(question)
    shown: list[str] = []
    for col in catalog:
        kind = classify_column(col["name"], col["comment"])
        if kind != "show":
            continue
        cmt = col["comment"]
        star = ""
        if cmt and (cmt in q or any(h in q and h in f"{cmt}{col['name']}" for h in _DISPLAY_HINT)):
            star = " *"
        shown.append(f"{col['table']}.{col['name']}" + (f"（{cmt}）" if cmt else "") + star)
        if len(shown) >= 18:
            break
    if not shown:
        return ""
    return "可展示列（注释判断；* 更贴近问题；不要 SELECT 主键/审计/敏感列）：\n" + "\n".join(f"- {x}" for x in shown)
