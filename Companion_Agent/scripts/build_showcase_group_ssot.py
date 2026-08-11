# -*- coding: utf-8 -*-
"""Build W9×20 showcase + W10×20 group SSOT manifests."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

SHOWCASE_SLOTS = [
    "kv_day",
    "kv_night",
    "kv_rain",
    "kv_festival",
    "os_soft",
    "os_close",
    "os_night",
    "lb_casual",
    "lb_work",
    "lb_date",
    "rf_window",
    "rf_mirror",
    "rf_rain",
    "cin_sit",
    "cin_walk",
    "cin_window",
    "cin_prop",
    "hero_close",
    "hero_back",
    "hero_low",
]
ALIAS = {"kv": "kv_day", "os": "os_soft", "lb": "lb_casual", "rf": "rf_window"}

# tier, theme, peer_primary, home_loc
CHARS: dict[str, tuple[str, str, str, str]] = {
    "xiaoyou": ("T0", "天窗画室", "youwei", "room"),
    "wanyu": ("T0", "咖啡蒸汽", "yuxi", "cafe"),
    "ruolin": ("T0", "讲台粉笔", "lingke", "campus"),
    "jingliu": ("T0", "玻璃门廊", "jingning", "office"),
    "aili": ("T0", "温室花枝", "aichen", "store"),
    "linxi": ("T0", "工位末班车", "jingliu", "office"),
    "taotao": ("T1", "舞台冰袋", "qingcai", "atelier"),
    "shizuku": ("T1", "图书馆层架", "ruolin", "library"),
    "qiansha": ("T1", "前端夜审", "linxi", "office"),
    "shiori": ("T1", "窗边书", "xiaoyou", "bookstore"),
    "miara": ("T1", "谷子精灵耳", "shiori", "store"),
    "xingnai": ("T2", "天台便当", "fengyin", "rooftop"),
    "fengyin": ("T2", "同居屋檐", "shuli", "home"),
    "qingcai": ("T2", "练舞室镜", "xiaoyang", "campus"),
    "xiaoyang": ("T2", "社团海报", "qingcai", "campus"),
    "luna": ("T2", "夜班塔罗", "wanyu", "cafe"),
    "shuli": ("L", "日程本", "fengyin", "home"),
    "jingning": ("L", "旁观笔记", "jingliu", "office"),
    "youwei": ("L", "第三支笔", "xiaoyou", "room"),
    "yuxi": ("L", "顶班护短", "wanyu", "cafe"),
    "lingke": ("L", "红笔边界", "ruolin", "campus"),
    "aichen": ("L", "复联守门", "aili", "store"),
}

# Per-character date rotation offsets so scenes/outfits/beats differ across cast
_DATE_POOL = [
    ("date_pc_cafe", "cafe", "date", "咖啡馆日常约会"),
    ("date_pc_rain", "street", "rain", "雨街共伞"),
    ("date_pc_park", "park", "casual", "公园散步"),
    ("date_pc_home", "home", "home", "居家闲谈"),
    ("date_pc_festival", "festival", "festival_spring", "节日约会"),
    ("date_pc_night", "cafe", "evening", "夜里留灯"),
    ("date_pc_commute", "street", "work", "通勤偶遇"),
    ("date_pc_work", "office", "work", "职业场附近"),
    ("date_pc_season", "campus", "season_winter", "季节外出"),
    ("date_pc_close", "home", "date", "告白近距"),
    ("date_pc_rooftop", "rooftop", "casual", "天台吹风"),
    ("date_pc_library", "library", "casual", "安静同桌"),
    ("date_pc_bookstore", "bookstore", "casual", "书架偶遇"),
    ("date_pc_atelier", "atelier", "work", "创作旁观"),
]

_PEER_SCENES = [
    ("studio", "casual", "工作/足迹旁"),
    ("cafe", "date", "咖啡闲聊"),
    ("street", "casual", "街上并肩"),
    ("home", "home", "私域做客"),
    ("night", "evening", "夜色短叙"),
]

# kind, outfit, location, beat
_SEC_KINDS = [
    ("gate", "work", "campus", "守门对视"),
    ("rival", "casual", "cafe", "微妙同席"),
    ("trio_pc_silhouette", "date", "street", "三人剪影"),
    ("ensemble", "festival_spring", "festival", "小型群像"),
    ("flashback", "season_winter", "library", "旧日闪回"),
]


def _date_shots(cid: str, home: str) -> list[dict]:
    """10 unique date shots; rotate pool by character index for variety."""
    keys = list(CHARS.keys())
    off = keys.index(cid) % max(1, len(_DATE_POOL) - 9)
    pool = _DATE_POOL[off:] + _DATE_POOL[:off]
    shots: list[dict] = []
    used: set[tuple[str, str, str]] = set()
    for sid, loc, outfit, beat in pool:
        if loc == "home":
            loc = home
        key = (loc, outfit, beat)
        if key in used:
            continue
        used.add(key)
        shots.append(
            {
                "shot_id": sid if sid not in {s["shot_id"] for s in shots} else f"{sid}_{cid[:3]}",
                "kind": "date",
                "members": [cid, "shenyuan"],
                "location": loc,
                "outfit_hint": outfit,
                "beat": f"{CHARS[cid][1]}·{beat}",
            }
        )
        if len(shots) >= 10:
            break
    # ensure unique shot_ids
    seen: set[str] = set()
    for s in shots:
        base = s["shot_id"]
        if base in seen:
            s["shot_id"] = f"{base}_{len(seen)}"
        seen.add(s["shot_id"])
    assert len(shots) == 10, (cid, len(shots))
    return shots


def _peer_shots(cid: str, peer: str, home: str) -> list[dict]:
    shots: list[dict] = []
    for i, (sc, outfit, beat) in enumerate(_PEER_SCENES):
        loc = home if sc in {"studio", "home"} else sc
        if sc == "night":
            loc = home
            outfit = "evening"
        # rotate outfit/loc slightly by cid hash
        if i == 1 and home not in {"cafe", "office"}:
            loc = home
        shots.append(
            {
                "shot_id": f"with_{peer}_{sc}",
                "kind": "relation",
                "members": [cid, peer],
                "location": loc,
                "outfit_hint": outfit,
                "beat": f"与{peer}·{beat}",
            }
        )
    assert len(shots) == 5
    return shots


def _sec_shots(cid: str, peer: str, home: str) -> list[dict]:
    shots: list[dict] = []
    for k, outfit, loc, beat in _SEC_KINDS:
        if k == "trio_pc_silhouette":
            mem = [cid, peer, "shenyuan"]
        elif k in ("gate", "rival"):
            mem = [cid, peer]
        elif k == "ensemble":
            mem = [cid, peer, "shenyuan"]
        else:
            mem = [cid, peer]
        if loc == "home":
            loc = home
        shots.append(
            {
                "shot_id": f"sec_{k}",
                "kind": "secondary",
                "members": mem,
                "location": loc,
                "outfit_hint": outfit,
                "beat": f"{CHARS[cid][1]}·{beat}",
            }
        )
    assert len(shots) == 5
    combos = [(s["location"], s["outfit_hint"], frozenset(s["members"])) for s in shots]
    assert len(combos) == len(set(combos)), (cid, "sec dup", combos)
    return shots


def main() -> None:
    show_root = DATA / "sprites" / "showcase"
    showcase = {
        "version": 2,
        "notes": "W9 每角固定 20 槽。落盘 showcase/{id}/{slot}.png。旧名 kv/os/lb/rf 见 aliases。",
        "slots": SHOWCASE_SLOTS,
        "aliases": ALIAS,
        "slot_meta": {
            "kv_day": "KV 日间全出血",
            "kv_night": "KV 夜景",
            "kv_rain": "KV 雨景",
            "kv_festival": "KV 节日",
            "os_soft": "过肩柔回眸",
            "os_close": "过肩近距",
            "os_night": "过肩夜",
            "lb_casual": "Lookbook 日常",
            "lb_work": "Lookbook 工作",
            "lb_date": "Lookbook 约会",
            "rf_window": "窗边情绪",
            "rf_mirror": "镜面情绪",
            "rf_rain": "雨窗情绪",
            "cin_sit": "生活电影·坐",
            "cin_walk": "生活电影·走",
            "cin_window": "生活电影·窗",
            "cin_prop": "生活电影·职业道具",
            "hero_close": "英雄半身",
            "hero_back": "背面全身",
            "hero_low": "仰角英雄",
        },
        "characters": {},
    }
    for cid, (tier, theme, peer, _) in CHARS.items():
        existing: list[str] = []
        d = show_root / cid
        if d.is_dir():
            for p in d.glob("*.png"):
                existing.append(ALIAS.get(p.stem, p.stem))
        existing = sorted(set(existing))
        showcase["characters"][cid] = {
            "tier": tier,
            "theme": theme,
            "peer_primary": peer,
            "slots": SHOWCASE_SLOTS,
            "existing": existing,
            "count": len(existing),
        }
    (DATA / "character_showcase_manifest.json").write_text(
        json.dumps(showcase, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    group: dict = {
        "version": 2,
        "notes": "W10 每角 20：约会男主×10 + 主锚×5 + 次关系/三人×5。须男主定妆。禁止 solo 假群像。",
        "pc_id": "shenyuan",
        "pc_label": "沈予安",
        "characters": {},
    }
    for cid, (tier, theme, peer, home) in CHARS.items():
        assert peer, cid
        shots = _date_shots(cid, home) + _peer_shots(cid, peer, home) + _sec_shots(cid, peer, home)
        assert len(shots) == 20, (cid, len(shots))
        for s in shots:
            assert len(s["members"]) >= 2, (cid, s["shot_id"], "solo forbidden")
            assert "shenyuan" in s["members"] or peer in s["members"], (cid, s)
        # soft uniqueness across all shots
        keys = [(s["location"], s["outfit_hint"], tuple(s["members"]), s["beat"]) for s in shots]
        assert len(keys) == len(set(keys)), (cid, "duplicate combo")
        gdir = DATA / "sprites" / "group" / cid
        existing = [p.stem for p in gdir.glob("*.png")] if gdir.is_dir() else []
        group["characters"][cid] = {
            "tier": tier,
            "theme": theme,
            "peer_primary": peer,
            "shots": shots,
            "existing": existing,
            "count": len(existing),
        }
    (DATA / "character_group_shots.json").write_text(
        json.dumps(group, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("OK showcase", showcase["characters"]["xiaoyou"]["existing"])
    print(
        "OK group",
        len(group["characters"]["xiaoyou"]["shots"]),
        "peers",
        {c: group["characters"][c]["peer_primary"] for c in ("linxi", "taotao", "xingnai")},
    )


if __name__ == "__main__":
    main()
