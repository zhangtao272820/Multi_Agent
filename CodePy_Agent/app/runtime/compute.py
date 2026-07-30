"""Manager compute path: facts/context → structured JSON answer (no repo tools)."""

from __future__ import annotations

import json
import time
from typing import Any, Callable, Awaitable

from app.config import get_settings
from app.llm.dashscope import chat_stream_text, chat_text
from app.protocol.agent_result import (
    build_code_compute_agent_result,
    build_code_fail_agent_result,
    classify_code_error,
)
from app.protocol.incoming import ManagerCodeTask, parse_manager_task
from app.runtime.playbook import compute_system_prompt, compute_user_tail

EmitDelta = Callable[[str], Awaitable[None] | None]


def _format_facts(facts: list[dict[str, Any]]) -> str:
    if not facts:
        return ""
    return "结构化事实 facts[]（须全部写入输出 JSON 的 facts 字段）：\n" + json.dumps(
        facts, ensure_ascii=False, indent=2
    )


def build_compute_user_message(
    *,
    question: str,
    manager: ManagerCodeTask,
) -> str:
    parts = [f"任务：{question}"]
    ctx = manager.upstream_context
    facts_block = _format_facts(manager.upstream_facts)
    if ctx:
        parts.extend(["", "已知上下文：", ctx])
    if facts_block:
        parts.extend(["", facts_block])
    if ctx or facts_block:
        parts.extend(["", compute_user_tail()])
    return "\n".join(parts)


async def run_compute(
    *,
    message: str,
    manager_task: str | dict[str, Any] | None = None,
    trace_id: str | None = None,
    emit_delta: EmitDelta | None = None,
) -> dict[str, Any]:
    started = time.time()
    settings = get_settings()
    manager = parse_manager_task(manager_task)
    question = (manager.refined_question or message or "").strip()
    if not question:
        ms = int((time.time() - started) * 1000)
        return {
            "ok": False,
            "answer": "",
            "ms": ms,
            "meta": {"task_kind": "compute", "error": "empty message"},
            "agentResult": build_code_fail_agent_result(
                error_code="empty_result",
                answer="empty message",
                trace_id=trace_id,
                ms=ms,
                structured={"task_kind": "compute"},
            ),
            "trace_id": trace_id,
        }

    if not settings.openai_api_key:
        ms = int((time.time() - started) * 1000)
        return {
            "ok": False,
            "answer": "",
            "ms": ms,
            "meta": {"task_kind": "compute", "error": "Missing OPENAI_API_KEY"},
            "agentResult": build_code_fail_agent_result(
                error_code="business",
                answer="Missing OPENAI_API_KEY",
                trace_id=trace_id,
                ms=ms,
                structured={"task_kind": "compute"},
            ),
            "error_code": "business",
            "trace_id": trace_id,
        }

    system = compute_system_prompt(must_outputs=manager.must_outputs or None)
    user = build_compute_user_message(question=question, manager=manager)

    try:
        if emit_delta:
            text = await chat_stream_text(
                system=system,
                user=user,
                max_tokens=settings.llm_json_max_tokens,
                on_delta=emit_delta,
            )
        else:
            text = await chat_text(
                system=system,
                user=user,
                max_tokens=settings.llm_json_max_tokens,
            )
        ms = int((time.time() - started) * 1000)
        answer = (text or "").strip()
        ok = bool(answer)
        agent_result = build_code_compute_agent_result(
            answer=answer,
            trace_id=trace_id,
            ms=ms,
            task_kind="compute",
            error_code=None if ok else "empty_result",
        )
        return {
            "ok": ok,
            "answer": answer,
            "ms": ms,
            "meta": {
                "task_kind": "compute",
                "from_manager": manager.source.lower() == "manager",
            },
            "agentResult": agent_result,
            "trace_id": trace_id,
        }
    except Exception as e:  # noqa: BLE001
        ms = int((time.time() - started) * 1000)
        err = str(e)[:400]
        code = classify_code_error(e)
        return {
            "ok": False,
            "answer": "",
            "ms": ms,
            "meta": {"task_kind": "compute", "error": err},
            "agentResult": build_code_fail_agent_result(
                error_code=code,
                answer=err,
                trace_id=trace_id,
                ms=ms,
                structured={"task_kind": "compute"},
            ),
            "error_code": code,
            "trace_id": trace_id,
        }
