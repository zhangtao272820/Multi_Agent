# -*- coding: utf-8 -*-
"""Audit T1/T2/N beat lengths and ending pages."""
from __future__ import annotations

import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"
PC = json.loads((ROOT / "data" / "presentation_catalog.json").read_text(encoding="utf-8"))
ROUTES = json.loads((ROOT / "data" / "story_routes.json").read_text(encoding="utf-8"))

T1 = ["taotao", "shizuku", "qiansha", "shiori", "miara"]
T2 = ["xingnai", "fengyin", "qingcai", "xiaoyang", "luna"]
N = ["shuli", "jingning", "youwei", "yuxi", "lingke", "aichen"]


def audit(ids: list[str], label: str) -> None:
    print("====", label)
    for cid in ids:
        files = sorted(EVENTS.glob(f"story_{cid}_*.yaml"))
        print(f" {cid}: {len(files)} acts tier={ROUTES['characters'].get(cid, {}).get('tier')}")
        for yf in files:
            data = yaml.safe_load(yf.read_text(encoding="utf-8"))
            beats = data.get("beats") or []
            lens = [len(str(b.get("summary") or "")) for b in beats]
            soft = [len(b.get("soft_options") or []) for b in beats]
            print(
                f"  {yf.name}: n={len(beats)} lens={lens} soft={soft} "
                f"min={min(lens) if lens else 0}"
            )


def endings(ids: set[str]) -> None:
    print("==== endings")
    for eid, e in sorted((PC.get("endings") or {}).items()):
        sp = e.get("sprite") or {}
        cid = sp.get("character_id") or ""
        if cid not in ids:
            continue
        pages = e.get("pages") or []
        print(
            f" {eid}: {cid} outfit={sp.get('outfit')} emo={sp.get('emotion')} "
            f"pages={len(pages)} chars={sum(len(p) for p in pages)}"
        )


def gates() -> None:
    print("==== route true endings / gate flags")
    for cid in T1 + T2 + N + ["xiaoyou", "wanyu", "ruolin", "jingliu", "aili", "linxi"]:
        ch = ROUTES["characters"].get(cid) or {}
        acts = ch.get("acts") or []
        endings = ch.get("endings") or ch.get("unique_endings") or []
        flags = []
        for a in acts:
            for f in a.get("flags") or a.get("flags_set") or a.get("rewards", {}).get("flags_set") or []:
                flags.append(f)
        # also from events
        for yf in EVENTS.glob(f"story_{cid}_*.yaml"):
            data = yaml.safe_load(yf.read_text(encoding="utf-8"))
            for f in (data.get("rewards") or {}).get("flags_set") or []:
                if f not in flags:
                    flags.append(f)
        gateish = [f for f in flags if any(k in f for k in ("gate", "done", "ally", "watch", "cover", "sketch", "boundary", "friend"))]
        if gateish or cid in N:
            print(f" {cid} tier={ch.get('tier')} flags={flags} endings={endings}")


if __name__ == "__main__":
    audit(T1, "T1")
    audit(T2, "T2")
    audit(N, "N")
    endings(set(T1 + T2 + N))
    gates()
