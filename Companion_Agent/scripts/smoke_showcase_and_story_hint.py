"""Smoke: W9 showcase catalog/assets + Hub story-hint short VN pages."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.showcase_gallery import (  # noqa: E402
    public_showcase_catalog,
    reload_showcase_manifest,
    resolve_showcase_file,
)
from app.story_hint_pages import load_story_hint_pages, public_hint_pages  # noqa: E402


def main() -> None:
    reload_showcase_manifest()
    cat = public_showcase_catalog()
    chars = {c["character_id"]: c for c in cat.get("characters") or []}
    assert "xiaoyou" in chars, "showcase missing xiaoyou"
    xy = chars["xiaoyou"]
    assert int(xy.get("present_count") or 0) >= 1, xy
    assert any(int(c.get("present_count") or 0) > 0 for c in chars.values()), "no showcase assets"

    path = resolve_showcase_file("xiaoyou", "kv") or resolve_showcase_file("xiaoyou", "kv_day")
    assert path is not None and path.is_file(), path

    pages_xy = public_hint_pages("xiaoyou", character_name="苏晚悠")
    assert len(pages_xy.get("pages") or []) >= 2, pages_xy
    assert all(str(p.get("text") or "").strip() for p in pages_xy["pages"])

    man = load_story_hint_pages()
    hint_chars = man.get("characters") if isinstance(man.get("characters"), dict) else {}
    tiers_path = ROOT / "data" / "cast_star_tiers.json"
    tiers = json.loads(tiers_path.read_text(encoding="utf-8"))
    cast_ids = list((tiers.get("characters") or {}).keys())
    assert len(cast_ids) >= 20, cast_ids
    missing = [cid for cid in cast_ids if cid not in hint_chars]
    assert not missing, f"story_hint_pages missing: {missing}"

    fb = public_hint_pages(
        "__no_such_char__",
        hint_text="测试合成钩子",
        character_name="某人",
    )
    assert len(fb.get("pages") or []) >= 1, fb

    print(
        "OK smoke_showcase_and_story_hint:",
        f"showcase_present={sum(1 for c in chars.values() if int(c.get('present_count') or 0) > 0)}",
        f"hint_chars={len(hint_chars)}",
        f"xiaoyou_slots={xy.get('present_count')}",
    )


if __name__ == "__main__":
    main()
