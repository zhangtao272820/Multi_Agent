from __future__ import annotations

import os
from collections.abc import Callable

from openai import OpenAI

from app.settings import get_settings


def _forbid_live_model() -> None:
    """契约 smoke 禁止真调模型/向量（省 token）。测试须 mock。"""
    flag = str(os.getenv("VANNA_SMOKE") or os.getenv("VANNA_FORBID_LLM") or "").strip().lower()
    if flag in {"1", "true", "yes", "on"}:
        raise RuntimeError(
            "llm_forbidden_in_smoke: set VANNA_SMOKE=0 only for intentional live calls; "
            "contract tests must patch chat_json/run_router/embed_texts"
        )


class LlmMeter:
    def __init__(
        self,
        *,
        max_llm_calls: int | None = None,
        max_embed_calls: int | None = None,
        max_repair_llm_calls: int | None = None,
        max_answer_llm_calls: int | None = None,
    ) -> None:
        self.llm_calls = 0
        self.embed_calls = 0
        self.repair_calls = 0
        self.answer_calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.max_llm_calls = max_llm_calls
        self.max_embed_calls = max_embed_calls
        self.max_repair_llm_calls = max_repair_llm_calls
        self.max_answer_llm_calls = max_answer_llm_calls

    def llm_cap(self) -> int:
        if self.max_llm_calls is not None:
            return int(self.max_llm_calls)
        return int(get_settings().vanna_max_llm_calls)

    def embed_cap(self) -> int:
        if self.max_embed_calls is not None:
            return int(self.max_embed_calls)
        return int(get_settings().vanna_max_embed_calls)

    def repair_cap(self) -> int:
        if self.max_repair_llm_calls is not None:
            return int(self.max_repair_llm_calls)
        return int(get_settings().vanna_max_repair_llm_calls)

    def answer_cap(self) -> int:
        if self.max_answer_llm_calls is not None:
            return int(self.max_answer_llm_calls)
        return int(get_settings().vanna_max_answer_llm_calls)

    def as_dict(self) -> dict:
        return {
            "llm_calls": self.llm_calls,
            "embed_calls": self.embed_calls,
            "repair_calls": self.repair_calls,
            "answer_calls": self.answer_calls,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
        }


def client() -> OpenAI:
    s = get_settings()
    return OpenAI(api_key=s.openai_api_key, base_url=s.openai_base_url)


def _check_llm_budget(meter: LlmMeter | None, *, repair: bool = False, answer: bool = False) -> None:
    if not meter:
        return
    if repair:
        if meter.repair_calls >= meter.repair_cap():
            raise RuntimeError("llm_budget_exceeded")
        return
    if answer:
        if meter.answer_calls >= meter.answer_cap():
            raise RuntimeError("llm_budget_exceeded")
        return
    if meter.llm_calls >= meter.llm_cap():
        raise RuntimeError("llm_budget_exceeded")


def _note_usage(
    meter: LlmMeter | None,
    resp: object | None,
    *,
    llm: bool = False,
    embed: bool = False,
    repair: bool = False,
    answer: bool = False,
) -> None:
    if not meter:
        return
    if llm:
        meter.llm_calls += 1
    if repair:
        meter.repair_calls += 1
    if answer:
        meter.answer_calls += 1
    if embed:
        meter.embed_calls += 1
    if resp is None:
        return
    usage = getattr(resp, "usage", None)
    if usage:
        meter.prompt_tokens += int(getattr(usage, "prompt_tokens", 0) or 0)
        meter.completion_tokens += int(getattr(usage, "completion_tokens", 0) or 0)


def embed_texts(texts: list[str], meter: LlmMeter | None = None) -> list[list[float]]:
    if not texts:
        return []
    if meter and meter.embed_calls >= meter.embed_cap():
        return []
    _forbid_live_model()
    s = get_settings()
    # 百炼兼容：单请求 batch 过大返回 400 InvalidParameter
    max_batch = 10
    if len(texts) <= max_batch:
        resp = client().embeddings.create(model=s.embedding_model, input=texts)
        _note_usage(meter, resp, embed=True)
        return [list(item.embedding) for item in resp.data]
    out: list[list[float]] = []
    for i in range(0, len(texts), max_batch):
        if meter and meter.embed_calls >= meter.embed_cap():
            break
        chunk = texts[i : i + max_batch]
        resp = client().embeddings.create(model=s.embedding_model, input=chunk)
        _note_usage(meter, resp, embed=True)
        out.extend(list(item.embedding) for item in resp.data)
    return out


