# -*- coding: utf-8 -*-
"""Emit per-act story events from story_routes.json into data/events/story_*.yaml.

默认跳过已有文件（保护手写 beats）。强制覆盖：--force
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"
ROUTES = ROOT / "data" / "story_routes.json"

# Affinity gates by act index (0-based)
AFFINITY = {
    "T0": [48, 62, 75, 85],
    "T1": [50, 68, 82],
    "T2": [55, 78],
    "N": [52, 70],
}
STAGE = {
    0: "friend",
    1: "close_friend",
    2: "crush",
    3: "dating",
}


def _beat_drafts(title: str, beat: str, sprites: list[str]) -> list[dict]:
    """从路线 beat 一行拆成 3 拍草稿（需人工润色）。"""
    core = (beat or title or "推进关系").strip()
    hints = sprites or ["casual"]
    return [
        {
            "id": "b1",
            "summary": f"开场：{core[:40]}",
            "sprite_hint": hints[:2] or ["casual"],
            "soft_options": ["认真接话", "先观察", "轻声提问"],
        },
        {
            "id": "b2",
            "summary": f"推进：围绕「{title}」出现选择或犹豫。",
            "sprite_hint": hints[1:3] or hints[:1] or ["casual"],
            "soft_options": ["表明态度", "给她空间", "确认她的意思"],
        },
        {
            "id": "b3",
            "summary": f"收束本幕「{title}」：留下可被系统记 flag 的结果，不剧透结局名。",
            "sprite_hint": hints[-1:] or ["casual"],
            "soft_options": ["答应下一步", "先缓一缓", "诚实说明顾虑"],
        },
    ]


def _yaml_list(items: list[str]) -> str:
    return "[" + ", ".join(items) + "]"


def _format_beats(beats: list[dict]) -> str:
    lines: list[str] = ["beats:"]
    for b in beats:
        lines.append(f"  - id: {b['id']}")
        lines.append(f"    summary: \"{b['summary']}\"")
        hints = b.get("sprite_hint") or []
        lines.append(f"    sprite_hint: {_yaml_list([str(x) for x in hints])}")
        opts = b.get("soft_options") or []
        quoted = ", ".join(f'"{x}"' for x in opts)
        lines.append(f"    soft_options: [{quoted}]")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="覆盖已有 story_*.yaml")
    args = ap.parse_args()

    data = json.loads(ROUTES.read_text(encoding="utf-8"))
    chars = data.get("characters") or {}
    written = 0
    skipped = 0
    for cid, row in chars.items():
        tier = str(row.get("tier") or "T1")
        gates = AFFINITY.get(tier, AFFINITY["T1"])
        acts = row.get("acts") or []
        for i, act in enumerate(acts):
            flags = [str(f) for f in (act.get("flags") or []) if f]
            if not flags:
                continue
            primary = flags[0]
            eid = f"story_{cid}_{act.get('id') or i}"
            path = EVENTS / f"{eid}.yaml"
            if path.is_file() and not args.force:
                skipped += 1
                continue
            aff = gates[i] if i < len(gates) else gates[-1]
            stage = STAGE.get(i, "dating")
            title = str(act.get("title") or primary)
            beat = str(act.get("beat") or "").strip()
            sprites = [str(s) for s in (act.get("sprites") or [])]
            prior = []
            if i > 0:
                prev_flags = acts[i - 1].get("flags") or []
                if prev_flags:
                    prior = [str(prev_flags[0])]

            absent = [primary]
            trigger_extra = ""
            if prior:
                trigger_extra = f"\n  flags_present: [{', '.join(prior)}]"

            drafts = _beat_drafts(title, beat, sprites)
            body = f"""id: {eid}
label: {title}
priority: {5 + i}
once: true
chance: 1.0
scene_id: ""
trigger:
  character_ids: [{cid}]
  stage_min: {stage}
  affinity_min: {aff}
  flags_absent: [{', '.join(absent)}]{trigger_extra}
prompt_snippet: |
  【专属故事 · {row.get('route_title')} · 第{i + 1}幕 · {title}】
advance: on_player_turn
{_format_beats(drafts)}
rewards:
  flags_set: [{', '.join(flags)}]
choice_effects:
  - {{ trust_delta: 3, affinity_delta: 3 }}
  - {{ trust_delta: 2, affinity_delta: 2 }}
  - {{ trust_delta: -2, affinity_delta: -1 }}
"""
            path.write_text(body, encoding="utf-8")
            written += 1
    print(f"wrote {written} story event yaml files (skipped existing={skipped})")


if __name__ == "__main__":
    main()
