"""AgentResult 契约（与 docs/agent-contract.md 对齐）。"""

from __future__ import annotations

import re
from typing import Any

_URL_RE = re.compile(r"https?://[^\s)\]>\"']+", re.I)


def _urls_from_text(text: str) -> list[dict[str, str]]:
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for m in _URL_RE.findall(str(text or "")):
        ref = m.rstrip(".,;:!?)")
        if not ref or ref in seen:
            continue
        seen.add(ref)
        out.append({"type": "url", "ref": ref})
    return out


def _admin_needs_clarify(text: str) -> bool:
    return bool(
        re.search(
            r"请确认.*(时间|标题|会议)|补全.*(时间|标题)|请提供.*(时间|标题)|请指定.*(时间|标题|会议|名称)|需提供|请补充|后重试|请问.*(会议|内容|标题|时间)|遇到.{0,4}小问题",
            text,
            re.I,
        )
    )


def _admin_has_informational_content(text: str) -> bool:
    if len(text) < 10:
        return False
    return bool(
        re.search(
            r"分钟|号线|公里|米|站|气温|预报|湿度|风力|导航|步行|驾车|公交|地铁|从.+到|直达|换乘",
            text,
            re.I,
        )
    )


def build_admin_agent_result(
    answer: str,
    *,
    trace_id: str | None = None,
    latency_ms: int | None = None,
    needs_clarify: bool = False,
    clarify_questions: list[str] | None = None,
    error_code: str | None = None,
    structured: dict[str, Any] | None = None,
) -> dict[str, Any]:
    text = str(answer or "").strip()
    pending_actions = []
    if structured and isinstance(structured.get("pending_actions"), list):
        pending_actions = structured["pending_actions"]
    needs_human_confirm = bool(pending_actions) or "【待确认】" in text
    needs_clarify = needs_clarify or _admin_needs_clarify(text)
    head = text[:160]
    hard_fail = not text or re.search(r"^(错误|失败|error)", head, re.I)
    write_fail_only = bool(
        re.search(
            r"未能完成写操作|工具未成功|未成功执行|遇到.{0,4}小问题|缺少具体内容|无法成功设置",
            text,
            re.I,
        )
    ) and not _admin_has_informational_content(text)
    ok = (
        bool(text)
        and not hard_fail
        and not write_fail_only
        and not needs_human_confirm
        and not needs_clarify
        and (
            _admin_has_informational_content(text)
            or not re.search(r"失败|error", head, re.I)
        )
    )
    # 显式 error_code（如 timeout）必须以失败收口，避免文案未命中 hard_fail 时 ok=true
    if error_code:
        ok = False
    sources = _urls_from_text(text)
    base_structured = {"transport": "ws"}
    if structured:
        base_structured.update(structured)
    if needs_human_confirm:
        base_structured["needs_human_confirm"] = True
    return {
        "ok": ok,
        "agent": "admin",
        "trace_id": trace_id or None,
        "answer": text or None,
        "sources": sources or None,
        "structured": base_structured,
        "needs_clarify": needs_clarify or None,
        "clarify_questions": clarify_questions,
        "error_code": error_code or (None if ok else "empty_result"),
        "latency_ms": latency_ms,
    }
