"""Admin 写闸：RISKY 工具是否必须走 pending HITL（可单测）。"""
from __future__ import annotations

from app.tools.registry import RISKY_TOOLS


def requires_risky_hitl(
    tool_name: str,
    *,
    auto_confirm_risky: bool,
    blast_radius: str | None = None,
    confirm_token: str | None = None,
) -> bool:
    """
    高风险写工具在未代确认时必须创建 pending，禁止静默执行。

    - auto_confirm_risky=True（总管可信编排代确认）→ 不强制 HITL
    - 已有 HITL confirm_token → 本轮已确认，不重复 pending
    - blast_radius=t2 且为 RISKY 工具 → 强制 HITL（与 T2 契约对齐）
    - 非 RISKY 工具 → 不强制 HITL
    """
    if auto_confirm_risky:
        return False
    if str(confirm_token or "").strip():
        return False
    name = str(tool_name or "").strip()
    if not name:
        return False
    if str(blast_radius or "").strip().lower() == "t2":
        return name in RISKY_TOOLS
    return name in RISKY_TOOLS
