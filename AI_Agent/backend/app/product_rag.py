"""轻量产品 RAG：本地 markdown 分块 + 词重叠检索，注入 LLM context。"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

from .config import Settings, resolve_proj_path

logger = logging.getLogger(__name__)

_TOKEN = re.compile(r"[\w\u4e00-\u9fff]+", re.UNICODE)
_CORPUS_CACHE: dict[str, tuple[float, list["Chunk"]]] = {}


@dataclass
class Chunk:
    path: str
    title: str
    text: str
    tokens: set[str]


def _tokenize(text: str) -> set[str]:
    return {t.lower() for t in _TOKEN.findall(text) if len(t) > 1}


def _split_chunks(text: str, *, max_chars: int = 600) -> list[str]:
    parts = re.split(r"\n(?=#+\s)|(?=\n- )", text.strip())
    chunks: list[str] = []
    buf = ""
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if len(buf) + len(p) + 1 <= max_chars:
            buf = f"{buf}\n{p}".strip()
        else:
            if buf:
                chunks.append(buf)
            buf = p
    if buf:
        chunks.append(buf)
    return chunks or ([text.strip()] if text.strip() else [])


def load_corpus(settings: Settings) -> list[Chunk]:
    root = resolve_proj_path(settings.rag_products_dir)
    if not root.is_dir():
        logger.warning("RAG products dir missing: %s", root)
        return []
    out: list[Chunk] = []
    for path in sorted(root.rglob("*")):
        if path.suffix.lower() not in {".md", ".txt"}:
            continue
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as ex:
            logger.warning("read %s: %s", path, ex)
            continue
        title = path.stem
        for i, block in enumerate(_split_chunks(raw)):
            out.append(
                Chunk(
                    path=str(path.relative_to(root)),
                    title=f"{title}#{i}",
                    text=block,
                    tokens=_tokenize(f"{title} {block}"),
                )
            )
    return out


def _corpus(settings: Settings) -> list[Chunk]:
    root = resolve_proj_path(settings.rag_products_dir)
    key = str(root)
    mtime = 0.0
    if root.is_dir():
        try:
            mtime = max((p.stat().st_mtime for p in root.rglob("*")), default=0.0)
        except OSError:
            mtime = 0.0
    hit = _CORPUS_CACHE.get(key)
    if hit and hit[0] == mtime:
        return hit[1]
    chunks = load_corpus(settings)
    _CORPUS_CACHE[key] = (mtime, chunks)
    return chunks


def retrieve(
    settings: Settings,
    query: str,
    *,
    top_k: int | None = None,
) -> list[dict[str, Any]]:
    if not settings.rag_enabled:
        return []
    q = (query or "").strip()
    if not q:
        return []
    k = top_k or max(1, settings.rag_top_k)
    q_tokens = _tokenize(q)
    if not q_tokens:
        return []
    scored: list[tuple[float, Chunk]] = []
    for ch in _corpus(settings):
        if not ch.tokens:
            continue
        overlap = len(q_tokens & ch.tokens)
        if overlap <= 0:
            continue
        score = overlap / (len(q_tokens) ** 0.5)
        if any(t in ch.title.lower() for t in q_tokens):
            score += 0.5
        scored.append((score, ch))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [
        {
            "score": round(score, 3),
            "path": ch.path,
            "title": ch.title,
            "text": ch.text,
        }
        for score, ch in scored[:k]
    ]


def format_context(hits: list[dict[str, Any]]) -> str:
    if not hits:
        return ""
    blocks = []
    for i, h in enumerate(hits, 1):
        blocks.append(f"[{i}] ({h.get('path')})\n{h.get('text', '').strip()}")
    return (
        "以下是产品知识库检索结果，请只依据这些内容回答；不知则说不确定，勿编造：\n"
        + "\n\n".join(blocks)
    )


def build_user_message(
    settings: Settings, user_text: str
) -> tuple[str, list[dict[str, Any]]]:
    hits = retrieve(settings, user_text)
    ctx = format_context(hits)
    if not ctx:
        return user_text, hits
    return f"{ctx}\n\n用户问题：{user_text}", hits
