# -*- coding: utf-8 -*-
from pathlib import Path
import json, re
from collections import defaultdict

root = Path(r"e:/Agent/Companion_Agent")
routes = json.loads((root/"data/story_routes.json").read_text(encoding="utf-8"))
manifest = json.loads((root/"data/sprite_gen_manifest.json").read_text(encoding="utf-8"))
chars = manifest.get("characters") or {}

EMOS = ("_neutral","_happy","_shy","_sad","_angry","_love","_surprised","_sleepy")

def disk_outfits(cid, cast):
    d = root/"data"/"sprites"/cast/cid
    if not d.is_dir():
        return {}, 0
    by = defaultdict(set)
    n = 0
    for f in d.glob("*.png"):
        n += 1
        name = f.stem
        outfit = name
        emo = None
        for e in EMOS:
            if name.endswith(e):
                outfit = name[:-len(e)]
                emo = e[1:]
                break
        by[outfit].add(emo or "?")
    return dict(by), n

def count_prefix(outfits, prefixes):
    return sum(1 for o in outfits if any(o.startswith(p) or o == p for p in prefixes))

def has(outfits, oid):
    return oid in outfits

# Expected packs
MAX_IDS = [
  "max_micro_slip","max_garter_stand","max_robe_gap","max_wet_shirt","max_knee_lean",
  "max_sofa_lie","max_mirror_pose","max_stocking_adjust","max_backless_turn","max_lace_sit",
]
# end packs typically 15 outfits x 2 emos = 30 files - count by prefix end_
BATH = ["bath_foam","shower_foam","foam_chest","bath_scrub"]
# pr_ typically many
Q = ["q_cleavage"]
AD = ["ad_bra_set","ad_lace_campaign","ad_silk_lookbook","ad_editorial"]

L0_SPECIAL = [
  "jealous_door","schedule_clash","ethics_lamp","diary_open",
  "secret_morning","window_listen","end_taboo_vow","end_roof_exposed","end_family_hold",
]

LIFE = ["home_eating","home_sleeping","work_working_focus","working_focus"]
WINTER = ["season_winter"]

# order by tier
order = []
for cid, row in routes["characters"].items():
    tier = row.get("story_tier") or row.get("tier") or "?"
    order.append((tier, cid, row))

tier_rank = {"L0":0,"T0":1,"T1":2,"T2":3,"L":4}
order.sort(key=lambda x: (tier_rank.get(x[0],9), x[1]))

