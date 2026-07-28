# -*- coding: utf-8 -*-
"""将 T0/T1/N（及未结构化的幕）写成 ≥3 拍 beats。

默认跳过已有 beats≥3 的文件；--force 全量覆盖。
不改 trigger/rewards，只升级 prompt_snippet 标题行 + beats。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"
ROUTES = ROOT / "data" / "story_routes.json"


def _opts_open() -> list[str]:
    return ["认真接话", "先观察", "轻声提问"]


def _opts_mid() -> list[str]:
    return ["表明态度", "给她空间", "确认她的意思"]


def _opts_close(neutral: bool) -> list[str]:
    if neutral:
        return ["答应站同一边", "先缓一缓", "诚实说明顾虑"]
    return ["坦白心意", "先缓一缓", "诚实说明顾虑"]


def _beats_for(act: dict, *, route_title: str, tier: str, act_i: int, title: str) -> list[dict]:
    beat = str(act.get("beat") or title).strip()
    sprites = [str(s) for s in (act.get("sprites") or [])] or ["casual"]
    neutral = tier == "N"
    # 拆一句 beat 为开场 / 中段钩子
    parts = [p.strip() for p in beat.replace("；", "。").split("。") if p.strip()]
    open_s = parts[0] if parts else f"围绕「{title}」的开场。"
    mid_s = parts[1] if len(parts) > 1 else f"「{title}」里出现犹豫或选择。"
    close_s = (
        f"收束本幕：留下可被记住的结果，不剧透结局名。"
        if not neutral
        else f"收束羁绊：确认界线与同盟，禁止恋爱走向。"
    )
    if len(parts) > 2:
        close_s = parts[2] + "——留下可记的结果，不剧透结局。"

    h0 = sprites[:2]
    h1 = sprites[1:3] if len(sprites) > 1 else sprites[:1]
    h2 = sprites[-1:] or ["casual"]

    return [
        {
            "id": "b1",
            "summary": open_s[:80],
            "sprite_hint": h0,
            "soft_options": _opts_open(),
        },
        {
            "id": "b2",
            "summary": mid_s[:80],
            "sprite_hint": h1,
            "soft_options": _opts_mid(),
        },
        {
            "id": "b3",
            "summary": close_s[:80],
            "sprite_hint": h2,
            "soft_options": _opts_close(neutral),
        },
    ]


# 人工加厚：覆盖算法草稿（摘要更有剧本感）
CURATED: dict[str, list[dict]] = {
    "story_xiaoyou_act1_threshold": [
        {
            "id": "b1",
            "summary": "傍晚阳台寒暄——她手上有颜料，门铃响得比往常轻。",
            "sprite_hint": ["casual", "home"],
            "soft_options": ["隔门问一句", "按铃再等", "先回自己家"],
        },
        {
            "id": "b2",
            "summary": "她借稀释剂或纸，欲言又止；是否跨过邻居的礼貌距离。",
            "sprite_hint": ["home", "atelier_paint"],
            "soft_options": ["递过去并进门", "门口交接", "改天再说"],
        },
        {
            "id": "b3",
            "summary": "进画室：灯光、未干的画、她背对你的肩线——门槛隐喻收束。",
            "sprite_hint": ["atelier_paint", "home"],
            "soft_options": ["夸画", "安静看", "懂时退出"],
        },
    ],
    "story_wanyu_act1_regular": [
        {
            "id": "b1",
            "summary": "你成了熟客座位；她把杯子放下的角度像记得糖度。",
            "sprite_hint": ["work", "barista_steam"],
            "soft_options": ["道谢点单", "开个小玩笑", "安静坐下"],
        },
        {
            "id": "b2",
            "summary": "雨敲窗；她问你是来躲雨，还是专门来找这杯味道。",
            "sprite_hint": ["rain", "work"],
            "soft_options": ["说专门来的", "说顺便", "问她歇没歇"],
        },
        {
            "id": "b3",
            "summary": "收束于「常客」被记住：她允许你把这里当成短暂停靠。",
            "sprite_hint": ["barista_steam", "casual"],
            "soft_options": ["约定下次还坐这", "多留一会儿", "道谢离开"],
        },
    ],
    "story_shuli_act1_dinner": [
        {
            "id": "b1",
            "summary": "晚饭桌上她先报校园近况，又装作不经意地问你最近见谁。",
            "sprite_hint": ["home", "school"],
            "soft_options": ["如实说", "先问她功课", "打趣岔开"],
        },
        {
            "id": "b2",
            "summary": "她强调：你们是家人——关心可以，别把她当恋爱参谋乱使。",
            "sprite_hint": ["home", "casual"],
            "soft_options": ["道歉边界", "认真听完", "说需要她意见"],
        },
        {
            "id": "b3",
            "summary": "洗碗时她松口：关键时候会站你这边，但先把日子过稳。",
            "sprite_hint": ["home", "casual"],
            "soft_options": ["道谢", "约周末再做饭", "保证不乱来"],
        },
    ],
}


def _dump_yaml(data: dict) -> str:
    """稳定、可读的 YAML（保留中文）。"""
    # 手动拼以控制 beats 格式
    lines: list[str] = []
    lines.append(f"id: {data['id']}")
    lines.append(f"label: {data['label']}")
    lines.append(f"priority: {data['priority']}")
    lines.append(f"once: {str(data.get('once', True)).lower()}")
    lines.append(f"chance: {data.get('chance', 1.0)}")
    lines.append(f"scene_id: \"{data.get('scene_id') or ''}\"")
    tr = data.get("trigger") or {}
    lines.append("trigger:")
    for k, v in tr.items():
        if isinstance(v, list):
            lines.append(f"  {k}: [{', '.join(str(x) for x in v)}]")
        else:
            lines.append(f"  {k}: {v}")
    title_line = (data.get("prompt_snippet") or "").strip().split("\n")[0]
    if not title_line.startswith("【专属故事"):
        title_line = f"【专属故事 · {data['label']}】"
    lines.append("prompt_snippet: |")
    lines.append(f"  {title_line}")
    lines.append(f"advance: {data.get('advance') or 'on_player_turn'}")
    lines.append("beats:")
    for b in data["beats"]:
        lines.append(f"  - id: {b['id']}")
        summ = str(b["summary"]).replace('"', '\\"')
        lines.append(f'    summary: "{summ}"')
        hints = b.get("sprite_hint") or []
        lines.append(f"    sprite_hint: [{', '.join(str(x) for x in hints)}]")
        opts = b.get("soft_options") or []
        q = ", ".join(f'"{x}"' for x in opts)
        lines.append(f"    soft_options: [{q}]")
    rewards = data.get("rewards") or {}
    flags = rewards.get("flags_set") or []
    lines.append("rewards:")
    lines.append(f"  flags_set: [{', '.join(str(x) for x in flags)}]")
    lines.append("choice_effects:")
    for ce in data.get("choice_effects") or [
        {"trust_delta": 3, "affinity_delta": 3},
        {"trust_delta": 2, "affinity_delta": 2},
        {"trust_delta": -2, "affinity_delta": -1},
    ]:
        td = int(ce.get("trust_delta", 0))
        ad = int(ce.get("affinity_delta", 0))
        lines.append(f"  - {{ trust_delta: {td}, affinity_delta: {ad} }}")
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--tiers", default="T0,T1,N", help="逗号分隔梯度")
    args = ap.parse_args()
    want = {t.strip() for t in args.tiers.split(",") if t.strip()}

    routes = json.loads(ROUTES.read_text(encoding="utf-8"))
    chars = routes.get("characters") or {}
    written = 0
    skipped = 0

    for cid, row in chars.items():
        tier = str(row.get("tier") or "")
        if tier not in want:
            continue
        route_title = str(row.get("route_title") or "")
        acts = row.get("acts") or []
        for i, act in enumerate(acts):
            aid = str(act.get("id") or i)
            eid = f"story_{cid}_{aid}"
            path = EVENTS / f"{eid}.yaml"
            if not path.is_file():
                print("missing", eid)
                continue
            raw = yaml.safe_load(path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                continue
            existing = raw.get("beats") or []
            if len(existing) >= 3 and not args.force:
                skipped += 1
                continue
            title = str(act.get("title") or raw.get("label") or aid)
            if eid in CURATED:
                beats = CURATED[eid]
            else:
                beats = _beats_for(act, route_title=route_title, tier=tier, act_i=i, title=title)
            raw["beats"] = beats
            raw["advance"] = "on_player_turn"
            raw["prompt_snippet"] = f"【专属故事 · {route_title} · 第{i + 1}幕 · {title}】"
            raw["label"] = title
            path.write_text(_dump_yaml(raw), encoding="utf-8")
            written += 1

    print(f"enriched={written} skipped={skipped} tiers={sorted(want)}")


if __name__ == "__main__":
    main()
