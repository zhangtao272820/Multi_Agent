from openai import OpenAI

from .config import get_settings
from .metrics import llm_calls_total


class QwenClient:
    """控制面 LLM 客户端：缺 key 时不在 import/构造阶段崩溃。"""

    def __init__(self) -> None:
        self.settings = get_settings()
        self._client: OpenAI | None = None

    @property
    def client(self) -> OpenAI | None:
        if self._client is not None:
            return self._client
        key = str(self.settings.qwen_api_key or "").strip()
        if not key:
            return None
        self._client = OpenAI(
            api_key=key,
            base_url=self.settings.qwen_base_url,
        )
        return self._client

    def chat(self, system_prompt: str, user_prompt: str, model: str | None = None) -> str:
        llm_calls_total.inc()
        if not self.settings.qwen_api_key or self.client is None:
            return "未配置 QWEN_API_KEY，当前返回平台模拟响应。"

        response = self.client.chat.completions.create(
            model=model or self.settings.qwen_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=self.settings.qwen_temperature,
        )
        content = response.choices[0].message.content
        return content if content else "模型返回了空结果。"
