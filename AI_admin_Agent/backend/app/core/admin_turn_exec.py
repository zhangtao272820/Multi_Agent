"""Admin 整轮执行超时与线程卸载（避免同步 LangGraph 卡死 uvicorn 事件循环）。"""
from __future__ import annotations

import os
from typing import Any, Callable

from app.core.admin_turn_cancel import AdminTurnCancelToken, bind_admin_turn_cancel


def admin_ws_turn_timeout_sec() -> float:
    """单轮 WS/HTTP 图执行上限（秒）。默认 90s，可用 ADMIN_WS_TURN_TIMEOUT_SEC 覆盖。"""
    raw = os.getenv("ADMIN_WS_TURN_TIMEOUT_SEC") or os.getenv("ADMIN_TURN_TIMEOUT_SEC") or "90"
    try:
        sec = float(raw)
    except (TypeError, ValueError):
        sec = 90.0
    return max(15.0, min(300.0, sec))


def run_agent_graph_stream(
    agent_graph: Any,
    initial_state: dict[str, Any],
    stream_kwargs: dict[str, Any],
    *,
    on_thought: Callable[[str], None] | None = None,
    on_node: Callable[[str], None] | None = None,
    cancel_token: AdminTurnCancelToken | None = None,
) -> dict[str, Any]:
    """
    同步跑 LangGraph stream，供 asyncio.to_thread 调用。
    思考推送必须走 on_thought（线程安全），禁止在调用线程里 await。
    """
    if cancel_token is not None:
        bind_admin_turn_cancel(cancel_token)
    final_result = dict(initial_state)
    for output in agent_graph.stream(initial_state, **stream_kwargs):
        if cancel_token is not None and cancel_token.is_cancelled():
            break
        if not isinstance(output, dict):
            continue
        for node_name, state_delta in output.items():
            if on_node:
                try:
                    on_node(str(node_name))
                except Exception:
                    pass
            if not isinstance(state_delta, dict):
                continue
            thoughts = state_delta.get("thoughts")
            if on_thought and isinstance(thoughts, list):
                for thought in thoughts:
                    try:
                        on_thought(str(thought or ""))
                    except Exception:
                        pass
            final_result.update(state_delta)
        if cancel_token is not None and cancel_token.is_cancelled():
            break
    return final_result


def run_agent_graph_invoke(
    agent_graph: Any,
    initial_state: dict[str, Any],
    invoke_kwargs: dict[str, Any],
    *,
    cancel_token: AdminTurnCancelToken | None = None,
) -> dict[str, Any]:
    """同步 invoke，供 asyncio.to_thread 调用。"""
    if cancel_token is not None:
        bind_admin_turn_cancel(cancel_token)
    if cancel_token is not None and cancel_token.is_cancelled():
        return dict(initial_state)
    result = agent_graph.invoke(initial_state, **invoke_kwargs)
    return result if isinstance(result, dict) else dict(initial_state)
