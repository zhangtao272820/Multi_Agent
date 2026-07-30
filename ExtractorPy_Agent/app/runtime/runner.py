"""Lean crawl runner: seed-first → fetch → extract → agentResult."""

from __future__ import annotations

import time
from typing import Any, Awaitable, Callable

from app.config import get_settings
from app.llm.extract import extract_items_from_pages
from app.nlu import (
    apply_slot_limit,
    build_structured_task_plan,
    default_seeds_for_site,
    maybe_clarify,
    sanitize_task,
)
from app.protocol.agent_result import build_crawler_agent_result
from app.protocol.incoming import (
    ExtractOptions,
    ManagerTaskHints,
    parse_manager_task_json,
    parse_options,
)
from app.runtime.channel import fetch_page
from app.runtime.lean import resolve_lean_caps
from app.runtime.seed_resolve import resolve_crawl_seeds
from app.runtime.web_search_enhance import enhance_with_web_search, should_web_search_enhance
from app.tools.searxng import search_searxng


LogFn = Callable[[str, str], Awaitable[None] | None]


def _serp_hits_to_items(hits: list[dict[str, Any]], *, max_items: int) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for h in hits:
        url = str(h.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        items.append(
            {
                "title": str(h.get("title") or "").strip() or url,
                "url": url,
                "source": "serp",
                "excerpt": str(h.get("snippet") or "").strip()[:400],
            }
        )
        if len(items) >= max_items:
            break
    return items


def _format_answer(items: list[dict[str, Any]], *, task: str) -> str:
    if not items:
        return f"未抓取到结果。任务：{task}"
    lines = [f"共 {len(items)} 条结果：", ""]
    for i, it in enumerate(items, 1):
        rank = it.get("rank")
        prefix = f"{rank}." if rank is not None else f"{i}."
        lines.append(f"{prefix} {it.get('title') or '(无标题)'}")
        lines.append(f"   {it.get('url')}")
        rating = it.get("rating")
        if rating is not None:
            lines.append(f"   评分：{rating}")
        ex = str(it.get("excerpt") or it.get("info") or it.get("quote") or "").strip()
        if ex:
            lines.append(f"   {ex[:200]}")
        lines.append("")
    # Manager table hint
    lines.append("<!--CRAWLER_TABLE-->")
    for it in items:
        lines.append(
            f"{it.get('title','')}|{it.get('url','')}|{it.get('source','')}|{it.get('excerpt','')}"
        )
    return "\n".join(lines).strip()


async def run_extract(
    *,
    task: str,
    manager_task_json: str | dict[str, Any] | None = None,
    options: dict[str, Any] | None = None,
    trace_id: str | None = None,
    network: bool | None = None,
    emit_log: LogFn | None = None,
    aborted: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    started = time.time()
    settings = get_settings()
    hints = parse_manager_task_json(manager_task_json)
    opts = parse_options(options, default_items=settings.default_max_items, default_pages=settings.default_max_pages)
    task_text = sanitize_task(hints.refined_task or task or "", max_chars=settings.task_max_chars)

    async def log(level: str, msg: str) -> None:
        if emit_log:
            r = emit_log(level, msg)
            if hasattr(r, "__await__"):
                await r  # type: ignore[misc]

    def is_aborted() -> bool:
        return bool(aborted and aborted())

    meta: dict[str, Any] = {
        "seed_first": False,
        "manager_seed_count": len(hints.seed_urls),
        "cloud_scrape_calls": 0,
        "playwright_mcp_calls": 0,
        "web_search_enhance": False,
        "nlu_path": "none",
    }
    failure_tags: list[str] = []

    # NLU：structured_task_plan（skill SSOT）+ structural 锁定 + slot clarify 门禁
    await log("info", "NLU：结构化任务计划（aligned Extractor skill）")
    plan = await build_structured_task_plan(task_text, hints=hints)
    meta["task_plan"] = plan.to_meta()
    meta["nlu_path"] = "structural_locked" if plan.structural_locked else "llm_or_heuristic"

    clarify = await maybe_clarify(task_text, plan=plan, hints=hints)
    plan = apply_slot_limit(plan, clarify.slot)
    if clarify.needs_clarify:
        qs = clarify.questions or ["请补充站点/目标/数量后再试。"]
        answer = "需要补充信息：\n" + "\n".join(f"- {q}" for q in qs)
        agent = build_crawler_agent_result(
            items=[],
            output_content=answer,
            status="needs_clarification",
            trace_id=trace_id,
            latency_ms=int((time.time() - started) * 1000),
            meta=meta,
            failure_tags=["slot_clarify"],
            needs_clarify=True,
            error_code="CRAWLER_NEEDS_CLARIFY",
        )
        agent["clarify_questions"] = qs
        return _pack([], answer, "needs_clarification", meta, agent)

    # limit：plan.limit 优先（与 Extractor maxItems 规则对齐）
    if plan.limit and plan.limit > 0:
        opts.max_items = min(100, max(1, int(plan.limit)))
    caps = resolve_lean_caps(opts)

    # preferred_channel：manager 优先；needsAuth → browser
    if not hints.preferred_channel and plan.needs_auth:
        hints.preferred_channel = "browser"

    # 0) 联网搜索增强：已知榜单站有能力默认种子时，先精抓（UI 勾选联网也不能用 SERP 顶替 top250）
    site_defaults = default_seeds_for_site(plan.target_site)
    ranking_site = plan.content_type == "ranking" or plan.target_site in {
        "douban",
        "zhihu",
        "weibo",
        "bilibili",
    }
    use_site_first = bool(
        site_defaults
        and not hints.seed_urls
        and (plan.structural_locked or (ranking_site and plan.target_site != "generic"))
    )
    want_search = should_web_search_enhance(
        hints,
        network=network,
        options=options,
        open_web_search=plan.open_web_search,
    )
    if use_site_first:
        want_search = False
        await log("info", f"已知站点 {plan.target_site}：优先能力默认种子精抓（跳过联网搜索抢种子）")

    if want_search:
        hints = await enhance_with_web_search(hints, task=task_text, emit_log=emit_log)
        meta["web_search_enhance"] = True
        meta["manager_seed_count"] = len(hints.seed_urls)
        if not hints.serp_hits:
            failure_tags.append("searxng_empty")

    # 1) serp_only → items from serp_hits
    if hints.crawl_strategy == "serp_only":
        await log("info", "crawl_strategy=serp_only，跳过 scrape")
        items = _serp_hits_to_items(hints.serp_hits, max_items=caps.max_items)
        answer = _format_answer(items, task=task_text)
        agent = build_crawler_agent_result(
            items=items,
            output_content=answer,
            status="ok" if items else "empty",
            trace_id=trace_id,
            latency_ms=int((time.time() - started) * 1000),
            serp_fallback=True,
            meta={**meta, "extract_path": "serp_only"},
            failure_tags=[] if items else ["serp_empty"],
            error_code=None if items else "CRAWLER_EMPTY",
        )
        return _pack(items, answer, "ok" if items else "empty", meta, agent)

    # 2) Resolve seeds（HeuristicPriority：manager > site default > filtered SERP）
    pages_needed = max(1, min(caps.max_pages, (opts.max_items + 24) // 25 if plan.target_site == "douban" else caps.max_pages))
    seeds = resolve_crawl_seeds(
        manager_seeds=list(hints.seed_urls),
        serp_hits=list(hints.serp_hits),
        target_site=plan.target_site,
        content_type=plan.content_type,
        structural_locked=plan.structural_locked,
        max_pages=pages_needed,
    )

    # 兜底：仍无种子且允许搜索时再搜一次
    if (
        not seeds
        and settings.web_search_enabled
        and not meta["web_search_enhance"]
        and (plan.open_web_search or hints.open_web_discovery or hints.crawl_strategy == "open_discovery")
    ):
        await log("info", f"SearXNG 补种子：{task_text[:80]}")
        try:
            hits = await search_searxng(task_text, max_results=settings.web_search_max_seeds)
            for h in hits:
                hints.serp_hits.append(h)
            seeds = resolve_crawl_seeds(
                manager_seeds=[],
                serp_hits=list(hints.serp_hits),
                target_site=plan.target_site,
                content_type=plan.content_type,
                structural_locked=False,
                max_pages=caps.max_pages,
            )
        except Exception as e:  # noqa: BLE001
            await log("warn", f"SearXNG 失败：{e}")
            failure_tags.append("searxng_failed")

    if seeds:
        meta["seed_first"] = True
        await log("info", f"种子 {len(seeds)} 个，开始精抓：{', '.join(seeds[:3])}")

    if not seeds:
        items = _serp_hits_to_items(hints.serp_hits, max_items=caps.max_items)
        if items:
            answer = _format_answer(items, task=task_text)
            agent = build_crawler_agent_result(
                items=items,
                output_content=answer,
                status="ok",
                trace_id=trace_id,
                latency_ms=int((time.time() - started) * 1000),
                serp_fallback=True,
                meta={**meta, "extract_path": "serp_fallback"},
            )
            return _pack(items, answer, "ok", meta, agent)
        agent = build_crawler_agent_result(
            items=[],
            output_content="缺少 seed_urls，且未能联网搜到种子。",
            status="needs_clarification",
            trace_id=trace_id,
            latency_ms=int((time.time() - started) * 1000),
            meta=meta,
            failure_tags=["no_seeds"],
            needs_clarify=True,
            error_code="CRAWLER_NO_SEEDS",
        )
        return _pack([], agent.get("answer") or "", "needs_clarification", meta, agent)

    # 3) Fetch pages
    remaining = caps.mcp_max_calls
    pages: list[dict[str, Any]] = []
    force_browser = opts.use_browser or plan.needs_auth or hints.preferred_channel == "browser"
    for url in seeds:
        if is_aborted():
            break
        if remaining <= 0:
            await log("warn", "MCP 调用预算耗尽")
            failure_tags.append("mcp_budget")
            break
        before = remaining
        snap, remaining = await fetch_page(
            url,
            preferred_channel=hints.preferred_channel,
            force_browser=force_browser,
            mcp_calls_left=remaining,
            emit_log=emit_log,
        )
        used = before - remaining
        # approximate accounting
        if snap and snap.get("channel") == "browser":
            meta["playwright_mcp_calls"] = int(meta["playwright_mcp_calls"]) + used
        else:
            meta["cloud_scrape_calls"] = int(meta["cloud_scrape_calls"]) + max(1, used)
        if snap:
            pages.append(snap)
        else:
            failure_tags.append("fetch_failed")

    # 4) If no pages but have serp → fallback（榜单站禁止用 SERP 条目冒充精抓结果）
    if not pages:
        if ranking_site and site_defaults:
            await log("warn", "精抓失败且为已知榜单站，不回退 SERP 列表")
            agent = build_crawler_agent_result(
                items=[],
                output_content="抓取失败，未能打开榜单页。请稍后重试或改用浏览器通道。",
                status="error",
                trace_id=trace_id,
                latency_ms=int((time.time() - started) * 1000),
                meta=meta,
                failure_tags=failure_tags or ["fetch_failed"],
                error_code="CRAWLER_FETCH_FAILED",
            )
            return _pack([], agent.get("answer") or "", "error", meta, agent)
        items = _serp_hits_to_items(hints.serp_hits, max_items=caps.max_items)
        if items:
            answer = _format_answer(items, task=task_text)
            agent = build_crawler_agent_result(
                items=items,
                output_content=answer,
                status="ok",
                trace_id=trace_id,
                latency_ms=int((time.time() - started) * 1000),
                serp_fallback=True,
                meta={**meta, "extract_path": "serp_after_fetch_fail"},
                failure_tags=failure_tags or ["fetch_failed"],
            )
            return _pack(items, answer, "ok", meta, agent)
        agent = build_crawler_agent_result(
            items=[],
            output_content="抓取失败，无可用页面内容。",
            status="error",
            trace_id=trace_id,
            latency_ms=int((time.time() - started) * 1000),
            meta=meta,
            failure_tags=failure_tags or ["fetch_failed"],
            error_code="CRAWLER_FETCH_FAILED",
        )
        return _pack([], agent.get("answer") or "", "error", meta, agent)

    # 5) Extract（榜单页抽列表，禁止「一页一条摘要」冒充 TopN）
    items, extract_path = await extract_items_from_pages(
        task=task_text,
        pages=pages,
        max_items=caps.max_items,
        hint_fields=plan.fields or hints.hint_fields or None,
        target_site=plan.target_site,
        content_type=plan.content_type,
    )
    meta["extract_path"] = extract_path
    meta["llm_extract_calls"] = 1 if extract_path == "llm" else 0
    await log("info", f"抽取路径 {extract_path}，得到 {len(items)} 条")

    # 榜单空结果：强制补抓能力默认种子（SERP 首页/检索页常抽不出列表）
    if (
        not items
        and ranking_site
        and site_defaults
        and remaining > 0
        and not is_aborted()
    ):
        retry_seeds = resolve_crawl_seeds(
            manager_seeds=[],
            serp_hits=[],
            target_site=plan.target_site,
            content_type=plan.content_type,
            structural_locked=True,
            max_pages=min(2, caps.max_pages),
        )
        retry_seeds = [u for u in retry_seeds if u not in {str(p.get("url") or "") for p in pages}]
        if retry_seeds:
            await log("info", f"榜单抽取为空，补抓默认种子：{', '.join(retry_seeds[:2])}")
            for url in retry_seeds:
                if is_aborted() or remaining <= 0:
                    break
                before = remaining
                snap, remaining = await fetch_page(
                    url,
                    preferred_channel=hints.preferred_channel,
                    force_browser=force_browser or plan.target_site == "douban",
                    mcp_calls_left=remaining,
                    emit_log=emit_log,
                )
                used = before - remaining
                if snap and snap.get("channel") == "browser":
                    meta["playwright_mcp_calls"] = int(meta["playwright_mcp_calls"]) + used
                else:
                    meta["cloud_scrape_calls"] = int(meta["cloud_scrape_calls"]) + max(1, used)
                if snap:
                    pages.append(snap)
            items, extract_path = await extract_items_from_pages(
                task=task_text,
                pages=pages,
                max_items=caps.max_items,
                hint_fields=plan.fields or hints.hint_fields or None,
                target_site=plan.target_site,
                content_type=plan.content_type,
            )
            meta["extract_path"] = f"retry_{extract_path}"
            await log("info", f"补抓后抽取 {extract_path}，得到 {len(items)} 条")

    # Enrich with must_filters lightly (substring keep)
    if hints.must_filters and items:
        filtered = []
        for it in items:
            blob = f"{it.get('title','')} {it.get('excerpt','')}".lower()
            if all(f.lower() in blob for f in hints.must_filters if f):
                filtered.append(it)
        if filtered:
            items = filtered

    answer = _format_answer(items, task=task_text)
    # 精抓已有列表时不把 SERP 摘要拼进主答案；榜单空结果也不用 SERP 冒充 TopN
    if hints.serp_context and items and extract_path in ("serp_fallback", "serp_after_fetch_fail", "serp_only"):
        answer = f"{answer}\n\n---\nSERP 上下文：\n{hints.serp_context[:800]}"

    status = "ok" if items else "empty"
    agent = build_crawler_agent_result(
        items=items,
        output_content=answer,
        status=status,
        trace_id=trace_id,
        latency_ms=int((time.time() - started) * 1000),
        meta=meta,
        failure_tags=failure_tags if not items else None,
        error_code=None if items else "CRAWLER_EMPTY",
    )
    return _pack(items, answer, status, meta, agent)


def _pack(
    items: list[dict[str, Any]],
    answer: str,
    status: str,
    meta: dict[str, Any],
    agent: dict[str, Any],
) -> dict[str, Any]:
    return {
        "ok": bool(agent.get("ok")),
        "items": items,
        "output": {"content": answer},
        "status": status,
        "meta": meta,
        "agentResult": agent,
    }
