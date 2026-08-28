from functools import lru_cache
from os import getenv
from typing import Optional

from dotenv import load_dotenv
from pydantic import BaseModel, Field

# 配置分层：
# - 默认加载 `.env`（更适合 docker/部署）
# - 当 DEPLOY_MODE=local 时，若存在 `.env.local` 则覆盖加载（仅本机开发）
load_dotenv(override=False)
if getenv("DEPLOY_MODE", "local").lower() == "local":
    try:
        from pathlib import Path

        local_env = Path(__file__).resolve().parents[1] / ".env.local"
        if local_env.exists():
            load_dotenv(dotenv_path=local_env, override=True)
    except Exception:
        # 不阻断启动：没有本机专用 env 时继续走默认 `.env`/系统环境变量
        pass


class Settings(BaseModel):
    deploy_mode: str = Field(default_factory=lambda: getenv("DEPLOY_MODE", "local"))
    agent_control_mode: str = Field(
        default_factory=lambda: getenv(
            "AGENT_CONTROL_MODE",
            "docker" if getenv("DEPLOY_MODE", "local").lower() == "docker" else "local",
        )
    )
    k8s_namespace: str = Field(default_factory=lambda: getenv("K8S_NAMESPACE", "clawhive"))
    k8s_kubeconfig: str = Field(default_factory=lambda: getenv("KUBECONFIG", "") or getenv("K8S_KUBECONFIG", ""))
    compose_file_path: str = Field(
        default_factory=lambda: getenv(
            "COMPOSE_FILE_PATH",
            "e:\\Agent\\Manage-platform_Agent\\docker-compose.agents-lan.yml",
        )
    )
    compose_env_file_path: str = Field(
        default_factory=lambda: getenv(
            "COMPOSE_ENV_FILE_PATH",
            "e:\\Agent\\Manage-platform_Agent\\.env.agents-lan",
        )
    )
    qwen_api_key: str = Field(default_factory=lambda: getenv("QWEN_API_KEY", ""))
    qwen_base_url: str = Field(
        default_factory=lambda: getenv(
            "QWEN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"
        )
    )
    qwen_model: str = Field(default_factory=lambda: getenv("QWEN_MODEL", "qwen-plus"))
    qwen_planner_model: str = Field(default_factory=lambda: getenv("QWEN_PLANNER_MODEL", "qwen-plus"))
    qwen_executor_model: str = Field(default_factory=lambda: getenv("QWEN_EXECUTOR_MODEL", "qwen-plus"))
    qwen_temperature: float = Field(default_factory=lambda: float(getenv("QWEN_TEMPERATURE", "0.2")))
    allow_origins: list[str] = Field(
        default_factory=lambda: [
            origin.strip()
            for origin in getenv("ALLOW_ORIGINS", "http://localhost:5173").split(",")
            if origin.strip()
        ]
    )
    database_url: str = Field(
        default_factory=lambda: getenv(
            "DATABASE_URL",
            "postgresql+psycopg2://postgres:postgres@localhost:5432/clawhive",
        )
    )
    redis_url: str = Field(default_factory=lambda: getenv("REDIS_URL", "redis://localhost:6379/0"))
    jwt_secret: str = Field(default_factory=lambda: getenv("JWT_SECRET", "change-this-secret"))
    jwt_algorithm: str = Field(default_factory=lambda: getenv("JWT_ALGORITHM", "HS256"))
    jwt_expire_minutes: int = Field(default_factory=lambda: int(getenv("JWT_EXPIRE_MINUTES", "480")))
    admin_username: str = Field(default_factory=lambda: getenv("ADMIN_USERNAME", "admin"))
    admin_password: str = Field(default_factory=lambda: getenv("ADMIN_PASSWORD", "admin123"))
    workspace_root: str = Field(default_factory=lambda: getenv("WORKSPACE_ROOT", "e:\\Agent"))
    runtime_root: str = Field(default_factory=lambda: getenv("RUNTIME_ROOT", ".local\\runtime"))
    # 技能沙箱：隔离执行（进程级），并尽量限制网络访问
    skill_sandbox_timeout_seconds: int = Field(
        default_factory=lambda: int(getenv("SKILL_SANDBOX_TIMEOUT_SECONDS", "30"))
    )
    skill_sandbox_allowed_hosts: str = Field(
        default_factory=lambda: getenv("SKILL_SANDBOX_ALLOWED_HOSTS", "127.0.0.1,localhost")
    )
    db_agent_port: str = Field(default_factory=lambda: getenv("DB_PORT", "13101"))
    db_agent_host: str = Field(default_factory=lambda: getenv("DB_AGENT_HOST", "localhost"))
    rag_agent_port: str = Field(default_factory=lambda: getenv("RAG_PORT", "13102"))
    rag_agent_host: str = Field(default_factory=lambda: getenv("RAG_AGENT_HOST", "localhost"))
    code_agent_port: str = Field(default_factory=lambda: getenv("CODE_PORT", "13103"))
    code_agent_host: str = Field(default_factory=lambda: getenv("CODE_AGENT_HOST", "localhost"))
    extractor_agent_port: str = Field(default_factory=lambda: getenv("CRAWLER_PORT", "13104"))
    extractor_agent_host: str = Field(default_factory=lambda: getenv("EXTRACTOR_AGENT_HOST", "localhost"))
    ai_admin_agent_port: str = Field(default_factory=lambda: getenv("AI_ADMIN_PORT", "13105"))
    ai_admin_agent_host: str = Field(default_factory=lambda: getenv("AI_ADMIN_AGENT_HOST", "localhost"))
    manager_agent_port: str = Field(default_factory=lambda: getenv("MANAGER_PORT", "13106"))
    manager_agent_host: str = Field(default_factory=lambda: getenv("MANAGER_AGENT_HOST", "localhost"))
    multimodal_agent_port: str = Field(default_factory=lambda: getenv("MULTIMODAL_PORT", "13107"))
    multimodal_agent_host: str = Field(default_factory=lambda: getenv("MULTIMODAL_AGENT_HOST", "localhost"))
    lobster_agent_port: str = Field(default_factory=lambda: getenv("LOBSTER_PORT", "13108"))
    lobster_agent_host: str = Field(default_factory=lambda: getenv("LOBSTER_AGENT_HOST", "localhost"))
    tavern_agent_port: str = Field(default_factory=lambda: getenv("TAVERN_PORT", "13109"))
    tavern_agent_host: str = Field(default_factory=lambda: getenv("TAVERN_AGENT_HOST", "localhost"))
    video_agent_port: str = Field(default_factory=lambda: getenv("VIDEO_AGENT_PORT", "13111"))
    video_agent_host: str = Field(default_factory=lambda: getenv("VIDEO_AGENT_HOST", "localhost"))
    ai_agent_port: str = Field(default_factory=lambda: getenv("AI_AGENT_PORT", "13112"))
    ai_agent_host: str = Field(default_factory=lambda: getenv("AI_AGENT_HOST", "localhost"))
    clawhive_internal_token: str = Field(default_factory=lambda: getenv("CLAWHIVE_INTERNAL_TOKEN", ""))
    # Manager /api/manager/ops 要求 x-manager-ops-token；与 manager_agent 的 MANAGER_OPS_TOKEN 对齐
    manager_ops_token: str = Field(default_factory=lambda: getenv("MANAGER_OPS_TOKEN", ""))
    clawhive_image_tag: str = Field(default_factory=lambda: getenv("CLAWHIVE_IMAGE_TAG", "prod"))
    skill_registry_urls: str = Field(default_factory=lambda: getenv("SKILL_REGISTRY_URLS", ""))
    skill_registry_token: str = Field(default_factory=lambda: getenv("SKILL_REGISTRY_TOKEN", ""))
    skill_registry_cache_ttl_sec: int = Field(
        default_factory=lambda: int(getenv("SKILL_REGISTRY_CACHE_TTL_SEC", "300"))
    )
    skill_sync_on_install: bool = Field(
        default_factory=lambda: getenv("SKILL_SYNC_ON_INSTALL", "1").strip().lower() not in ("0", "false", "no")
    )
    skill_sync_agent_reload: bool = Field(
        default_factory=lambda: getenv("SKILL_SYNC_AGENT_RELOAD", "0").strip().lower() not in ("0", "false", "no")
    )
    skill_sync_reload_timeout_sec: int = Field(
        default_factory=lambda: int(getenv("SKILL_SYNC_RELOAD_TIMEOUT_SEC", "10"))
    )
    skill_install_require_published: bool = Field(
        default_factory=lambda: getenv("SKILL_INSTALL_REQUIRE_PUBLISHED", "1").strip().lower()
        not in ("0", "false", "no")
    )
    skill_registry_db_cache: bool = Field(
        default_factory=lambda: getenv("SKILL_REGISTRY_DB_CACHE", "1").strip().lower() not in ("0", "false", "no")
    )
    max_task_retries: int = Field(default_factory=lambda: int(getenv("MAX_TASK_RETRIES", "2")))
    default_tenant_quota_tokens: int = Field(
        default_factory=lambda: int(getenv("CLAWHIVE_DEFAULT_TENANT_QUOTA_TOKENS", "0"))
    )
    quota_hard_limit_enabled: bool = Field(
        default_factory=lambda: getenv("CLAWHIVE_QUOTA_HARD_LIMIT", "1").strip().lower() not in ("0", "false", "no")
    )
    prometheus_base_url: str = Field(
        default_factory=lambda: getenv(
            "PROMETHEUS_BASE_URL",
            "http://prometheus:9090" if getenv("DEPLOY_MODE", "local").lower() == "docker" else "http://127.0.0.1:9090",
        )
    )
    grafana_public_url: str = Field(
        default_factory=lambda: getenv(
            "GRAFANA_PUBLIC_URL",
            f"http://127.0.0.1:{getenv('CLAWHIVE_GRAFANA_PORT', '13000')}",
        )
    )
    tempo_base_url: str = Field(
        default_factory=lambda: getenv(
            "TEMPO_BASE_URL",
            "http://tempo:3200" if getenv("DEPLOY_MODE", "local").lower() == "docker" else "http://127.0.0.1:3200",
        )
    )
    loki_base_url: str = Field(
        default_factory=lambda: getenv(
            "LOKI_BASE_URL",
            "http://loki:3100" if getenv("DEPLOY_MODE", "local").lower() == "docker" else "http://127.0.0.1:3100",
        )
    )
    # P2b LiteLLM egress gateway
    litellm_enabled: bool = Field(
        default_factory=lambda: getenv("LITELLM_ENABLED", "0").strip().lower() in ("1", "true", "yes", "on")
    )
    litellm_base_url: str = Field(
        default_factory=lambda: getenv("LITELLM_BASE_URL", "http://litellm:4000/v1").strip()
        or "http://litellm:4000/v1"
    )
    litellm_master_key: str = Field(
        default_factory=lambda: getenv("LITELLM_MASTER_KEY", "sk-clawhive-litellm").strip()
    )
    # Langfuse (LLM observability)
    langfuse_public_url: str = Field(
        default_factory=lambda: getenv(
            "LANGFUSE_PUBLIC_URL",
            f"http://127.0.0.1:{getenv('CLAWHIVE_LANGFUSE_PORT', '13001')}",
        )
    )
    langfuse_base_url: str = Field(
        default_factory=lambda: getenv(
            "LANGFUSE_BASE_URL",
            "http://langfuse:3000" if getenv("DEPLOY_MODE", "local").lower() == "docker" else "http://127.0.0.1:13001",
        )
    )
    # P1b-3 OIDC / SSO（未启用时仅本地密码登录）
    oidc_enabled: bool = Field(
        default_factory=lambda: getenv("OIDC_ENABLED", "0").strip().lower() in ("1", "true", "yes", "on")
    )
    oidc_issuer: str = Field(default_factory=lambda: getenv("OIDC_ISSUER", "").strip())
    oidc_client_id: str = Field(default_factory=lambda: getenv("OIDC_CLIENT_ID", "").strip())
    oidc_client_secret: str = Field(default_factory=lambda: getenv("OIDC_CLIENT_SECRET", "").strip())
    oidc_redirect_uri: str = Field(default_factory=lambda: getenv("OIDC_REDIRECT_URI", "").strip())
    oidc_scopes: str = Field(default_factory=lambda: getenv("OIDC_SCOPES", "openid profile email").strip())
    oidc_role_claim: str = Field(default_factory=lambda: getenv("OIDC_ROLE_CLAIM", "roles").strip() or "roles")
    oidc_tenant_claim: str = Field(
        default_factory=lambda: getenv("OIDC_TENANT_CLAIM", "tenant_id").strip() or "tenant_id"
    )
    oidc_frontend_callback_url: str = Field(
        default_factory=lambda: getenv(
            "OIDC_FRONTEND_CALLBACK_URL",
            f"http://127.0.0.1:{getenv('CLAWHIVE_FRONTEND_PORT', '18073')}/",
        ).strip()
    )
    cors_allow_origin_regex: Optional[str] = Field(default_factory=lambda: _default_cors_allow_origin_regex())


