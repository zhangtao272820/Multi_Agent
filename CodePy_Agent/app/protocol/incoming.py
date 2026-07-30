"""Parse managerTask / manager_task_json for Code paths."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


VALID_KINDS = frozenset({"compute", "inspect", "edit", "script", "auto"})


@dataclass
class ManagerCodeTask:
    source: str = ""
    task_kind: str = "auto"
    refined_question: str = ""
    upstream_context: str = ""
    upstream_facts: list[dict[str, Any]] = field(default_factory=list)
    must_outputs: list[str] = field(default_factory=list)
    hint_files: list[str] = field(default_factory=list)
    write_allowed: bool | None = None
    root: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


def _as_list_str(v: Any) -> list[str]:
    if not isinstance(v, list):
        return []
    out: list[str] = []
    for x in v:
        s = str(x or "").strip()
        if s:
            out.append(s)
    return out


def _normalize_kind(raw: Any) -> str:
    k = str(raw or "").strip().lower()
    if k in VALID_KINDS:
        return k
    return "auto"


def parse_manager_task(raw: str | dict[str, Any] | None) -> ManagerCodeTask:
    if raw is None or raw == "":
        return ManagerCodeTask()
    data: Any = raw
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return ManagerCodeTask()
    if not isinstance(data, dict):
        return ManagerCodeTask()

    # envelope v2 unwrap
    if "payload" in data and isinstance(data.get("payload"), dict):
        inner = data["payload"]
        if isinstance(inner.get("data"), dict):
            data = {**data, **inner["data"]}
        else:
            data = {**data, **inner}

    facts_raw = data.get("upstream_facts") or data.get("structured_facts") or data.get("facts")
    facts: list[dict[str, Any]] = []
    if isinstance(facts_raw, list):
        for f in facts_raw:
            if isinstance(f, dict):
                facts.append(f)

    return ManagerCodeTask(
        source=str(data.get("source") or "").strip(),
        task_kind=_normalize_kind(data.get("task_kind") or data.get("taskKind") or data.get("code_mode")),
        refined_question=str(
            data.get("refined_question") or data.get("refined_task") or data.get("question") or ""
        ).strip(),
        upstream_context=str(data.get("upstream_context") or data.get("upstreamContext") or "").strip(),
        upstream_facts=facts,
        must_outputs=_as_list_str(data.get("must_outputs") or data.get("mustOutputs")),
        hint_files=_as_list_str(data.get("hint_files") or data.get("hintFiles")),
        write_allowed=None if data.get("write_allowed") is None else bool(data.get("write_allowed")),
        root=str(data.get("root") or "").strip(),
        raw=data,
    )


def resolve_task_kind(
    *,
    manager: ManagerCodeTask,
    mode: str | None = None,
    explicit: str | None = None,
) -> str:
    for cand in (explicit, manager.task_kind, mode):
        k = _normalize_kind(cand)
        if k != "auto":
            return k
    if manager.upstream_context or manager.upstream_facts:
        return "compute"
    if str(mode or "").lower() in ("ask", "inspect"):
        return "inspect"
    if str(mode or "").lower() in ("edit", "agent"):
        return "edit"
    return "inspect"
