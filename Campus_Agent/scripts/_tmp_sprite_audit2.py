# -*- coding: utf-8 -*-
from pathlib import Path
import json

root = Path(r"e:/Agent/Campus_Agent/data/sprites/students")
roster = json.loads(Path(r"e:/Agent/Campus_Agent/data/class_roster.json").read_text(encoding="utf-8"))
budget = json.loads(Path(r"e:/Agent/Campus_Agent/data/sprite_budget.json").read_text(encoding="utf-8"))
cat = json.loads(Path(r"e:/Agent/Campus_Agent/data/personality_catalog.json").read_text(encoding="utf-8"))

beauty = {}
for tier_name, info in budget["female_by_beauty"].items():
    for sid in info["ids"]:
        beauty[sid] = (info["tier"], tier_name, info["sprites_per_character"] + 20)

ref = set(p.name for p in (root / "f21").glob("*.png"))

lines = []
lines.append("=== grade_tiers ===")
lines.append(json.dumps(cat.get("grade_tiers"), ensure_ascii=False, indent=2))
lines.append("=== beauty_tiers ===")
lines.append(json.dumps(cat.get("beauty_tiers"), ensure_ascii=False, indent=2))

lines.append("=== f06 ===")
f06 = root / "f06"
for p in sorted(f06.rglob("*")):
    if p.is_file():
        lines.append(str(p.relative_to(f06)))

lines.append("=== females ===")
for s in sorted([x for x in roster["students"] if x.get("gender") == "female"], key=lambda x: x["id"]):
    sid = s["id"]
    files = [p.name for p in (root / sid).glob("*.png")] if (root / sid).is_dir() else []
    nameset = set(files)
    miss = len(ref - nameset)
    bt = beauty.get(sid, ("?", "?", 0))
    status = "COMPLETE" if miss == 0 else ("IN_PROGRESS" if len(files) > 3 else "BASELINE")
    lines.append(
        f"{sid}|{s['name']}|{status}|files={len(files)}|miss_vs_f21={miss}|"
        f"sprite_tier={bt[0]}({bt[1]}) target~{bt[2]}|"
        f"beauty={s.get('beauty_tier')}|grade={s.get('grade_tier')}|charm={s.get('charm')}"
    )

# categorize f21 set
cats = {"meta": [], "private": [], "summer_core": [], "summer_sc": [], "winter": [], "other": []}
for n in sorted(ref):
    if n.startswith("_") or n.startswith("q_"):
        cats["meta"].append(n)
    elif n.startswith(("casual_", "pajama_", "towel_")):
        cats["private"].append(n)
    elif n.startswith("summer_sc_"):
        cats["summer_sc"].append(n)
    elif n.startswith("summer_"):
        cats["summer_core"].append(n)
    elif n.startswith("winter_"):
        cats["winter"].append(n)
    else:
        cats["other"].append(n)
lines.append("=== f21 categories ===")
for k, v in cats.items():
    lines.append(f"{k}: {len(v)}")
    for n in v:
        lines.append(f"  {n}")

out = Path(r"e:/Agent/Campus_Agent/scripts/_tmp_audit_out.txt")
out.write_text("\n".join(lines), encoding="utf-8")
print("wrote", out, "lines", len(lines))
