from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = _BACKEND_DIR.parent

# 后加载的覆盖先加载的；进程环境变量（含 compose env_file 注入）仍优先于文件
_ENV_FILES = tuple(
    p
    for p in (
        PROJECT_ROOT / ".env",
        PROJECT_ROOT / ".env.local",
    )
    if p.is_file()
)


def resolve_proj_path(p: str | Path) -> Path:
    path = Path(p)
    return path.resolve() if path.is_absolute() else (PROJECT_ROOT / path).resolve()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_ENV_FILES or None,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    dashscope_api_key: str = ""
    openai_api_key: str = ""

    openai_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"

    asr_model: str = "qwen3-asr-flash"
    llm_model: str = "qwen-plus"
    tts_model: str = "qwen-tts"
    tts_voice: str = "Cherry"

    system_prompt: str = (
        "你是虚拟数字人助手「小艾」，对外说话风格固定、简短、口语化。"
        "硬性规则：每次只回答1到2句话，总字数不超过45字；先直接回应用户，不要展开背景、不要聊天气、不要主动寒暄延伸。"
        "禁止 emoji、颜文字、感叹号连用、省略号。"
        "相同或相近问候（如「你好」「在吗」「嗨」）必须固定回复：「你好，我是小艾，有什么可以帮你？」"
        "其他问题也先给结论，最多再补一句，保持每次措辞稳定。"
    )

    llm_temperature: float = 0.35

    cors_origins: str = (
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://localhost:5174,http://127.0.0.1:5174"
    )

    # client_rhythm=假口型（默认，无 GPU）| livetalking=真口型主路径
    # 兼容旧值 local_* / wan_s2v（不推荐）
    lip_sync_mode: str = "client_rhythm"
    lipsync_service_url: str = "http://127.0.0.1:8091"
    lipsync_backend: str = "ultralight"
    lipsync_stream_frames: bool = False
    lipsync_timeout_sec: int = 600
    wan_s2v_model: str = "wan2.2-s2v"
    wan_s2v_resolution: str = "480P"
    wan_poll_interval_sec: float = 15.0
    wan_wait_timeout_sec: int = 900
    assets_dir: str = "assets"
    avatar_video_path: str = "video/ai.mp4"
    avatar_image_path: str = ""

    # LiveTalking + FeatherTalk
    livetalking_url: str = "http://127.0.0.1:8010"
    livetalking_webrtc_url: str = "http://127.0.0.1:8010"
    livetalking_timeout_sec: int = 60
    livetalking_feed_audio: bool = True
    feathertalk_root: str = ".external/FeatherTalk"
    feathertalk_checkpoint: str = "assets/avatar_runtime/feathertalk"
    avatar_actions_dir: str = "assets/avatar_actions"

    # 情绪/动作导演 + 产品 RAG
    director_enabled: bool = True
    rag_enabled: bool = True
    rag_products_dir: str = "assets/products"
    rag_top_k: int = 3

    api_host: str = "0.0.0.0"
    api_port: int = 8080

    stream_llm: bool = True
    stream_tts: bool = True
    stream_tts_api: bool = False
    llm_max_tokens: int = 96
    stream_delta_throttle_ms: int = 60
    tts_first_chunk_chars: int = 8
    tts_pause_min_chars: int = 6
    tts_parallel_workers: int = 2


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    try:
        from .platform_config import apply_platform_models

        apply_platform_models(s)
    except Exception:
        pass
    return s


def api_key(settings: Settings) -> str:
    k = (settings.dashscope_api_key or settings.openai_api_key or "").strip()
    return k
