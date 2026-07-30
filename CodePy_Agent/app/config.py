"""Env SSOT for CodePy (Manager-compatible CODE_* / OPENAI_*)."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path


def _load_dotenv() -> None:
    """Lightweight .env loader for local runs (compose already injects env)."""
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.is_file():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            key, _, val = s.partition("=")
            key = key.strip()
            if not key or key in os.environ:
                continue
            val = val.strip().strip('"').strip("'")
            if " #" in val:
                val = val.split(" #", 1)[0].rstrip()
            os.environ[key] = val
    except OSError:
        pass


_load_dotenv()


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
    port: int = 13103

    openai_api_key: str = ""
    openai_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    openai_model: str = "qwen-coder-plus"
    enable_thinking: bool = False
    llm_json_max_tokens: int = 896
    llm_timeout_sec: float = 120.0

    project_dir: str = "."
    allowed_roots: list[str] = []
    write_tool_enabled: bool = False
    mcp_server_enabled: bool = True
    edit_max_rounds: int = 8
    max_file_chars: int = 120_000

    clawhive_internal_token: str = ""

    def __init__(self) -> None:
        self.host = _env("HOST", "0.0.0.0") or "0.0.0.0"
        self.port = _env_int("CODE_PORT", _env_int("PORT", 13103, 1, 65535), 1, 65535)

        self.openai_api_key = _env("OPENAI_API_KEY") or _env("QWEN_API_KEY")
        self.openai_base_url = (
            _env("OPENAI_BASE_URL")
            or _env("QWEN_BASE_URL")
            or "https://dashscope.aliyuncs.com/compatible-mode/v1"
        ).rstrip("/")
        self.openai_model = (
            _env("OPENAI_MODEL")
            or _env("QWEN_MODEL")
            or _env("CAP_REASON")
            or _env("CAP_ROUTE")
            or "qwen-coder-plus"
        )
        thinking_raw = _env("QWEN_ENABLE_THINKING") or _env("CAP_ENABLE_THINKING") or "off"
        self.enable_thinking = thinking_raw.lower() in {"1", "true", "yes", "on"}
        self.llm_json_max_tokens = _env_int("AGENT_LLM_JSON_MAX_TOKENS", 896, 128, 4096)
        self.llm_timeout_sec = _env_int("AGENT_LLM_REQUEST_TIMEOUT_MS", 120000, 5000, 600000) / 1000.0

        pd = _env("PROJECT_DIR") or _env("CODE_PROJECT_DIR") or "."
        self.project_dir = str(Path(pd).expanduser().resolve())
        roots_raw = _env("ALLOWED_ROOTS") or _env("CODE_ALLOWED_ROOTS") or pd
        roots: list[str] = []
        for part in roots_raw.replace(";", ",").split(","):
            p = part.strip()
            if not p:
                continue
            roots.append(str(Path(p).expanduser().resolve()))
        if self.project_dir not in roots:
            roots.insert(0, self.project_dir)
        self.allowed_roots = roots

        self.write_tool_enabled = _env_bool("WRITE_TOOL_ENABLED", False)
        self.mcp_server_enabled = _env_bool("CODE_MCP_SERVER", True)
        self.edit_max_rounds = _env_int("CODE_EDIT_MAX_ROUNDS", 8, 1, 24)
        self.max_file_chars = _env_int("CODE_MAX_FILE_CHARS", 120_000, 4000, 500_000)

        self.clawhive_internal_token = _env("CLAWHIVE_INTERNAL_TOKEN")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reload_settings() -> Settings:
    get_settings.cache_clear()
    return get_settings()
