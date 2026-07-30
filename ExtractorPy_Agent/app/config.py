"""Env SSOT for ExtractorPy (Manager-compatible CRAWLER_* / MCP_*)."""

from __future__ import annotations

import os
from functools import lru_cache


def _env(name: str, default: str = "") -> str:
    return str(os.environ.get(name, default) or "").strip()


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None or str(v).strip() == "":
        return default
    return str(v).strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, lo: int | None = None, hi: int | None = None) -> int:
    try:
        n = int(str(os.environ.get(name, default)).strip())
    except (TypeError, ValueError):
        n = default
    if lo is not None:
        n = max(lo, n)
    if hi is not None:
        n = min(hi, n)
    return n


class Settings:
    host: str = "0.0.0.0"
    port: int = 13104

    qwen_api_key: str = ""
    qwen_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    # T0 CAP_ROUTE（省 token）；勿默认 CAP_REASON
    qwen_model: str = "qwen-turbo"
    enable_thinking: bool = False
    llm_json_max_tokens: int = 512
    llm_max_pages: int = 3
    llm_page_chars: int = 1200
    task_max_chars: int = 2000
    plan_max_tokens: int = 384

    web_search_enabled: bool = True
    searxng_base_url: str = "http://searxng:8080"
    searxng_timeout_ms: int = 25000
    web_search_max_seeds: int = 6

    mcp_provider: str = "firecrawl"
    mcp_base_url: str = "http://crw:3000/v1/scrape"
    mcp_api_key: str = "local"
    mcp_render: bool = True
    mcp_max_calls: int = 12

    playwright_mcp_url: str = "http://playwright_mcp:8931/mcp"
    playwright_mcp_enabled: bool = True

    async_queue: bool = True
    max_concurrency: int = 3
    default_max_items: int = 20
    default_max_pages: int = 5
    request_timeout_ms: int = 60000

    clawhive_internal_token: str = ""

    def __init__(self) -> None:
        self.host = _env("HOST", "0.0.0.0") or "0.0.0.0"
        self.port = _env_int("CRAWLER_PORT", _env_int("PORT", 13104, 1, 65535), 1, 65535)

        self.qwen_api_key = _env("QWEN_API_KEY")
        self.qwen_base_url = (
            _env("QWEN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1").rstrip("/")
            or "https://dashscope.aliyuncs.com/compatible-mode/v1"
        )
        # 对齐能力层：QWEN_MODEL ← CAP_ROUTE（compose / ClawHive sync）
        self.qwen_model = (
            _env("QWEN_MODEL")
            or _env("CAP_ROUTE")
            or "qwen-turbo"
        )
        thinking_raw = _env("QWEN_ENABLE_THINKING") or _env("CAP_ENABLE_THINKING") or "off"
        self.enable_thinking = thinking_raw.lower() in {"1", "true", "yes", "on"}
        self.llm_json_max_tokens = _env_int("AGENT_LLM_JSON_MAX_TOKENS", 512, 128, 2048)
        self.llm_max_pages = _env_int("EXTRACTOR_LLM_MAX_PAGES", 3, 1, 8)
        self.llm_page_chars = _env_int("EXTRACTOR_LLM_PAGE_CHARS", 1200, 400, 6000)
        self.task_max_chars = _env_int("EXTRACTOR_TASK_MAX_CHARS", 2000, 200, 8000)
        self.plan_max_tokens = _env_int("EXTRACTOR_PLAN_MAX_TOKENS", 384, 128, 1024)

        self.web_search_enabled = _env_bool("EXTRACTOR_WEB_SEARCH", True)
        self.searxng_base_url = (
            _env("SEARXNG_BASE_URL", _env("EXTRACTOR_SEARXNG_BASE_URL", "http://searxng:8080")).rstrip("/")
            or "http://searxng:8080"
        )
        self.searxng_timeout_ms = _env_int("SEARXNG_TIMEOUT_MS", 25000, 3000, 120000)
        self.web_search_max_seeds = _env_int("EXTRACTOR_WEB_SEARCH_MAX_SEEDS", 6, 1, 12)

        self.mcp_provider = (_env("MCP_PROVIDER", "firecrawl") or "firecrawl").lower()
        self.mcp_base_url = _env("MCP_BASE_URL", "http://crw:3000/v1/scrape") or "http://crw:3000/v1/scrape"
        self.mcp_api_key = _env("MCP_API_KEY", "local") or "local"
        self.mcp_render = _env_bool("MCP_RENDER", True)
        self.mcp_max_calls = _env_int("EXTRACTOR_MCP_MAX_CALLS", 12, 0, 64)

        self.playwright_mcp_url = (
            _env("PLAYWRIGHT_MCP_URL", "http://playwright_mcp:8931/mcp").rstrip("/")
            or "http://playwright_mcp:8931/mcp"
        )
        self.playwright_mcp_enabled = _env_bool("PLAYWRIGHT_MCP_ENABLED", True)

        self.async_queue = _env_bool("EXTRACTOR_ASYNC_QUEUE", True)
        self.max_concurrency = _env_int("CRAWLER_MAX_CONCURRENCY", 3, 1, 16)
        self.default_max_items = _env_int("CRAWLER_DEFAULT_MAX_ITEMS", 20, 1, 100)
        self.default_max_pages = _env_int("CRAWLER_DEFAULT_MAX_PAGES", 5, 1, 30)
        self.request_timeout_ms = _env_int("EXTRACTOR_REQUEST_TIMEOUT_MS", 60000, 5000, 300000)

        self.clawhive_internal_token = _env("CLAWHIVE_INTERNAL_TOKEN")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
