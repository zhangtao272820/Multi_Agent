"""Multimodal agent_result structured handoff contract (no LLM)."""
from __future__ import annotations

from app.agent_result import build_multimodal_agent_result


def main() -> None:
    payload = {
        "description": "体检报告",
        "ocr_text": "姓名张三 收缩压138",
        "confidence": 0.9,
        "entities": [{"name": "张三", "kind": "person"}],
        "metrics": [{"name": "收缩压", "value": "138", "unit": "mmHg"}],
        "media_type": "image",
    }
    ar = build_multimodal_agent_result(payload, media_type="image", latency_ms=12)
    assert ar["ok"] is True
    st = ar["structured"]
    assert st["entities"][0]["name"] == "张三"
    assert st["metrics"][0]["value"] == "138"
    assert "张三" in st["ocr_text_digest"]
    assert st["confidence"] == 0.9
    print("smoke_multimodal_structured_handoff: ok")


if __name__ == "__main__":
    main()
