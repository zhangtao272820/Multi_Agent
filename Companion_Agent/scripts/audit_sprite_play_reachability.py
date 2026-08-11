#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""审计立绘游玩可达性；可选 --fix 将 route.sprites 并入 event sprite_hint，并修正结局 outfit。

分类：
  story   — events/*.yaml sprite_hint
  ending  — presentation_catalog endings.sprite.outfit
  gallery — showcase / group / ad_* / q_* / intro_cards（故意不进日常 resolve）
  dead    — 磁盘有 outfit，但未出现在 story/ending（且非 gallery_only 前缀）

用法：
  python scripts/audit_sprite_play_reachability.py
  python scripts/audit_sprite_play_reachability.py --fix
  python scripts/audit_sprite_play_reachability.py --min-weight 5 --fix
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
EVENTS = DATA / "events"
DOC = ROOT / "doc" / "_sprite_play_reachability.md"
SPRITES = DATA / "sprites"

EMOS = ("neutral", "happy", "shy", "sad", "angry", "love", "surprised", "sarcastic")
GALLERY_PREFIXES = ("ad_", "q_", "menu_", "avatar")
GALLERY_EXACT = frozenset(
    {
        "q_cleavage",
        "ad_bra_set",
        "ad_lace_campaign",
        "ad_silk_lookbook",
        "ad_editorial",
    }
)
# 日常 resolve 可达（亲和/时段/地点），不必进 story hint；不算 dead
SYSTEM_RESOLVE_PREFIXES = (
    "intimate_",
    "pr_intimate_",
    "max_",
    "bath_",
    "shower_",
    "foam_",
    "pr_bath_",
    "pr_shower_",
    "pr_foam_",
    "pr_wrap_",
    "pr_tub_",
    "pr_steam_",
    "pr_kneel_",
    "pr_wet_",
    "pr_shoulder_",
    "pr_back_",
    "pr_edge_",
    "pr_rinse_",
    "after_bath",
    "silk_slip",
    "backless_home",
    "bedside_hug",
    "home_eating",
    "home_sleeping",
)


def is_system_resolve_outfit(oid: str) -> bool:
    if oid in {"bridal", "maternity", "after_bath", "silk_slip", "backless_home", "bedside_hug"}:
        return True
    return oid.startswith(SYSTEM_RESOLVE_PREFIXES)


def load_json(name: str) -> dict:
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def cast_dir(cid: str) -> Path:
    for lane in ("romance", "neutral"):
        d = SPRITES / lane / cid
        if d.is_dir():
            return d
    return SPRITES / "romance" / cid


def outfit_set(cid: str) -> set[str]:
    d = cast_dir(cid)
    out: set[str] = set()
    if not d.is_dir():
        return out
    for p in d.glob("*.png"):
        if p.name.startswith(("menu_", "avatar")):
            continue
        stem = p.stem
        matched = False
        for em in EMOS:
            suf = "_" + em
            if stem.endswith(suf):
                out.add(stem[: -len(suf)])
                matched = True
                break
        if not matched and stem not in EMOS:
            out.add(stem)
    return out


def is_gallery_outfit(oid: str) -> bool:
    if oid in GALLERY_EXACT:
        return True
    return oid.startswith(GALLERY_PREFIXES)


def event_path_for(cid: str, act: dict) -> Path | None:
    eid = (act.get("event_id") or "").strip()
    if eid:
        p = EVENTS / f"{eid}.yaml"
        if p.is_file():
            return p
    act_id = str(act.get("id") or "").strip()
    if act_id:
        p = EVENTS / f"story_{cid}_{act_id}.yaml"
        if p.is_file():
            return p
    # fuzzy: story_{cid}_*{tail}
    tail = act_id.split("_", 1)[-1] if act_id else ""
    if tail:
        matches = sorted(EVENTS.glob(f"story_{cid}_*{tail}*.yaml"))
        if len(matches) == 1:
            return matches[0]
    return None


def collect_story_hints(cid: str, acts: list[dict]) -> tuple[set[str], list[tuple[Path, list[str]]]]:
    """Return (all hints used, list of (path, route_sprites) for wiring)."""
    used: set[str] = set()
    wire_jobs: list[tuple[Path, list[str]]] = []
    for act in acts:
        sprites = [str(s).strip() for s in (act.get("sprites") or []) if str(s).strip()]
        path = event_path_for(cid, act)
        if path and path.is_file():
            doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            for beat in doc.get("beats") or []:
                for h in beat.get("sprite_hint") or []:
                    if str(h).strip():
                        used.add(str(h).strip())
            wire_jobs.append((path, sprites))
        else:
            for s in sprites:
                used.add(s)
    return used, wire_jobs


def collect_ending_outfits(cid: str, endings_cat: dict, present: dict) -> set[str]:
    used: set[str] = set()
    end_map = present.get("endings") or {}
    on_disk = outfit_set(cid)
    for row in endings_cat.get("endings") or []:
        ids = row.get("character_ids") or []
        # 专属结局：必须点名本角；泛用结局：仅统计本角磁盘已有的 outfit（避免 maternity 误记到非 5★）
        specific = bool(ids)
        if specific and cid not in ids:
            continue
        eid = str(row.get("id") or "")
        for key in (eid, str(row.get("presentation_id") or eid)):
            block = end_map.get(key) or {}
            spr = block.get("sprite") or {}
            spr_cid = str(spr.get("character_id") or "").strip()
            if spr_cid and spr_cid != cid:
                continue
            outfit = str(spr.get("outfit") or "").strip()
            if not outfit:
                continue
            if specific or outfit in on_disk or spr_cid == cid:
                used.add(outfit)
    return used


def merge_hints(existing: list[str], route: list[str], on_disk: set[str], limit: int = 8) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    # 先保证 route 声明（且磁盘存在）尽量全部入列
    for x in route:
        x = str(x).strip()
        if not x or x in seen:
            continue
        if x.startswith("end_") or is_gallery_outfit(x):
            continue
        if on_disk and x not in on_disk:
            continue
        seen.add(x)
        out.append(x)
    for x in existing:
        x = str(x).strip()
        if not x or x in seen:
            continue
        if x.startswith("end_") or is_gallery_outfit(x):
            continue
        if on_disk and x not in on_disk:
            continue
        seen.add(x)
        out.append(x)
        if len(out) >= max(limit, len(route) + 2):
            break
    return out or existing[:limit] or (["casual"] if "casual" in on_disk else list(on_disk)[:1])


def fix_event_hints(path: Path, route_sprites: list[str], on_disk: set[str]) -> bool:
    text = path.read_text(encoding="utf-8")
    doc = yaml.safe_load(text) or {}
    beats = doc.get("beats") or []
    if not beats:
        return False
    changed = False
    for beat in beats:
        old = [str(x) for x in (beat.get("sprite_hint") or [])]
        new = merge_hints(old, route_sprites, on_disk)
        if new != old:
            beat["sprite_hint"] = new
            changed = True
    if not changed:
        return False
    # Prefer round-trip via yaml dump for beats only — rewrite whole file carefully
    path.write_text(
        yaml.safe_dump(doc, allow_unicode=True, sort_keys=False, default_flow_style=False),
        encoding="utf-8",
    )
    return True


def pick_existing_ending_outfit(preferred: str, on_disk: set[str]) -> str:
    if preferred and preferred in on_disk:
        return preferred
    for cand in (
        "end_lingerie_set",
        "end_robe_open",
        "end_close_embrace",
        "end_window_night",
        "maternity",
        "bridal",
        "date",
        "casual",
        "home",
        "work",
    ):
        if cand in on_disk:
            return cand
    return preferred


def fix_presentation_outfits(present: dict, endings_cat: dict, stars: dict, min_weight: int) -> int:
    end_map = present.setdefault("endings", {})
    fixed = 0
    for row in endings_cat.get("endings") or []:
        ids = row.get("character_ids") or []
        if not ids:
            continue
        cid = ids[0]
        weight = int((stars.get(cid) or {}).get("story_weight") or 0)
        if weight < min_weight:
            continue
        eid = str(row.get("id") or "")
        block = end_map.get(eid)
        if not isinstance(block, dict):
            continue
        spr = block.get("sprite")
        if not isinstance(spr, dict):
            continue
        outfit = str(spr.get("outfit") or "").strip()
        on_disk = outfit_set(cid)
        new_o = pick_existing_ending_outfit(outfit, on_disk)
        if new_o != outfit:
            spr["outfit"] = new_o
            spr["character_id"] = cid
            fixed += 1
        elif not spr.get("character_id"):
            spr["character_id"] = cid
            fixed += 1
    return fixed


def write_report(rows: list[dict], by_weight: dict[int, dict[str, int]]) -> None:
    lines = [
        "# 立绘游玩可达性审计",
        "",
        "> 由 `scripts/audit_sprite_play_reachability.py` 生成。gallery = showcase/ad/q 等故意不进日常 resolve。",
        "",
        "## 按戏份星汇总",
        "",
        "| 戏份星 | 角色数 | dead outfits | route 未进 hint | ending 缺盘 |",
        "|--------|--------|--------------|-----------------|-------------|",
    ]
    for w in (5, 4, 3, 2, 1):
        s = by_weight.get(w) or {}
        lines.append(
            f"| {'★' * w or '—'} | {s.get('chars', 0)} | {s.get('dead', 0)} | "
            f"{s.get('unwired', 0)} | {s.get('ending_miss', 0)} |"
        )
    lines.extend(["", "## 每角色", ""])
    lines.append("| 星 | id | disk | story | ending | dead | unwired route | ending miss |")
    lines.append("|----|----|------|-------|--------|------|---------------|-------------|")
    for r in rows:
        lines.append(
            f"| {r['stars']} | `{r['cid']}` | {r['disk']} | {r['story']} | {r['ending']} | "
            f"{r['dead_n']} | {r['unwired_n']} | {r['ending_miss_n']} |"
        )
    lines.extend(
        [
            "",
            "## dead 样例（每角最多 8）",
            "",
        ]
    )
    for r in rows:
        if not r["dead_sample"]:
            continue
        lines.append(f"- **{r['cid']}** ({r['stars']}): " + ", ".join(f"`{x}`" for x in r["dead_sample"]))
    lines.append("")
    DOC.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true", help="写入 sprite_hint / presentation outfit 修正")
    ap.add_argument("--min-weight", type=int, default=2, help="接线最低戏份星（默认 2=全可攻略）")
    args = ap.parse_args()

    stars = load_json("cast_star_tiers.json").get("characters") or {}
    routes = load_json("story_routes.json").get("characters") or {}
    endings_cat = load_json("endings.json")
    present = load_json("presentation_catalog.json")

    rows: list[dict] = []
    by_weight: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    fixed_events = 0

    ordered = sorted(
        stars.items(),
        key=lambda kv: (-int((kv[1] or {}).get("story_weight") or 0), kv[0]),
    )

    for cid, meta in ordered:
        weight = int((meta or {}).get("story_weight") or 0)
        by_weight[weight]["chars"] += 1
        on_disk = outfit_set(cid)
        acts = (routes.get(cid) or {}).get("acts") or []
        story_used, wire_jobs = collect_story_hints(cid, acts)
        ending_used = collect_ending_outfits(cid, endings_cat, present)

        playable = set()
        for o in on_disk:
            if is_gallery_outfit(o):
                continue
            playable.add(o)

        dead = sorted(
            o
            for o in playable
            if o not in story_used
            and o not in ending_used
            and not o.startswith("end_")
            and not is_system_resolve_outfit(o)
            and not o.startswith("festival_")
            and o not in {"season_winter", "season_spring", "season_summer", "season_autumn"}
        )

        route_declared: set[str] = set()
        for _path, sprites in wire_jobs:
            route_declared.update(sprites)
        for act in acts:
            route_declared.update(str(s) for s in (act.get("sprites") or []))
        unwired = sorted(
            s
            for s in route_declared
            if s
            and s in on_disk
            and s not in story_used
            and not s.startswith("end_")
            and not is_gallery_outfit(s)
        )

        ending_miss = sorted(o for o in ending_used if o and o not in on_disk)

        by_weight[weight]["dead"] += len(dead)
        by_weight[weight]["unwired"] += len(unwired)
        by_weight[weight]["ending_miss"] += len(ending_miss)

        rows.append(
            {
                "cid": cid,
                "stars": (meta or {}).get("tier_stars") or ("★" * weight),
                "disk": len(on_disk),
                "story": len(story_used),
                "ending": len(ending_used),
                "dead_n": len(dead),
                "unwired_n": len(unwired),
                "ending_miss_n": len(ending_miss),
                "dead_sample": dead[:8],
            }
        )

        if args.fix and weight >= args.min_weight:
            for path, sprites in wire_jobs:
                if fix_event_hints(path, sprites, on_disk):
                    fixed_events += 1

    fixed_pres = 0
    if args.fix:
        fixed_pres = fix_presentation_outfits(present, endings_cat, stars, args.min_weight)
        if fixed_pres:
            (DATA / "presentation_catalog.json").write_text(
                json.dumps(present, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )

    write_report(rows, by_weight)
    print(f"OK report → {DOC.relative_to(ROOT)}")
    if args.fix:
        print(f"fixed events={fixed_events} presentation_outfits={fixed_pres}")
    # soft gate: 5★ should not have route unwired after fix
    star5 = [r for r in rows if r["stars"] == "★★★★★"]
    unwired5 = sum(r["unwired_n"] for r in star5)
    if args.fix and unwired5 > 0:
        # re-count after fix would need re-scan; warn only
        print(f"note: pre-fix 5★ unwired total was {unwired5}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
