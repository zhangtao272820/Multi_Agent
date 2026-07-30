"""Slot clarify — GateRules aligned with Extractor_Agent crawler_slot_clarify."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.config import get_settings
from app.llm.dashscope import chat_json
from app.nlu.prompts import build_slot_infer_prompt, get_slot_clarify_defaults
from app.nlu.task_plan import StructuredTaskPlan
from app.protocol.incoming import ManagerTaskHints

SLOT_CONF_MIN = 0.72


@dataclass
class SlotInfer:
    has_source: bool = False
    has_goal: bool = False
    has_limit: bool = False
    limit_value: int | None = None
    confidence: float = 0.0
    source_hint: str = ""
    goal_hint: str = ""
    limit_hint: str = ""


@dataclass
class ClarifyResult:
    needs_clarify: bool
    questions: list[str]
    slot: SlotInfer | None = None


async def infer_slots(task: str) -> SlotInfer | None:
    settings = get_settings()
    if not settings.qwen_api_key:
        return None
    system, user = build_slot_infer_prompt(task[: settings.task_max_chars])
    data = await chat_json(
        system=system,
        user=user,
        max_tokens=min(256, settings.plan_max_tokens),
    )
    if not isinstance(data, dict):
        return None
    try:
        conf = float(data.get("confidence") or 0)
    except (TypeError, ValueError):
        conf = 0.0
    lim = data.get("limitValue")
    try:
        lim_n = int(lim) if lim is not None else None
    except (TypeError, ValueError):
        lim_n = None
    return SlotInfer(
        has_source=bool(data.get("hasSource")),
        has_goal=bool(data.get("hasGoal")),
        has_limit=bool(data.get("hasLimit")),
        limit_value=lim_n,
        confidence=conf,
        source_hint=str(data.get("sourceHint") or "").strip(),
        goal_hint=str(data.get("goalHint") or "").strip(),
        limit_hint=str(data.get("limitHint") or "").strip(),
    )


async def maybe_clarify(
    task: str,
    *,
    plan: StructuredTaskPlan,
    hints: ManagerTaskHints,
) -> ClarifyResult:
    """
    GateRules:
    - openWebSearch or fromManager → skip
    - confidence < 0.72 → no clarify
    - missing slots >= 3 → clarify
    """
    from_manager = (hints.source or "").lower() == "manager"
    if plan.open_web_search or from_manager or hints.seed_urls or hints.serp_hits:
        return ClarifyResult(needs_clarify=False, questions=[])

    slot = await infer_slots(task)
    if not slot or slot.confidence < SLOT_CONF_MIN:
        return ClarifyResult(needs_clarify=False, questions=[], slot=slot)

    # treat openWeb / known site as source
    has_source = slot.has_source or plan.target_site != "generic" or plan.open_web_search
    has_goal = slot.has_goal
    has_limit = slot.has_limit or bool(plan.limit)
    missing = 0
    questions: list[str] = []
    defaults = get_slot_clarify_defaults()
    if not has_source:
        missing += 1
        questions.append(slot.source_hint or defaults["source"])
    if not has_goal:
        missing += 1
        questions.append(slot.goal_hint or defaults["goal"])
    if not has_limit:
        missing += 1
        questions.append(slot.limit_hint or defaults["limit"])

    if missing >= 3:
        return ClarifyResult(needs_clarify=True, questions=questions[:3], slot=slot)
    return ClarifyResult(needs_clarify=False, questions=[], slot=slot)


def apply_slot_limit(plan: StructuredTaskPlan, slot: SlotInfer | None) -> StructuredTaskPlan:
    if slot and slot.limit_value and not plan.limit:
        plan.limit = max(1, min(250, slot.limit_value))
    return plan
