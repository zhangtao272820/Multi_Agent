"""Unified task runner for HTTP compute / WS agent-chat / MCP."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from app.protocol.incoming import parse_manager_task, resolve_task_kind
from app.runtime.compute import run_compute
from app.runtime.edit_loop import run_edit_loop

SendFn = Callable[[dict[str, Any]], Awaitable[None] | None]


async def run_code_task(
    *,
    message: str,
    manager_task: str | dict[str, Any] | None = None,
    mode: str | None = None,
    root: str | None = None,
    trace_id: str | None = None,
    auto_apply: bool = False,
    send: SendFn | None = None,
) -> dict[str, Any]:
    manager = parse_manager_task(manager_task)
    kind = resolve_task_kind(manager=manager, mode=mode)

    async def emit_delta(d: str) -> None:
        if send:
            r = send({"type": "delta", "payload": d})
            if hasattr(r, "__await__"):
                await r  # type: ignore[misc]

    if kind == "compute":
        result = await run_compute(
            message=message,
            manager_task=manager_task,
            trace_id=trace_id,
            emit_delta=emit_delta if send else None,
        )
        if send:
            meta = result.get("meta") or {"task_kind": "compute"}
            r1 = send({"type": "meta", "payload": meta})
            if hasattr(r1, "__await__"):
                await r1  # type: ignore[misc]
            if not result.get("ok") and result.get("answer") == "":
                err = (result.get("meta") or {}).get("error") or result.get("error_code") or "compute failed"
                r2 = send({"type": "error", "payload": str(err)})
                if hasattr(r2, "__await__"):
                    await r2  # type: ignore[misc]
            r3 = send({"type": "done"})
            if hasattr(r3, "__await__"):
                await r3  # type: ignore[misc]
        return result

    return await run_edit_loop(
        message=message,
        manager_task=manager_task,
        mode=mode,
        root=root,
        trace_id=trace_id,
        auto_apply=auto_apply,
        send=send,
    )
