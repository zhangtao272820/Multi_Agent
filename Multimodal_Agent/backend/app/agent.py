import logging
from pathlib import Path
from typing import Any, Callable

from .config import Settings
from .llm import text_qa, transcribe_audio_file, vision_caption, vision_describe
from .processors import AudioProcessor, ImageProcessor, VideoProcessor

logger = logging.getLogger(__name__)

StageFn = Callable[[str, str], None] | None


def _stage(fn: StageFn, node: str, message: str) -> None:
    if fn:
        fn(node, message)


_BUILTIN_IMAGE_Q = (
    "请描述画面",
    "描述画面",
    "识别图片",
    "提取文字",
    "画面内容",
)
_BUILTIN_VIDEO_Q = ("概括视频", "视频主要", "摘要")


def needs_extra_qa(query: str, media_type: str) -> bool:
    """默认 Tab 提示走单轮 VL/ASR；仅自定义追问才再调 helper 问答。"""
    q = (query or "").strip()
    if not q:
        return False
    if media_type == "audio":
        return not any(x in q for x in ("转写", "语音", "音频内容"))
    if media_type.startswith("vid"):
        return not any(x in q for x in _BUILTIN_VIDEO_Q)
    return not any(x in q for x in _BUILTIN_IMAGE_Q)


def _is_mock_payload(res: dict[str, Any]) -> bool:
    if res.get("mock"):
        return True
    raw = res.get("raw")
    if isinstance(raw, dict) and raw.get("mock"):
        return True
    desc = str(res.get("description") or "")
    ans = str(res.get("answer") or "")
    return "[mock]" in desc or "[mock]" in ans


def build_agent_reply(res: dict[str, Any]) -> str:
    """将结构化结果整理为面向用户的 Agent 自然语言回复。"""
    if not res.get("ok", True) and res.get("error"):
        return f"处理失败：{res['error']}"
    if _is_mock_payload(res):
        return (
            "当前处于演示模式（未加载有效 API Key），无法调用真实模型。\n"
            "请在 Multimodal_Agent/.env 配置 DASHSCOPE_API_KEY 后执行：\n"
            "docker compose ... up -d --force-recreate multimodal_agent"
        )
    parts: list[str] = []
    if ans := (res.get("answer") or "").strip():
        parts.append(ans)
    if summary := (res.get("summary") or "").strip():
        if summary not in parts:
            parts.append(summary)
    if desc := (res.get("description") or "").strip():
        if desc not in parts and desc not in (parts[0] if parts else ""):
            parts.append(desc)
    if transcript := (res.get("transcript") or "").strip():
        if res.get("media_type") == "audio" and not res.get("answer"):
            parts.append(transcript)
        else:
            parts.append(f"转写：{transcript}")
    if err := (res.get("error") or (res.get("raw") or {}).get("error") if isinstance(res.get("raw"), dict) else None):
        if str(err).strip() and not parts:
            return f"语音转写失败：{err}"
    ocr = (res.get("ocr_text") or "").strip()
    if ocr:
        parts.append(f"画面文字：{ocr}")
    emo = res.get("emotions")
    if isinstance(emo, list) and emo:
        parts.append(f"情绪线索：{', '.join(str(x) for x in emo)}")
    fds = res.get("frame_descriptions")
    if isinstance(fds, list) and fds and not parts:
        parts.append("关键帧：" + "；".join(str(x) for x in fds[:4]))
    if not parts:
        return "已完成分析，但未提取到可读文本，请换一张图或补充问题后重试。"
    return "\n\n".join(parts)


