# -*- coding: utf-8 -*-
from pathlib import Path
import json, re, yaml

root = Path(r"e:/Agent/Companion_Agent")
routes = json.loads((root/"data/story_routes.json").read_text(encoding="utf-8"))
endings = json.loads((root/"data/endings.json").read_text(encoding="utf-8"))
pres = json.loads((root/"data/presentation_catalog.json").read_text(encoding="utf-8"))
lores_path = root/"data/character_lores.json"
lores = json.loads(lores_path.read_text(encoding="utf-8")) if lores_path.exists() else {}

T0 = ["xiaoyou","wanyu","ruolin","jingliu","aili","linxi"]
T1 = ["taotao","shizuku","qiansha","shiori","miara"]

def load_ev(cid):
    files = sorted((root/"data/events").glob(f"story_{cid}_*.yaml"))
    out=[]
    for p in files:
        try:
            d = yaml.safe_load(p.read_text(encoding="utf-8"))
        except Exception as e:
            d = {"_err": str(e)}
        out.append((p.name, d))
    return out

def beat_stats(d):
    beats = d.get("beats") or []
    summaries = [str(b.get("summary") or "") for b in beats]
    softs = []
    for b in beats:
        softs.extend(b.get("soft_options") or [])
    hints=[]
    for b in beats:
        hints.extend(b.get("sprite_hint") or [])
    chars = sum(len(s) for s in summaries)
    generic_soft = sum(1 for s in softs if s in {"留下","关心一句","告辞","靠近","安静听","换话题","认真回应","先缓一缓","推开"})
    return {
        "n_beats": len(beats),
        "sum_chars": chars,
        "avg_sum": chars//max(1,len(beats)),
        "n_soft": len(softs),
        "generic_soft": generic_soft,
        "n_hints": len(set(hints)),
        "label": d.get("label") or "",
    }

print("=== ROUTES / THEME ===")
for cid in T0+T1:
    r = routes["characters"][cid]
    acts = r.get("acts") or []
    theme = (r.get("theme") or "")[:40]
    logline = (r.get("logline") or "")[:60]
    ends = r.get("unique_ending_ids") or []
    print(f"{cid:10} acts={len(acts)} ends={len(ends)} theme={theme!r}")
    print(f"           logline={logline!r}")

print("\n=== EVENT THICKNESS ===")
for cid in T0+T1:
    evs = load_ev(cid)
    total_beats=0; total_chars=0; gen=0; files=0
    thin=[]
    for name,d in evs:
        if not isinstance(d, dict) or d.get("_err"): 
            print(cid, name, "ERR", d.get("_err")); continue
        st = beat_stats(d)
        files += 1
        total_beats += st["n_beats"]
        total_chars += st["sum_chars"]
        gen += st["generic_soft"]
        if st["n_beats"] < 3 or st["avg_sum"] < 28:
            thin.append((name, st["n_beats"], st["avg_sum"], st["label"]))
    print(f"{cid:10} files={files} beats={total_beats} sum_chars={total_chars} avg/beat={total_chars//max(1,total_beats)} generic_soft_hits={gen} thin={len(thin)}")
    for t in thin[:3]:
        print(f"           THIN {t}")

print("\n=== ENDINGS PRESENTATION ===")
ecat = (pres.get("endings") or {})
for cid in T0+T1:
    ids = routes["characters"][cid].get("unique_ending_ids") or []
    ok=0; short=0; missing=0
    for eid in ids:
        pages = (ecat.get(eid) or {}).get("pages") or []
        if not pages:
            # try endings list structure
            missing += 1
            continue
        text_len = sum(len(str(p.get("text") or p.get("body") or "")) for p in pages if isinstance(p, dict))
        if text_len < 80: short += 1
        else: ok += 1
    print(f"{cid:10} unique_ends={len(ids)} pages_ok={ok} short={short} missing_pages={missing}")

# sample one T0 crisis + one early act for quality sniff
print("\n=== SAMPLE SUMMARIES (xiaoyou act1/act6) ===")
for name in ["story_xiaoyou_act1_atelier.yaml","story_xiaoyou_act6_third_pen.yaml","story_taotao_act1_stage.yaml","story_taotao_act5b_festival.yaml"]:
    p = root/"data/events"/name
    if not p.exists():
        # find
        cands = list((root/"data/events").glob(name.replace(".yaml","*.yaml")))
        print(name, "missing", cands[:2]); continue
    d = yaml.safe_load(p.read_text(encoding="utf-8"))
    print("---", name, d.get("label"))
    for b in (d.get("beats") or [])[:3]:
        print(" ", (b.get("summary") or "")[:100])
        print("  soft:", b.get("soft_options"))
