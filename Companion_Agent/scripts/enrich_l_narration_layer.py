# -*- coding: utf-8 -*-
"""One-shot: enrich L-tier (linked) story beats with narration / pc_thought / brief."""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"
L_CHARS = ("youwei", "yuxi", "jingning", "lingke", "aichen")
BANNED = "选择会改写后面的路"

CHAR_SCENE = {
    "youwei": ("素描纸与松节油", "画室角落"),
    "yuxi": ("围裙布料与蒸汽", "吧台侧"),
    "jingning": ("观察笔记与玻璃反光", "家族局外"),
    "lingke": ("红笔与文件夹", "办公室门"),
    "aichen": ("花泥与温室雾", "门口"),
}

CHAR_THOUGHTS = {
    "youwei": [
        "我是学妹同盟，还是挤进画框的第三人？",
        "打包颜料时她看我一眼——帮忙还是越界？",
        "展示位有我的笔。晚悠会不会觉得被抢？",
        "开放门开了：第三支笔留下，还是自觉退出？",
        "画室门缝里有松节油。我想守同盟，也想被看见。",
        "那道门落章前，我别抢她的主线。",
        "学妹位置很安全。再近一步，就变成第三者剧本。",
    ],
    "yuxi": [
        "死党位很硬。我护晚雨，还是把自己也交出去？",
        "顶班信任不是恋爱通行证——我别搞混。",
        "展示真心时围裙还挂着。蒸汽里看不清界限。",
        "开放门：并肩站柜台，还是退回死党席？",
        "摔围裙那晚我在场。账要算清楚。",
        "关店钥匙很重。接过来像介入她的疲惫。",
        "那道门过了，心却还在观察期。",
    ],
    "jingning": [
        "观察日记是刀。我记破例，也在记自己心动。",
        "敬酒场上堂姐的笑很冷。我挡不挡？",
        "展示不是叛逆秀。我想有自己的声音。",
        "开放门：退出家族剧本，还是继续当影子记录员？",
        "那道门落章后，闲话会先找到我。",
        "玻璃门外她是堂姐。门里我还是小孩吗？",
        "家族局要划风险项。我把自己划进去还是划出去？",
    ],
    "lingke": [
        "红笔在我手里。边界是护她，也是护我自己。",
        "通行证不是免罪金牌。师生线一松，闲话就来。",
        "展示对等时我站门口——助教还是见证者？",
        "开放门：允许牵手，还是退回礼貌称呼？",
        "那道门过了，我仍怕重演灾难。",
        "办公室门禁比情话硬。我守得住吗？",
        "若铃摘镜那秒，我比她更不敢出声。",
    ],
    "aichen": [
        "夸花不算分。靠近姐姐的人先过我这关。",
        "按住她的手，不是占有，是怕她再被辜负。",
        "展示审核时花泥溅到鞋上。认真还是走过场？",
        "开放门：cleared，还是把门摔上？",
        "那道门落章前，我听得到自己的偏见。",
        "温室门口像法庭。我是法官，也是怕输的人。",
        "离婚后的沉默埋在花泥里。我别踩成旧剧本。",
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
    base = pool[beat_index % len(pool)]
    hook = ""
    for token in ("画", "笔", "围裙", "钥匙", "日记", "红笔", "花", "门", "边界", "堂姐"):
        if token in core:
            hook = token
            break
    if hook and hook not in base and len(base) < 70:
        base = f"{base.rstrip('。')}——想起{hook}。"
    return _clip(base, 80)


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


def _char_of(event_id: str) -> str | None:
    for c in L_CHARS:
        if event_id.startswith(f"story_{c}_"):
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
                if not val:
                    bad.append(f"{eid}/{b.get('id')}: empty {key}")
                elif len(val) > lim:
                    bad.append(f"{eid}/{b.get('id')}: {key} len={len(val)}")
                if BANNED in val:
                    bad.append(f"{eid}/{b.get('id')}: banned")

    print(f"updated_files={updated} beats={beats_n}")
    if bad:
        for line in bad[:40]:
            print("FAIL", line)
        return 1
    print("OK enrich_l_narration_layer")
    return 0


if __name__ == "__main__":
    sys.exit(main())
