from __future__ import annotations

from typing import Any


def _is_count_key(key: str) -> bool:
    k = str(key or "")
    low = k.lower()
    return low in {"count", "cnt", "total", "n"} or "count" in low or k in {"数量", "人数"}


def _name_keys(row: dict[str, Any]) -> list[str]:
    return [
        k
        for k in row.keys()
        if k.lower() in {"name", "title", "usertruename", "username", "studenttruename"}
        or k in {"姓名", "学生姓名", "名称", "客户姓名"}
        or ("姓名" in str(k) and "学号" not in str(k))
    ]


def _nonempty_items(row: dict[str, Any]) -> list[tuple[str, Any]]:
    return [(str(k), v) for k, v in row.items() if v is not None and str(v).strip() != ""]


def _pick_name(row: dict[str, Any]) -> str:
    for k in _name_keys(row):
        val = str(row.get(k) or "").strip()
        if val:
            return val
    return ""


def _bucket(label: str) -> str:
    """按展示名（注释）分桶，用于口头汇报结构；不是用户意图路由。"""
    s = str(label or "")
    if any(h in s for h in ("姓名", "性别", "出生", "民族", "地址", "年龄", "婚姻")):
        return "profile"
    if any(h in s for h in ("身高", "体重", "腰围", "心率", "血压", "收缩", "舒张", "血糖", "体温", "血氧")):
        return "vital"
    if any(h in s for h in ("报告", "服务", "医生", "检测", "项目", "护理", "时间", "日期")):
        return "service"
    return "other"


def _join_pairs(items: list[tuple[str, Any]], *, limit: int = 12) -> str:
    return "；".join(f"{k} {v}" for k, v in items[:limit])


def suggest_followups(question: str, rows: list[dict[str, Any]]) -> list[str]:
    """确定性后续建议（基于结果字段形态，不调 LLM）。"""
    _ = question
    if not rows:
        return ["放宽筛选条件再查一次", "换个人名或时间范围试试", "看看这张表还有哪些可展示字段"]
    row = rows[0]
    keys = [str(k) for k in row.keys()]
    name = _pick_name(row)
    out: list[str] = []
    if name:
        out.append(f"{name}最近几次同类记录")
    if any(any(h in k for h in ("血压", "心率", "身高", "体重")) for k in keys):
        out.append(f"{name}的体征指标对比" if name else "把体征指标做个对比")
    if any(any(h in k for h in ("检测", "项目", "服务")) for k in keys):
        out.append("同项目还有哪些人做过")
    if len(rows) >= 2:
        out.append("按时间画成趋势图")
    else:
        out.append("把结果画成图表")
    # 去重保序
    seen: set[str] = set()
    uniq: list[str] = []
    for s in out:
        s = str(s or "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        uniq.append(s)
    return uniq[:3]


def format_answer(
    question: str,
    rows: list[dict[str, Any]],
    sql: str,
    *,
    empty_note: str = "",
) -> str:
    n = len(rows)
    if n == 0:
        return empty_note or (
            "按这条查询在库里查到 0 行。可能是库中确实没有匹配记录，或过滤条件过严。"
            "没有编造数据；请核对 SQL。"
        )

    tips = suggest_followups(question, rows)
    tip_block = ""
    if tips:
        tip_block = "\n\n你可以接着问：\n" + "\n".join(f"· {t}" for t in tips)

    if n == 1 and len(rows[0]) == 1:
        key = next(iter(rows[0].keys()))
        val = rows[0][key]
        if _is_count_key(str(key)):
            return f"一共查到 {val} 条。" + tip_block
        return f"{key}：{val}" + tip_block

    if n == 1:
        row = rows[0]
        items = _nonempty_items(row)
        if not items:
            return "查到 1 条记录，但展示字段均为空。" + tip_block
        name = _pick_name(row)
        lead = f"已查到「{name}」的 1 条记录。" if name else "已查到 1 条记录。"
        buckets: dict[str, list[tuple[str, Any]]] = {"profile": [], "service": [], "vital": [], "other": []}
        for k, v in items:
            if name and k in _name_keys(row):
                continue
            buckets[_bucket(k)].append((k, v))
        parts: list[str] = [lead]
        if buckets["profile"]:
            parts.append("基本信息：" + _join_pairs(buckets["profile"]) + "。")
        if buckets["service"]:
            parts.append("检测与服务：" + _join_pairs(buckets["service"]) + "。")
        if buckets["vital"]:
            parts.append("主要体征：" + _join_pairs(buckets["vital"]) + "。")
        if buckets["other"]:
            parts.append("其它：" + _join_pairs(buckets["other"]) + "。")
        parts.append("完整字段见下方一览。")
        return "\n".join(parts) + tip_block

    name_keys = _name_keys(rows[0])
    if name_keys:
        names = [str(r.get(name_keys[0]) or "").strip() for r in rows]
        names = [x for x in names if x]
        if names:
            other = [k for k in rows[0].keys() if k != name_keys[0]]
            bits: list[str] = []
            for r in rows[:8]:
                nm = str(r.get(name_keys[0]) or "").strip()
                extras = [
                    f"{k} {r.get(k)}"
                    for k in other[:3]
                    if r.get(k) is not None and str(r.get(k)).strip() != ""
                ]
                bits.append(f"{nm}（{'；'.join(extras)}）" if extras else nm)
            more = f"等，共 {n} 条" if n > 8 else f"共 {n} 条"
            body = f"已整理 {more}：\n" + "\n".join(f"· {b}" for b in bits)
            return body + "\n完整名单见下方表格。" + tip_block

    preview_bits = []
    for r in rows[:5]:
        items = _nonempty_items(r)[:4]
        if items:
            preview_bits.append("；".join(f"{k} {v}" for k, v in items))
    preview = "\n".join(f"· {b}" for b in preview_bits) if preview_bits else ""
    head = f"查询完成，共 {n} 行。"
    if n > 5:
        head += "下面先摘前 5 条："
    return (head + ("\n" + preview if preview else "") + "\n完整结果见下方表格。") + tip_block
