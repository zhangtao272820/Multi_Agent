import os

import dashscope
from app.core.config import settings
from app.core.platform_config import effective_model_name
from typing import List, Dict, Any, Optional


def _api_key() -> str:
    return str(settings.DASHSCOPE_API_KEY or os.getenv("OPENAI_API_KEY") or "").strip()


def _openai_base_url() -> str:
    return str(os.getenv("OPENAI_BASE_URL") or os.getenv("DASHSCOPE_BASE_URL") or "").strip()


def _use_openai_compatible() -> bool:
    return bool(_openai_base_url() and _api_key())


def _llm_timeout_sec() -> float:
    raw = os.getenv("AGENT_LLM_REQUEST_TIMEOUT_MS") or os.getenv("ADMIN_LLM_REQUEST_TIMEOUT_MS") or "120000"
    try:
        ms = float(raw)
    except (TypeError, ValueError):
        ms = 120_000.0
    return max(8.0, min(180.0, ms / 1000.0))


def _llm_json_max_tokens() -> int:
    raw = os.getenv("AGENT_LLM_JSON_MAX_TOKENS") or "896"
    try:
        n = int(raw)
    except (TypeError, ValueError):
        n = 896
    return max(128, min(4096, n))


def _llm_synth_max_tokens() -> int:
    raw = os.getenv("AGENT_LLM_SYNTH_MAX_TOKENS") or "2048"
    try:
        n = int(raw)
    except (TypeError, ValueError):
        n = 2048
    return max(256, min(8192, n))


def _read_qwen_enable_thinking(stream: bool) -> bool:
    raw = str(os.getenv("QWEN_ENABLE_THINKING") or os.getenv("CAP_ENABLE_THINKING") or "0").strip().lower()
    enabled = raw in ("1", "true", "yes", "on")
    # 百炼 OpenAI 兼容：非流式必须 enable_thinking=false
    if not stream:
        return False
    return enabled


def _is_qwen3_hybrid(model: str) -> bool:
    return str(model or "").strip().lower().startswith("qwen3")


def _openai_extra_body(model: str, stream: bool) -> Optional[Dict[str, Any]]:
    if not _is_qwen3_hybrid(model):
        return None
    return {"enable_thinking": _read_qwen_enable_thinking(stream)}


def _dashscope_call_with_timeout(**kwargs):
    """dashscope.Generation.call 补超时：优先原生 timeout，否则线程池硬切。"""
    timeout = _llm_timeout_sec()
    try:
        return dashscope.Generation.call(timeout=timeout, **kwargs)
    except TypeError:
        from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

        with ThreadPoolExecutor(max_workers=1) as pool:
            fut = pool.submit(dashscope.Generation.call, **kwargs)
            try:
                return fut.result(timeout=timeout)
            except FuturesTimeout as e:
                fut.cancel()
                raise TimeoutError(f"dashscope Generation.call timed out after {timeout:.0f}s") from e


