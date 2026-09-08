"""Manager-facing contracts: Envelope v2, turn_scope, AgentResult, service auth."""
from __future__ import annotations

import hmac
import json
import os
from dataclasses import dataclass, field
from typing import Any

from app.settings import get_settings

TURN_SCOPE_MODES = ("current_only", "continuation", "topic_shift", "chitchat")
TURN_KINDS = ("new_task", "continuation", "output_followup", "slot_answer", "chitchat")


def normalize_experience_question_key(question: str, max_len: int = 120) -> str:
    return (
        str(question or "")
        .strip()
        .lower()
        .replace(" ", "")
        .translate(str.maketrans("", "", "，,。.;；:：!?？"))
    )[:max_len]


@dataclass
class TurnScope:
    mode: str = "current_only"
    turn_kind: str = ""
    suppress_history: bool = True
    suppress_anchor: bool = True
    suppress_experience_replay: bool = True
    narrow_output_followup: bool = False


def parse_turn_scope(raw: Any) -> TurnScope | None:
    if not isinstance(raw, dict):
        return None
    mode = str(raw.get("mode") or "").strip()
    if mode not in TURN_SCOPE_MODES:
        return None
    kind = str(raw.get("turn_kind") or raw.get("turnKind") or "").strip()
    suppress_history = bool(raw.get("suppress_history", mode != "continuation"))
    suppress_anchor = bool(raw.get("suppress_anchor", True))
    suppress_xp = bool(raw.get("suppress_experience_replay", True))
    return TurnScope(
        mode=mode,
        turn_kind=kind if kind in TURN_KINDS else "",
        suppress_history=suppress_history,
        suppress_anchor=suppress_anchor,
        suppress_experience_replay=suppress_xp,
        narrow_output_followup=bool(raw.get("narrow_output_followup")),
    )


@dataclass
class ManagerDbTask:
    source: str = ""
    refined_question: str = ""
    must_filters: list[str] = field(default_factory=list)
    schema_search_keywords: str = ""
    hint_tables: list[str] = field(default_factory=list)
    hint_fields: list[str] = field(default_factory=list)
    turn_scope: TurnScope | None = None
    write_allowed: bool = False
    confirm_token: str = ""
    pending_id: str = ""
    impact_ack: bool = False
    verify_sql: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def is_manager(self) -> bool:
        return self.source == "manager"


def _as_str_list(v: Any) -> list[str]:
    if not isinstance(v, list):
        return []
    return [str(x).strip() for x in v if str(x).strip()]


def parse_manager_task(raw: str | dict[str, Any] | None) -> ManagerDbTask:
    if raw is None or raw == "":
        return ManagerDbTask()
    data: Any = raw
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return ManagerDbTask()
    if not isinstance(data, dict):
        return ManagerDbTask()
    if "payload" in data and isinstance(data.get("payload"), dict):
        inner = data["payload"]
        if isinstance(inner.get("data"), dict):
            data = {**data, **inner["data"]}
        else:
            data = {**data, **inner}
    scope = parse_turn_scope(data.get("turn_scope"))
    return ManagerDbTask(
        source=str(data.get("source") or "").strip(),
        refined_question=str(
            data.get("refined_question")
            or data.get("refined_task")
            or data.get("question")
            or data.get("utterance")
            or ""
        ).strip(),
        must_filters=_as_str_list(data.get("must_filters")),
        schema_search_keywords=str(data.get("schema_search_keywords") or "").strip(),
        hint_tables=_as_str_list(data.get("hint_tables")),
        hint_fields=_as_str_list(data.get("hint_fields")),
        turn_scope=scope,
        write_allowed=bool(data.get("write_allowed")),
        confirm_token=str(data.get("confirm_token") or "").strip(),
        pending_id=str(data.get("pending_id") or "").strip(),
        impact_ack=bool(data.get("impact_ack")),
        verify_sql=str(data.get("verify_sql") or "").strip(),
        raw=data,
    )


def last_user_message(messages: list[dict[str, Any]] | None, fallback: str = "") -> str:
    if not messages:
        return str(fallback or "").strip()
    for m in reversed(messages):
        if str(m.get("role") or "") == "user":
            return str(m.get("content") or "").strip()
    return str(fallback or "").strip()


def resolve_service_token() -> str:
    s = get_settings()
    return str(
        s.agent_service_token
        or os.getenv("AGENT_SERVICE_TOKEN")
        or s.clawhive_internal_token
        or os.getenv("CLAWHIVE_INTERNAL_TOKEN")
        or s.agent_internal_token
        or os.getenv("AGENT_INTERNAL_TOKEN")
        or s.manager_ops_token
        or os.getenv("MANAGER_OPS_TOKEN")
        or ""
    ).strip()


def resolve_auth_mode() -> str:
    raw = str(os.getenv("AGENT_SERVICE_AUTH") or get_settings().agent_service_auth or "").strip().lower()
    if raw in {"0", "false", "off", "no"}:
        return "off"
    if raw in {"1", "true", "on", "yes", "require", "required"}:
        return "require"
    if raw == "optional":
        return "optional"
    prof = str(os.getenv("AGENT_SECURITY_PROFILE") or os.getenv("MANAGER_SECURITY_MODE") or "").strip().lower()
    if prof in {"enterprise", "prod", "production", "strict", "fail_closed", "fail-closed"}:
        return "require"
    token = resolve_service_token()
    return "optional" if token else "off"