class MultimodalAgent:
    """多模态 Agent 主类：理解 + 生成编排。"""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.image = ImageProcessor(settings)
        self.video = VideoProcessor(settings)
        self.audio = AudioProcessor(settings)

    def caption_image(self, path: Path, question: str = "") -> dict[str, Any]:
        """总管路由用短 caption（≤80 字），不走 helper 精炼。"""
        ok, msg = self.image.validate(path)
        if not ok:
            return {"ok": False, "error": msg, "caption": "", "ocr_snippet": ""}
        vl_path = self.image.prepare_for_vl(path)
        cap = vision_caption(self.settings, image_path=vl_path, question=question)
        return {
            "ok": True,
            "media_type": "image",
            "caption": str(cap.get("caption") or "").strip()[:80],
            "ocr_snippet": str(cap.get("ocr_snippet") or "").strip()[:120],
            "confidence": float(cap.get("confidence", 0.7) or 0.7),
            "raw": cap,
        }

    def analyze_image(self, path: Path, question: str = "", *, on_stage: StageFn = None) -> dict[str, Any]:
        _stage(on_stage, "validate", "校验图像格式与大小…")
        ok, msg = self.image.validate(path)
        if not ok:
            return {"ok": False, "error": msg}
        vl_path = self.image.prepare_for_vl(path)
        if vl_path != path:
            _stage(on_stage, "resize", "压缩大图以加速视觉模型…")
        _stage(
            on_stage,
            "vl",
            f"调用 {self.settings.qwen_vl_model} 理解画面…",
        )
        vl = vision_describe(self.settings, image_paths=[vl_path], question=question, on_stage=on_stage)
        return {
            "ok": True,
            "media_type": "image",
            "description": vl.get("description", ""),
            "confidence": float(vl.get("confidence", 0.7) or 0.7),
            "emotions": vl.get("emotions") or [],
            "ocr_text": vl.get("ocr_text", ""),
            "raw": vl,
        }

    def analyze_video(self, path: Path, question: str = "", *, on_stage: StageFn = None) -> dict[str, Any]:
        _stage(on_stage, "validate", "校验视频文件…")
        ok, msg = self.video.validate(path)
        if not ok:
            return {"ok": False, "error": msg}
        _stage(on_stage, "frames", "提取关键帧（最多 6 帧）…")
        try:
            frames = self.video.extract_keyframes(path)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        meta = self.video.meta(path)
        if not frames:
            return {"ok": False, "error": "无法提取视频关键帧", "meta": meta}
        _stage(on_stage, "vl", f"调用 {self.settings.qwen_vl_model} 分析 {len(frames)} 帧…")
        vl = vision_describe(
            self.settings,
            image_paths=frames,
            question=question or "请概括视频内容，按关键帧描述并给出整体摘要。",
            system_hint=(
                "你是视频理解助手。根据多张关键帧输出 JSON："
                "frame_descriptions(str[]), summary(str), confidence(0-1), emotions(str[])。仅 JSON。"
            ),
            on_stage=on_stage,
        )
        return {
            "ok": True,
            "media_type": "video",
            "meta": meta,
            "frame_count": len(frames),
            "frame_descriptions": vl.get("frame_descriptions") or [],
            "summary": vl.get("summary") or vl.get("description", ""),
            "confidence": float(vl.get("confidence", 0.7) or 0.7),
            "emotions": vl.get("emotions") or [],
            "raw": vl,
        }

    def transcribe_audio(self, path: Path, *, on_stage: StageFn = None) -> dict[str, Any]:
        _stage(on_stage, "validate", "校验音频文件…")
        ok, msg = self.audio.validate(path)
        if not ok:
            return {"ok": False, "error": msg}
        _stage(on_stage, "convert", "转换为 WAV 便于识别…")
        wav = self.audio.to_wav(path)
        _stage(on_stage, "asr", f"调用 {self.settings.qwen_asr_model} 语音转写…")
        asr = transcribe_audio_file(self.settings, wav)
        transcript = (asr.get("transcript") or "").strip()
        ok = bool(transcript) and not asr.get("error")
        return {
            "ok": ok,
            "media_type": "audio",
            "transcript": transcript,
            "language": asr.get("language", "zh"),
            "error": asr.get("error"),
            "hint": asr.get("hint"),
            "raw": asr,
        }

    def multimodal_qa(
        self,
        path: Path,
        question: str,
        media_type: str = "image",
        *,
        on_stage: StageFn = None,
    ) -> dict[str, Any]:
        if media_type == "video":
            base = self.analyze_video(path, question, on_stage=on_stage)
            ctx = base.get("summary") or base.get("description") or ""
        elif media_type == "audio":
            base = self.transcribe_audio(path, on_stage=on_stage)
            ctx = base.get("transcript") or ""
        else:
            base = self.analyze_image(path, question, on_stage=on_stage)
            ctx = f"{base.get('description', '')}\nOCR:{base.get('ocr_text', '')}"
        if not base.get("ok"):
            return base
        _stage(
            on_stage,
            "reason",
            f"调用 {self.settings.qwen_helper_model} 结合上下文作答…",
        )
        qa = text_qa(self.settings, context=str(ctx), question=question)
        return {
            "ok": True,
            "media_type": media_type,
            "answer": qa.get("answer", ""),
            "confidence": float(qa.get("confidence", 0.7) or 0.7),
            "context": ctx,
            "analysis": base,
        }

    def unified_understand(
        self,
        *,
        file_path: Path | None,
        media_type: str,
        query: str = "",
        action: str = "understand",
        on_stage: StageFn = None,
    ) -> dict[str, Any]:
        """供总管 Agent 调用的统一入口。"""
        action = (action or "understand").strip().lower()
        mt = (media_type or "image").strip().lower()

        if action in ("generate_music", "music", "compose_music"):
            return {"ok": False, "error": "音乐生成请使用 generate_music 并传入 prompt", "action": action}

        if action in ("generate_video", "video", "compose_video"):
            return {"ok": False, "error": "视频生成请使用 generate_video 并传入 prompt", "action": action}

        if not file_path or not file_path.is_file():
            if query.strip():
                _stage(on_stage, "reason", "纯文本问答…")
                qa = text_qa(self.settings, context="（无附件）", question=query)
                res = {
                    "ok": True,
                    "mode": "text_only",
                    "answer": qa.get("answer"),
                    "confidence": qa.get("confidence"),
                }
                return {
                    "ok": True,
                    "action": action,
                    "media_type": mt,
                    "agent_reply": build_agent_reply(res),
                    "mock": _is_mock_payload(res),
                    "result": res,
                }
            return {"ok": False, "error": "缺少媒体文件"}

        _stage(on_stage, "route", f"路由到 {mt} 理解管线…")
        if mt.startswith("vid"):
            res = self.analyze_video(file_path, query, on_stage=on_stage)
        elif mt.startswith("aud"):
            res = self.transcribe_audio(file_path, on_stage=on_stage)
            transcript = (res.get("transcript") or "").strip()
            q = (query or "").strip()
            image_default = "请描述画面内容" in q or "提取文字" in q
            if res.get("ok") and q and not image_default and transcript:
                _stage(
                    on_stage,
                    "reason",
                    f"调用 {self.settings.qwen_helper_model} 基于转写作答…",
                )
                qa = text_qa(self.settings, context=transcript, question=q)
                res["answer"] = qa.get("answer")
                res["confidence"] = qa.get("confidence")
            elif res.get("ok") and not transcript:
                res["ok"] = False
                res["error"] = res.get("error") or res.get("hint") or "未识别到语音内容"
        else:
            if needs_extra_qa(query, "image"):
                res = self.multimodal_qa(file_path, query, "image", on_stage=on_stage)
            else:
                res = self.analyze_image(file_path, query, on_stage=on_stage)

        _stage(on_stage, "reply", "整理 Agent 自然语言回复…")
        reply = build_agent_reply(res) if res.get("ok") else str(res.get("error") or "处理失败")
        return {
            "ok": bool(res.get("ok")),
            "action": action,
            "media_type": mt,
            "agent_reply": reply,
            "mock": _is_mock_payload(res),
            "result": res,
        }

