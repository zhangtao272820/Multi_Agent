"""Unify drifted display names in model_roles backstories / personality to label SSOT."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

# wrong substring -> correct (apply carefully; longer first)
BACKSTORY_FIXES: list[tuple[str, str]] = [
    ("白霜雫", "白初雪"),
    ("顾悠微", "温悠微"),
    ("沈雨汐", "何雨汐"),
    ("林千纱", "顾千纱"),
    ("楚铃可", "陈铃可"),
    ("夏艾辰", "程艾辰"),
    ("莫米拉", "莫岚纱"),
    ("叶诗织", "白诗织"),
    ("叶小阳", "叶晓阳"),
    ("高中青梅星奈", "高中青梅程星宁"),
    ("偶像练习生桃桃", "偶像练习生唐桃夭"),
    ("咖啡兼职露娜", "咖啡兼职月露宁"),
    ("小悠画室学妹", "苏晚悠画室学妹"),
    ("先问小悠脸色", "先问苏晚悠脸色"),
]

# personality opener mismatches
PERSONALITY_NAME = {
    "shizuku": "白初雪",
    "youwei": "温悠微",
    "yuxi": "何雨汐",
    "qiansha": "顾千纱",
    "lingke": "陈铃可",
    "aichen": "程艾辰",
    "miara": "莫岚纱",
    "shiori": "白诗织",
    "xiaoyang": "叶晓阳",
    "xingnai": "程星宁",
    "taotao": "唐桃夭",
    "luna": "月露宁",
}


def main() -> None:
    path = DATA / "model_roles.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    n_bs = n_pers = n_label = 0
    for base in data.get("bases") or []:
        for row in base.get("characters") or []:
            cid = row.get("id") or ""
            prof = row.setdefault("profile", {})
            label = (row.get("label") or "").strip()
            name = (prof.get("name") or "").strip()
            if label and name != label:
                prof["name"] = label
                n_label += 1
            bs = prof.get("backstory") or ""
            new_bs = bs
            for old, new in BACKSTORY_FIXES:
                if old in new_bs:
                    new_bs = new_bs.replace(old, new)
            if new_bs != bs:
                prof["backstory"] = new_bs
                n_bs += 1
            # ensure personality starts with correct name if present
            pers = prof.get("personality") or ""
            expect = PERSONALITY_NAME.get(cid) or label
            if expect and pers.startswith("你是") and f"你是{expect}" not in pers[:20]:
                # replace first 「你是X」 chunk
                import re

                fixed, c = re.subn(r"^你是[^。，,（( ]+", f"你是{expect}", pers, count=1)
                if c:
                    prof["personality"] = fixed
                    n_pers += 1
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"label/name sync={n_label} backstory={n_bs} personality={n_pers}")

    # also fix character_lores free text drifts
    lore_path = DATA / "character_lores.json"
    lore = json.loads(lore_path.read_text(encoding="utf-8"))
    n_lore = 0
    for _cid, block in (lore.get("characters") or {}).items():
        for key in ("codex", "prompt_seed"):
            s = block.get(key) or ""
            ns = s
            for old, new in BACKSTORY_FIXES:
                ns = ns.replace(old, new)
            # common short-name leftovers in seeds are ok; fix known wrong surnames
            if ns != s:
                block[key] = ns
                n_lore += 1
        unlocks = block.get("unlocks") or {}
        for uk, uv in list(unlocks.items()):
            if not isinstance(uv, str):
                continue
            nv = uv
            for old, new in BACKSTORY_FIXES:
                nv = nv.replace(old, new)
            if nv != uv:
                unlocks[uk] = nv
                n_lore += 1
    lore_path.write_text(json.dumps(lore, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"lores fixed fields={n_lore}")


if __name__ == "__main__":
    main()
