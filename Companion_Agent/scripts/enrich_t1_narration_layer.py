# -*- coding: utf-8 -*-
"""One-shot: enrich T1 story beats with narration / pc_thought / brief."""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"
T1 = ("taotao", "shizuku", "qiansha", "shiori", "miara")
BANNED = "选择会改写后面的路"

CHAR_SCENE = {
    "taotao": ("声乐棚回音与汗味", "练功房", "灯牌"),
    "shizuku": ("纸页尘与闭馆灯", "书库", "麦克风"),
    "qiansha": ("显示器蓝光与键盘声", "工位", "旧 PR"),
    "shiori": ("纸墨与坡道夜风", "书店", "月亮"),
    "miara": ("布料纤维与展会灯", "摊位", "假发"),
}

CHAR_THOUGHTS = {
    "taotao": [
        "破音也比完美假笑真。我想当观众，不是灯牌支架。",
        "应急观众很好当——素颜观众才难。",
        "万人喜欢很吵。我想听她私下喘一口气的声音。",
        "冰袋比灯牌烫手。经纪人在门外，我挡不挡？",
        "舞台灯灭后，她还愿不愿意被我看见？",
        "安可压力像第二次公演。我接的是人，还是人设？",
        "冬夜练功房只剩我们。灯牌可以放下吗？",
    ],
    "shizuku": [
        "书脊后的她很安全。出声一步，线上久识就露馅。",
        "闭馆灯一关，声线无处躲。我想听，又怕吓跑她。",
        "码书比告白容易。我别把温柔当成客服话术。",
        "闭架书库像秘密。钥匙在她手里，也在我喉咙里。",
        "中秋书架边的沉默——要不要打破？",
        "冬馆暖气不足。我想把围巾递给声线，不是人设。",
        "线下见面像合并冲突。我选哪一版她？",
    ],
    "qiansha": [
        "旧 PR 还开着。Merge 还是 Close——我别当版本控制器。",
        "debug 到深夜，像把分手理由一行行编译。",
        "脏 diff 里藏着没说完的话。我敢不敢 review？",
        "新年 PR 标题很甜。落地还是 revert？",
        "冬屏蓝光刺眼。我想关掉显示器，看她本人。",
        "分支太久会腐烂。并肩提交，还是各写各的？",
        "主线只有一条。我是 feature，还是 breaking change？",
    ],
    "shiori": [
        "她荐别人的书很准。空白页才是她自己。",
        "坡上月亮很亮。我想读她未写完的那一行。",
        "窗边朗读像告白预演。我鼓掌还是接过笔？",
        "冬书架冷。书店可以关，心不能只当店员。",
        "中秋页码停在未写处——我填不填？",
        "写自己比卖书难。我想当第一个读者，不是顾客。",
        "月亮下她不荐书了。轮到我说一句真话。",
    ],
    "miara": [
        "摊位笑很满。戏言契约当真时，我会不会退缩？",
        "缝纫针脚比誓言稳。我想帮她缝，不是只收谷子。",
        "假发一摘，偶像壳裂了。素颜契约更重。",
        "冬摊位冷风灌进来。星约还作数吗？",
        "春日合同纸很薄。认真签字还是当同人玩笑？",
        "戏言生效的那一秒，比舞台灯更烫。",
        "谷子可以买。认真的她，买不到也骗不了。",
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
    s = re.sub(r"气氛忽然认真起来。?", "", s)
    s = re.sub(r"[—－]{2,}", "——", s)
    s = re.sub(r"\b[a-z]+_[a-z_]+\b", "", s, flags=re.I)
    s = re.sub(r" {2,}", " ", s)
    return s.strip("—-·。；;，, ")


def _to_brief(core: str) -> str:
    t = re.sub(r"(你怎么回答|你怎么选|选择会.*)$", "", core)
    t = t.strip("—-·。；;，, ")
    if not t.endswith(("。", "！", "？")):
        t = t + "。"
    if "等你" not in t and "等他" not in t and len(t) < 70:
        t = t.rstrip("。") + "。等你回应。"
    return _clip(t, 80)


def _to_narration(core: str, cid: str, sprite_hint: list[str]) -> str:
    smell, place, _prop = CHAR_SCENE.get(cid, ("空气微凉", "这里", "细节"))
    body = (core or "").replace(BANNED, "").strip("—-·。；;，, ")
    if smell[:2] in body or place in body:
        text = body
    else:
        text = f"{smell}里，{body}"
    if not text.endswith(("。", "！", "？", "…")):
        text += "。"
    _ = sprite_hint
    return _clip(text, 120)


def _to_thought(cid: str, beat_index: int, core: str) -> str:
    pool = CHAR_THOUGHTS.get(cid) or ["我想靠近，又怕把局面弄坏。"]
    base = pool[beat_index % len(pool)]
    hook = ""
    for token in ("灯牌", "素颜", "书", "声线", "PR", "月亮", "假发", "冰袋", "契约", "摊位"):
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
    out = dict(beat)
    out["narration"] = _to_narration(core, cid, hints)
    out["pc_thought"] = _to_thought(cid, beat_index, core)
    out["brief"] = _to_brief(core)
    out["summary"] = out["brief"]
    for k in ("narration", "pc_thought", "brief", "summary"):
        out[k] = str(out[k]).replace(BANNED, "").strip()
    return out


def _char_of(event_id: str) -> str | None:
    for c in T1:
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
    updated = 0
    beats_n = 0
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
                    bad.append(f"{eid}/{b.get('id')}: {key} len={len(val)}>{lim}")
                if BANNED in val:
                    bad.append(f"{eid}/{b.get('id')}: banned in {key}")

    print(f"updated_files={updated} beats={beats_n}")
    if bad:
        print("FAIL verify:")
        for line in bad[:40]:
            print(" ", line)
        return 1
    print("OK enrich_t1_narration_layer")
    return 0


if __name__ == "__main__":
    sys.exit(main())
