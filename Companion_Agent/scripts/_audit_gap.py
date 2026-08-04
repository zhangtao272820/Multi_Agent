from pathlib import Path
import json, re
from collections import defaultdict
root = Path(r"e:/Agent/Companion_Agent")
routes = json.loads((root/"data/story_routes.json").read_text(encoding="utf-8"))
EMOS = ("_neutral","_happy","_shy","_sad","_angry","_love","_surprised","_sleepy")
def disk_outfits(cid, cast):
    d = root/"data"/"sprites"/cast/cid
    if not d.is_dir(): return set()
    outs=set()
    for f in d.glob("*.png"):
        name=f.stem
        for emo in EMOS:
            if name.endswith(emo):
                outs.add(name[:-len(emo)]); break
        else: outs.add(name)
    return outs
hint_need=defaultdict(set)
for p in (root/"data/events").glob("story_*.yaml"):
    t=p.read_text(encoding="utf-8")
    m=re.match(r"story_([^_]+)_", p.stem)
    if not m: continue
    cid=m.group(1)
    for block in re.findall(r"sprite_hint:\n((?:  - .+\n)+)", t):
        for line in block.strip().splitlines():
            hid=line.strip()[2:].strip()
            if hid: hint_need[cid].add(hid)
BASE={"casual","home","work","date","rain","school","office","party","overtime","sleepy","sick"}
L0=["jealous_door","schedule_clash","ethics_lamp","diary_open","secret_morning","window_listen","end_taboo_vow","end_roof_exposed","end_family_hold"]
print("=== L0 shuli specialty ===")
so=disk_outfits("shuli","neutral")
for x in L0: print(x, "OK" if x in so else "NEED")
print("=== L package ===")
for cid in ["shuli","jingning","youwei","yuxi","lingke","aichen"]:
    o=disk_outfits(cid,"neutral")
    end=sum(1 for x in o if x.startswith("end_"))
    mx=sum(1 for x in o if x.startswith("max_"))
    bath=sum(1 for x in o if x.startswith(("bath_","shower_","foam_","pr_")))
    print(f"{cid}: n={len(o)} end={end} max={mx} bath={bath}")
print("=== T2 winter/life ===")
for cid in ["fengyin","luna","qingcai","xiaoyang","xingnai"]:
    o=disk_outfits(cid,"romance")
    print(cid, "winter", "OK" if "season_winter" in o else "NEED",
          "eat", any("eating" in x for x in o),
          "sleep", any("sleeping" in x for x in o),
          "work", any("working" in x for x in o))
print("=== hint miss ===")
for cid in sorted(hint_need):
    cast="neutral" if cid in {"shuli","jingning","youwei","yuxi","lingke","aichen"} else "romance"
    o=disk_outfits(cid,cast)
    miss=[]
    for h in sorted(hint_need[cid]):
        if h in BASE: continue
        if h in o or any(x==h or x.startswith(h+"_") for x in o): continue
        miss.append(h)
    if miss: print(cid, miss)
g=sum(1 for p in (root/"data/events").glob("story_*.yaml") if "- 留下" in p.read_text(encoding="utf-8") and "- 关心一句" in p.read_text(encoding="utf-8"))
print("generic soft", g, "chars", len(routes["characters"]), "yeyu", "yeyu" in routes["characters"])
