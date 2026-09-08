import base64
import json
import logging
import re
from pathlib import Path
from typing import Any, Callable

StageFn = Callable[[str, str], None] | None

from openai import OpenAI

from .config import Settings

logger = logging.getLogger(__name__)


def _client(settings: Settings) -> OpenAI:
    key = (settings.openai_api_key or settings.dashscope_api_key or "").strip()
    if not key:
        raise RuntimeError("未配置 OPENAI_API_KEY 或 DASHSCOPE_API_KEY")
    return OpenAI(api_key=key, base_url=settings.openai_base_url)


def _parse_json_object(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    if not raw:
        return {}
    try:
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else {"text": raw}
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{[\s\S]*\}", raw)
    if m:
        try:
            obj = json.loads(m.group(0))
            return obj if isinstance(obj, dict) else {"text": raw}
        except json.JSONDecodeError:
            pass
    return {"text": raw}


def _image_data_url(path: Path) -> str:
    suffix = path.suffix.lower().lstrip(".") or "jpeg"
    mime = "image/png" if suffix == "png" else "image/jpeg"
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{b64}"


_VL_SYS = "输出JSON:description,confidence,emotions[],ocr_text。仅JSON。"
_HELPER_SYS = "将视觉草稿整理为JSON:description,confidence,emotions[],ocr_text,summary。仅JSON，简练。"


def _helper_refine(settings: Settings, draft: str, question: str) -> dict[str, Any]:
    if not settings.use_helper_for_vision:
        return _parse_json_object(draft)
    key = (settings.openai_api_key or settings.dashscope_api_key or "").strip()
    if not key:
        return _parse_json_object(draft)
    model = (settings.qwen_helper_model or "qwen3.5-35b-a3b").strip()
    q = (question or "")[:400]
    d = (draft or "")[:2000]
    resp = _client(settings).chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": _HELPER_SYS},
            {"role": "user", "content": f"问题:{q}\n草稿:{d}"},
        ],
        temperature=0.15,
        max_tokens=max(256, int(settings.helper_max_tokens)),
    )
    out = _parse_json_object((resp.choices[0].message.content or "").strip())
    if not out.get("description"):
        out["description"] = draft[:1500]
    out.setdefault("confidence", 0.75)
    out["helper_model"] = model
    return out


_CAPTION_SYS = "用中文一句话概括画面要点与可读文字。JSON:caption,ocr_snippet。仅JSON，caption≤80字。"
_CAPTION_MAX_TOKENS = 128


def vision_caption(
    settings: Settings,
    *,
    image_path: Path,
    question: str = "",
) -> dict[str, Any]:
    """路由用轻量 VL 摘要：硬顶 max_tokens，不做 helper 精炼。"""
    if not image_path or not image_path.is_file():
        return {"caption": "", "ocr_snippet": "", "confidence": 0.0}

    key = (settings.openai_api_key or settings.dashscope_api_key or "").strip()
    if not key and settings.use_mock_when_no_key:
        return {
            "caption": f"[mock] 图片摘要 {image_path.name}",
            "ocr_snippet": "",
            "confidence": 0.5,
            "mock": True,
        }

    model = (settings.qwen_vl_model or "qwen-vl-plus").strip()
    user_q = (question or "概括画面主体、关键文字与可识别实体。").strip()[:200]
    content: list[dict[str, Any]] = [
        {"type": "text", "text": user_q},
        {"type": "image_url", "image_url": {"url": _image_data_url(image_path)}},
    ]
    resp = _client(settings).chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": _CAPTION_SYS}, {"role": "user", "content": content}],
        temperature=0.1,
        max_tokens=_CAPTION_MAX_TOKENS,
    )
    raw = (resp.choices[0].message.content or "").strip()
    out = _parse_json_object(raw)
    caption = str(out.get("caption") or out.get("description") or raw or "").strip()
    if len(caption) > 80:
        caption = caption[:80].rstrip()
    ocr = str(out.get("ocr_snippet") or out.get("ocr_text") or "").strip()[:120]
    return {
        "caption": caption,
        "ocr_snippet": ocr,
        "confidence": float(out.get("confidence", 0.7) or 0.7),
        "vl_model": model,
        "max_tokens": _CAPTION_MAX_TOKENS,
    }


