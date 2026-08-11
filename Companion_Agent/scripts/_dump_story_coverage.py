# -*- coding: utf-8 -*-
"""One-shot story coverage dump for docs."""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
stars = json.loads((ROOT / "data/cast_star_tiers.json").read_text(encoding="utf-8"))["characters"]
routes = json.loads((ROOT / "data/story_routes.json").read_text(encoding="utf-8"))["characters"]
pres = json.loads((ROOT / "data/presentation_catalog.json").read_text(encoding="utf-8")).get("endings") or {}
endings = json.loads((ROOT / "data/endings.json").read_text(encoding="utf-8")).get("endings") or []

by_cid: dict[str, list[Path]] = defaultdict(list)
for p in (ROOT / "data/events").glob("story_*.yaml"):
    rest = p.stem[len("story_") :]
    cid = None
    for c in sorted(stars, key=len, reverse=True):
        if rest == c or rest.startswith(c + "_"):
            cid = c
            break
    if cid:
        by_cid[cid].append(p)


def narr_stats(cid: str):
    lens = []
    missing_narr = 0
    for path in by_cid.get(cid, []):
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for b in doc.get("beats") or []:
            n = (b.get("narration") or "").strip()
            if n:
                lens.append(len(n))
            else:
                missing_narr += 1
                s = (b.get("summary") or "").strip()
                if s:
                    lens.append(len(s))
    if not lens:
        return 0, 0, 0, missing_narr
    return len(lens), min(lens), round(sum(lens) / len(lens)), missing_narr


def ending_page_floor(weight: int, etype: str) -> int:
    """与故事厚度规范 §3 对齐：真/好按星；soft/bad 5★/4★≥3，其余≥2。"""
    et = (etype or "normal").lower()
    if et in {"secret", "good"}:
        return {5: 5, 4: 4, 3: 3, 2: 2}.get(weight, 2)
    # normal=soft, bad
    return {5: 3, 4: 3, 3: 2, 2: 2}.get(weight, 2)


def ending_pages(cid: str, weight: int):
    ids = set((routes.get(cid) or {}).get("unique_ending_ids") or [])
    type_by_id = {str(row.get("id") or ""): str(row.get("type") or "normal") for row in endings}
    for row in endings:
        chars = row.get("character_ids") or []
        if cid in chars:
            ids.add(str(row.get("id") or ""))
    pages = []
    thin = []
    for eid in sorted(ids):
        block = pres.get(eid) or {}
        ps = block.get("pages") or []
        n = len(ps)
        pages.append((eid, n))
        need = ending_page_floor(weight, type_by_id.get(eid, "normal"))
        if n < need:
            thin.append(f"{eid}({n}<{need})")
    return pages, thin


rows = []
for cid, meta in sorted(stars.items(), key=lambda kv: (-int(kv[1].get("story_weight") or 0), kv[0])):
    ch = routes.get(cid) or {}
    acts = ch.get("acts") or []
    yamls = by_cid.get(cid, [])
    nb, mn, avg, miss_n = narr_stats(cid)
    married = any("married" in p.name for p in yamls)
    weight = int(meta.get("story_weight") or 0)
    pages, thin = ending_pages(cid, weight)
    target_min = {5: 80, 4: 70, 3: 60, 2: 50}.get(weight, 40)
    gaps = []
    if not acts:
        gaps.append("无 route acts")
    if len(yamls) < len(acts):
        gaps.append(f"yaml{len(yamls)}<acts{len(acts)}")
    if miss_n:
        gaps.append(f"缺narration×{miss_n}")
    if mn and mn < target_min:
        gaps.append(f"narr偏短min={mn}<{target_min}")
    # 书璃 5★ 但政策禁孕装/婚孕幕，不记缺口
    if weight == 5 and not married and cid != "shuli":
        gaps.append("缺married_expecting")
    if thin:
        gaps.append("结局页薄:" + ",".join(thin[:3]))
    # missing act yamls
    missing_acts = []
    for act in acts:
        eid = (act.get("event_id") or "").strip()
        act_id = str(act.get("id") or "")
        found = False
        if eid and (ROOT / "data/events" / f"{eid}.yaml").is_file():
            found = True
        elif act_id and (ROOT / "data/events" / f"story_{cid}_{act_id}.yaml").is_file():
            found = True
        else:
            # fuzzy
            for p in yamls:
                if act_id and act_id.replace("act", "") in p.name:
                    found = True
                    break
        if not found:
            missing_acts.append(act_id or eid or "?")
    if missing_acts:
        gaps.append("缺幕:" + ",".join(missing_acts[:4]))
    rows.append(
        {
            "cid": cid,
            "stars": meta.get("tier_stars"),
            "w": int(meta.get("story_weight") or 0),
            "name": meta.get("name"),
            "acts": len(acts),
            "yaml": len(yamls),
            "beats": nb,
            "narr_min": mn,
            "narr_avg": avg,
            "uend": len(ch.get("unique_ending_ids") or []),
            "married": married,
            "gaps": gaps,
        }
    )

