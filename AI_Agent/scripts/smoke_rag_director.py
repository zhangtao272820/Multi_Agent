# AI_Agent 实时数字人冒烟：RAG + 导演解析（无需 GPU / Key）
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.config import Settings  # noqa: E402
from app import director, product_rag  # noqa: E402


def main() -> None:
    s = Settings(
        rag_enabled=True,
        rag_products_dir=str(ROOT / "assets" / "products"),
        director_enabled=True,
        avatar_actions_dir=str(ROOT / "assets" / "avatar_actions"),
    )
    hits = product_rag.retrieve(s, "耳机 降噪 续航")
    assert hits, "RAG 应命中耳机文档"
    print("rag_ok", hits[0]["path"], hits[0]["score"])

    speak, d = director.parse_director_block(
        '这款耳机主打主动降噪。\nDIRECTOR:{"emotion":"smile","action":"present","confidence":0.9}'
    )
    assert "DIRECTOR" not in speak
    assert d and d["action"] == "present" and d["emotion"] == "smile"
    print("director_ok", speak, d)

    amap = director.load_audiotype_map(s)
    assert amap.get("present") == 2
    print("audiotype_map_ok", amap.get("present"))
    print("SMOKE_PASS")


if __name__ == "__main__":
    main()