def _default_cors_allow_origin_regex() -> Optional[str]:
    """Docker/LAN：放行管理台与 1A Agent UI Origin（本地登录跨域调 /api/auth/login）。"""
    explicit = getenv("CLAWHIVE_CORS_ALLOW_ORIGIN_REGEX", "").strip()
    if explicit.lower() == "none":
        return None
    if explicit:
        return explicit
    if getenv("DEPLOY_MODE", "local").lower() != "docker":
        # 本机直连各 Agent 端口登录时也放行常见端口
        ports = (
            getenv("CLAWHIVE_FRONTEND_PORT", "18073"),
            getenv("CLAWHIVE_BACKEND_PORT", "18000"),
            getenv("DB_PORT", "13101"),
            getenv("VANNA_WEB_PORT", "13120"),
            getenv("VANNA_PORT", "13121"),
            getenv("RAG_PORT", "13102"),
            getenv("CODE_PORT", "13103"),
            getenv("CRAWLER_PORT", "13104"),
            getenv("AI_ADMIN_PORT", "13105"),
            getenv("MANAGER_PORT", "13106"),
            getenv("MULTIMODAL_PORT", "13107"),
            getenv("LOBSTER_PORT", "13108"),
            getenv("MUSIC_AGENT_PORT", "13110"),
            getenv("VIDEO_AGENT_PORT", "13111"),
        )
        joined = "|".join(dict.fromkeys(str(p).strip() for p in ports if str(p).strip()))
        return rf"^https?://(localhost|127\.0\.0\.1|[\w.-]+):({joined})$"
    fe = getenv("CLAWHIVE_FRONTEND_PORT", "18073")
    be = getenv("CLAWHIVE_BACKEND_PORT", "18000")
    agent_ports = "|".join(
        [
            fe,
            be,
            getenv("DB_PORT", "13101"),
            getenv("VANNA_WEB_PORT", "13120"),
            getenv("VANNA_PORT", "13121"),
            getenv("RAG_PORT", "13102"),
            getenv("CODE_PORT", "13103"),
            getenv("CRAWLER_PORT", "13104"),
            getenv("AI_ADMIN_PORT", "13105"),
            getenv("MANAGER_PORT", "13106"),
            getenv("MULTIMODAL_PORT", "13107"),
            getenv("LOBSTER_PORT", "13108"),
            getenv("MUSIC_AGENT_PORT", "13110"),
            getenv("VIDEO_AGENT_PORT", "13111"),
        ]
    )
    return rf"^https?://[\w.-]+:({agent_ports})$"


@lru_cache
def get_settings() -> Settings:
    return Settings()
