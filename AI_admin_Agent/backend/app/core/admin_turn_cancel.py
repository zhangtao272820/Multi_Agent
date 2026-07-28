"""单轮取消标志：超时 / WS cancel 后禁止继续执行高风险写工具（堵住孤儿写入）。"""
from __future__ import annotations

import threading
from contextvars import ContextVar
from typing import Optional


class AdminTurnCancelToken:
    """可跨线程共享的取消令牌（ContextVar 存引用，主线程 set、工作线程读）。"""

    __slots__ = ("_event",)

    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    def is_cancelled(self) -> bool:
        return self._event.is_set()


_admin_turn_cancel: ContextVar[Optional[AdminTurnCancelToken]] = ContextVar(
    "admin_turn_cancel", default=None
)


def begin_admin_turn_cancel() -> AdminTurnCancelToken:
    token = AdminTurnCancelToken()
    _admin_turn_cancel.set(token)
    return token


def bind_admin_turn_cancel(token: AdminTurnCancelToken) -> None:
    """在工作线程入口绑定与主线程相同的取消令牌。"""
    _admin_turn_cancel.set(token)


def get_admin_turn_cancel() -> AdminTurnCancelToken | None:
    return _admin_turn_cancel.get()


def cancel_admin_turn() -> None:
    token = _admin_turn_cancel.get()
    if token is not None:
        token.cancel()


def clear_admin_turn_cancel() -> None:
    _admin_turn_cancel.set(None)


def is_admin_turn_cancelled() -> bool:
    token = _admin_turn_cancel.get()
    return bool(token and token.is_cancelled())
