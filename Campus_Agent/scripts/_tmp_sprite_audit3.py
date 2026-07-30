import json
from pathlib import Path

root = Path(r"e:/Agent/Campus_Agent/data/sprites/students")
budget = json.loads(
    Path(r"e:/Agent/Campus_Agent/data/sprite_budget.json").read_text(encoding="utf-8")
)
f21 = {p.name for p in (root / "f21").glob("*.png")} if (root / "f21").exists() else set()
print("f21 count", len(f21))
print(f"{'id':<5} {'tier':<4} {'quota':>5} {'png':>5} {'vs21':>5} {'miss':>5}")
for tier_key in ["school_belle", "extreme", "high", "mid", "low"]:
    block = budget["female_by_beauty"][tier_key]
    for sid in block["ids"]:
        p = root / sid
        files = {x.name for x in p.glob("*.png")} if p.exists() else set()
        target = block["sprites_per_character"] + 20
        miss = sorted(f21 - files) if f21 else []
        print(
            f"{sid:<5} {block['tier']:<4} {target:>5} {len(files):>5} "
            f"{len(files & f21):>5} {len(miss):>5}"
        )

# progress docs
doc = Path(r"e:/Agent/Campus_Agent/doc/archive")
if doc.exists():
    for p in sorted(doc.glob("立绘生成进度*.md")):
        print("DOC", p.name)
