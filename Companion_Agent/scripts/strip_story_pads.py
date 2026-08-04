# -*- coding: utf-8 -*-
"""Strip generic pad phrases from all story beat summaries; keep 40–80 chars."""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"

PADS = (
    "空气里还剩一点未说完的话。",
    "她等你给一个不伤人的回应。",
    "这一拍的选择，会留下痕迹。",
)
FILLERS = (
    "选择会改写后面的路。",
    "气氛忽然认真起来。",
    "这句话比表面更重。",
)

IDS = [
    "xiaoyou",
    "wanyu",
    "ruolin",
    "jingliu",
    "aili",
    "linxi",
    "yeyu",
    "taotao",
    "shizuku",
    "qiansha",
    "shiori",
    "miara",
    "xingnai",
    "fengyin",
    "qingcai",
    "xiaoyang",
    "luna",
    "shuli",
    "jingning",
    "youwei",
    "yuxi",
    "lingke",
    "aichen",
]


def clean(s: str) -> str:
    s = s or ""
    for p in PADS:
        s = s.replace("——" + p, "").replace(p, "")
    return s.strip()


def fatten(s: str, lo: int = 40, hi: int = 80) -> str:
    s = clean(s)
    i = 0
    while len(s) < lo and i < len(FILLERS):
        s = s.rstrip("。") + "——" + FILLERS[i]
        i += 1
    return s[:hi]


def dump(data: dict) -> str:
    # prefer rest dumper; works for all story events
    from curate_rest_story_beats import _dump_event

    return _dump_event(data)


def main() -> None:
    n = 0
    bad: list[str] = []
    for cid in IDS:
        for yf in sorted(EVENTS.glob(f"story_{cid}_*.yaml")):
            raw = yaml.safe_load(yf.read_text(encoding="utf-8"))
            changed = False
            for b in raw.get("beats") or []:
                old = str(b.get("summary") or "")
                new = fatten(old)
                if new != old:
                    b["summary"] = new
                    changed = True
                    n += 1
            if changed:
                yf.write_text(dump(raw), encoding="utf-8")
            for b in raw.get("beats") or []:
                s = str(b.get("summary") or "")
                if len(s) < 40 or len(s) > 80 or any(p in s for p in PADS):
                    bad.append(f"{yf.name}:{b.get('id')}:{len(s)}")
    print(f"cleaned={n} bad={len(bad)}")
    for x in bad[:20]:
        print(x)
    if bad:
        raise SystemExit(1)
    print("strip_story_pads: OK")


if __name__ == "__main__":
    main()
