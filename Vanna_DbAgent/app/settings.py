from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env", override=False)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(ROOT / ".env"), extra="ignore")

    openai_api_key: str = ""
    openai_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    openai_model: str = "qwen-plus-2025-07-14"
    embedding_model: str = "text-embedding-v1"
    vanna_port: int = 13121
    vanna_data_dir: str = ".data"
    vanna_auto_ingest: bool = True
    vanna_checkpoint_default: bool = True
    vanna_scene_detect: bool = False
    vanna_polish: bool = True
    vanna_max_rows: int = 80
    vanna_default_limit: int = 50
    vanna_query_timeout_s: int = 30
    vanna_golden_min_score: float = 0.78
    vanna_max_llm_calls: int = 2
    vanna_max_embed_calls: int = 1
    vanna_max_ingest_embed_calls: int = 500
    vanna_max_repair_llm_calls: int = 1
    vanna_max_answer_llm_calls: int = 1
    vanna_max_prompt_chars: int = 6000
    vanna_router_max_tables: int = 4
    vanna_sql_card_tables: int = 6
    vanna_router_min_confidence_golden: float = 0.72
    vanna_router_min_confidence: float = 0.35
    vanna_max_question_chars: int = 400
    vanna_history_turns: int = 6
    vanna_mcp_token: str = ""
    vanna_default_tenant: str = "p2604"
    agent_service_auth: str = "off"
    agent_service_token: str = ""
    clawhive_internal_token: str = ""
    agent_internal_token: str = ""
    manager_ops_token: str = ""
    agent_database_url: str = ""
    clawhive_database_url: str = ""
    database_url: str = ""
    evo_allow_expert_auto_promote: bool = False
    experience_recall_confirmed_only: bool = True
    experience_standalone_exclude_federated: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()


def data_dir() -> Path:
    p = Path(get_settings().vanna_data_dir)
    if not p.is_absolute():
        p = ROOT / p
    p.mkdir(parents=True, exist_ok=True)
    return p
