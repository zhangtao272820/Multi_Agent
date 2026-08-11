# -*- coding: utf-8 -*-
"""全员白话加厚：故事旁白/思考/pages + 结局 pages（不改 flags/conditions）。

目标字数见 doc/故事厚度与文案规范.md；呈现契约见 galgame美德演绎升级计划.md。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"
STARS = ROOT / "data" / "cast_star_tiers.json"
PRESENT = ROOT / "data" / "presentation_catalog.json"
ENDINGS = ROOT / "data" / "endings.json"

NARR_MIN = {5: 80, 4: 70, 3: 60, 2: 50, 1: 40}
THOUGHT_MIN = {5: 30, 4: 28, 3: 24, 2: 20, 1: 16}
# (star, type) -> min pages；secret/good 按真/好；normal=soft；bad
END_PAGES = {
    (5, "secret"): 5,
    (5, "good"): 5,
    (5, "normal"): 3,
    (5, "bad"): 3,
    (4, "secret"): 4,
    (4, "good"): 4,
    (4, "normal"): 3,
    (4, "bad"): 3,
    (3, "secret"): 3,
    (3, "good"): 3,
    (3, "normal"): 2,
    (3, "bad"): 2,
    (2, "secret"): 2,
    (2, "good"): 2,
    (2, "normal"): 2,
    (2, "bad"): 2,
}

# 真/好结局若仍不足星级页数，用白话余温页补齐（不改结局语义）

MOTIFS: dict[str, list[str]] = {
    "xiaoyou": [
        "松节油味道还在鼻尖打转。",
        "画室暖黄灯把未干的线稿照得很清楚。",
        "门铃那一下轻得像怕吵醒整条走廊。",
        "阳台风把颜料味吹进来又吹出去。",
    ],
    "wanyu": [
        "咖啡蒸汽糊住眼镜边，又慢慢散开。",
        "打烊铃响了一下，店里忽然静下来。",
        "柜台擦得发亮，她的指节还沾着糖浆。",
        "雨还在窗外敲，杯垫印着一圈水痕。",
    ],
    "ruolin": [
        "红笔盖子扣上，桌上只剩茶凉了一截。",
        "办公室灯管嗡了一声，像提醒边界还在。",
        "粉笔灰落尽后，空气里只剩纸张味道。",
        "答疑名单翻过一页，字迹规矩得吓人。",
    ],
    "jingliu": [
        "玻璃门外走廊空了，只剩空调的风声。",
        "工牌贴在胸口，像多了一层壳。",
        "会议室灯关掉，屏幕还留着一点余光。",
        "天台风比写字楼里硬得多。",
    ],
    "aili": [
        "花茎上的水珠滚下来，凉凉的。",
        "温室里土腥味混着淡花香。",
        "她把剪刀放回原位，动作很稳。",
        "包装纸沙沙响，像把旧事折小一点。",
    ],
    "linxi": [
        "键盘声停了一拍，表格光标还在闪。",
        "加班灯把两人影子拉得很长。",
        "便利贴边角卷起，字却写得很清楚。",
        "电梯下行时耳朵发闷，谁也没先开口。",
    ],
    "shuli": [
        "日程本摊在碗边，格子被她点得笃定。",
        "厨房灯下饭香很近，称呼却很远。",
        "隔壁偶尔传来游戏声，又忽然静了。",
        "本子夹层鼓着，像藏着还没说出口的字。",
    ],
    "taotao": [
        "应援棒的光在余光里闪了一下。",
        "卸妆棉放下，舞台味还没散干净。",
        "彩排间隙饮水机嗡嗡响。",
        "耳返线缠在手指上，她却笑得很轻。",
    ],
    "shizuku": [
        "图书馆空调把书页吹得微微动。",
        "闭馆广播响起，座位还空着一半。",
        "屏幕光映在她眼镜上，字打得很慢。",
        "借书证并排放着，塑料边有点旧。",
    ],
    "qiansha": [
        "PR 状态灯从黄变绿，又灭了。",
        "耳机线绕在手腕上，评论区还在刷。",
        "工位隔板后只剩键盘的轻响。",
        "提交记录干净得像什么都没发生过。",
    ],
    "shiori": [
        "荐书单墨水未干，纸边微微卷。",
        "柜台灯把她袖口照得很白。",
        "书架深处有纸张和旧胶水的味道。",
        "她把书签夹好，动作轻得像怕弄响。",
    ],
    "miara": [
        "摊位帘布一掀，谷子味混着热气。",
        "通票绳子勒着手腕，倒也不讨厌。",
        "漫展喇叭远处嗡嗡响，近处却很静。",
        "她把样衣折好，布料摩擦沙沙响。",
    ],
    "youwei": [
        "速写本边角卷起，铅笔屑掉在鞋尖。",
        "画室门缝透出暖光，走廊有点凉。",
        "胶带扯断的一声很清脆。",
        "她把第三支笔搁在桌上，没再说话。",
    ],
    "yuxi": [
        "围裙带子在她腰后打了个松结。",
        "咖啡机泄压声响过，蒸汽散开。",
        "换班钟响了一下，她看了眼你。",
        "抹布拧干，台面留下一道水印。",
    ],
    "jingning": [
        "小本子合上，笔帽咔哒一声。",
        "秀场边缘灯光乱晃，她却站得很稳。",
        "家族聚会酒杯碰响，她语气仍平。",
        "观察日记翻过一页，名字旁有个勾。",
    ],
    "lingke": [
        "红笔搁在名单上，像一道浅浅的线。",
        "办公室门只开一条缝，规矩还在。",
        "她把须知推过来，纸张边角很齐。",
        "走廊人声远去，只剩鞋跟轻响。",
    ],
    "aichen": [
        "花刀搁在垫布上，刃口还沾着水。",
        "后门风把包装纸吹得哗哗响。",
        "她把备用花材推进你怀里，眼神很硬。",
        "店里花香浓，她的话却不甜。",
    ],
    "xingnai": [
        "便当盒盖合上，饭菜香还冒着热气。",
        "天台风把头发吹到她脸上。",
        "旧相册边角起毛，照片有点发黄。",
        "她把自行车锁好，钥匙串叮叮当当。",
    ],
    "fengyin": [
        "手柄震动了一下，屏幕光打在脸上。",
        "宿舍门缝透出游戏音效，又停了。",
        "运动鞋边还沾着跑道灰。",
        "她靠着墙喝水，喉结滚动得很清楚。",
    ],
    "qingcai": [
        "排练室镜子反光，她额角有汗。",
        "麦克风支架微微晃，线缠了一圈。",
        "舞台侧幕布擦过手臂，有点痒。",
        "谢幕灯暗下去，掌声还在耳边。",
    ],
    "xiaoyang": [
        "社团海报墨未干，手指沾了一点蓝。",
        "实验室白大褂袖口卷了两折。",
        "文化祭摊位布条被风掀起一角。",
        "她把笔帽咬着，又赶紧放下。",
    ],
    "luna": [
        "拿铁拉花转了一圈，又慢慢塌。",
        "塔罗牌边角磨旧，她洗牌很慢。",
        "围裙上绣着小月亮，线头翘起一点。",
        "夜班灯偏黄，影子拉得很长。",
    ],
}

LITERARY_FIX = [
    (r"像怕你不应", "像怕你不开门"),
    (r"兄长身份在这一秒发烫", "我知道不该这么看，还是没挪开眼睛"),
    (r"合法亲近", "说得过去的亲近"),
    (r"撕开一道缝", "露出破绽"),
    (r"软枷锁咔哒一声", "家里的规矩又紧了一扣"),
    (r"薄墙倒塌", "隔墙那点遮掩没了"),
    (r"心跳加速", "心里一紧"),
    (r"目光还是黏住了", "眼睛还是没挪开"),
    (r"像誓言，又像威胁", "像保证，也像警告"),
    (r"半文半白", ""),
    (r"选择会改写后面的路。?", ""),
    (r"气氛忽然认真起来。?", ""),
    (r"这句话比表面更重。?", ""),
]

THOUGHT_PAD = [
    "我想靠近，又怕一开口就退不回去。",
    "现在装没事很容易，事后一定会后悔。",
    "我该先认错，还是先把话说清楚？",
    "这一步迈出去，明天还怎么当面见她？",
    "别把她当任务。把眼前这点事做好就行。",
]

END_PAD = [
    "灯还亮着。有些话不必再说第二遍。",
    "风从门口进来，又把门轻轻带上。",
    "你站了一会儿，才把脚步迈出去。",
    "夜里很安静。该留下的，已经留下了。",
    "明天太阳照样升起，故事停在这一页。",
]


def vernacular(text: str) -> str:
    t = (text or "").strip()
    for pat, rep in LITERARY_FIX:
        t = re.sub(pat, rep, t)
    t = re.sub(r"[ \t]+", "", t)
    return t.strip()


def thicken(text: str, target: int, pads: list[str]) -> str:
    t = vernacular(text)
    if not t:
        t = pads[0] if pads else "事情就发生在眼前。"
    i = 0
    while len(t) < target and pads and i < 40:
        extra = pads[i % len(pads)]
        if extra and extra not in t:
            if not t.endswith(("。", "！", "？", "…")):
                t += "。"
            t += extra
        i += 1
    return t


def cid_from_event(path: Path, stars: dict) -> str | None:
    rest = path.stem[len("story_") :]
    for c in sorted(stars, key=len, reverse=True):
        if rest == c or rest.startswith(c + "_"):
            return c
    return None


def build_pages(narration: str, thought: str, hints: list[str]) -> list[dict]:
    outfit = ""
    for h in hints or []:
        if str(h).strip():
            outfit = str(h).strip()
            break
    pages: list[dict] = []
    if narration:
        pages.append(
            {
                "text": narration[:120],
                "voice": "narration",
                "sprite": {"outfit": outfit, "emotion": "neutral"} if outfit else {"emotion": "neutral"},
            }
        )
    if thought:
        pages.append(
            {
                "text": thought[:80],
                "voice": "pc",
                "sprite": {"outfit": outfit, "emotion": "shy"} if outfit else {"emotion": "shy"},
            }
        )
    # 若旁白很长，拆第二页旁白（白话可读）
    if narration and len(narration) > 100 and len(pages) == 2:
        mid = max(40, len(narration) // 2)
        cut = narration.rfind("。", 0, mid + 20)
        if cut > 30:
            pages[0]["text"] = narration[: cut + 1]
            pages.insert(
                1,
                {
                    "text": narration[cut + 1 :][:120],
                    "voice": "narration",
                    "sprite": pages[0]["sprite"],
                },
            )
    return pages


def patch_stories() -> tuple[int, int]:
    stars = json.loads(STARS.read_text(encoding="utf-8"))["characters"]
    files = 0
    beats_n = 0
    for path in sorted(EVENTS.glob("story_*.yaml")):
        cid = cid_from_event(path, stars)
        if not cid:
            continue
        weight = int((stars.get(cid) or {}).get("story_weight") or 2)
        nmin = NARR_MIN.get(weight, 50)
        tmin = THOUGHT_MIN.get(weight, 20)
        motifs = MOTIFS.get(cid) or [
            "周围很安静，细节却记得清楚。",
            "空气里有一点味道，让人没法装没事。",
            "她看了你一眼，又把视线挪开。",
        ]
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        changed = False
        for beat in doc.get("beats") or []:
            if not isinstance(beat, dict):
                continue
            narr = thicken(beat.get("narration") or beat.get("summary") or "", nmin, motifs)
            thought = thicken(beat.get("pc_thought") or "", tmin, THOUGHT_PAD)
            hints = list(beat.get("sprite_hint") or [])
            pages = build_pages(narr, thought, hints)
            if (
                narr != (beat.get("narration") or "").strip()
                or thought != (beat.get("pc_thought") or "").strip()
                or pages != (beat.get("pages") or [])
            ):
                changed = True
            beat["narration"] = narr
            beat["pc_thought"] = thought
            beat["pages"] = pages
            if not (beat.get("brief") or "").strip():
                beat["brief"] = (beat.get("summary") or narr)[:80]
            beats_n += 1
        if changed:
            path.write_text(
                yaml.safe_dump(doc, allow_unicode=True, sort_keys=False, width=120),
                encoding="utf-8",
            )
            files += 1
    return files, beats_n


def patch_endings() -> int:
    stars = json.loads(STARS.read_text(encoding="utf-8"))["characters"]
    endings = {e["id"]: e for e in json.loads(ENDINGS.read_text(encoding="utf-8")).get("endings") or []}
    pc = json.loads(PRESENT.read_text(encoding="utf-8"))
    pe = pc.setdefault("endings", {})
    n = 0
    for eid, meta in endings.items():
        cids = list(meta.get("character_ids") or [])
        weight = 2
        for cid in cids:
            if cid in stars:
                weight = max(weight, int(stars[cid].get("story_weight") or 2))
        etype = str(meta.get("type") or "normal")
        need = END_PAGES.get((weight, etype), 2)
        block = pe.get(eid) or {}
        pages = [vernacular(str(p)) for p in (block.get("pages") or []) if str(p).strip()]
        # 把偏文艺的旧页再扫一遍
        pages = [p for p in pages if p]
        i = 0
        while len(pages) < need:
            pad = END_PAD[i % len(END_PAD)]
            # 角色母题补一句，避免全库同句
            if cids:
                motif = (MOTIFS.get(cids[0]) or [""])[i % max(1, len(MOTIFS.get(cids[0]) or [""]))]
                line = vernacular(f"{pad}{motif}")
            else:
                line = pad
            if line not in pages:
                pages.append(line)
            i += 1
            if i > 20:
                break
        # 真/好结局额外保证总字数观感（白话短句可多页）
        if etype in {"secret", "good"} and weight >= 4:
            while len(pages) < need:
                pages.append(END_PAD[len(pages) % len(END_PAD)])
        if pages != (block.get("pages") or []):
            n += 1
        block = dict(block)
        block["pages"] = pages
        if "bg" not in block:
            block["bg"] = "cafe.png" if etype != "bad" else "rain.png"
        if "bgm" not in block:
            block["bgm"] = (
                "ending_bad"
                if etype == "bad"
                else "ending_good"
                if etype in {"secret", "good"}
                else "ending_soft"
            )
        pe[eid] = block
    # 序章 lines 白话轻扫
    opening = pc.get("opening") or {}
    slides = opening.get("slides") if isinstance(opening, dict) else None
    if isinstance(slides, list):
        for slide in slides:
            if not isinstance(slide, dict):
                continue
            if slide.get("caption"):
                slide["caption"] = vernacular(str(slide["caption"]))
            if isinstance(slide.get("lines"), list):
                slide["lines"] = [vernacular(str(x)) for x in slide["lines"] if str(x).strip()]
    PRESENT.write_text(json.dumps(pc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return n


def main() -> None:
    sf, sb = patch_stories()
    en = patch_endings()
    print(f"stories_files={sf} beats={sb} endings_touched={en}")


if __name__ == "__main__":
    main()
