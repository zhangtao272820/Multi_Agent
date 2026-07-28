# -*- coding: utf-8 -*-
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
data = json.loads(Path(r"e:/Agent/Campus_Agent/data/class_roster.json").read_text(encoding="utf-8"))
students = None
for v in data.values() if isinstance(data, dict) else [data]:
    if isinstance(v, list) and v and isinstance(v[0], dict) and "id" in v[0]:
        students = v
        break
order = {"school_belle": 0, "extreme": 1, "high": 2, "mid": 3, "low": 4}
fem = [s for s in students if str(s.get("id", "")).startswith("f")]
fem.sort(key=lambda s: (order.get(str(s.get("beauty_tier")), 9), -int(s.get("charm") or 0), s.get("id")))
print("=== beauty ranking ===")
for i, s in enumerate(fem, 1):
    root = Path(r"e:/Agent/Campus_Agent/data/sprites/students") / s["id"]
    n = len(list(root.glob("*.png"))) if root.exists() else 0
    print(f"{i:2} {s['id']} charm={s.get('charm')} tier={s.get('beauty_tier')} sprites={n} {s.get('name')}")

print("\n=== f09 full ===")
s = next(x for x in students if x["id"] == "f09")
for k, v in s.items():
    print(f"{k}: {v}")

print("\n=== f09 existing files ===")
for p in sorted(Path(r"e:/Agent/Campus_Agent/data/sprites/students/f09").glob("*.png")):
    print(p.name)

print("\n=== f21 file count ===")
print(len(list(Path(r"e:/Agent/Campus_Agent/data/sprites/students/f21").glob("*.png"))))
