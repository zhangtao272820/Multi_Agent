"""Manager-compatible agentResult envelope (agent=code)."""

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
    usage: dict[str, Any]


def classify_code_error(error: Any) -> str:
    msg = str(getattr(error, "message", None) or error or "").lower()
    if any(x in msg for x in ("timeout", "timed out", "aborted", "deadline")):
        return "timeout"
    if any(x in msg for x in ("tool_round_limit", "max tool rounds", "recursion limit")):
        return "tool_round_limit"
    if "http_5xx" in msg or "internal server" in msg:
        return "http_5xx"
    return "business"


def build_code_fail_agent_result(
    *,
    error_code: str,
    answer: str = "",
    trace_id: str | None = None,
    ms: int | None = None,
    structured: dict[str, Any] | None = None,
) -> AgentResult:
    return {
        "ok": False,
        "agent": "code",
        "trace_id": trace_id or "",
        "answer": answer or "",
        "structured": structured or {},
        "error_code": str(error_code or "business"),
        "latency_ms": ms or 0,
    }


def build_code_compute_agent_result(
    *,
    answer: str,
    trace_id: str | None = None,
    ms: int | None = None,
    task_kind: str = "compute",
    error_code: str | None = None,
    usage: dict[str, Any] | None = None,
    extra_structured: dict[str, Any] | None = None,
) -> AgentResult:
    text = str(answer or "")
    ok = bool(text.strip()) and not error_code
    structured: dict[str, Any] = {"task_kind": task_kind or "compute", "ms": ms}
    if extra_structured:
        structured.update(extra_structured)
    result: AgentResult = {
        "ok": ok,
        "agent": "code",
        "answer": text,
        "structured": structured,
        "latency_ms": ms or 0,
    }
    if trace_id:
        result["trace_id"] = trace_id
    if not ok:
        result["error_code"] = error_code or "empty_result"
    if usage:
        result["usage"] = usage
    return result


def build_code_edit_agent_result(
    *,
    answer: str,
    trace_id: str | None = None,
    ms: int | None = None,
    task_kind: str = "edit",
    files_touched: list[str] | None = None,
    validate_ok: bool | None = None,
    unified_diff: str | None = None,
) -> AgentResult:
    text = str(answer or "")
    structured: dict[str, Any] = {
        "task_kind": task_kind,
        "ms": ms,
        "files_touched": files_touched or [],
    }
    if validate_ok is not None:
        structured["validate_ok"] = validate_ok
    if unified_diff:
        structured["unified_diff"] = unified_diff[:8000]
    return {
        "ok": bool(text.strip()),
        "agent": "code",
        "trace_id": trace_id or "",
        "answer": text,
        "structured": structured,
        "latency_ms": ms or 0,
        "sources": [{"type": "doc", "ref": p} for p in (files_touched or [])[:12]],
    }