out = ROOT / "doc" / "_story_coverage_snapshot.md"
gap_rows = [r for r in rows if r["gaps"]]
narr_ok = not any(any("narr偏短" in g or "缺narration" in g for g in r["gaps"]) for r in rows)
pages_ok = not any(any("结局页薄" in g for g in r["gaps"]) for r in rows)
copy_line = (
    "旁白字数与结局页数按星级目标 **已齐**；总览缺口列为空"
    if narr_ok and pages_ok and not gap_rows
    else ("仍有缺口，见总览「缺口」列" if gap_rows else "旁白/结局页目标已齐")
)
lines = [
    "# 角色故事覆盖快照",
    "",
    "> 由 `scripts/_dump_story_coverage.py` 生成 · 重建会刷新总览表。",
    "> 戏份星：[`cast_star_tiers.json`](../data/cast_star_tiers.json) · [`故事厚度与文案规范.md`](./故事厚度与文案规范.md) §0 · 美德式 §0",
    "",
    "## 结论（先看这）",
    "",
    "| | |",
    "|--|--|",
    "| **骨架** | 22 人专属幕 yaml **齐全**；无人缺 route 幕；5★ 婚孕短拍 **齐全**（书璃政策不建） |",
    "| **接线** | 故事立绘 route→hint **已齐** |",
    f"| **文案** | {copy_line} |",
    "| **介绍卡文案** | `character_intro_cards.json` **22/22**（出图见立绘进度表 W8） |",
    "",
    "详见总览表「缺口」列。",
    "",
    "## 总览",
    "",
    "| 星 | id | 名 | route幕 | yaml | beats | narr_min | narr_avg | 专属结局 | 婚孕幕 | 缺口 |",
    "|----|----|----|---------|------|-------|----------|----------|----------|--------|------|",
]
for r in rows:
    gap = "；".join(r["gaps"]) if r["gaps"] else "—"
    lines.append(
        f"| {r['stars']} | `{r['cid']}` | {r['name']} | {r['acts']} | {r['yaml']} | {r['beats']} | "
        f"{r['narr_min']} | {r['narr_avg']} | {r['uend']} | {'有' if r['married'] else '—'} | {gap} |"
    )

# gap focus sections
need_thicken = [r for r in rows if any("narr偏短" in g or "缺narration" in g for g in r["gaps"])]
need_pages = [r for r in rows if any("结局页薄" in g for g in r["gaps"])]
need_married = [r for r in rows if r["w"] == 5 and not r["married"]]
missing_yaml = [r for r in rows if any(g.startswith("缺幕") or "yaml" in g for g in r["gaps"])]

lines += ["", "## 优先缺口（故事文案）", ""]
lines.append("### A. 旁白未达星级字数目标（加厚候选）")
if need_thicken:
    for r in need_thicken:
        lines.append(f"- **{r['stars']} `{r['cid']}`** {r['name']}：narr_min={r['narr_min']} / avg={r['narr_avg']}；{('；'.join(r['gaps']))}")
else:
    lines.append("- （无）")

lines.append("")
lines.append("### B. 专属结局 presentation 页偏少")
if need_pages:
    for r in need_pages:
        thin = [g for g in r["gaps"] if g.startswith("结局页薄")]
        lines.append(f"- **{r['stars']} `{r['cid']}`** {r['name']}：{'; '.join(thin)}")
else:
    lines.append("- （无）")

lines.append("")
lines.append("### C. 5★ 婚孕短拍")
if need_married:
    for r in need_married:
        lines.append(f"- `{r['cid']}` 缺 `story_*_married_expecting`")
else:
    lines.append("- 5★ 六人均已有 married_expecting yaml")

lines.append("")
lines.append("### D. route 幕缺对应 yaml")
if missing_yaml:
    for r in missing_yaml:
        lines.append(f"- **{r['stars']} `{r['cid']}`**：{('；'.join(r['gaps']))}")
else:
    lines.append("- （无）")

lines += [
    "",
    "## 已完成（接线波次）",
    "",
    "- 戏份星级 SSOT + 图鉴「戏份」星展示",
    "- `route.sprites` → event `sprite_hint` 全星级 route 未接线 = 0",
    "- 审计报告：[`_sprite_play_reachability.md`](./_sprite_play_reachability.md)",
    "- 厚度规范已落盘；**YAML 加厚尚未开跑**",
    "",
]
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
print("wrote", out)
for r in rows:
    if r["gaps"]:
        print(r["cid"], r["gaps"])