lines = []
for tier, cid, row in order:
    cast = "neutral" if cid in {"shuli","jingning","youwei","yuxi","lingke","aichen"} else "romance"
    outfits, png_n = disk_outfits(cid, cast)
    name = (chars.get(cid) or {}).get("name") or row.get("display_name") or cid
    max_n = sum(1 for o in outfits if o.startswith("max_"))
    end_n = sum(1 for o in outfits if o.startswith("end_"))
    bath_n = sum(1 for o in outfits if o.startswith(("bath_","shower_","foam_")))
    pr_n = sum(1 for o in outfits if o.startswith("pr_"))
    q_n = sum(1 for o in outfits if o.startswith("q_"))
    ad_n = sum(1 for o in outfits if o.startswith("ad_"))
    winter = has(outfits, "season_winter")
    life_miss = [x for x in ["home_eating","home_sleeping"] if not has(outfits, x) and not any("eating" in o for o in outfits) if x=="home_eating" or (x=="home_sleeping" and not any("sleeping" in o for o in outfits))]
    # fix life miss properly
    has_eat = any("eating" in o for o in outfits)
    has_sleep = any("sleeping" in o for o in outfits)
    has_workf = any("working_focus" in o or o.endswith("_working_focus") for o in outfits)
    life_miss = []
    if not has_eat: life_miss.append("home_eating")
    if not has_sleep: life_miss.append("home_sleeping")
    if not has_workf: life_miss.append("work_working_focus")

    # romance targets
    if cast == "romance":
        tgt_max, tgt_end, tgt_bath, tgt_pr, tgt_q, tgt_ad = 10, 15, 4, (15 if tier=="T0" or tier=="T1" else 10), 1, 4
        # actually §2.3 is 20 files = 10 outfits; §2.4 30 files = 15 outfits; §2.5 8 files; §2.6 T0/T1 30 files T2 20; §2.7 2; §2.8 8
        # count FILES not outfit ids for progress
        # recount files
        d = root/"data"/"sprites"/cast/cid
        files = list(d.glob("*.png")) if d.is_dir() else []
        def fcount(pred):
            return sum(1 for f in files if pred(f.stem))
        max_f = fcount(lambda s: s.startswith("max_"))
        end_f = fcount(lambda s: s.startswith("end_"))
        bath_f = fcount(lambda s: any(s.startswith(p) for p in ("bath_","shower_","foam_")))
        pr_f = fcount(lambda s: s.startswith("pr_"))
        q_f = fcount(lambda s: s.startswith("q_"))
        ad_f = fcount(lambda s: s.startswith("ad_"))
        tgt_max_f = 20
        tgt_end_f = 30
        tgt_bath_f = 8
        tgt_pr_f = 30 if tier in ("T0","T1") else 20
        tgt_q_f = 2
        tgt_ad_f = 8
        miss = []
        if max_f < tgt_max_f: miss.append(f"max_* {max_f}/{tgt_max_f}")
        if end_f < tgt_end_f: miss.append(f"end_* {end_f}/{tgt_end_f}")
        if bath_f < tgt_bath_f: miss.append(f"bath {bath_f}/{tgt_bath_f}")
        if pr_f < tgt_pr_f: miss.append(f"pr_* {pr_f}/{tgt_pr_f}")
        if q_f < tgt_q_f: miss.append(f"q_* {q_f}/{tgt_q_f}")
        if ad_f < tgt_ad_f: miss.append(f"ad_* {ad_f}/{tgt_ad_f}")
        if not winter: miss.append("season_winter")
        for x in life_miss:
            # T0 may already have; only flag if missing
            miss.append(x)
        # T0 intimate pack - skip detailed if high file count
        print(f"## {tier}|{cid}|{name}|cast={cast}|png={len(files)}|max={max_f}/{tgt_max_f}|end={end_f}/{tgt_end_f}|bath={bath_f}/{tgt_bath_f}|pr={pr_f}/{tgt_pr_f}|q={q_f}/{tgt_q_f}|ad={ad_f}/{tgt_ad_f}|winter={'Y' if winter else 'N'}|life_miss={','.join(life_miss) or '-'}|extra_miss={';'.join([m for m in miss if not m.startswith(('max','end','bath','pr','q','ad','home','work'))]) or '-'}")
    else:
        d = root/"data"/"sprites"/cast/cid
        files = list(d.glob("*.png")) if d.is_dir() else []
        def fcount(pred):
            return sum(1 for f in files if pred(f.stem))
        max_f = fcount(lambda s: s.startswith("max_"))
        end_f = fcount(lambda s: s.startswith("end_"))
        bath_f = fcount(lambda s: any(s.startswith(p) for p in ("bath_","shower_","foam_")))
        pr_f = fcount(lambda s: s.startswith("pr_"))
        q_f = fcount(lambda s: s.startswith("q_"))
        ad_f = fcount(lambda s: s.startswith("ad_"))
        tgt_max_f, tgt_end_f, tgt_bath_f, tgt_pr_f, tgt_q_f, tgt_ad_f = 20, 30, 8, 20, 2, 8
        l0 = []
        if cid == "shuli":
            for oid in L0_SPECIAL:
                if oid not in outfits:
                    l0.append(oid)
        print(f"## {tier}|{cid}|{name}|cast={cast}|png={len(files)}|max={max_f}/{tgt_max_f}|end={end_f}/{tgt_end_f}|bath={bath_f}/{tgt_bath_f}|pr={pr_f}/{tgt_pr_f}|q={q_f}/{tgt_q_f}|ad={ad_f}/{tgt_ad_f}|winter={'Y' if winter else 'N'}|life_miss={','.join(life_miss) or '-'}|L0_miss={','.join(l0) or '-'}")

# also list missing max outfit ids for L chars
print("---DETAIL L---")
for cid in ["shuli","jingning","youwei","yuxi","lingke","aichen"]:
    outfits,_ = disk_outfits(cid,"neutral")
    max_have = sorted(o for o in outfits if o.startswith("max_"))
    end_have = sorted(o for o in outfits if o.startswith("end_"))
    print(cid, "max", max_have)
    print(cid, "end", end_have[:20], "...", len(end_have))
