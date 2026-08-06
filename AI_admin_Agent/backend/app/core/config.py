import os
from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

load_dotenv()

def _env_str(name: str, default: str) -> str:
    """
    Read env var; treat empty/whitespace as missing.
    This avoids Docker env like WORKSPACE_DIR="" breaking path logic.
    """
    v = os.getenv(name)
    if v is None:
        return default
    v = str(v).strip()
    return v if v else default


def _parse_cors_origins(raw_value: str) -> list[str]:
    if not raw_value:
        return ["http://localhost:5173"]
    return [origin.strip() for origin in raw_value.split(",") if origin.strip()]

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    PROJECT_NAME: str = "Personal Assistant Agent"
    DASHSCOPE_API_KEY: str = os.getenv("DASHSCOPE_API_KEY", "")
    PORT: int = int(os.getenv("PORT", 8000))
    HOST: str = os.getenv("HOST", "0.0.0.0")
    CORS_ORIGINS: str = os.getenv("CORS_ORIGINS", "http://localhost:5173")
    
    # Model settings
    MODEL_NAME: str = os.getenv("MODEL_NAME", "qwen-plus-2025-07-28")

    # Timezone settings (for parsing/scheduling/display)
    TIMEZONE: str = os.getenv("TIMEZONE", "Asia/Shanghai")
    
    # Workspace settings
    WORKSPACE_DIR: str = _env_str(
        "WORKSPACE_DIR",
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "workspace"),
    )
    
    # SMTP Email settings
    SMTP_SERVER: str = os.getenv("SMTP_SERVER", "smtp.qq.com")
    SMTP_PORT: int = int(os.getenv("SMTP_PORT", 465))
    SMTP_USER: str = os.getenv("SMTP_USER", "")
    SMTP_PASS: str = os.getenv("SMTP_PASS", "")
    IMAP_SERVER: str = os.getenv("IMAP_SERVER", "")
    IMAP_PORT: int = int(os.getenv("IMAP_PORT", 993))
    IMAP_USER: str = os.getenv("IMAP_USER", "")
    IMAP_PASS: str = os.getenv("IMAP_PASS", "")
    # Per-user mailbox binding (Fernet). Public default: no global .env fallback.
    ADMIN_MAIL_FERNET_KEY: str = os.getenv("ADMIN_MAIL_FERNET_KEY", "")
    ADMIN_MAIL_ALLOW_GLOBAL_FALLBACK: bool = os.getenv(
        "ADMIN_MAIL_ALLOW_GLOBAL_FALLBACK", "0"
    ).strip().lower() in ("1", "true", "yes", "on")

    # Weather API settings (QWeather)
    WEATHER_API_KEY: str = os.getenv("WEATHER_API_KEY", "")
    WEATHER_API_HOST: str = os.getenv("WEATHER_API_HOST", "")
    WEATHER_CACHE_TTL_SECONDS: int = int(os.getenv("WEATHER_CACHE_TTL_SECONDS", 900))
    WEATHER_RATE_LIMIT_SECONDS: int = int(os.getenv("WEATHER_RATE_LIMIT_SECONDS", 60))

    # Token consumption control
    MAX_TOKENS_PER_REQUEST: int = int(os.getenv("MAX_TOKENS_PER_REQUEST", 2000))
    MAX_TOKENS_PER_SESSION: int = int(os.getenv("MAX_TOKENS_PER_SESSION", 10000))

    # Batch 0: memory & playbook
    ADMIN_LOAD_PLAYBOOK: bool = os.getenv("ADMIN_LOAD_PLAYBOOK", "1").strip().lower() not in (
        "0",
        "false",
        "no",
    )
    ADMIN_AUTO_LEARN_PREFS: bool = os.getenv("ADMIN_AUTO_LEARN_PREFS", "1").strip().lower() not in (
        "0",
        "false",
        "no",
    )

    # Batch 1: RAG / 搜索 / 画像
    RAG_AGENT_URL: str = _env_str("RAG_AGENT_URL", os.getenv("RAG_AGENT_HTTP_URL", ""))
    RAG_RETRIEVE_TIMEOUT_SECONDS: float = float(os.getenv("RAG_RETRIEVE_TIMEOUT_SECONDS", "25"))
    RAG_SKIP_EVIDENCE_SELECT: bool = os.getenv("RAG_SKIP_EVIDENCE_SELECT", "0").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    ADMIN_SEARCH_PROVIDER: str = _env_str("ADMIN_SEARCH_PROVIDER", "auto")
    WEB_SEARCH_TIMEOUT_SECONDS: float = float(os.getenv("WEB_SEARCH_TIMEOUT_SECONDS", "15"))
    SEARXNG_BASE_URL: str = _env_str("SEARXNG_BASE_URL", "")
    SEARXNG_LANGUAGE: str = _env_str("SEARXNG_LANGUAGE", "zh-CN")
    SEARXNG_CATEGORIES: str = _env_str("SEARXNG_CATEGORIES", "")
    SEARXNG_TIMEOUT_SECONDS: float = float(os.getenv("SEARXNG_TIMEOUT_SECONDS", "20"))
    ADMIN_DIALOGUE_SUMMARY: bool = os.getenv("ADMIN_DIALOGUE_SUMMARY", "1").strip().lower() not in (
        "0",
        "false",
        "no",
    )
    ADMIN_DIALOGUE_MAX_TURNS: int = int(os.getenv("ADMIN_DIALOGUE_MAX_TURNS", "6"))
    ADMIN_TURN_SCOPE_LLM: bool = os.getenv("ADMIN_TURN_SCOPE_LLM", "1").strip().lower() not in (
        "0",
        "false",
        "no",
    )

    # Batch 2: prompt evolution
    ADMIN_PROMPT_EVOLUTION: bool = os.getenv("ADMIN_PROMPT_EVOLUTION", "1").strip().lower() not in (
        "0",
        "false",
        "no",
    )
    ADMIN_PROMOTE_MIN_HITS: int = int(os.getenv("ADMIN_PROMOTE_MIN_HITS", "3"))
    ADMIN_AUTO_CURATE: bool = os.getenv("ADMIN_AUTO_CURATE", "1").strip().lower() not in (
        "0",
        "false",
        "no",
    )

    # Batch 3: integrations
    ADMIN_MCP_ENABLED: bool = os.getenv("ADMIN_MCP_ENABLED", "0").strip().lower() not in (
        "0",
        "false",
        "no",
    )
    ADMIN_MCP_SERVERS: str = _env_str("ADMIN_MCP_SERVERS", "")
    ADMIN_MCP_URL: str = _env_str("ADMIN_MCP_URL", "")
    ADMIN_WEBHOOK_URL: str = _env_str("ADMIN_WEBHOOK_URL", "")
    ADMIN_WEBHOOK_FORMAT: str = _env_str("ADMIN_WEBHOOK_FORMAT", "generic")
    ADMIN_LANGGRAPH_CHECKPOINTER: bool = os.getenv("ADMIN_LANGGRAPH_CHECKPOINTER", "0").strip() == "1"
    ADMIN_CALENDAR_ICS_URL: str = _env_str("ADMIN_CALENDAR_ICS_URL", "")

    # Batch 4: 问数 / 协作
    DB_AGENT_HTTP_URL: str = _env_str("DB_AGENT_HTTP_URL", "")
    DB_AGENT_DB_ID: str = _env_str("DB_AGENT_DB_ID", os.getenv("DB_AGENT_DEFAULT_DB_ID", "default"))
    DB_ASK_TIMEOUT_SECONDS: float = float(os.getenv("DB_ASK_TIMEOUT_SECONDS", "60"))
    ADMIN_WECOM_WEBHOOK_URL: str = _env_str("ADMIN_WECOM_WEBHOOK_URL", "")
    ADMIN_DINGTALK_WEBHOOK_URL: str = _env_str("ADMIN_DINGTALK_WEBHOOK_URL", "")

    # Batch 5: Lobster / 高德 / 飞书 / 短信
    LOBSTER_AGENT_HTTP_URL: str = _env_str("LOBSTER_AGENT_HTTP_URL", "")
    LOBSTER_TIMEOUT_SECONDS: float = float(os.getenv("LOBSTER_TIMEOUT_SECONDS", "30"))
    LOBSTER_POLL_MAX_SECONDS: float = float(os.getenv("LOBSTER_POLL_MAX_SECONDS", "90"))
    LOBSTER_POLL_INTERVAL_SECONDS: float = float(os.getenv("LOBSTER_POLL_INTERVAL_SECONDS", "3"))
    ADMIN_AMAP_KEY: str = _env_str("ADMIN_AMAP_KEY", "")
    ADMIN_AMAP_CITY: str = _env_str("ADMIN_AMAP_CITY", "")
    ADMIN_FEISHU_ICS_URL: str = _env_str("ADMIN_FEISHU_ICS_URL", "")

    # Batch 6: 集成清单 / 飞书 / 多日历
    ADMIN_FEISHU_WEBHOOK_URL: str = _env_str("ADMIN_FEISHU_WEBHOOK_URL", "")
    ADMIN_CALENDAR_SUBSCRIPTIONS: str = _env_str("ADMIN_CALENDAR_SUBSCRIPTIONS", "")
    ADMIN_FEISHU_MCP_URL: str = _env_str("ADMIN_FEISHU_MCP_URL", "")

    def get_cors_origins(self) -> list[str]:
        origins = _parse_cors_origins(self.CORS_ORIGINS)
        # 内置 Web UI 常见访问地址（Docker 映射 13105）
        for extra in (
            "http://localhost:13105",
            "http://127.0.0.1:13105",
            f"http://localhost:{self.PORT}",
            f"http://127.0.0.1:{self.PORT}",
        ):
            if extra not in origins:
                origins.append(extra)
        return origins

    def get_cors_origin_regex(self) -> str:
        raw = os.getenv("ADMIN_CORS_ORIGIN_REGEX", "").strip()
        if raw:
            return raw
        # 允许本机 / 局域网任意端口（WebSocket 握手受 CORS Origin 校验）
        return r"https?://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?"

settings = Settings()
