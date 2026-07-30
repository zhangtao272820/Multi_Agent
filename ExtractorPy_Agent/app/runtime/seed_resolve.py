"""Seed resolution aligned with Extractor seed_crawl_plan HeuristicPriority + URL quality."""

from __future__ import annotations

from urllib.parse import urlparse, urlunparse

from app.nlu.structural import SITE_DEFAULT_SEEDS

# SERP / meta-search hosts — not deep-crawl content pages (URL quality, not intent keywords)
_SEARCH_HOST_FRAGMENTS = (
    "searx",
    "searxng",
    "google.",
    "bing.com",
    "baidu.com",
    "sogou.com",
    "duckduckgo.com",
    "yahoo.com",
    "so.com",
)

_TUTORIAL_HOSTS = (
    "csdn.net",
    "jb51.net",
    "cnblogs.com",
    "jianshu.com",
    "juejin.cn",
    "segmentfault.com",
    "stackoverflow.com",
    "runoob.com",
    "w3school.com.cn",
    "github.com",
)


def normalize_crawl_url_key(url: str) -> str:
    try:
        u = urlparse(str(url or "").strip())
        if not u.scheme or not u.netloc:
            return str(url or "").strip().rstrip("/")
        path = u.path.rstrip("/") or ""
        return urlunparse((u.scheme.lower(), u.netloc.lower(), path, "", u.query, "")).rstrip("/")
    except Exception:
        return str(url or "").strip().rstrip("/")


def is_search_engine_result_url(url: str) -> bool:
    raw = str(url or "").strip()
    if not raw.startswith(("http://", "https://")):
        return False
    try:
        u = urlparse(raw)
        host = (u.hostname or "").lower().removeprefix("www.")
        path_q = f"{u.path}{u.query}".lower()
        if any(frag in host for frag in _SEARCH_HOST_FRAGMENTS):
            return True
        if "baidu.com" in host and ("/s" in u.path or "wd=" in u.query or "word=" in u.query):
            return True
        if "google." in host and ("/search" in path_q or "q=" in u.query):
            return True
        if "bing.com" in host and "/search" in path_q:
            return True
        return False
    except Exception:
        return False


def is_valid_crawl_seed_url(url: str) -> bool:
    u = str(url or "").strip()
    if not u.startswith(("http://", "https://")):
        return False
    if is_search_engine_result_url(u):
        return False
    try:
        host = (urlparse(u).hostname or "").lower().removeprefix("www.")
    except Exception:
        return False
    if any(host == h or host.endswith(f".{h}") for h in _TUTORIAL_HOSTS):
        return False
    return True


def canonicalize_seed_url(url: str, *, target_site: str, content_type: str = "") -> str:
    """Align with Extractor canonicalizeSeedUrl for known capability sites."""
    raw = str(url or "").strip()
    if not raw.startswith(("http://", "https://")):
        return raw
    site = (target_site or "").strip().lower()
    try:
        u = urlparse(raw)
        host = (u.hostname or "").lower().removeprefix("www.")
        path = (u.path or "").lower()
        query = (u.query or "").lower()
    except Exception:
        return raw

    if site == "douban":
        # 站内检索/发现页不是 TopN 榜单页 → 归一到 top250
        if host in ("douban.com", "movie.douban.com") and (
            path in ("/", "")
            or "top250" in path
            or path.startswith("/search")
            or "search" in path
            or "q=" in query
        ):
            if "top250" in path and "start=" in query:
                return raw.split("#")[0]
            return "https://movie.douban.com/top250"
        if host == "movie.douban.com" and "top250" in path:
            return raw.split("#")[0]
        if host.endswith("douban.com"):
            return "https://movie.douban.com/top250"

    if site == "zhihu" and content_type == "ranking":
        return "https://www.zhihu.com/hot"
    if site == "weibo" and content_type == "ranking":
        return "https://s.weibo.com/top/summary"
    if site == "bilibili" and content_type == "ranking":
        return "https://www.bilibili.com/v/popular/rank/all"

    return raw


def site_host_hints(site: str) -> tuple[str, ...]:
    return {
        "douban": ("douban.com",),
        "zhihu": ("zhihu.com",),
        "weibo": ("weibo.com",),
        "bilibili": ("bilibili.com",),
        "toutiao": ("toutiao.com",),
        "douyin": ("douyin.com",),
        "jd": ("jd.com",),
    }.get((site or "").lower(), ())


def _host_matches(url: str, hints: tuple[str, ...]) -> bool:
    if not hints:
        return True
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    return any(host == h or host.endswith(f".{h}") for h in hints)


def resolve_crawl_seeds(
    *,
    manager_seeds: list[str],
    serp_hits: list[dict],
    target_site: str,
    content_type: str = "",
    structural_locked: bool = False,
    max_pages: int = 3,
) -> list[str]:
    """
    HeuristicPriority (lean):
    1) manager/UI explicit seeds
    2) capability default seeds when targetSite known
    3) SERP hits (filtered; prefer same-site when locked)
    """
    max_pages = max(1, min(30, int(max_pages or 3)))
    site = (target_site or "generic").strip().lower()
    hints = site_host_hints(site)
    out: list[str] = []
    seen: set[str] = set()
    defaults = list(SITE_DEFAULT_SEEDS.get(site, []))
    prefer_defaults = bool(defaults and (structural_locked or (site != "generic" and content_type == "ranking")))

    def _push(raw: str) -> None:
        if len(out) >= max_pages:
            return
        u = canonicalize_seed_url(str(raw or "").strip(), target_site=site, content_type=content_type)
        if not is_valid_crawl_seed_url(u):
            return
        key = normalize_crawl_url_key(u)
        if not key or key in seen:
            return
        seen.add(key)
        out.append(u)

    # 1) 显式种子（总管/UI 手填）。已知榜单站：只收同站 URL，避免 SERP 脏链占坑
    for s in manager_seeds or []:
        raw = str(s or "").strip()
        if prefer_defaults and hints and not _host_matches(raw, hints):
            continue
        _push(raw)

    # 2) 能力默认精抓页（豆瓣 top250 等）— 必须在 SERP 之前
    if prefer_defaults:
        if site == "douban" and max_pages > 1:
            for i in range(max_pages):
                _push(f"https://movie.douban.com/top250?start={i * 25}")
        else:
            for d in defaults:
                _push(d)
    elif defaults and site != "generic":
        for d in defaults:
            _push(d)

    # 3) SERP 补位：锁定时仅同站；未锁定时再放开
    serp_urls = []
    for h in serp_hits or []:
        u = str((h or {}).get("url") or "").strip()
        if u:
            serp_urls.append(u)

    if hints:
        for u in serp_urls:
            if _host_matches(u, hints):
                _push(u)
        if not structural_locked and not prefer_defaults:
            for u in serp_urls:
                _push(u)
    else:
        for u in serp_urls:
            _push(u)

    return out[:max_pages]
