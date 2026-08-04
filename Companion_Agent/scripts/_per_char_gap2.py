# -*- coding: utf-8 -*-
from pathlib import Path
import json
from collections import defaultdict

root = Path(r"e:/Agent/Companion_Agent")
routes = json.loads((root/"data/story_routes.json").read_text(encoding="utf-8"))
manifest = json.loads((root/"data/sprite_gen_manifest.json").read_text(encoding="utf-8"))
chars = manifest["characters"]

EMOS = ("_neutral","_happy","_shy","_sad","_angry","_love","_surprised","_sleepy")

# Standard packs from plan / shuli complete set
END_STD = [
  "end_lingerie_set","end_close_embrace","end_robe_open","end_sheer_cover","end_window_night",
  "end_lace_bra","end_deep_v","end_garter_bed","end_sofa_invite","end_morning_after",
  "end_wet_home","end_strappy","end_choker","end_kneel_pillow","end_back_glance",
]
MAX_STD = [
  "max_micro_slip","max_garter","max_sofa_lie","max_wet_cling","max_kneel_pillow",
  "max_choker","max_over_shoulder","max_ribbon_cover","max_slit_gown","max_strappy",
]
BATH_STD = ["bath_foam","shower_foam","foam_chest","bath_scrub"]  # x2 emos = 8
# pr for L/T2 = 20 files - get from shuli
def outfits_of(cid, cast):
    d = root/"data"/"sprites"/cast/cid
    by=defaultdict(set); files=0
    if not d.is_dir(): return by,0
    for f in d.glob("*.png"):
        files+=1
        name=f.stem; outfit=name; emo="?"
        for e in EMOS:
            if name.endswith(e):
                outfit=name[:-len(e)]; emo=e[1:]; break
        by[outfit].add(emo)
    return by, files

shuli_o,_ = outfits_of("shuli","neutral")
PR_STD = sorted(o for o in shuli_o if o.startswith("pr_"))
Q_STD = ["q_cleavage"]  # 2 emos
AD_STD = ["ad_bra_set","ad_lace_campaign","ad_silk_lookbook","ad_editorial"]
L0_SPECIAL = [
  "jealous_door","schedule_clash","ethics_lamp","diary_open",
  "secret_morning","window_listen","end_taboo_vow","end_roof_exposed","end_family_hold",
]
LIFE = ["home_eating","home_sleeping","work_working_focus"]

out_path = root/"doc"/"_per_char_sprite_gap.md"
# write UTF-8 report with names from manifest
lines=[]
lines.append("# 每角色立绘进度与缺口（审计生成 · 2026-08-04）\n")
lines.append("> 由磁盘 `data/sprites/{romance|neutral}/{id}/` 对照扩展计划配额扫描。\n")

tier_rank={"L0":0,"T0":1,"T1":2,"T2":3,"L":4}
items=[]
for cid,row in routes["characters"].items():
    tier=row.get("story_tier") or row.get("tier") or "?"
    items.append((tier_rank.get(tier,9), tier, cid))
items.sort()