def _qwen_enable_thinking() -> bool:
    raw = str(os.getenv("QWEN_ENABLE_THINKING") or os.getenv("CAP_ENABLE_THINKING") or "off").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _is_qwen3_hybrid(model: str) -> bool:
    return str(model or "").strip().lower().startswith("qwen3")


def chat_text(
    system: str,
    user: str,
    meter: LlmMeter | None = None,
    max_tokens: int = 700,
    *,
    answer: bool = False,
    on_token: Callable[[str], None] | None = None,
    on_reasoning: Callable[[str], None] | None = None,
) -> str:
    _check_llm_budget(meter, answer=answer)
    _forbid_live_model()
    s = get_settings()
    kwargs: dict = {
        "model": s.openai_model,
        "temperature": 0.2 if answer else 0,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    # 自然语言答：stream + 跟随 env 开思考；SQL/结构化调用 answer=False 强制关
    if answer and _is_qwen3_hybrid(s.openai_model):
        kwargs["stream"] = True
        kwargs["extra_body"] = {"enable_thinking": _qwen_enable_thinking()}
        parts: list[str] = []
        stream = client().chat.completions.create(**kwargs)
        for chunk in stream:
            choice = (chunk.choices or [None])[0]
            if not choice:
                continue
            delta = getattr(choice, "delta", None)
            content = getattr(delta, "content", None) if delta else None
            if isinstance(content, str) and content:
                parts.append(content)
                if on_token:
                    try:
                        on_token(content)
                    except Exception:
                        pass
            reasoning = None
            if delta is not None:
                reasoning = getattr(delta, "reasoning_content", None)
                if reasoning is None:
                    ak = getattr(delta, "model_extra", None) or {}
                    if isinstance(ak, dict):
                        reasoning = ak.get("reasoning_content")
            if isinstance(reasoning, str) and reasoning and on_reasoning:
                try:
                    on_reasoning(reasoning)
                except Exception:
                    pass
        _note_usage(meter, None, llm=not answer, answer=answer)
        return "".join(parts).strip()
    if answer:
        try:
            kwargs["stream"] = True
            parts: list[str] = []
            stream = client().chat.completions.create(**kwargs)
            for chunk in stream:
                choice = (chunk.choices or [None])[0]
                if not choice:
                    continue
                delta = getattr(choice, "delta", None)
                content = getattr(delta, "content", None) if delta else None
                if isinstance(content, str) and content:
                    parts.append(content)
                    if on_token:
                        try:
                            on_token(content)
                        except Exception:
                            pass
            _note_usage(meter, None, llm=not answer, answer=answer)
            return "".join(parts).strip()
        except Exception:
            kwargs.pop("stream", None)
    if _is_qwen3_hybrid(s.openai_model):
        kwargs["extra_body"] = {"enable_thinking": False}
    resp = client().chat.completions.create(**kwargs)
    _note_usage(meter, resp, llm=not answer, answer=answer)
    text = str(resp.choices[0].message.content or "").strip()
    if answer and on_token and text:
        step = 12
        for i in range(0, len(text), step):
            try:
                on_token(text[i : i + step])
            except Exception:
                pass
    return text


def chat_json(
    system: str,
    user: str,
    meter: LlmMeter | None = None,
    max_tokens: int = 900,
    *,
    repair: bool = False,
) -> str:
    _check_llm_budget(meter, repair=repair)
    _forbid_live_model()
    s = get_settings()
    kwargs = {
        "model": s.openai_model,
        "temperature": 0,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    if _is_qwen3_hybrid(s.openai_model):
        kwargs["extra_body"] = {"enable_thinking": False}
    try:
        resp = client().chat.completions.create(**kwargs, response_format={"type": "json_object"})
    except TypeError:
        resp = client().chat.completions.create(**kwargs)
    _note_usage(meter, resp, llm=True, repair=repair)
    return str(resp.choices[0].message.content or "").strip()
