"""One-shot: set 24 cast display names to 3-char Chinese (plan table).

SSOT: model_roles.profile.name; sync cast_weights; rewrite free-text old names
in data JSON/YAML (and selected docs under data/).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

# id -> (old, new)  — old used for free-text rewrite
RENAMES: dict[str, tuple[str, str]] = {
    "xiaoyou": ("小悠", "苏晚悠"),
    "wanyu": ("晚雨", "温晚雨"),
    "linxi": ("凛汐", "陆凛汐"),
    "ruolin": ("若铃", "顾若铃"),
    "jingliu": ("静流", "江静流"),
    "aili": ("艾莉", "夏艾黎"),
    "shiori": ("诗织", "白诗织"),
    "taotao": ("桃桃", "唐桃夭"),
    "qiansha": ("千纱", "顾千纱"),
    "moran": ("墨染", "墨染川"),
    "shizuku": ("雫", "白初雪"),
    "miara": ("米拉", "莫岚纱"),
    "xingnai": ("星奈", "程星宁"),
    "fengyin": ("枫音", "沈枫音"),
    "qingcai": ("晴菜", "夏晴彩"),
    "xiaoyang": ("小阳", "叶晓阳"),
    "luna": ("露娜", "月露宁"),
    "shuli": ("书璃", "沈书璃"),
    "jingning": ("静宁", "江静宁"),
    "youwei": ("悠微", "温悠微"),
    "yuxi": ("雨汐", "何雨汐"),
    "lingke": ("铃可", "陈铃可"),
    "aichen": ("艾辰", "程艾辰"),
}

# Extra free-text aliases (typos / alt spellings)
EXTRA_TEXT = [
    ("书里", "沈书璃"),  # social_graph summary typo
    ("青彩", "夏晴彩"),  # occasional alt for qingcai
]


def _set_structured_names() -> None:
    mr_path = DATA / "model_roles.json"
    mr = json.loads(mr_path.read_text(encoding="utf-8"))
    n = 0
    for base in mr.get("bases") or []:
        for row in base.get("characters") or []:
            cid = row.get("id")
            if cid not in RENAMES:
                continue
            new = RENAMES[cid][1]
            prof = row.setdefault("profile", {})
            if prof.get("name") != new:
                prof["name"] = new
                n += 1
    mr_path.write_text(json.dumps(mr, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"model_roles: updated {n} names")

    cw_path = DATA / "cast_weights.json"
    cw = json.loads(cw_path.read_text(encoding="utf-8"))
    chars = cw.setdefault("characters", {})
    n2 = 0
    for cid, (_old, new) in RENAMES.items():
        if cid not in chars:
            continue
        if chars[cid].get("name") != new:
            chars[cid]["name"] = new
            n2 += 1
    cw_path.write_text(json.dumps(cw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"cast_weights: updated {n2} names")


def _rewrite_text(text: str) -> str:
    # Tokenize to avoid double-application (墨染 -> 墨染川 -> 墨染川川)
    pairs = [(old, new) for old, new in RENAMES.values()] + list(EXTRA_TEXT)
    # Longer old strings first
    pairs.sort(key=lambda p: len(p[0]), reverse=True)
    tokens: list[tuple[str, str]] = []
    out = text
    for i, (old, new) in enumerate(pairs):
        if not old or old == new:
            continue
        tok = f"\x00RN{i}\x00"
        if old in out:
            out = out.replace(old, tok)
            tokens.append((tok, new))
    for tok, new in tokens:
        out = out.replace(tok, new)
    return out


def _rewrite_files() -> None:
    patterns = ("*.json", "*.yaml", "*.yml", "*.md")
    skip_names = {"companion_save.db", "china_calendar_2026.json"}
    files: list[Path] = []
    for pat in patterns:
        files.extend(DATA.rglob(pat))
    # Also frontend types comment if any
    types = ROOT / "frontend" / "src" / "types.ts"
    if types.is_file():
        files.append(types)

    changed = 0
    for path in sorted(set(files)):
        if any(part.startswith("_") for part in path.parts if part != DATA.name):
            # allow data root _ files? skip sprites/_staging etc via path parts
            if "sprites" in path.parts and any(
                p.startswith("_") for p in path.parts[path.parts.index("sprites") + 1 :]
            ):
                continue
        if path.name in skip_names:
            continue
        if path.suffix.lower() not in {".json", ".yaml", ".yml", ".md", ".ts"}:
            continue
        # Skip huge binary-adjacent
        if "sprites" in path.parts and path.suffix == ".png":
            continue
        try:
            raw = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        new = _rewrite_text(raw)
        if new != raw:
            path.write_text(new, encoding="utf-8")
            changed += 1
            print(f"  rewrite {path.relative_to(ROOT)}")
    print(f"free-text files changed: {changed}")


def main() -> None:
    # Free-text first (while old names still present), then force SSOT by id
    # so new names that contain old as substring (温晚雨⊃晚雨) are not doubled.
    _rewrite_files()
    _set_structured_names()
    mr = json.loads((DATA / "model_roles.json").read_text(encoding="utf-8"))
    for base in mr.get("bases") or []:
        for row in base.get("characters") or []:
            cid = row.get("id")
            name = (row.get("profile") or {}).get("name")
            want = RENAMES.get(cid, (None, None))[1]
            ok = name == want and want is not None and len(want) == 3
            print(f"{'OK' if ok else 'FAIL'} {cid} {name!r} want={want!r}")


if __name__ == "__main__":
    main()
