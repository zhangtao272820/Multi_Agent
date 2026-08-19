from __future__ import annotations

from typing import Any


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
    if n == 1 and len(rows[0]) == 1:
        key = next(iter(rows[0].keys()))
        val = rows[0][key]
        if key.lower() in {"count", "cnt", "total", "n"} or "count" in key.lower() or key in {"数量", "人数"}:
            return f"共 {val} 条。"
        return f"{key}：{val}"

    name_keys = [
        k
        for k in rows[0].keys()
        if k.lower() in {"name", "title", "usertruename", "username", "studenttruename"}
        or k in {"姓名", "学生姓名", "名称"}
    ]
    if name_keys:
        names = [str(r.get(name_keys[0]) or "").strip() for r in rows]
        names = [x for x in names if x]
        if names:
            extra = ""
            other = [k for k in rows[0].keys() if k != name_keys[0]]
            if other and all(r.get(other[0]) is not None for r in rows[: min(4, n)]):
                extra = "；".join(
                    f"{str(r.get(name_keys[0]) or '')}（{other[0]}={r.get(other[0])}）" for r in rows[:12]
                )
                return f"共 {n} 条：{extra}"
            return f"共 {n} 条：{'、'.join(names[:30])}"
    q = str(question or "")
    if "分别" in q or "哪些" in q:
        preview = "；".join(
            "，".join(f"{k}={v}" for k, v in r.items()) for r in rows[:12]
        )
        return f"共 {n} 条。{preview}"
    return f"查询完成，返回 {n} 行。完整结果见下方表格。"
