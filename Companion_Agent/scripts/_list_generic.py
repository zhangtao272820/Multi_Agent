from pathlib import Path
root = Path(r"e:/Agent/Companion_Agent/data/events")
for p in sorted(root.glob("story_*.yaml")):
    t=p.read_text(encoding="utf-8")
    if "- 留下" in t and "- 关心一句" in t:
        print(p.name)
