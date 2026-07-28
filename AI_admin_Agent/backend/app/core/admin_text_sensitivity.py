"""
Admin 对中文、数字、时间表达的结构化敏感度。
仅用于检测/保真/续接判断，不从用户原话 regex 抽取业务槽位。
"""
from __future__ import annotations

import re
from typing import Any

# 时间相关结构信号（中英混合、半角全角数字）
_TIME_SIGNAL = re.compile(
    r"(?:"
    r"[\d０-９]{1,2}\s*[:：]\s*[\d０-９]{1,2}|"
    r"[\d０-９]{1,2}\s*点\s*[\d０-９]{0,2}\s*分?|"
    r"[\d０-９]{1,2}\s*点半|"
    r"[一二三四五六七八九十两〇零]+\s*点\s*[半一二三四五六七八九十两]?\s*分?|"
    r"上午|下午|晚上|中午|凌晨|傍晚|清晨|早间|晚间|"
    r"明天|后天|大后天|今天|今日|昨天|昨日|"
    r"下[个]?周[一二三四五六日天]|本?周[一二三四五六日天]|星期[一二三四五六日天]|"
    r"下[个]?月|本?月|[\d０-９]{1,2}\s*月\s*[\d０-９]{1,2}\s*[日号]|"
    r"[\d０-９]{1,2}\s*[日号](?!\s*元)|"
    r"tomorrow|today|tonight|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)|"
    r"this\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
    r"\d+\s*(?:am|pm|a\.m\.|p\.m\.|hours?|minutes?|mins?)"
    r")",
    re.I,
)

_NUMERIC_RUN = re.compile(r"[\d０-９]+|[一二三四五六七八九十百千万两〇零]+")


def normalize_fullwidth_digits(text: str) -> str:
    """全角数字 → 半角，便于后续时间模型解析。"""
    out: list[str] = []
    for ch in str(text or ""):
        if "\uff10" <= ch <= "\uff19":
            out.append(chr(ord(ch) - 0xFEE0))
        else:
            out.append(ch)
    return "".join(out)


def has_time_signal(text: str) -> bool:
    s = normalize_fullwidth_digits(str(text or "").strip())
    return bool(s and _TIME_SIGNAL.search(s))


def looks_like_time_answer(text: str) -> bool:
    """短回复是否像在补时间，避免多轮续接被误判为新意图。"""
    s = normalize_fullwidth_digits(str(text or "").strip())
    if not s or len(s) > 56:
        return False
    if has_time_signal(s):
        return True
    return bool(re.match(r"^(明|后|大后|本|下)?(天|周|星期|月)", s))


def extract_time_literal_span(text: str) -> str:
    """从用户原话截取含时间信号的最短片段（保留中文与数字原貌）。"""
    s = str(text or "").strip()
    if not s:
        return ""
    norm = normalize_fullwidth_digits(s)
    m = _TIME_SIGNAL.search(norm)
    if not m:
        return s[:80]
    start = max(0, m.start() - 8)
    end = min(len(s), m.end() + 12)
    return s[start:end].strip()


def numeric_literals_in(text: str) -> list[str]:
    return _NUMERIC_RUN.findall(normalize_fullwidth_digits(str(text or "")))


def preserve_slot_from_user(user_message: str, slot_value: str) -> str:
    """
    槽位保真：模型若丢掉用户原话中的关键数字，尝试补回。
    不覆盖模型已填且包含数字的内容。
    """
    raw = str(user_message or "").strip()
    val = str(slot_value or "").strip()
    if not raw:
        return val
    user_nums = numeric_literals_in(raw)
    if not user_nums:
        return val
    if val and any(n in val for n in user_nums):
        return val
    if not val and has_time_signal(raw):
        return extract_time_literal_span(raw)
    if not val and len(raw) <= 48:
        return raw
    missing = [n for n in user_nums if n not in val]
    if missing and val:
        return f"{val} {' '.join(missing[:2])}".strip()
    return val or raw


def enrich_time_and_literal_sensitivity(
    understanding: dict[str, Any] | None,
    user_message: str,
    dialogue: str = "",
) -> dict[str, Any]:
    """NLU 后处理：时间信号、中文/数字槽位保真。"""
    if not isinstance(understanding, dict):
        return understanding or {}

    msg = str(user_message or "").strip()
    dlg = str(dialogue or "").strip()
    anchor = f"{dlg}\n{msg}".strip() if dlg else msg
    intent = str(understanding.get("intent") or "")
    # 联系人增删查不走日程/待办时间强行解析，避免邮箱数字等误触发截止时间
    if intent == "联系人":
        understanding["has_time_reference"] = False
        understanding["time_expression"] = ""
        slots = dict(understanding.get("slots") or {})
        for key in ("contact_name", "contact_email", "contact_description"):
            if key in slots and msg and len(msg) <= 120:
                slots[key] = preserve_slot_from_user(msg, str(slots.get(key) or ""))
        understanding["slots"] = slots
        return understanding

    time_hit = has_time_signal(msg) or has_time_signal(anchor)

    if time_hit or intent in ("日程", "待办", "混合任务"):
        if time_hit:
            understanding["has_time_reference"] = True

        if not str(understanding.get("time_expression") or "").strip():
            if has_time_signal(msg):
                understanding["time_expression"] = extract_time_literal_span(msg)
            elif has_time_signal(anchor):
                understanding["time_expression"] = extract_time_literal_span(anchor)

        slots = dict(understanding.get("slots") or {})
        if intent in ("日程", "混合任务"):
            slots["start_time_expression"] = preserve_slot_from_user(
                msg, str(slots.get("start_time_expression") or "")
            )
            if not slots["start_time_expression"] and understanding.get("time_expression"):
                slots["start_time_expression"] = str(understanding["time_expression"])
        if intent in ("待办", "混合任务"):
            slots["task_due_time_expression"] = preserve_slot_from_user(
                msg, str(slots.get("task_due_time_expression") or "")
            )
        for key in ("event_title", "task_title", "email_subject", "city", "poi_keywords"):
            if key in slots and msg and len(msg) <= 64:
                slots[key] = preserve_slot_from_user(msg, str(slots.get(key) or ""))
        understanding["slots"] = slots

    return understanding