def vision_describe(
    settings: Settings,
    *,
    image_paths: list[Path],
    question: str = "",
    system_hint: str = "",
    on_stage: StageFn = None,
) -> dict[str, Any]:
    """VL 识图 + 可选 qwen3.5-35b-a3b 文本精炼（省 VL token，结构化更稳）。"""
    if not image_paths:
        return {"description": "", "confidence": 0.0, "emotions": [], "ocr_text": ""}

    key = (settings.openai_api_key or settings.dashscope_api_key or "").strip()
    if not key and settings.use_mock_when_no_key:
        return {
            "description": f"[mock] {len(image_paths)}帧。{question or ''}",
            "confidence": 0.5,
            "emotions": ["neutral"],
            "ocr_text": "",
            "mock": True,
        }

    model = (settings.qwen_vl_model or "qwen-vl-plus").strip()
    user_q = (question or "描述画面并提取文字与情绪。").strip()
    sys = system_hint or _VL_SYS
    content: list[dict[str, Any]] = [{"type": "text", "text": user_q}]
    for p in image_paths[:6]:
        if p.is_file():
            content.append({"type": "image_url", "image_url": {"url": _image_data_url(p)}})

    resp = _client(settings).chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": sys}, {"role": "user", "content": content}],
        temperature=0.2,
        max_tokens=max(400, int(settings.vl_max_tokens)),
    )
    raw = (resp.choices[0].message.content or "").strip()
    if settings.use_helper_for_vision and on_stage:
        on_stage(
            "helper",
            f"调用 {settings.qwen_helper_model} 精炼视觉结果…",
        )
    out = _helper_refine(settings, raw, user_q) if settings.use_helper_for_vision else _parse_json_object(raw)
    out.setdefault("description", raw)
    out.setdefault("confidence", 0.75)
    out["vl_model"] = model
    return out


def text_qa(settings: Settings, *, context: str, question: str) -> dict[str, Any]:
    key = (settings.openai_api_key or settings.dashscope_api_key or "").strip()
    if not key and settings.use_mock_when_no_key:
        return {"answer": f"[mock] {context[:120]}…", "confidence": 0.5, "mock": True}
    model = (settings.qwen_helper_model or settings.qwen_text_model or "qwen3.5-35b-a3b").strip()
    ctx = (context or "")[:2500]
    q = (question or "")[:500]
    resp = _client(settings).chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": "据上下文答。JSON:answer,confidence。仅JSON。"},
            {"role": "user", "content": f"上下文:{ctx}\n问:{q}"},
        ],
        temperature=0.2,
        max_tokens=500,
    )
    text = (resp.choices[0].message.content or "").strip()
    out = _parse_json_object(text)
    out.setdefault("answer", text)
    out.setdefault("confidence", 0.7)
    return out


def transcribe_audio_file(settings: Settings, audio_path: Path) -> dict[str, Any]:
    """语音转文字：DashScope Qwen-ASR（OpenAI 兼容 + asr_options）。"""
    key = (settings.openai_api_key or settings.dashscope_api_key or "").strip()
    if not key and settings.use_mock_when_no_key:
        return {"transcript": "[mock] 音频已接收，请配置 API Key 以启用 ASR。", "language": "zh", "mock": True}

    client = _client(settings)
    model = (settings.qwen_asr_model or "qwen3-asr-flash").strip()
    suffix = audio_path.suffix.lower().lstrip(".") or "wav"
    mime_map = {"wav": "audio/wav", "mp3": "audio/mpeg", "m4a": "audio/mp4", "ogg": "audio/ogg", "webm": "audio/webm"}
    mime = mime_map.get(suffix, f"audio/{suffix}")
    b64 = base64.b64encode(audio_path.read_bytes()).decode("ascii")
    data_uri = f"data:{mime};base64,{b64}"
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": [{"type": "input_audio", "input_audio": {"data": data_uri}}],
                }
            ],
            stream=False,
            extra_body={"asr_options": {"enable_itn": True}},
        )
        text = (resp.choices[0].message.content or "").strip()
        if not text:
            return {
                "transcript": "",
                "language": "zh",
                "error": "ASR 返回空文本",
                "hint": f"请确认模型 {model} 可用，音频时长与格式正确（建议 WAV/MP3，≤10MB）",
            }
        return {"transcript": text, "language": "zh", "model": model}
    except Exception as ex:
        logger.warning("ASR failed model=%s: %s", model, ex)
        return {
            "transcript": "",
            "language": "unknown",
            "error": str(ex),
            "hint": f"ASR 调用失败，请检查 QWEN_ASR_MODEL（当前 {model}）与 DashScope 配额",
        }
