# -*- coding: utf-8 -*-
"""One-shot: enrich T0 story beats with narration / pc_thought / brief.

Hand-authored transform rules (not LLM dump). Re-run after editing summaries if needed.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"
T0 = ("xiaoyou", "wanyu", "ruolin", "jingliu", "aili", "linxi")
BANNED = "选择会改写后面的路"

# character sensory anchors + rotating PC thoughts (first person)
CHAR_SCENE = {
    "xiaoyou": ("松节油与暖黄灯", "画室", "线稿"),
    "wanyu": ("蒸汽与咖啡渣", "吧台", "打烊灯"),
    "ruolin": ("粉笔灰与纸页", "办公室", "讲台"),
    "jingliu": ("玻璃反光与夜风", "天台", "样衣间"),
    "aili": ("泥土与花茎汁", "阳台", "花房"),
    "linxi": ("打印纸与轨道风", "工位", "末班车"),
}

CHAR_THOUGHTS = {
    "xiaoyou": [
        "应门的话，邻居的壳就薄了。不应，又怕今晚只剩自己和未干的线稿。",
        "我是来帮忙的，还是来被画进她的框里？",
        "夸她的画容易；留下来才难。",
        "deadline 里掺着心动——我别把忙碌当成逃避。",
        "被看见的感觉烫。我想逃，又想再靠近一寸。",
        "第三支笔一来，画框外的位置就挤了。我站哪边？",
        "冬窗边她的围巾——我想伸手，又怕弄脏画面。",
    ],
    "wanyu": [
        "熟客位很安全。再近一步，营业笑就撑不住。",
        "我想听她卸妆后的声音，不只是菜单上的温度。",
        "真心洒出来时，我是接住，还是假装没看见？",
        "留杯像约会。我怕自己把照料当成理所当然。",
        "雨汐的围脖一摔，店里的空气就变了。我帮不帮？",
        "蒸汽里她的眼睛很亮——我别只当她是服务员。",
        "打烊后的钥匙很重。接过来，就再也装不成路人。",
    ],
    "ruolin": [
        "粉笔灰落在袖口。我想叫她名字，又怕越界。",
        "边界课是给两个人的——我也在被考试。",
        "摘掉工牌的那一秒，师生戏就松了。我敢不敢对等？",
        "同学名比情话更烫。接住还是退回老师？",
        "红笔在门口——闲话比心动更快。我护不护这道线？",
        "冬办公室只剩我们。我想把「老师」咽回去。",
        "铃可在看。边界守不住，真结局也守不住。",
    ],
    "jingliu": [
        "玻璃门里她是上司。门一关，我还站不站得住？",
        "面具摘了半寸。我想看全，又怕被职场反噬。",
        "天台夜风冷。她递来的钥匙比合同烫。",
        "对等工位——专一承诺的影子已经来了。",
        "堂妹的观察笔记像刀。我是麻烦，还是值得亮出来的人？",
        "冬天台上围巾松了。权力差被风吹薄一层。",
        "新年卡不写职位。我想签的是人，不是下属。",
    ],
    "aili": [
        "旧婚书的影子还在。我是新选择，不是替补。",
        "修剪茎的声音很稳。我想学照顾她，不只是看花。",
        "外送袋破了也好。弄脏的是完美人设，不是我们。",
        "再选择不是复合回档——我别踩进旧剧本。",
        "艾辰站在门口像审核。我答得诚实吗？",
        "温室暖，她的话更暖。我想写第二次开花，不是怀旧。",
        "节日花束没祝词。空白留给我们填，还是留给退路？",
    ],
    "linxi": [
        "对桌探头那一下，像实习期的心跳漏拍。",
        "末班车扶手很凉。逞强的她，其实也怕走丢。",
        "打印室只剩我们。我想把「同事」说成更私的词。",
        "工位之间只要一步——我迈不迈得出去？",
        "加班决裂的纸堆像墙。扶住她，还是成全她的逞强？",
        "冬轨风里围巾勒紧。并肩不等于绑死前程。",
        "春日工位只剩一盏灯。我想把这一步写成共同绩效以外的事。",
    ],
}


def _clip(text: str, limit: int) -> str:
    t = (text or "").strip()
    if len(t) <= limit:
        return t
    return t[: max(0, limit - 1)] + "…"


def _clean_core(summary: str) -> str:
    s = (summary or "").strip()
    s = s.replace("——" + BANNED, "").replace("—" + BANNED, "").replace(BANNED, "")
    s = re.sub(r"[—－]{2,}", "——", s)
    s = s.strip("—-·。；;，, ")
    # drop meta flag jargon from player-facing narration seed
    s = re.sub(r"\b[a-z]+_[a-z_]+\b", "", s, flags=re.I)
    s = re.sub(r"\s+", "", s) if False else re.sub(r" {2,}", " ", s)
    return s.strip("—-·。；;，, ")


def _to_brief(core: str) -> str:
    """Third-person stimulus; strip trailing choice rhetoric."""
    t = core
    t = re.sub(r"(你怎么回答|你怎么选|选择会.*)$", "", t)
    t = t.strip("—-·。；;，, ")
    if not t.endswith(("。", "！", "？")):
        t = t + "。"
    # prefer imperative emotional task feel
    if "等你" not in t and len(t) < 70:
        t = t.rstrip("。") + "。等你回应。"
    return _clip(t, 80)


def _to_narration(core: str, cid: str, sprite_hint: list[str]) -> str:
    smell, place, _prop = CHAR_SCENE.get(cid, ("空气微凉", "这里", "细节"))
    body = (core or "").replace(BANNED, "").strip("—-·。；;，, ")
    # core often already scenic; only prefix smell if missing
    if smell[:2] in body or place in body:
        text = body
    else:
        text = f"{smell}里，{body}"
    if not text.endswith(("。", "！", "？", "…")):
        text += "。"
    # avoid dumping sprite ids into player text
    _ = sprite_hint
    return _clip(text, 120)


def _to_thought(cid: str, beat_index: int, core: str) -> str:
    pool = CHAR_THOUGHTS.get(cid) or ["我想靠近，又怕把局面弄坏。"]
    base = pool[beat_index % len(pool)]
    # lightly hook a short noun from core
    hook = ""
    for token in ("门铃", "画", "钥匙", "围巾", "红笔", "玻璃", "花", "工位", "末班", "天台", "吧台"):
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
    hints = [str(x) for x in (beat.get("sprite_hint") or []) if str(x).strip()]
    brief = _to_brief(core)
    narration = _to_narration(core, cid, hints)
    thought = _to_thought(cid, beat_index, core)
    out = dict(beat)
    out["narration"] = narration
    out["pc_thought"] = thought
    out["brief"] = brief
    out["summary"] = brief
    # drop banned if any slipped
    for k in ("narration", "pc_thought", "brief", "summary"):
        out[k] = str(out[k]).replace(BANNED, "").strip()
    return out


def _char_of(event_id: str) -> str | None:
    for c in T0:
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
    paths = sorted(EVENTS.glob("story_*.yaml"))
    updated = 0
    beats_n = 0
    for path in paths:
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
        new_beats = [enrich_beat(b, cid, i) for i, b in enumerate(beats)]
        raw["beats"] = new_beats
        # normalize prompt_snippet to block style without extra blank if possible
        path.write_text(
            yaml.dump(
                raw,
                Dumper=_Dumper,
                allow_unicode=True,
                sort_keys=False,
                width=100,
            ),
            encoding="utf-8",
        )
        updated += 1
        beats_n += len(new_beats)

    # verify
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
                    bad.append(f"{eid}/{b.get('id')}: {key} len={len(val)}>{lim}")
                if BANNED in val:
                    bad.append(f"{eid}/{b.get('id')}: banned in {key}")

    print(f"updated_files={updated} beats={beats_n}")
    if bad:
        print("FAIL verify:")
        for line in bad[:40]:
            print(" ", line)
        return 1
    print("OK enrich_t0_narration_layer")
    return 0


if __name__ == "__main__":
    sys.exit(main())
