"""WS helpers."""

from __future__ import annotations

import json
from typing import Any


def ws_msg(msg_type: str, payload: Any = None) -> str:
    return json.dumps({"type": msg_type, "payload": payload}, ensure_ascii=False)


def ws_event(msg_type: str, **extra: Any) -> str:
    """Code agent UI/Manager events sometimes put fields at top level (e.g. agent_edit_preview)."""
    data = {"type": msg_type, **extra}
    return json.dumps(data, ensure_ascii=False)
