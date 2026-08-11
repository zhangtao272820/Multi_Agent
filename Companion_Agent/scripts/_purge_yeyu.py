"""One-shot: remove yeyu from live SSOT JSON and archive sprites."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"


def dump(path: Path, obj: object) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    # model_roles
    mr_path = DATA / "model_roles.json"
    mr = json.loads(mr_path.read_text(encoding="utf-8"))
    removed = 0
    for base in mr.get("bases", []):
        chars = base.get("characters", [])
        before = len(chars)
        base["characters"] = [c for c in chars if c.get("id") != "yeyu"]
        removed += before - len(base["characters"])
    dump(mr_path, mr)
    print(f"model_roles removed {removed}")

    # cast_intro
    ci_path = DATA / "cast_intro.json"
    ci = json.loads(ci_path.read_text(encoding="utf-8"))
    if "yeyu" in ci.get("characters", {}):
        del ci["characters"]["yeyu"]
        dump(ci_path, ci)
        print("cast_intro removed yeyu")

    # tts_pregen_manifest
    tts_path = DATA / "tts_pregen_manifest.json"
    tts = json.loads(tts_path.read_text(encoding="utf-8"))
    for k, v in list(tts.items()):
        if isinstance(v, list):
            nv = [
                x
                for x in v
                if not (isinstance(x, dict) and x.get("character_id") == "yeyu")
            ]
            if len(nv) != len(v):
                tts[k] = nv
                print(f"tts cleaned {k}: {len(v)} -> {len(nv)}")
    dump(tts_path, tts)

    # sprite_gen_manifest
    sg_path = DATA / "sprite_gen_manifest.json"
    sg = json.loads(sg_path.read_text(encoding="utf-8"))
    if isinstance(sg.get("characters"), dict) and "yeyu" in sg["characters"]:
        del sg["characters"]["yeyu"]
        print("sprite_gen characters removed yeyu")
    elif "yeyu" in sg:
        del sg["yeyu"]
        print("sprite_gen top-level removed yeyu")
    else:
        for k, v in sg.items():
            if isinstance(v, dict) and "yeyu" in v:
                del v["yeyu"]
                print(f"sprite_gen removed from {k}")
    dump(sg_path, sg)

    # sprite_inventory
    si_path = DATA / "sprite_inventory.json"
    si = json.loads(si_path.read_text(encoding="utf-8"))
    for k, v in list(si.items()):
        if isinstance(v, list):
            nv = [
                x
                for x in v
                if not (isinstance(x, dict) and x.get("character_id") == "yeyu")
            ]
            if len(nv) != len(v):
                si[k] = nv
                print(f"inventory {k}: {len(v)} -> {len(nv)}")
        elif isinstance(v, dict) and "yeyu" in v:
            del v["yeyu"]
            print(f"inventory dict removed yeyu from {k}")
    if "yeyu" in si:
        del si["yeyu"]
        print("inventory top removed")
    dump(si_path, si)

    # archive sprites
    src = DATA / "sprites" / "romance" / "yeyu"
    dst = DATA / "sprites" / "_archive" / "purged_yeyu" / "romance" / "yeyu"
    if src.is_dir():
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            shutil.rmtree(dst)
        shutil.move(str(src), str(dst))
        print(f"sprites moved {src} -> {dst}")
    else:
        print("no live yeyu sprite dir")

    print("purge ok")


if __name__ == "__main__":
    main()
