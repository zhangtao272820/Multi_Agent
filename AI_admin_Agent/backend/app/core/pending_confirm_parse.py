"""HITL 口令解析（纯函数）：确认/取消 + action_id。"""
from __future__ import annotations

import re
from typing import Any


def extract_direct_confirmation(user_message: str) -> dict[str, Any]:
    """
    明确确认指令：确认 12 / 取消[12] / confirm 3
    整句须以确认/取消开头，避免「待确认」「请确认后再发」误匹配。
    """
    text = (user_message or "").strip()
    if not text:
        return {"is_confirmation": False, "decision": "", "action_id": 0}
    m = re.match(
        r"^(确认|取消|confirm|cancel)\s*\[?\s*(\d+)\s*\]?\s*[。.!！]?$",
        text,
        re.IGNORECASE,
    )
    if not m:
        return {"is_confirmation": False, "decision": "", "action_id": 0}
    raw_decision = (m.group(1) or "").strip().lower()
    action_id = int(m.group(2))
    if raw_decision in ("confirm", "确认"):
        decision = "确认"
    elif raw_decision in ("cancel", "取消"):
        decision = "取消"
    else:
        decision = ""
    return {
        "is_confirmation": bool(decision and action_id > 0),
        "decision": decision,
        "action_id": action_id,
    }


def detect_confirmation_without_id(user_message: str) -> dict[str, Any]:
    """
    裸确认意图（无编号）：「确认」「取消一下」。
    不得匹配「待确认」「请改写…」等长句。
    """
    text = (user_message or "").strip()
    if not text:
        return {"is_confirmation_intent": False, "decision": ""}
    if len(text) > 24:
        return {"is_confirmation_intent": False, "decision": ""}
    m = re.match(
        r"^(确认|取消|confirm|cancel)(\s*(一下|下|吧|了|操作|执行|发送)?)?[。.!！]*$",
        text,
        re.IGNORECASE,
    )
    if not m:
        return {"is_confirmation_intent": False, "decision": ""}
    raw = (m.group(1) or "").strip().lower()
    decision = "确认" if raw in ("确认", "confirm") else "取消"
    return {"is_confirmation_intent": True, "decision": decision}
