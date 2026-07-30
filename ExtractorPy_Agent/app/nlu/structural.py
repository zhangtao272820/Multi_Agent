"""Structural task infer — aligned with Extractor_Agent core/plan/structural.ts."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlparse

TargetSite = Literal[
    "douban", "zhihu", "weibo", "bilibili", "toutiao", "douyin", "jd", "qqmusic", "kugou", "generic"
]
ContentType = Literal["ranking", "news", "products", "qa", "videos", "music", "generic"]

CN_NUM = {
    "零": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "十": 10,
    "百": 100,
}


def parse_chinese_number(raw: str) -> int | None:
    s = (raw or "").strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    if s == "十":
        return 10
    if "十" in s:
        parts = s.split("十", 1)
        tens = CN_NUM.get(parts[0], 1) if parts[0] else 1
        ones = CN_NUM.get(parts[1], 0) if len(parts) > 1 and parts[1] else 0
        return tens * 10 + ones
    return CN_NUM.get(s)


@dataclass
class StructuralInfer:
    target_site: TargetSite = "generic"
    content_type: ContentType = "generic"
    limit: int | None = None
    fields: list[str] | None = None
    open_web_search: bool = False
    confidence: float = 0.0


_SITE_RULES: list[tuple[TargetSite, re.Pattern[str], re.Pattern[str] | None, ContentType, re.Pattern[str]]] = [
    ("zhihu", re.compile(r"知乎|zhihu", re.I), re.compile(r"微博|weibo|豆瓣|bilibili|哔哩|头条|douyin|抖音|京东", re.I), "ranking", re.compile(r"zhihu\.com", re.I)),
    ("weibo", re.compile(r"微博|weibo|新浪微博", re.I), re.compile(r"知乎|zhihu|豆瓣|bilibili|哔哩", re.I), "ranking", re.compile(r"weibo\.com", re.I)),
    ("douban", re.compile(r"豆瓣|douban", re.I), None, "ranking", re.compile(r"douban\.com", re.I)),
    ("bilibili", re.compile(r"bilibili|哔哩|B站|b站", re.I), None, "ranking", re.compile(r"bilibili\.com", re.I)),
    ("toutiao", re.compile(r"头条|toutiao", re.I), re.compile(r"知乎|微博", re.I), "ranking", re.compile(r"toutiao\.com", re.I)),
    ("douyin", re.compile(r"抖音|douyin", re.I), None, "ranking", re.compile(r"douyin\.com", re.I)),
    ("jd", re.compile(r"京东|jd\.com", re.I), None, "products", re.compile(r"jd\.com", re.I)),
]

_RANKING_HINT = re.compile(r"热榜|热搜|排行榜|榜单|top\s*\d+|前\s*[\d一二三四五六七八九十两百]+", re.I)
_URL_RE = re.compile(r"https?://[^\s<>\"']+", re.I)

# Known public entry seeds (capability defaults, lean)
SITE_DEFAULT_SEEDS: dict[str, list[str]] = {
    "zhihu": ["https://www.zhihu.com/hot"],
    "weibo": ["https://s.weibo.com/top/summary"],
    "douban": ["https://movie.douban.com/top250"],
    "bilibili": ["https://www.bilibili.com/v/popular/rank/all"],
    "toutiao": ["https://www.toutiao.com/"],
    "douyin": ["https://www.douyin.com/"],
    "jd": ["https://www.jd.com/"],
}


def parse_task_limit_structural(task: str) -> int | None:
    t = (task or "").strip()
    if not t:
        return None
    m = re.search(r"\btop\s*(\d+)\b", t, re.I)
    if m:
        n = int(m.group(1))
        return min(250, n) if n > 0 else None
    m = re.search(r"前\s*([一二三四五六七八九十两百\d]+)\s*(?:条|名|个|部|款)?", t, re.I)
    if m:
        raw = m.group(1)
        n = int(raw) if raw.isdigit() else parse_chinese_number(raw)
        if n and n > 0:
            return min(250, n)
    m = re.search(r"给(?:我|出)?\s*([一二三四五六七八九十两\d]+)\s*(?:条|名|个)?", t, re.I)
    if m:
        raw = m.group(1)
        n = int(raw) if raw.isdigit() else parse_chinese_number(raw)
        if n and n > 0:
            return min(250, n)
    return None


def infer_structural_task(task: str) -> StructuralInfer:
    t = (task or "").strip()
    out = StructuralInfer()
    if not t:
        return out

    limit = parse_task_limit_structural(t)
    if limit:
        out.limit = limit

    # URL host lock
    for m in _URL_RE.finditer(t):
        try:
            host = urlparse(m.group(0)).hostname or ""
        except Exception:
            continue
        for site, _kw, _ex, ctype, host_pat in _SITE_RULES:
            if host_pat.search(host):
                out.target_site = site
                out.content_type = ctype
                out.fields = ["title", "url", "excerpt"] if ctype == "ranking" else ["title", "url"]
                out.open_web_search = False
                out.confidence = 0.92
                return out

    for site, kw, exclude, ctype, _host in _SITE_RULES:
        if exclude and exclude.search(t):
            continue
        if kw.search(t):
            out.target_site = site
            out.content_type = ctype if _RANKING_HINT.search(t) or ctype == "products" else ctype
            out.fields = ["rank", "title", "url"] if ctype == "ranking" else ["title", "url"]
            out.open_web_search = False
            out.confidence = 0.85
            return out

    if _RANKING_HINT.search(t) and limit:
        out.content_type = "ranking"
        out.fields = ["title", "url", "excerpt"]
        out.confidence = 0.55
    return out
