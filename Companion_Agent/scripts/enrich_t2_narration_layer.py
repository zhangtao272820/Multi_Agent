# -*- coding: utf-8 -*-
"""One-shot: enrich T2 light story beats with narration / pc_thought / brief."""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"
T2 = ("xingnai", "fengyin", "qingcai", "xiaoyang", "luna")
BANNED = "选择会改写后面的路"

CHAR_SCENE = {
    "xingnai": ("相册纸边与青梅味", "旧书桌"),
    "fengyin": ("门轴与耳机低音", "同住屋檐"),
    "qingcai": ("练舞镜与汗味", "练舞室"),
    "xiaoyang": ("海报胶与社团室", "摊位旁"),
    "luna": ("塔罗牌与夜班灯", "柜台"),
}

CHAR_THOUGHTS = {
    "xingnai": [
        "合影缺口像未说完的夏天。我补不补？",
        "青梅如故很安全。再近一步就怕弄丢从前。",
        "冬相册冷。空白页等的是人，不是滤镜。",
        "新年缺口还在。我想站进去，又怕抢了回忆。",
    ],
    "fengyin": [
        "先敲门才是喜欢。不敲，就只是同屋檐的室友。",
        "隔墙有没有声响？书璃那边的夜灯，我装没看见。",
        "冬天门缝漏风。边界比暖气更重要。",
        "春檐下她等我敲门——我别用钥匙直接推。",
    ],
    "qingcai": [
        "镜子里她很满。固定观众很好当，恋人更难。",
        "夏日祭灯光一亮，空舞台的恐惧也亮了。",
        "冬练功室只剩回音。我想留下，不只是鼓掌。",
        "春舞台位空着。我是观众席，还是并肩那一步？",
    ],
    "xiaoyang": [
        "海报上的名字很吵。摊位旁的她其实很轻。",
        "同班如常最安全。告白会撕坏一张海报吗？",
        "冬社团室胶味刺鼻。我想把名字念准。",
        "中秋海报边她停笔。我接不接那支马克笔？",
    ],
    "luna": [
        "月咒护符像玩笑。当真时，班次就不是班次。",
        "星夜柜台很静。假护符一拆，她还肯看我吗？",
        "冬塔罗冷。我想听解读，也想听她本人。",
        "中秋护符线缠着手指。戏言与认真只差一句。",
    ],
}


def _clip(text: str, limit: int) -> str:
    t = (text or "").strip()
    return t if len(t) <= limit else t[: max(0, limit - 1)] + "…"


def _clean_core(summary: str) -> str:
    s = (summary or "").strip()
    s = s.replace("——" + BANNED, "").replace("—" + BANNED, "").replace(BANNED, "")
    s = re.sub(r"[—－]{2,}", "——", s)
    s = re.sub(r"\b[a-z]+_[a-z_]+\b", "", s, flags=re.I)
    s = re.sub(r" {2,}", " ", s)
    return s.strip("—-·。；;，, ")


def _to_brief(core: str) -> str:
    t = re.sub(r"(你怎么回答|你怎么选|选择会.*)$", "", core).strip("—-·。；;，, ")
    if not t.endswith(("。", "！", "？")):
        t += "。"
    if "等你" not in t and "等他" not in t and len(t) < 70:
        t = t.rstrip("。") + "。等你回应。"
    return _clip(t, 80)


def _to_narration(core: str, cid: str) -> str:
    smell, place = CHAR_SCENE.get(cid, ("空气微凉", "这里"))
    body = (core or "").replace(BANNED, "").strip("—-·。；;，, ")
    text = body if (smell[:2] in body or place in body) else f"{smell}里，{body}"
    if not text.endswith(("。", "！", "？", "…")):
        text += "。"
    return _clip(text, 120)


def _to_thought(cid: str, beat_index: int, core: str) -> str:
    pool = CHAR_THOUGHTS.get(cid) or ["我想靠近，又怕把局面弄坏。"]
    return _clip(pool[beat_index % len(pool)], 80)


def enrich_beat(beat: dict, cid: str, beat_index: int) -> dict:
    core = _clean_core(str(beat.get("summary") or beat.get("brief") or ""))
    if not core:
        core = str(beat.get("id") or "这一拍")
    out = dict(beat)
    out["narration"] = _to_narration(core, cid)
    out["pc_thought"] = _to_thought(cid, beat_index, core)
    out["brief"] = _to_brief(core)
    out["summary"] = out["brief"]
    for k in ("narration", "pc_thought", "brief", "summary"):
        out[k] = str(out[k]).replace(BANNED, "").strip()
    return out


def _char_of(eid: str) -> str | None:
    for c in T2:
        if eid.startswith(f"story_{c}_"):
            return c
    return None


class _Dumper(yaml.SafeDumper):
    pass


def _str_representer(dumper, data: str):
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    if any(ch in data for ch in ":“”\"'："):
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style='"')
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


_Dumper.add_representer(str, _str_representer)


def main() -> int:
    updated = beats_n = 0
    for path in sorted(EVENTS.glob("story_*.yaml")):
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            continue
        eid = str(raw.get("id") or path.stem)
        cid = _char_of(eid)
        if not cid:
            continue
        beats = raw.get("beats") or []
        if not beats:
            continue
        raw["beats"] = [enrich_beat(b, cid, i) for i, b in enumerate(beats)]
        path.write_text(
            yaml.dump(raw, Dumper=_Dumper, allow_unicode=True, sort_keys=False, width=100),
            encoding="utf-8",
        )
        updated += 1
        beats_n += len(raw["beats"])

    bad = []
    for path in sorted(EVENTS.glob("story_*.yaml")):
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            continue
        eid = str(raw.get("id") or "")
        if not _char_of(eid):
            continue
        for b in raw.get("beats") or []:
            for key, lim in (("narration", 120), ("pc_thought", 80), ("brief", 80)):
                val = str(b.get(key) or "").strip()
                if not val or len(val) > lim or BANNED in val:
                    bad.append(f"{eid}/{b.get('id')}:{key}")

    print(f"updated_files={updated} beats={beats_n}")
    if bad:
        print("FAIL", bad[:20])
        return 1
    print("OK enrich_t2_narration_layer")
    return 0


if __name__ == "__main__":
    sys.exit(main())
