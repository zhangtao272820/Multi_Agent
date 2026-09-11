from __future__ import annotations

import re
from typing import Any

_URL_RE = re.compile(r"https?://[^\s)\]>\"']+", re.I)


def _urls_from_text(text: str) -> list[dict[str, str]]:
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for m in _URL_RE.findall(str(text or "")):
        ref = m.rstrip(".,;:!?)")
        if not ref or ref in seen:
            continue
        seen.add(ref)
        out.append({"type": "url", "ref": ref})
    return out


def _pick_answer(payload: dict[str, Any] | None) -> str:
    if not payload:
        return ""
    if isinstance(payload.get("agent_reply"), str) and str(payload["agent_reply"]).strip():
        return str(payload["agent_reply"]).strip()
    for key in ("answer", "description", "summary", "transcript", "ocr_text"):
        val = str(payload.get(key) or "").strip()
        if val:
            return val
    result = payload.get("result")
    if isinstance(result, dict):
        return _pick_answer(result)
    if isinstance(result, str) and result.strip():
        return result.strip()
    return ""


def _normalize_entities(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    for item in raw[:12]:
        if isinstance(item, str):
            name = item.strip()[:64]
            if name:
                out.append({"name": name})
            continue
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("label") or item.get("text") or "").strip()[:64]
        if not name:
            continue
        kind = str(item.get("kind") or item.get("type") or "").strip()[:32]
        out.append({"name": name, **({"kind": kind} if kind else {})})
    return out


def _normalize_metrics(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    for item in raw[:16]:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("label") or item.get("key") or "").strip()[:64]
        value = str(item.get("value") or item.get("val") or item.get("amount") or "").strip()[:48]
        if not name or not value:
            continue
        unit = str(item.get("unit") or "").strip()[:16]
        out.append({"name": name, "value": value, **({"unit": unit} if unit else {})})
    return out


def build_multimodal_agent_result(
    payload: dict[str, Any] | None,
    *,
    trace_id: str | None = None,
    latency_ms: int | None = None,
    media_type: str | None = None,
) -> dict[str, Any]:
    row = payload if isinstance(payload, dict) else {}
    nested = row.get("raw") if isinstance(row.get("raw"), dict) else {}
    merged = {**nested, **row}
    answer = _pick_answer(row)
    sources = _urls_from_text(answer)
    fp = str(row.get("file_path") or "").strip()
    if fp:
        sources.append({"type": "doc", "ref": fp})
    ok = bool(answer)
    entities = _normalize_entities(merged.get("entities") or merged.get("entity_list"))
    metrics = _normalize_metrics(merged.get("metrics") or merged.get("indicators"))
    ocr = str(
        merged.get("ocr_text")
        or merged.get("ocr_snippet")
        or merged.get("transcript")
        or ""
    ).strip()[:240]
    conf_raw = merged.get("confidence")
    try:
        confidence = float(conf_raw) if conf_raw is not None else None
    except (TypeError, ValueError):
        confidence = None
    structured: dict[str, Any] = {
        "media_type": media_type or str(row.get("media_type") or ""),
        "action": str(row.get("action") or "understand"),
        "entities": entities,
        "metrics": metrics,
        "ocr_text_digest": ocr,
        "raw": row,
    }
    if confidence is not None:
        structured["confidence"] = max(0.0, min(1.0, confidence))
    return {
        "ok": ok,
        "agent": "multimodal",
        "trace_id": trace_id or None,
        "answer": answer or None,
        "sources": sources or None,
        "structured": structured,
        "error_code": None if ok else "empty_result",
        "latency_ms": latency_ms,
    }