class QwenLLM:
    def __init__(self, model: str = None):
        self.model = effective_model_name(model or settings.MODEL_NAME)
        dashscope.api_key = settings.DASHSCOPE_API_KEY

    def _resolve_model(self) -> str:
        return effective_model_name(self.model or settings.MODEL_NAME)

    def chat(
        self,
        messages: List[Dict[str, str]],
        stream: bool = False,
        *,
        max_tokens: int | None = None,
    ):
        model = self._resolve_model()
        extra: Dict[str, Any] = {}
        if _is_qwen3_hybrid(model):
            extra["enable_thinking"] = _read_qwen_enable_thinking(stream)
        if max_tokens is not None:
            extra["max_tokens"] = max_tokens
        response = _dashscope_call_with_timeout(
            model=model,
            messages=messages,
            result_format='message',
            stream=stream,
            incremental_output=stream,
            **extra
        )
        return response

    def _chat_openai_compatible(
        self,
        messages: List[Dict[str, str]],
        stream: bool = False,
        *,
        max_tokens: int | None = None,
    ):
        from openai import OpenAI

        client = OpenAI(
            api_key=_api_key(),
            base_url=_openai_base_url(),
            timeout=_llm_timeout_sec(),
            max_retries=int(os.getenv("AGENT_LLM_MAX_RETRIES") or "0") or 0,
        )
        model = self._resolve_model()
        extra_body = _openai_extra_body(model, stream)
        kwargs: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": stream,
            "max_tokens": max_tokens or _llm_synth_max_tokens(),
        }
        if extra_body:
            kwargs["extra_body"] = extra_body
        return client.chat.completions.create(**kwargs)

    def chat_text(self, messages: List[Dict[str, str]], *, max_tokens: int | None = None) -> str:
        """
        Safe non-stream chat helper.
        Raises a descriptive RuntimeError instead of leaking NoneType failures.
        """
        if _use_openai_compatible():
            try:
                response = self._chat_openai_compatible(
                    messages, stream=False, max_tokens=max_tokens or _llm_synth_max_tokens()
                )
                content = response.choices[0].message.content
                if content is not None:
                    return str(content)
            except Exception as e:
                raise RuntimeError(
                    f"LLM response has no text content (provider=openai_compatible, "
                    f"message={e}, model={self._resolve_model()})"
                ) from e
            raise RuntimeError(
                f"LLM response has no text content (provider=openai_compatible, model={self._resolve_model()})"
            )

        response = self.chat(messages, stream=False, max_tokens=max_tokens)
        try:
            content = response.output.choices[0].message.content
            if content is not None:
                return str(content)
        except Exception:
            pass

        status_code = getattr(response, "status_code", None)
        code = getattr(response, "code", None)
        message = getattr(response, "message", None)
        request_id = getattr(response, "request_id", None)
        raise RuntimeError(
            f"LLM response has no text content "
            f"(status_code={status_code}, code={code}, message={message}, request_id={request_id}, model={self._resolve_model()})"
        )

    def chat_text_stream(self, messages: List[Dict[str, str]], *, max_tokens: int | None = None):
        """
        用户可见终答流：yield ("reasoning"|"content", text)。
        百炼混合模型仅在 stream=True 时可开 enable_thinking。
        """
        mt = max_tokens or _llm_synth_max_tokens()
        if _use_openai_compatible():
            stream = self._chat_openai_compatible(messages, stream=True, max_tokens=mt)
            for chunk in stream:
                choice = (chunk.choices or [None])[0]
                if not choice:
                    continue
                delta = getattr(choice, "delta", None)
                if not delta:
                    continue
                rc = getattr(delta, "reasoning_content", None)
                if isinstance(rc, str) and rc:
                    yield ("reasoning", rc)
                content = getattr(delta, "content", None)
                if isinstance(content, str) and content:
                    yield ("content", content)
            return

        response = self.chat(messages, stream=True, max_tokens=mt)
        for chunk in response:
            try:
                msg = chunk.output.choices[0].message
            except Exception:
                continue
            rc = getattr(msg, "reasoning_content", None)
            if isinstance(rc, str) and rc:
                yield ("reasoning", rc)
            content = getattr(msg, "content", None)
            if isinstance(content, str) and content:
                yield ("content", content)

    def chat_text_json(self, messages: List[Dict[str, str]]) -> str:
        """结构化 JSON 输出：较短 max_tokens，加快 NLU/路由类调用。"""
        return self.chat_text(messages, max_tokens=_llm_json_max_tokens())

    def _api_key_configured(self) -> bool:
        return bool(_api_key())

    def validate_config(self) -> Dict[str, Any]:
        """
        Config-only health check for /api/health — must NOT call the LLM (platform probes every ~20s).
        """
        model = self._resolve_model()
        api_key_ok = self._api_key_configured()
        return {
            "ok": bool(api_key_ok and model),
            "model": model,
            "api_key_configured": api_key_ok,
            "provider": "openai_compatible" if _use_openai_compatible() else "dashscope_native",
            "probe": "config_only",
        }

    def get_token_count(self, text: str) -> int:
        return len(text) // 2


qwen_llm = QwenLLM()
