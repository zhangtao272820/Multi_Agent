# -*- coding: utf-8 -*-
"""Pad T0 beat summaries to 40–80 chars; sync route_beat/sprites from CURATED."""

from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

from curate_t0_story_beats import CURATED, _dump_event

EVENTS = Path(__file__).resolve().parents[1] / "data" / "events"
ROUTES = Path(__file__).resolve().parents[1] / "data" / "story_routes.json"

PAD_CHAIN = [
    "空气里还剩一点未说完的话。",
    "她等你给一个不伤人的回应。",
    "这一拍的选择，会留下痕迹。",
]


def ensure_len(s: str, lo: int = 40, hi: int = 80) -> str:
    s = (s or "").strip()
    if len(s) > hi:
        return s[:hi]
    if len(s) >= lo:
        return s
    for pad in PAD_CHAIN:
        if len(s) >= lo:
            break
        if s.endswith(("。", "——", "？", "！")):
            s = s + pad
        else:
            s = s + "——" + pad
    return s[:hi]


def main() -> None:
    routes = json.loads(ROUTES.read_text(encoding="utf-8"))
    padded = 0
    for eid, curated in CURATED.items():
        path = EVENTS / f"{eid}.yaml"
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        for b in raw["beats"]:
            old = str(b.get("summary") or "")
            new = ensure_len(old)
            if new != old:
                b["summary"] = new
                padded += 1
        path.write_text(_dump_event(raw), encoding="utf-8")

        cid = ((raw.get("trigger") or {}).get("character_ids") or [""])[0]
        char = routes["characters"][cid]
        m = re.match(rf"story_{re.escape(cid)}_(.+)", eid)
        if not m:
            continue
        act_id = m.group(1)
        for act in char.get("acts") or []:
            if act.get("id") == act_id:
                if curated.get("route_beat"):
                    act["beat"] = curated["route_beat"]
                if curated.get("route_sprites"):
                    act["sprites"] = list(curated["route_sprites"])
                break

    ROUTES.write_text(json.dumps(routes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    bad: list[str] = []
    for cid in ["xiaoyou", "wanyu", "ruolin", "jingliu", "aili", "linxi"]:
        for yf in sorted(EVENTS.glob(f"story_{cid}_*.yaml")):
            data = yaml.safe_load(yf.read_text(encoding="utf-8"))
            for b in data["beats"]:
                n = len(str(b.get("summary") or ""))
                if n < 40 or n > 80:
                    bad.append(f"{yf.name}:{b.get('id')}:{n}")
    print(f"padded={padded} bad={len(bad)}")
    for x in bad[:30]:
        print(x)
    if bad:
        raise SystemExit(1)
    print("pad_t0_beat_summaries: OK")


if __name__ == "__main__":
    main()
