"""Manager-compatible agentResult envelope (agent=crawler)."""

from __future__ import annotations

from typing import Any, TypedDict


class AgentSource(TypedDict):
    type: str
    ref: str


class AgentResult(TypedDict, total=False):
    ok: bool
    agent: str
    trace_id: str
    answer: str
    sources: list[AgentSource]
    structured: dict[str, Any]
    needs_clarify: bool
    clarify_questions: list[str]
    error_code: str
    latency_ms: int


def build_crawler_agent_result(
    *,
    items: list[dict[str, Any]] | None = None,
    output_content: str = "",
    status: str = "ok",
    trace_id: str | None = None,
    latency_ms: int | None = None,
    serp_fallback: bool = False,
    meta: dict[str, Any] | None = None,
    failure_tags: list[str] | None = None,
    error_code: str | None = None,
    needs_clarify: bool = False,
) -> AgentResult:
    items = items or []
    sources: list[AgentSource] = []
    seen: set[str] = set()
    for it in items:
        url = str(it.get("url") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        sources.append({"type": "url", "ref": url})

    answer = (output_content or "").strip()
    item_count = len(items)
    status_l = (status or "").lower()
    ok = status_l == "ok" or bool(sources) or bool(answer)
    if needs_clarify is False and status_l == "needs_clarification":
        needs_clarify = True
    if not ok and item_count == 0 and not answer:
        needs_clarify = True

    structured: dict[str, Any] = {
        "content_trust": "untrusted",
        "content_trust_source": "crawler",
        "itemCount": item_count,
        "status": status,
    }
    meta = meta or {}
    if serp_fallback:
        structured["serp_fallback"] = True
    for k in (
        "seed_first",
        "manager_seed_count",
        "cloud_scrape_calls",
        "playwright_mcp_calls",
        "extract_path",
        "llm_extract_calls",
    ):
        if meta.get(k) is not None:
            structured[k] = meta[k]
    if failure_tags:
        structured["failure_tags"] = failure_tags

    result: AgentResult = {
        "ok": ok,
        "agent": "crawler",
        "structured": structured,
    }
    if trace_id:
        result["trace_id"] = trace_id
    if answer:
        result["answer"] = answer
    if sources:
        result["sources"] = sources
    if needs_clarify:
        result["needs_clarify"] = True
    if latency_ms is not None:
        result["latency_ms"] = latency_ms
    if not ok:
        result["error_code"] = error_code or "CRAWLER_EMPTY"
    return result
