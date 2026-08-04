# -*- coding: utf-8 -*-
"""Smoke: L0 shuli chain + narration layer + T0 gate + L open + build SSOT no-rollback."""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
EVENTS = DATA / "events"
BANNED = "选择会改写后面的路"

SHULI_ACTS = [
    "story_shuli_act1_dinner",
    "story_shuli_act2_ally",
    "story_shuli_act3_display",
    "story_shuli_act4_jealous",
    "story_shuli_act5_ethics",
    "story_shuli_act6_secret",
]


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


def _load_yaml(path: Path) -> dict:
    import yaml

    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        fail(f"bad yaml: {path.name}")
    return raw


def main() -> None:
    routes = json.loads((DATA / "story_routes.json").read_text(encoding="utf-8"))
    shuli = routes["characters"]["shuli"]
    if shuli.get("tier") != "L0" or len(shuli.get("acts") or []) != 6:
        fail(f"shuli tier/acts: {shuli.get('tier')} {len(shuli.get('acts') or [])}")
    if not shuli.get("prime_heroine"):
        fail("shuli missing prime_heroine")

    orphan = EVENTS / "story_shuli_act4_ethics.yaml"
    if orphan.exists():
        fail("orphan story_shuli_act4_ethics.yaml still exists")

    jealous = (EVENTS / "story_shuli_act4_jealous.yaml").read_text(encoding="utf-8")
    ethics = (EVENTS / "story_shuli_act5_ethics.yaml").read_text(encoding="utf-8")
    secret = (EVENTS / "story_shuli_act6_secret.yaml").read_text(encoding="utf-8")
    if "shuli_jealous_break" not in jealous:
        fail("act4_jealous missing reward flag")
    if "shuli_jealous_break" not in ethics or "taboo_romance_ok" not in ethics:
        fail("act5_ethics must require jealous and set taboo")
    if "第5幕" not in ethics or "日程本里的禁忌" not in ethics:
        fail("act5_ethics prompt title wrong")
    if "shuli_secret_roof" not in secret:
        fail("act6_secret missing secret_roof")

    # Batch 1：旁白层 · 每幕≥4 拍 · 三字段 · 禁套话 · act4–6 枫音/隔墙悬念
    wall_needles = ("枫音", "隔墙", "薄墙", "门轴")
    for act_id in SHULI_ACTS:
        path = EVENTS / f"{act_id}.yaml"
        if not path.is_file():
            fail(f"missing {path.name}")
        data = _load_yaml(path)
        beats = data.get("beats") or []
        if len(beats) < 4:
            fail(f"{act_id}: beats={len(beats)} < 4")
        for i, b in enumerate(beats):
            bid = b.get("id") or f"b{i+1}"
            nar = str(b.get("narration") or "").strip()
            thought = str(b.get("pc_thought") or "").strip()
            brief = str(b.get("brief") or "").strip()
            summary = str(b.get("summary") or "").strip()
            if not nar:
                fail(f"{act_id}/{bid}: missing narration")
            if not thought:
                fail(f"{act_id}/{bid}: missing pc_thought")
            if not brief:
                fail(f"{act_id}/{bid}: missing brief")
            if len(nar) > 120:
                fail(f"{act_id}/{bid}: narration>{len(nar)}>120")
            if len(thought) > 80:
                fail(f"{act_id}/{bid}: pc_thought>{len(thought)}>80")
            if len(brief) > 80:
                fail(f"{act_id}/{bid}: brief>{len(brief)}>80")
            blob = " ".join([nar, thought, brief, summary])
            if BANNED in blob:
                fail(f"{act_id}/{bid}: banned filler phrase")
            opts = b.get("soft_options") or []
            if not opts:
                fail(f"{act_id}/{bid}: missing soft_options")
        if act_id in (
            "story_shuli_act4_jealous",
            "story_shuli_act5_ethics",
            "story_shuli_act6_secret",
        ):
            joined = " ".join(str(b.get("narration") or "") for b in beats)
            if not any(n in joined for n in wall_needles):
                fail(f"{act_id}: narration missing 枫音/隔墙悬念")

    ends = {
        e["id"]: e
        for e in json.loads((DATA / "endings.json").read_text(encoding="utf-8"))["endings"]
    }
    true = ends["ending_shuli_taboo_true"]
    cond = true.get("conditions") or {}
    need = {"shuli_jealous_break", "taboo_romance_ok", "shuli_secret_roof"}
    if not need <= set(cond.get("flags_all") or []):
        fail(f"taboo_true flags_all={cond.get('flags_all')}")
    if "linked" not in (true.get("cast_roles") or []):
        fail("taboo_true cast_roles missing linked")

    xy = ends.get("ending_xiaoyou_frame_true") or {}
    xy_flags = set((xy.get("conditions") or {}).get("flags_all") or [])
    if "studio_sketch_done" not in xy_flags and "studio_sketch_done" not in str(xy):
        blob = json.dumps(xy, ensure_ascii=False)
        if "studio_sketch_done" not in blob:
            fail("ending_xiaoyou_frame_true missing studio_sketch_done gate")

    youwei_open = ends["ending_youwei_third_pen_true"]
    yw = set((youwei_open.get("conditions") or {}).get("flags_all") or [])
    if "youwei_open_heart" not in yw:
        fail("L true ending missing youwei_open_heart")

    cat = json.loads((DATA / "route_catalog.json").read_text(encoding="utf-8"))
    by = {r["character_id"]: r for r in cat["routes"]}
    if by["shuli"].get("story_tier") != "L0" or by["shuli"].get("cast_role") != "linked":
        fail(f"catalog shuli={by['shuli'].get('story_tier')} {by['shuli'].get('cast_role')}")

    # build should not rollback
    before_acts = len(routes["characters"]["shuli"]["acts"])
    subprocess.check_call([sys.executable, str(ROOT / "scripts" / "build_story_routes.py")])
    after = json.loads((DATA / "story_routes.json").read_text(encoding="utf-8"))
    if after["characters"]["shuli"]["tier"] != "L0":
        fail("build rollback: shuli tier")
    if len(after["characters"]["shuli"]["acts"]) != before_acts:
        fail("build rollback: shuli acts count")
    if after["characters"]["xiaoyou"]["tier"] != "T0" or len(after["characters"]["xiaoyou"]["acts"]) != 7:
        fail("build rollback: xiaoyou")

    print("OK smoke_shuli_l0_story")


if __name__ == "__main__":
    main()
