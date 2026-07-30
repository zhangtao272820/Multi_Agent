"""StructuredTaskPlan — schema + LLM parser aligned with Extractor_Agent."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from app.config import get_settings
from app.llm.dashscope import chat_json
from app.nlu.prompts import build_structured_task_plan_prompt
from app.nlu.structural import SITE_DEFAULT_SEEDS, StructuralInfer, infer_structural_task
from app.protocol.incoming import ManagerTaskHints

TargetSite = Literal[
    "douban", "zhihu", "weibo", "bilibili", "toutiao", "douyin", "jd", "qqmusic", "kugou", "generic"
]
ContentType = Literal["ranking", "news", "products", "qa", "videos", "music", "generic"]

PLAN_CONF_MIN = 0.45
STRUCTURAL_LOCK = 0.72


class StructuredTaskPlanModel(BaseModel):
    targetSite: TargetSite = "generic"
    contentType: ContentType = "generic"
    limit: int | None = Field(default=None, ge=1, le=250)
    fields: list[str] = Field(default_factory=lambda: ["title", "url"])
    filters: list[str] = Field(default_factory=list)
    sortBy: str | None = None
    sortOrder: Literal["asc", "desc"] | None = None
    timeRange: dict[str, Any] | None = None
    outputSpec: dict[str, Any] | None = None
    qualityTarget: dict[str, Any] | None = None
    needsAuth: bool = False
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    openWebSearch: bool = False


@dataclass
class StructuredTaskPlan:
    target_site: TargetSite = "generic"
    content_type: ContentType = "generic"
    limit: int | None = None
    fields: list[str] = field(default_factory=lambda: ["title", "url"])
    filters: list[str] = field(default_factory=list)
    sort_by: str | None = None
    sort_order: str | None = None
    needs_auth: bool = False
    confidence: float = 0.0
    open_web_search: bool = False
    structural_locked: bool = False

    def to_meta(self) -> dict[str, Any]:
        return {
            "targetSite": self.target_site,
            "contentType": self.content_type,
            "limit": self.limit,
            "fields": self.fields,
            "filters": self.filters,
            "needsAuth": self.needs_auth,
            "confidence": self.confidence,
            "openWebSearch": self.open_web_search,
            "structuralLocked": self.structural_locked,
        }


def _from_model(m: StructuredTaskPlanModel, *, locked: bool = False) -> StructuredTaskPlan:
    return StructuredTaskPlan(
        target_site=m.targetSite,
        content_type=m.contentType,
        limit=m.limit,
        fields=[str(x).strip() for x in (m.fields or []) if str(x).strip()][:12] or ["title", "url"],
        filters=[str(x).strip() for x in (m.filters or []) if str(x).strip()][:12],
        sort_by=m.sortBy,
        sort_order=m.sortOrder,
        needs_auth=bool(m.needsAuth),
        confidence=float(m.confidence or 0),
        open_web_search=bool(m.openWebSearch),
        structural_locked=locked,
    )


def _merge_structural(base: StructuredTaskPlan, structural: StructuralInfer) -> StructuredTaskPlan:
    locked = structural.confidence >= STRUCTURAL_LOCK and structural.target_site != "generic"
    if locked:
        base.target_site = structural.target_site
        base.content_type = structural.content_type
        if structural.fields:
            base.fields = list(structural.fields)
        base.open_web_search = False
        base.structural_locked = True
        base.confidence = max(base.confidence, structural.confidence)
    elif structural.confidence >= 0.5 and base.target_site == "generic" and structural.target_site != "generic":
        base.target_site = structural.target_site
        base.content_type = structural.content_type
        if structural.fields:
            base.fields = list(structural.fields)
        base.confidence = max(base.confidence, structural.confidence)
    if structural.limit and (not base.limit or structural.limit > 0):
        # take structural limit when base missing
        if not base.limit:
            base.limit = structural.limit
    return base


def _merge_manager_hints(plan: StructuredTaskPlan, hints: ManagerTaskHints) -> StructuredTaskPlan:
    if hints.hint_fields:
        plan.fields = list(dict.fromkeys([*plan.fields, *hints.hint_fields]))[:12]
    if hints.must_filters:
        plan.filters = list(dict.fromkeys([*plan.filters, *hints.must_filters]))[:12]
    # structural 已锁定已知站点时，禁止 UI open_discovery 再改写成开放检索
    if hints.open_web_discovery and not plan.structural_locked:
        plan.open_web_search = True
    if hints.seed_urls:
        plan.open_web_search = False
    if hints.source == "manager" and (hints.seed_urls or hints.serp_hits):
        plan.open_web_search = False
    return plan


def sanitize_task(task: str, *, max_chars: int) -> str:
    t = (task or "").strip()
    if len(t) > max_chars:
        return t[:max_chars]
    return t


async def build_structured_task_plan(
    task: str,
    *,
    hints: ManagerTaskHints | None = None,
) -> StructuredTaskPlan:
    settings = get_settings()
    task_s = sanitize_task(task, max_chars=settings.task_max_chars)
    structural = infer_structural_task(task_s)
    hints = hints or ManagerTaskHints()

    # Neutral + structural first
    plan = StructuredTaskPlan()
    plan = _merge_structural(plan, structural)

    # Skip LLM when structural locked (same as Extractor heuristic path for locked sites)
    if plan.structural_locked:
        return _merge_manager_hints(plan, hints)

    if not settings.qwen_api_key:
        # heuristic-only: open web when generic and no seeds
        if plan.target_site == "generic" and not hints.seed_urls and not hints.serp_hits:
            plan.open_web_search = True
            plan.confidence = max(plan.confidence, 0.4)
        return _merge_manager_hints(plan, hints)

    system, user = build_structured_task_plan_prompt(task_s)
    data = await chat_json(
        system=system,
        user=user,
        max_tokens=min(settings.llm_json_max_tokens, settings.plan_max_tokens),
    )
    if isinstance(data, dict):
        try:
            model = StructuredTaskPlanModel.model_validate(data)
            if float(model.confidence or 0) >= PLAN_CONF_MIN:
                llm_plan = _from_model(model)
                # re-apply structural lock over LLM
                plan = _merge_structural(llm_plan, structural)
            # else discard LLM (same as Extractor conf < 0.45)
        except ValidationError:
            pass

    if plan.target_site == "generic" and not hints.seed_urls and not hints.serp_hits and plan.confidence < 0.45:
        # open discovery default for vague UI tasks without API confidence
        if hints.open_web_discovery or hints.source in ("ui", "standalone", ""):
            plan.open_web_search = True

    return _merge_manager_hints(plan, hints)


def default_seeds_for_site(site: str) -> list[str]:
    return list(SITE_DEFAULT_SEEDS.get(site, []))
