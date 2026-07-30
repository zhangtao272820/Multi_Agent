import json
from pathlib import Path

root = Path(r"e:/Agent/Campus_Agent/data/sprites/students")
budget = json.loads(Path(r"e:/Agent/Campus_Agent/data/sprite_budget.json").read_text(encoding="utf-8"))
roster = json.loads(Path(r"e:/Agent/Campus_Agent/data/class_roster.json").read_text(encoding="utf-8"))

beauty = {}
for tier_name, info in budget["female_by_beauty"].items():
    for sid in info["ids"]:
        beauty[sid] = (info["tier"], tier_name, info["sprites_per_character"])

private = [
    "casual_stand_neutral.png","casual_stand_happy.png","casual_stand_shy.png","casual_sit_bunk_neutral.png","casual_stretch_happy.png",
    "pajama_stand_neutral.png","pajama_stand_shy.png","pajama_sit_bunk_neutral.png","pajama_sit_bunk_happy.png","pajama_yawn_neutral.png",
    "towel_stand_neutral.png","towel_stand_shy.png","towel_wet_hair_neutral.png","towel_door_shy.png",
    "casual_lean_wall_shy.png","casual_look_back_happy.png","pajama_hug_pillow_shy.png","towel_after_bath_shy.png","casual_window_night_neutral.png","pajama_bed_edge_shy.png",
]

ref = sorted(p.name for p in (root / "f21").glob("*.png"))
print("f21_count", len(ref))
for n in ref:
    print("REF", n)

females = [s for s in roster["students"] if s.get("gender") == "female"]
print("---SUMMARY---")
for s in sorted(females, key=lambda x: x["id"]):
    sid = s["id"]
    files = sorted(p.name for p in (root / sid).glob("*.png")) if (root / sid).is_dir() else []
    nameset = set(files)
    missing = [f for f in ref if f not in nameset]
    extras = [f for f in files if f not in set(ref)]
    priv_have = sum(1 for p in private if p in nameset)
    bt = beauty.get(sid, ("?", "?", 0))
    print(
        sid,
        s.get("name", ""),
        f"{bt[0]}/{bt[1]}/{bt[2]}",
        s.get("beauty_tier"),
        s.get("grade_tier"),
        s.get("charm"),
        len(files),
        f"miss={len(missing)}",
        f"extra={len(extras)}",
        f"priv={priv_have}/20",
        "q" if "q_stand_neutral.png" in nameset else "no_q",
        "id" if "_identity_neutral.png" in nameset else "no_id",
        "ss" if "summer_stand_neutral.png" in nameset else "no_ss",
    )
    if missing and len(files) > 3:
        print("  MISSING_SAMPLE", missing[:8])
    if extras:
        print("  EXTRAS", extras)
