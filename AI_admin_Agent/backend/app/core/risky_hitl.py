"""Admin 写闸：RISKY 工具是否必须走 pending HITL（可单测）。"""
from __future__ import annotations

from app.tools.registry import RISKY_TOOLS


def requires_risky_hitl(tool_name: str, *, auto_confirm_risky: bool) -> bool:
    """
    高风险写工具在未代确认时必须创建 pending，禁止静默执行。

    - auto_confirm_risky=True（总管可信编排代确认）→ 不强制 HITL
    - 非 RISKY 工具 → 不强制 HITL
    - 缺槽澄清由 admin_write_clarify 另管；本函数只管「写确认」闸门
    """
    if auto_confirm_risky:
        return False
    name = str(tool_name or "").strip()
    return bool(name) and name in RISKY_TOOLS