for _, tier, cid in items:
    cast = "neutral" if cid in {"shuli","jingning","youwei","yuxi","lingke","aichen"} else "romance"
    meta = chars.get(cid) or {}
    name = meta.get("name") or cid
    o, png = outfits_of(cid, cast)
    def fcount(prefix=None, exact=None, startswith=None):
        d = root/"data"/"sprites"/cast/cid
        if not d.is_dir(): return 0
        n=0
        for f in d.glob("*.png"):
            s=f.stem
            if startswith and s.startswith(startswith): n+=1
            elif exact and any(s.startswith(x+"_") or s==x for x in exact): n+=1
        return n
    max_f = sum(1 for f in (root/"data"/"sprites"/cast/cid).glob("*.png") if f.stem.startswith("max_")) if (root/"data"/"sprites"/cast/cid).is_dir() else 0
    end_f = sum(1 for f in (root/"data"/"sprites"/cast/cid).glob("*.png") if f.stem.startswith("end_")) if (root/"data"/"sprites"/cast/cid).is_dir() else 0
    bath_f = sum(1 for f in (root/"data"/"sprites"/cast/cid).glob("*.png") if f.stem.startswith(("bath_","shower_","foam_"))) if (root/"data"/"sprites"/cast/cid).is_dir() else 0
    pr_f = sum(1 for f in (root/"data"/"sprites"/cast/cid).glob("*.png") if f.stem.startswith("pr_")) if (root/"data"/"sprites"/cast/cid).is_dir() else 0
    q_f = sum(1 for f in (root/"data"/"sprites"/cast/cid).glob("*.png") if f.stem.startswith("q_")) if (root/"data"/"sprites"/cast/cid).is_dir() else 0
    ad_f = sum(1 for f in (root/"data"/"sprites"/cast/cid).glob("*.png") if f.stem.startswith("ad_")) if (root/"data"/"sprites"/cast/cid).is_dir() else 0
    winter = "season_winter" in o
    life_have = [x for x in LIFE if x in o or any(x.split("_")[-1] in oo and x.split("_")[0] in oo for oo in o)]
    # simpler life
    has_eat = any("eating" in x for x in o)
    has_sleep = any("sleeping" in x for x in o)
    has_wf = any("working_focus" in x for x in o)

    if cast=="romance":
        tgt_pr = 30 if tier in ("T0","T1") else 20
        packs = [
            ("§2.3 max", max_f, 20),
            ("§2.4 end", end_f, 30),
            ("§2.5 bath", bath_f, 8),
            ("§2.6 pr", pr_f, tgt_pr),
            ("§2.7 q", q_f, 2),
            ("§2.8 ad", ad_f, 8),
        ]
    else:
        tgt_pr = 20
        packs = [
            ("§2.3 max", max_f, 20),
            ("§2.4 end", end_f, 30),
            ("§2.5 bath", bath_f, 8),
            ("§2.6 pr", pr_f, tgt_pr),
            ("§2.7 q", q_f, 2),
            ("§2.8 ad", ad_f, 8),
        ]

    miss_outfits=[]
    # missing outfit ids (not file count)
    if cast!="romance" or True:
        for oid in MAX_STD:
            if oid not in o and max_f < 20:
                # only list if pack incomplete
                pass
        if max_f < 20:
            miss_outfits += [f"{x}（缺）" for x in MAX_STD if x not in o]
        if end_f < 30:
            miss_outfits += [f"{x}（缺）" for x in END_STD if x not in o]
        if bath_f < 8:
            miss_outfits += [f"{x}（缺）" for x in BATH_STD if x not in o]
        if pr_f < (30 if tier in ("T0","T1") else 20):
            # list missing pr ids vs shuli set for L/T2
            for oid in PR_STD:
                if oid not in o:
                    miss_outfits.append(f"{oid}（缺）")
        if q_f < 2:
            miss_outfits.append("q_cleavage（缺）")
        if ad_f < 8:
            miss_outfits += [f"{x}（缺）" for x in AD_STD if x not in o]
        if not winter and tier=="T2":
            miss_outfits.append("season_winter（缺·冬幕）")
        if tier=="T2":
            if not has_eat: miss_outfits.append("home_eating（缺·A.2）")
            if not has_sleep: miss_outfits.append("home_sleeping（缺·A.2）")
            if not has_wf: miss_outfits.append("work_working_focus（缺·A.2）")
        if cid=="shuli":
            for oid in L0_SPECIAL:
                if oid not in o:
                    miss_outfits.append(f"{oid}（缺·L0专属）")

    # progress bar summary
    done = sum(1 for _,a,b in packs if a>=b)
    total = len(packs)
    status = "完成线齐" if done==total and not any("L0专属" in m or "冬幕" in m or "A.2" in m for m in miss_outfits) else ("主包齐·有查漏" if done==total else "进行中")
    if cid=="shuli" and any("L0专属" in m for m in miss_outfits):
        status = "通用包齐·L0专属未出"
    if tier=="T2" and done==total and any("冬幕" in m or "A.2" in m for m in miss_outfits):
        status = "主包齐·冬/生活态缺口"

    lines.append(f"\n## {name}（`{cid}`）· {tier} · `{cast}/`\n")
    lines.append(f"- **总 PNG**：{png} · **状态**：{status}\n")
    lines.append("| 包 | 进度 |")
    lines.append("|----|------|")
    for label, a, b in packs:
        mark = "✅" if a>=b else f"**{a}/{b}**"
        lines.append(f"| {label} | {mark if a>=b else str(a)+'/'+str(b)} |")
    lines.append(f"| season_winter | {'✅' if winter else '❌ 缺'} |")
    lines.append(f"| 生活态 eating/sleeping/focus | {'✅' if (has_eat and has_sleep and has_wf) else ('部分' if (has_eat or has_sleep or has_wf) else '❌ 缺')} |")
    if miss_outfits:
        lines.append("\n**缺少 outfit（按 id）**：\n")
        for m in miss_outfits:
            lines.append(f"- `{m.replace('（缺）','').replace('（缺·L0专属）','').replace('（缺·冬幕）','').replace('（缺·A.2）','')}`" + (" · L0专属" if "L0" in m else (" · 冬幕" if "冬幕" in m else (" · A.2" if "A.2" in m else ""))))
    else:
        lines.append("\n**缺少 outfit**：无（完成线内）。\n")

text="\n".join(lines)+"\n"
# print for console with ascii ids only
print(text.encode("utf-8", errors="replace")[:200])
out_path.write_text(text, encoding="utf-8")
print("WROTE", out_path, "chars", len(items))
