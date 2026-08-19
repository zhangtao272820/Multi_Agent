from __future__ import annotations

from openai import OpenAI

from app.settings import get_settings


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
    resp: object,
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
    usage = getattr(resp, "usage", None)
    if usage:
        meter.prompt_tokens += int(getattr(usage, "prompt_tokens", 0) or 0)
        meter.completion_tokens += int(getattr(usage, "completion_tokens", 0) or 0)


def embed_texts(texts: list[str], meter: LlmMeter | None = None) -> list[list[float]]:
    if not texts:
        return []
    if meter and meter.embed_calls >= meter.embed_cap():
        return []
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


def chat_text(
    system: str,
    user: str,
    meter: LlmMeter | None = None,
    max_tokens: int = 700,
    *,
    answer: bool = False,
) -> str:
    _check_llm_budget(meter, answer=answer)
    s = get_settings()
    resp = client().chat.completions.create(
        model=s.openai_model,
        temperature=0.2 if answer else 0,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    _note_usage(meter, resp, llm=not answer, answer=answer)
    return str(resp.choices[0].message.content or "").strip()


def chat_json(
    system: str,
    user: str,
    meter: LlmMeter | None = None,
    max_tokens: int = 900,
    *,
    repair: bool = False,
) -> str:
    _check_llm_budget(meter, repair=repair)
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
    try:
        resp = client().chat.completions.create(**kwargs, response_format={"type": "json_object"})
    except TypeError:
        resp = client().chat.completions.create(**kwargs)
    _note_usage(meter, resp, llm=True, repair=repair)
    return str(resp.choices[0].message.content or "").strip()
