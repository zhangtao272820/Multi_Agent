from __future__ import annotations

from typing import Any

from app.scenes import Scene


def infer_chart(rows: list[dict[str, Any]], scene: Scene) -> dict[str, Any] | None:
    if not scene.allow_chart or not rows or len(rows) < 2:
        return None
    keys = list(rows[0].keys())
    if len(keys) < 2:
        return None
    label_key = None
    value_key = None
    for k in keys:
        sample = [r.get(k) for r in rows[:12]]
        if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in sample if v is not None):
            if value_key is None:
                value_key = k
        elif label_key is None:
            label_key = k
    if not label_key or not value_key:
        return None
    points = []
    for r in rows[:20]:
        lab = r.get(label_key)
        val = r.get(value_key)
        if lab is None or val is None:
            continue
        try:
            points.append({"label": str(lab), "value": float(val)})
        except (TypeError, ValueError):
            continue
    if len(points) < 2:
        return None
    chart_type = "bar"
    labels = [p["label"] for p in points]
    if _looks_temporal(label_key, labels):
        chart_type = "line"
    elif len(points) <= 6:
        chart_type = "pie"
    return {"type": chart_type, "label_key": label_key, "value_key": value_key, "points": points}


def _looks_temporal(key: str, labels: list[str]) -> bool:
    blob = str(key or "")
    if any(tok in blob for tok in ("年", "日期", "date", "year", "月", "time", "时间")):
        return True
    hits = 0
    for lab in labels[:8]:
        s = str(lab)
        if s[:4].isdigit() and int(s[:4]) >= 1900:
            hits += 1
        elif len(s) >= 8 and s[4] in "-/" and s[:4].isdigit():
            hits += 1
    return hits >= 2
