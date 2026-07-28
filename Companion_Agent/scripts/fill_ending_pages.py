# -*- coding: utf-8 -*-
"""为 secret/good 结局补齐 presentation_catalog.pages（≥2 段，0 Token）。

已有 ≥2 页的不覆盖；可 --force。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENDINGS = ROOT / "data" / "endings.json"
PRES = ROOT / "data" / "presentation_catalog.json"

BG_BY_TYPE = {
    "secret": "starry.png",
    "good": "cafe.png",
    "normal": "campus.png",
    "bad": "rain.png",
}
BGM_BY_TYPE = {
    "secret": "ending_true",
    "good": "ending_good",
    "normal": "ending_soft",
    "bad": "ending_bad",
}
OUTFIT_BY_TYPE = {
    "secret": "end_lingerie_set",
    "good": "end_robe_open",
}


def _split_pages(title: str, desc: str, cg_hint: str, *, kind: str) -> list[str]:
    desc = (desc or "").strip()
    hint = (cg_hint or "").strip()
    title = (title or "").strip()
    pages: list[str] = []
    if desc:
        # 按句号粗切成 2～3 段
        parts = [p.strip() for p in desc.replace("！", "。").replace("？", "。").split("。") if p.strip()]
        if len(parts) >= 3:
            pages = [
                parts[0] + "。",
                "。".join(parts[1:-1]) + "。",
                parts[-1] + ("。" if not parts[-1].endswith("…") else ""),
            ]
        elif len(parts) == 2:
            pages = [parts[0] + "。", parts[1] + "。"]
        elif len(parts) == 1:
            pages = [parts[0] + "。"]
        else:
            pages = [desc]
    if hint and hint not in "".join(pages):
        pages.append(hint if hint.endswith(("。", "…", "！")) else hint + "。")
    while len(pages) < 2:
        if kind == "secret":
            pages.append("这一次，你们把说不出口的话，轻轻放进了此后每一个平常的日子。")
        else:
            pages.append("不必宣布结局的名字——靠近本身，已经够清楚。")
    # 限制长度，避免 EndingScreen 一屏过长
    return [p[:180] for p in pages[:3]]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    endings = json.loads(ENDINGS.read_text(encoding="utf-8")).get("endings") or []
    catalog = json.loads(PRES.read_text(encoding="utf-8"))
    slot = catalog.setdefault("endings", {})
    filled = 0
    skipped = 0

    for row in endings:
        eid = str(row.get("id") or "")
        kind = str(row.get("type") or "")
        if not eid or kind not in {"secret", "good"}:
            continue
        existing = slot.get(eid) or {}
        pages = existing.get("pages") or []
        if len(pages) >= 2 and not args.force:
            skipped += 1
            continue
        cids = row.get("character_ids") or []
        cid = cids[0] if cids else ""
        entry = dict(existing)
        entry.setdefault("bg", BG_BY_TYPE.get(kind, "cafe.png"))
        entry.setdefault("bgm", BGM_BY_TYPE.get(kind, "ending_good"))
        if cid:
            sp = dict(entry.get("sprite") or {})
            sp.setdefault("character_id", cid)
            sp.setdefault("emotion", "love" if kind == "secret" else "happy")
            sp.setdefault("outfit", OUTFIT_BY_TYPE.get(kind, "end_robe_open"))
            entry["sprite"] = sp
        entry["pages"] = _split_pages(
            str(row.get("title") or ""),
            str(row.get("description") or ""),
            str(row.get("cg_hint") or ""),
            kind=kind,
        )
        slot[eid] = entry
        filled += 1

    PRES.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"filled={filled} skipped={skipped} catalog_endings={len(slot)}")


if __name__ == "__main__":
    main()
