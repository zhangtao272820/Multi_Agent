"""Structured extract from page markdown/html (list-first for rankings)."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urljoin, urlparse

from app.config import get_settings
from app.llm.dashscope import chat_json

_MD_LINK = re.compile(r"\[([^\]]{1,200})\]\((https?://[^)\s]+)\)")
_HTML_A = re.compile(
    r'<a[^>]+href=["\'](https?://[^"\']+)["\'][^>]*>(.*?)</a>',
    re.I | re.S,
)
_DOUBAN_ITEM = re.compile(
    r'<div class="item">[\s\S]*?<em>(\d+)</em>[\s\S]*?'
    r'href="(https://movie\.douban\.com/subject/\d+/?)"[\s\S]*?'
    r'<span class="title">([^<]+)</span>',
    re.I,
)
_DOUBAN_SUBJECT_MD = re.compile(
    r"\[([^\]]+)\]\((https://movie\.douban\.com/subject/\d+/?)\)",
    re.I,
)


def _clean_text(s: str) -> str:
    t = re.sub(r"<[^>]+>", "", str(s or ""))
    return re.sub(r"\s+", " ", t).strip()


def _extract_douban_top250(html: str, markdown: str, *, max_items: int) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for m in _DOUBAN_ITEM.finditer(html or ""):
        rank = int(m.group(1))
        url = m.group(2).rstrip("/") + "/"
        title = _clean_text(m.group(3))
        if not title or url in seen:
            continue
        seen.add(url)
        items.append(
            {
                "rank": rank,
                "title": title,
                "url": url,
                "source": "crawl",
                "excerpt": f"豆瓣 Top250 #{rank}",
            }
        )
        if len(items) >= max_items:
            return items

    for m in _DOUBAN_SUBJECT_MD.finditer(markdown or ""):
        title = _clean_text(m.group(1))
        url = m.group(2).rstrip("/") + "/"
        if not title or url in seen:
            continue
        # skip nav chrome
        if title in ("豆瓣", "豆瓣电影", "登录", "下载豆瓣 App"):
            continue
        seen.add(url)
        items.append(
            {
                "rank": len(items) + 1,
                "title": title,
                "url": url,
                "source": "crawl",
                "excerpt": "",
            }
        )
        if len(items) >= max_items:
            break
    return items


def _extract_ranking_links(
    pages: list[dict[str, Any]],
    *,
    max_items: int,
    prefer_host: str | None = None,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    def push(title: str, url: str, excerpt: str = "") -> None:
        nonlocal items
        if len(items) >= max_items:
            return
        title = _clean_text(title)
        url = str(url or "").strip()
        if not title or not url.startswith(("http://", "https://")):
            return
        if prefer_host:
            host = (urlparse(url).hostname or "").lower()
            if prefer_host not in host:
                return
        key = url.rstrip("/")
        if key in seen:
            return
        # skip self-page / very short nav labels
        if len(title) < 2 or title.lower() in {"home", "首页", "更多", "下一页", "previous", "next"}:
            return
        seen.add(key)
        items.append(
            {
                "rank": len(items) + 1,
                "title": title[:160],
                "url": url,
                "source": "crawl",
                "excerpt": (excerpt or "")[:200],
            }
        )

    for p in pages:
        base = str(p.get("url") or "")
        md = str(p.get("markdown") or "")
        html = str(p.get("html") or "")
        for m in _MD_LINK.finditer(md):
            push(m.group(1), m.group(2))
            if len(items) >= max_items:
                return items
        for m in _HTML_A.finditer(html):
            href = m.group(1)
            try:
                href = urljoin(base, href)
            except Exception:
                pass
            push(m.group(2), href)
            if len(items) >= max_items:
                return items
    return items


def _page_as_items(pages: list[dict[str, Any]], *, task: str, max_items: int) -> list[dict[str, Any]]:
    """Fallback: one summary item per fetched page (open-discovery docs)."""
    items: list[dict[str, Any]] = []
    for p in pages:
        url = str(p.get("url") or "").strip()
        title = str(p.get("title") or "").strip()
        md = str(p.get("markdown") or "").strip()
        if not url:
            continue
        if not title:
            for line in md.splitlines():
                s = line.strip().lstrip("#").strip()
                if s and len(s) > 2:
                    title = s[:160]
                    break
        if not title:
            title = urlparse(url).path.rsplit("/", 1)[-1] or url
        excerpt = re.sub(r"\s+", " ", md)[:280].strip()
        items.append(
            {
                "title": title,
                "url": url,
                "source": str(p.get("channel") or "crawl"),
                "excerpt": excerpt or task[:120],
            }
        )
        if len(items) >= max_items:
            break
    return items


def _heuristic_good_enough(items: list[dict[str, Any]], *, max_items: int, ranking: bool) -> bool:
    if not items:
        return False
    if ranking:
        # ranking needs multiple list rows, not 1–2 page blurbs
        filled = sum(1 for it in items if it.get("title") and it.get("url"))
        return filled >= min(max_items, max(3, min(5, max_items)))
    filled = sum(1 for it in items if it.get("title") and it.get("url") and it.get("excerpt"))
    return filled >= min(len(items), max(1, min(3, max_items)))


async def extract_items_from_pages(
    *,
    task: str,
    pages: list[dict[str, Any]],
    max_items: int,
    hint_fields: list[str] | None = None,
    target_site: str | None = None,
    content_type: str | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """Returns (items, extract_path). Ranking → list extract; else page summary / LLM."""
    if not pages:
        return [], "empty"

    site = (target_site or "").strip().lower()
    ranking = (content_type or "").strip().lower() == "ranking" or site in {
        "douban",
        "zhihu",
        "weibo",
        "bilibili",
    }

    list_items: list[dict[str, Any]] = []
    if site == "douban" or any("movie.douban.com/top250" in str(p.get("url") or "") for p in pages):
        for p in pages:
            list_items.extend(
                _extract_douban_top250(
                    str(p.get("html") or ""),
                    str(p.get("markdown") or ""),
                    max_items=max_items - len(list_items),
                )
            )
            if len(list_items) >= max_items:
                break
        if list_items:
            return list_items[:max_items], "douban_top250"

    if ranking:
        prefer = {
            "douban": "douban.com",
            "zhihu": "zhihu.com",
            "weibo": "weibo.com",
            "bilibili": "bilibili.com",
        }.get(site)
        list_items = _extract_ranking_links(pages, max_items=max_items, prefer_host=prefer)
        if _heuristic_good_enough(list_items, max_items=max_items, ranking=True):
            return list_items[:max_items], "list_heuristic"

    page_items = _page_as_items(pages, task=task, max_items=max_items)
    settings = get_settings()
    if not settings.qwen_api_key:
        return (list_items or page_items)[:max_items], "heuristic"

    if not ranking and _heuristic_good_enough(page_items, max_items=max_items, ranking=False):
        return page_items, "heuristic"
    if ranking and _heuristic_good_enough(list_items, max_items=max_items, ranking=True):
        return list_items[:max_items], "list_heuristic"

    fields = hint_fields or ["rank", "title", "url", "excerpt"]
    max_pages = settings.llm_max_pages
    page_chars = settings.llm_page_chars
    blobs = []
    for i, p in enumerate(pages[:max_pages]):
        md = str(p.get("markdown") or "")[:page_chars]
        blobs.append(f"### P{i + 1}\nURL: {p.get('url')}\nTitle: {p.get('title')}\n{md}")

    if ranking:
        system = (
            '输出 JSON：{"items":[{"rank":1,"title":"","url":"","excerpt":""}]}。'
            "从页面中抽取榜单/列表条目（每部电影/每条热榜一行），不要把整页摘要当成一条；"
            f"最多{max_items}条；url 必须是条目详情链接；只用页面事实；勿编造。"
        )
    else:
        system = (
            '输出 JSON：{"items":[{"title":"","url":"","source":"","excerpt":""}]}。'
            "只用页面事实；excerpt≤200字；"
            f"最多{max_items}条；勿编造。"
        )
    user = f"任务：{task[:200]}\n字段：{','.join(fields)}\n" + "\n".join(blobs)
    data = await chat_json(system=system, user=user)
    items: list[dict[str, Any]] = []
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        for it in data["items"]:
            if not isinstance(it, dict):
                continue
            url = str(it.get("url") or "").strip()
            if not url.startswith(("http://", "https://")):
                continue
            row = {
                "title": str(it.get("title") or "").strip() or url,
                "url": url,
                "source": str(it.get("source") or "crawl").strip() or "crawl",
                "excerpt": str(it.get("excerpt") or "").strip()[:280],
            }
            if it.get("rank") is not None:
                try:
                    row["rank"] = int(it["rank"])
                except (TypeError, ValueError):
                    pass
            items.append(row)
            if len(items) >= max_items:
                break
        if items and (not ranking or len(items) >= min(3, max_items)):
            return items, "llm"

    if list_items:
        return list_items[:max_items], "list_heuristic"
    # 榜单任务：禁止用「每页一条摘要」冒充 TopN（否则 UI 看起来像只有搜索种子）
    if ranking and not _heuristic_good_enough(page_items, max_items=max_items, ranking=True):
        return [], "ranking_empty"
    return page_items, "heuristic"
