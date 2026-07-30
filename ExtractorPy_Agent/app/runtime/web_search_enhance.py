"""Standalone UI / open-discovery: SearXNG → seed_urls（对齐总管 search→crawl）."""

from __future__ import annotations

from typing import Any

from app.config import get_settings
from app.protocol.incoming import ManagerTaskHints
from app.tools.searxng import search_searxng


def should_web_search_enhance(
    hints: ManagerTaskHints,
    *,
    network: bool | None = None,
    options: dict[str, Any] | None = None,
    open_web_search: bool | None = None,
) -> bool:
    """Manager 已带 seed/serp 时不再搜；独立 UI / openWebSearch / network 增强时搜。"""
    settings = get_settings()
    if not settings.web_search_enabled:
        return False
    opts = options or {}
    if opts.get("webSearchEnhance") is False or opts.get("web_search_enhance") is False:
        return False
    if opts.get("webSearchEnhance") is True or opts.get("web_search_enhance") is True:
        return True
    if network is True:
        return True
    if open_web_search is True:
        return True
    if open_web_search is False and hints.seed_urls:
        return False
    src = (hints.source or "").strip().lower()
    # 总管已注入种子或 SERP：跳过本地搜索
    if src == "manager" and (hints.seed_urls or hints.serp_hits):
        return False
    if hints.crawl_strategy == "serp_only" and hints.serp_hits:
        return False
    if hints.open_web_discovery or hints.crawl_strategy == "open_discovery":
        return True
    if src in ("ui", "standalone", ""):
        return True
    if not hints.seed_urls and not hints.serp_hits:
        return True
    return False


async def enhance_with_web_search(
    hints: ManagerTaskHints,
    *,
    task: str,
    emit_log: Any = None,
) -> ManagerTaskHints:
    """Mutate-copy hints with SearXNG seeds + serp_context（对齐 manager_task_json）."""
    settings = get_settings()
    q = (hints.refined_task or task or "").strip()
    if not q:
        return hints

    async def _log(level: str, msg: str) -> None:
        if emit_log:
            r = emit_log(level, msg)
            if hasattr(r, "__await__"):
                await r

    await _log("info", f"联网搜索增强（SearXNG）：{q[:100]}")
    try:
        hits = await search_searxng(q, max_results=settings.web_search_max_seeds)
    except Exception as e:  # noqa: BLE001
        await _log("warn", f"SearXNG 失败：{e}")
        return hints

    if not hits:
        await _log("warn", "SearXNG 无结果")
        return hints

    # 搜索命中只进 serp_hits，不写入 seed_urls。
    # 否则 resolve 会把 SERP 当「总管显式种子」优先于站点默认精抓页（豆瓣 top250 等），
    # 导致只爬到首页/检索页，答案看起来像「只有联网搜索结果」。
    serp_hits = list(hints.serp_hits)
    seen = {str(h.get("url") or "").strip() for h in serp_hits}
    for h in hits:
        u = str(h.get("url") or "").strip()
        if not u.startswith(("http://", "https://")) or u in seen:
            continue
        seen.add(u)
        serp_hits.append(h)

    lines = []
    for h in hits[: settings.web_search_max_seeds]:
        lines.append(f"- {h.get('title') or ''} | {h.get('url')}\n  {h.get('snippet') or ''}")
    serp_context = hints.serp_context
    if not serp_context:
        serp_context = "联网搜索结果：\n" + "\n".join(lines)

    await _log("info", f"联网搜索得到 {len(hits)} 条，写入 SERP 候选（显式种子仍 {len(hints.seed_urls)} 个）")

    strategy = hints.crawl_strategy
    if strategy != "serp_only":
        # 有 SERP 或原种子即可进入精抓；具体 URL 由 resolve_crawl_seeds 决定
        strategy = "crawl_seeds" if (hints.seed_urls or serp_hits) else hints.crawl_strategy

    return ManagerTaskHints(
        source=hints.source or "ui",
        refined_task=hints.refined_task,
        hint_fields=hints.hint_fields,
        preferred_channel=hints.preferred_channel,
        must_filters=hints.must_filters,
        open_web_discovery=hints.open_web_discovery or not hints.seed_urls,
        seed_urls=list(hints.seed_urls),
        serp_context=serp_context,
        serp_hits=serp_hits,
        search_context=hints.search_context,
        crawl_strategy=strategy,
    )