def header_get(headers: dict[str, Any] | None, name: str) -> str:
    if not headers:
        return ""
    want = name.lower()
    for k, v in headers.items():
        if str(k).lower() == want:
            return str(v or "").strip()
    return ""


def _safe_eq(a: str, b: str) -> bool:
    try:
        return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
    except Exception:
        return False


def verify_agent_service_auth(headers: dict[str, Any] | None) -> tuple[bool, str]:
    mode = resolve_auth_mode()
    if mode == "off":
        return True, ""
    expected = resolve_service_token()
    if not expected:
        if mode == "require":
            return False, "agent_service_token_not_configured"
        return True, ""
    got = (
        header_get(headers, "x-agent-service-token")
        or header_get(headers, "x-clawhive-internal-token")
        or header_get(headers, "x-internal-token")
    )
    if not got:
        return False, "agent_service_token_missing"
    if not _safe_eq(got, expected):
        return False, "agent_service_token_invalid"
    return True, ""


def has_internal_service_header(headers: dict[str, Any] | None) -> bool:
    return bool(
        header_get(headers, "x-agent-service-token")
        or header_get(headers, "x-clawhive-internal-token")
        or header_get(headers, "x-internal-token")
    )


def is_manager_request(
    *,
    headers: dict[str, Any] | None = None,
    messages: list[dict[str, Any]] | None = None,
    mgr: ManagerDbTask | None = None,
    force_manager: bool = False,
) -> bool:
    """Manager dbClient: messages + dbId + protocol/auth headers; standalone UI sends question only."""
    if force_manager:
        return True
    if mgr and mgr.source == "manager":
        return True
    if has_internal_service_header(headers):
        return True
    proto = header_get(headers, "x-agent-protocol").strip().lower()
    if proto in {"2", "v2"}:
        return True
    return bool(messages)


def mcp_token_ok(headers: dict[str, Any] | None) -> bool:
    expected = str(get_settings().vanna_mcp_token or os.getenv("VANNA_MCP_TOKEN") or "").strip()
    if not expected:
        return True
    got = header_get(headers, "x-vanna-mcp-token") or header_get(headers, "authorization")
    if got.lower().startswith("bearer "):
        got = got[7:].strip()
    return bool(got) and _safe_eq(got, expected)


def build_db_agent_result(
    *,
    answer: str,
    empty: bool = False,
    reason: str = "ok",
    trace_id: str = "",
    needs_clarify: bool = False,
    clarify: str = "",
    executed_sql: str = "",
    error_code: str = "",
    path: str = "",
    latency_ms: int = 0,
    usage: dict[str, Any] | None = None,
    tables: list[str] | None = None,
    rows: list[dict[str, Any]] | None = None,
    field_details: list[dict[str, str]] | None = None,
    experience_hits: int = 0,
    needs_human_confirm: bool = False,
    pending_actions: list[dict[str, Any]] | None = None,
    pending_id: str = "",
    impact_estimate: dict[str, Any] | None = None,
    chart: Any = None,
    deliverables: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if needs_clarify:
        code = error_code or "needs_clarify"
    elif empty:
        # 成功执行但 0 行：业务空结果，不是 Agent 故障
        code = error_code or "empty_result"
    elif error_code:
        code = error_code
    elif reason and reason not in {"ok", "clarify", "chitchat", ""}:
        code = error_code or "business"
    else:
        code = error_code
    # empty_result alone → ok=true（保留 structured.empty / error_code 供证据）
    # pending HITL 也是 ok=true（未失败，等待确认）
    failed = bool(needs_clarify) or bool(code and code != "empty_result" and not needs_human_confirm)
    structured: dict[str, Any] = {
        "empty": empty,
        "reason": reason or ("empty_result" if empty else "ok"),
    }
    if path:
        structured["path"] = path
    if code:
        structured["error_code"] = code
    if executed_sql:
        structured["executed_sql"] = executed_sql
    if needs_human_confirm:
        structured["needs_human_confirm"] = True
    if pending_id:
        structured["pending_id"] = pending_id
    if pending_actions:
        structured["pending_actions"] = pending_actions
    impact = impact_estimate
    if not impact and pending_actions:
        for row in pending_actions:
            if isinstance(row, dict) and isinstance(row.get("impact_estimate"), dict):
                impact = row["impact_estimate"]
                break
    if impact:
        structured["impact_estimate"] = impact
    if tables:
        structured["tables"] = tables[:12]
    if rows:
        structured["rows"] = rows[:30]
    if field_details:
        structured["field_details"] = field_details[:12]
    if chart is not None:
        structured["chart"] = chart
    if deliverables:
        structured["deliverables"] = {
            "need_chart": bool(deliverables.get("need_chart")),
            "need_interpret": bool(deliverables.get("need_interpret")),
            "sys_meta": bool(deliverables.get("sys_meta")),
        }
    structured["evolutionApplied"] = {
        "promptPatches": 0,
        "experienceHits": max(0, int(experience_hits)),
    }
    result: dict[str, Any] = {
        "ok": not failed,
        "agent": "db",
        "trace_id": trace_id or "",
        "answer": answer or "",
        "structured": structured,
        "needs_clarify": needs_clarify,
        "latency_ms": latency_ms,
    }
    if needs_clarify and clarify:
        result["clarify_questions"] = [clarify]
    if code:
        result["error_code"] = code
    if usage:
        result["usage"] = usage
    return result
