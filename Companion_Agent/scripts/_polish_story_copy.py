# -*- coding: utf-8 -*-
"""全员文案润色：去脚本垫句、保字数、重建 pages；顺带润结局/约会/序章。

不改 flags / choice_effects / conditions。
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
DATES = ROOT / "data" / "date_catalog.json"
SPRITES = ROOT / "data" / "sprites"

NARR_MIN = {5: 80, 4: 70, 3: 60, 2: 50, 1: 40}
THOUGHT_MIN = {5: 28, 4: 26, 3: 22, 2: 18, 1: 16}

# 脚本加厚留下的重复垫句（整句删除）
PAD_SENTENCES = [
    "松节油味道还在鼻尖打转。",
    "画室暖黄灯把未干的线稿照得很清楚。",
    "门铃那一下轻得像怕吵醒整条走廊。",
    "阳台风把颜料味吹进来又吹出去。",
    "咖啡蒸汽糊住眼镜边，又慢慢散开。",
    "打烊铃响了一下，店里忽然静下来。",
    "柜台擦得发亮，她的指节还沾着糖浆。",
    "雨还在窗外敲，杯垫印着一圈水痕。",
    "红笔盖子扣上，桌上只剩茶凉了一截。",
    "办公室灯管嗡了一声，像提醒边界还在。",
    "粉笔灰落尽后，空气里只剩纸张味道。",
    "答疑名单翻过一页，字迹规矩得吓人。",
    "玻璃门外走廊空了，只剩空调的风声。",
    "工牌贴在胸口，像多了一层壳。",
    "会议室灯关掉，屏幕还留着一点余光。",
    "天台风比写字楼里硬得多。",
    "花茎上的水珠滚下来，凉凉的。",
    "温室里土腥味混着淡花香。",
    "她把剪刀放回原位，动作很稳。",
    "包装纸沙沙响，像把旧事折小一点。",
    "键盘声停了一拍，表格光标还在闪。",
    "加班灯把两人影子拉得很长。",
    "便利贴边角卷起，字却写得很清楚。",
    "电梯下行时耳朵发闷，谁也没先开口。",
    "日程本摊在碗边，格子被她点得笃定。",
    "厨房灯下饭香很近，称呼却很远。",
    "隔壁偶尔传来游戏声，又忽然静了。",
    "本子夹层鼓着，像藏着还没说出口的字。",
    "应援棒的光在余光里闪了一下。",
    "卸妆棉放下，舞台味还没散干净。",
    "彩排间隙饮水机嗡嗡响。",
    "耳返线缠在手指上，她却笑得很轻。",
    "图书馆空调把书页吹得微微动。",
    "闭馆广播响起，座位还空着一半。",
    "屏幕光映在她眼镜上，字打得很慢。",
    "借书证并排放着，塑料边有点旧。",
    "PR 状态灯从黄变绿，又灭了。",
    "耳机线绕在手腕上，评论区还在刷。",
    "工位隔板后只剩键盘的轻响。",
    "提交记录干净得像什么都没发生过。",
    "荐书单墨水未干，纸边微微卷。",
    "柜台灯把她袖口照得很白。",
    "书架深处有纸张和旧胶水的味道。",
    "她把书签夹好，动作轻得像怕弄响。",
    "摊位帘布一掀，谷子味混着热气。",
    "通票绳子勒着手腕，倒也不讨厌。",
    "漫展喇叭远处嗡嗡响，近处却很静。",
    "她把样衣折好，布料摩擦沙沙响。",
    "速写本边角卷起，铅笔屑掉在鞋尖。",
    "画室门缝透出暖光，走廊有点凉。",
    "胶带扯断的一声很清脆。",
    "她把第三支笔搁在桌上，没再说话。",
    "围裙带子在她腰后打了个松结。",
    "咖啡机泄压声响过，蒸汽散开。",
    "换班钟响了一下，她看了眼你。",
    "抹布拧干，台面留下一道水印。",
    "小本子合上，笔帽咔哒一声。",
    "秀场边缘灯光乱晃，她却站得很稳。",
    "家族聚会酒杯碰响，她语气仍平。",
    "观察日记翻过一页，名字旁有个勾。",
    "红笔搁在名单上，像一道浅浅的线。",
    "办公室门只开一条缝，规矩还在。",
    "她把须知推过来，纸张边角很齐。",
    "走廊人声远去，只剩鞋跟轻响。",
    "花刀搁在垫布上，刃口还沾着水。",
    "后门风把包装纸吹得哗哗响。",
    "她把备用花材推进你怀里，眼神很硬。",
    "店里花香浓，她的话却不甜。",
    "便当盒盖合上，饭菜香还冒着热气。",
    "天台风把头发吹到她脸上。",
    "旧相册边角起毛，照片有点发黄。",
    "她把自行车锁好，钥匙串叮叮当当。",
    "手柄震动了一下，屏幕光打在脸上。",
    "宿舍门缝透出游戏音效，又停了。",
    "运动鞋边还沾着跑道灰。",
    "她靠着墙喝水，喉结滚动得很清楚。",
    "排练室镜子反光，她额角有汗。",
    "麦克风支架微微晃，线缠了一圈。",
    "舞台侧幕布擦过手臂，有点痒。",
    "谢幕灯暗下去，掌声还在耳边。",
    "社团海报墨未干，手指沾了一点蓝。",
    "实验室白大褂袖口卷了两折。",
    "文化祭摊位布条被风掀起一角。",
    "她把笔帽咬着，又赶紧放下。",
    "拿铁拉花转了一圈，又慢慢塌。",
    "塔罗牌边角磨旧，她洗牌很慢。",
    "围裙上绣着小月亮，线头翘起一点。",
    "夜班灯偏黄，影子拉得很长。",
    "周围很安静，细节却记得清楚。",
    "空气里有一点味道，让人没法装没事。",
    "她看了你一眼，又把视线挪开。",
    "我想靠近，又怕一开口就退不回去。",
    "现在装没事很容易，事后一定会后悔。",
    "我该先认错，还是先把话说清楚？",
    "这一步迈出去，明天还怎么当面见她？",
    "别把她当任务。把眼前这点事做好就行。",
    "灯还亮着。有些话不必再说第二遍。",
    "风从门口进来，又把门轻轻带上。",
    "你站了一会儿，才把脚步迈出去。",
    "夜里很安静。该留下的，已经留下了。",
    "明天太阳照样升起，故事停在这一页。",
]

# 每角色唯一「补长」句（仅当去垫后仍短于下限时用一次）
MOTIF_ONCE: dict[str, str] = {
    "xiaoyou": "门缝里还能闻见一点松节油。",
    "wanyu": "杯沿还留着一圈淡咖啡渍。",
    "ruolin": "红笔帽扣得严严实实。",
    "jingliu": "工牌边缘硌了一下手指。",
    "aili": "花茎切口还渗着水。",
    "linxi": "表格最后一行数字还没填完。",
    "shuli": "日程本角被她捏得有点翘。",
    "taotao": "耳返线还绕在她指节上。",
    "shizuku": "借书证边角磨得发白。",
    "qiansha": "耳机麦还开着静音。",
    "shiori": "荐书单墨迹刚干。",
    "miara": "摊位帘布蹭过手背。",
    "youwei": "速写本夹着一支没削尖的笔。",
    "yuxi": "围裙带松松挂着。",
    "jingning": "小本子别在她包侧。",
    "lingke": "名单页折了一道痕。",
    "aichen": "包装纸角还翘着。",
    "xingnai": "便当绳结打得很仔细。",
    "fengyin": "手柄按键还留着一点热。",
    "qingcai": "镜面上有一圈水雾。",
    "xiaoyang": "海报卷边还没压平。",
    "luna": "杯托上印着浅浅的月牙。",
}

SAFE_OUTFITS = ("casual", "home", "work", "date", "home_sibling", "kitchen_helper")

END_MOTIF_PAGES: dict[str, list[str]] = {
    "xiaoyou": [
        "画室灯还亮着。有些线，今天不必画完。",
        "门铃安静下来。你知道下次还会再响。",
    ],
    "wanyu": [
        "打烊铃过后，柜台只剩两只杯子。",
        "她说慢走。这一次，你听懂了。",
    ],
    "ruolin": [
        "红笔合上。边界还在，心却松了一点。",
        "办公室的门没有关死，也没有完全打开。",
    ],
    "jingliu": [
        "工牌还在，称呼却不一样了。",
        "电梯门合上前，她看了你一眼。",
    ],
    "aili": [
        "花枝收下了。旧伤不必再当笑话讲。",
        "温室的灯灭了一半，新芽还在。",
    ],
    "linxi": [
        "表格存档了。附件里没有心跳，人却还在。",
        "下班路上风有点凉，话说清楚就够了。",
    ],
    "shuli": [
        "日程本合上。当面仍是兄妹，私下你们自己知道。",
        "隔壁游戏声又响起来。家还没散。",
    ],
}


def strip_pads(text: str) -> str:
    t = (text or "").strip()
    for pad in PAD_SENTENCES:
        t = t.replace(pad, "")
    t = re.sub(r"。{2,}", "。", t)
    t = re.sub(r"\s+", "", t)
    return t.strip("。") + ("。" if t and not t.endswith(("。", "！", "？", "…")) else "")


def ensure_len(text: str, target: int, motif: str) -> str:
    t = strip_pads(text)
    if not t:
        t = motif
    if len(t) < target and motif and motif not in t:
        if not t.endswith(("。", "！", "？", "…")):
            t += "。"
        t += motif
    # 仍短则用白话补一句动作，避免再堆垫句库
    fillers = [
        "她没再多说，只是看着你。",
        "这一秒谁先开口，都会把关系往前推一点。",
        "空气有点静，连呼吸都听得见。",
    ]
    i = 0
    while len(t) < target and i < len(fillers):
        if fillers[i] not in t:
            if not t.endswith(("。", "！", "？", "…")):
                t += "。"
            t += fillers[i]
        i += 1
    return t


def cid_from_path(path: Path, stars: dict) -> str | None:
    rest = path.stem[len("story_") :]
    for c in sorted(stars, key=len, reverse=True):
        if rest == c or rest.startswith(c + "_"):
            return c
    return None


def disk_outfits(cid: str) -> set[str]:
    found: set[str] = set()
    for folder in (SPRITES / "romance" / cid, SPRITES / "neutral" / cid, SPRITES / cid):
        if not folder.is_dir():
            continue
        for p in folder.glob("*.png"):
            stem = p.stem
            for emo in ("neutral", "happy", "shy", "sad", "angry", "love", "surprised"):
                suf = "_" + emo
                if stem.endswith(suf):
                    found.add(stem[: -len(suf)])
                    break
    return found


def pick_outfit(hints: list[str], disk: set[str]) -> str:
    for h in hints or []:
        h = str(h).strip()
        if h and (not disk or h in disk):
            return h
    for s in SAFE_OUTFITS:
        if not disk or s in disk:
            return s
    return "casual"


def build_pages(narr: str, thought: str, outfit: str) -> list[dict]:
    pages = []
    if narr:
        pages.append(
            {
                "text": narr[:120],
                "voice": "narration",
                "sprite": {"outfit": outfit, "emotion": "neutral"},
            }
        )
    if thought:
        pages.append(
            {
                "text": thought[:80],
                "voice": "pc",
                "sprite": {"outfit": outfit, "emotion": "shy"},
            }
        )
    return pages


def polish_stories() -> tuple[int, int]:
    stars = json.loads(STARS.read_text(encoding="utf-8"))["characters"]
    files = 0
    beats_n = 0
    for path in sorted(EVENTS.glob("story_*.yaml")):
        cid = cid_from_path(path, stars)
        if not cid:
            continue
        weight = int((stars.get(cid) or {}).get("story_weight") or 2)
        nmin = NARR_MIN.get(weight, 50)
        tmin = THOUGHT_MIN.get(weight, 20)
        motif = MOTIF_ONCE.get(cid, "她站在不远不近的地方。")
        disk = disk_outfits(cid)
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        changed = False
        for beat in doc.get("beats") or []:
            if not isinstance(beat, dict):
                continue
            raw_n = beat.get("narration") or beat.get("summary") or ""
            raw_t = beat.get("pc_thought") or ""
            narr = ensure_len(raw_n, nmin, motif)
            thought = ensure_len(raw_t, tmin, "我想靠近，又怕说错一句。")
            # 男主思考避免复述旁白开头
            if thought[:12] and thought[:12] in narr:
                thought = ensure_len("这话我该不该接。接了就退不回去。", tmin, "")
            outfit = pick_outfit(list(beat.get("sprite_hint") or []), disk)
            pages = build_pages(narr, thought, outfit)
            if (
                narr != (beat.get("narration") or "").strip()
                or thought != (beat.get("pc_thought") or "").strip()
                or pages != (beat.get("pages") or [])
            ):
                changed = True
            beat["narration"] = narr
            beat["pc_thought"] = thought
            beat["pages"] = pages
            beats_n += 1
        if changed:
            path.write_text(
                yaml.safe_dump(doc, allow_unicode=True, sort_keys=False, width=120),
                encoding="utf-8",
            )
            files += 1
    return files, beats_n


def polish_endings() -> int:
    stars = json.loads(STARS.read_text(encoding="utf-8"))["characters"]
    endings = {e["id"]: e for e in json.loads(ENDINGS.read_text(encoding="utf-8")).get("endings") or []}
    pc = json.loads(PRESENT.read_text(encoding="utf-8"))
    pe = pc.setdefault("endings", {})
    n = 0
    pad_set = set(PAD_SENTENCES)

    def need_pages(weight: int, etype: str) -> int:
        if etype in {"secret", "good"}:
            return {5: 5, 4: 4, 3: 3, 2: 2}.get(weight, 2)
        return {5: 3, 4: 3, 3: 2, 2: 2}.get(weight, 2)

    for eid, meta in endings.items():
        cids = list(meta.get("character_ids") or [])
        weight = 2
        for cid in cids:
            if cid in stars:
                weight = max(weight, int(stars[cid].get("story_weight") or 2))
        etype = str(meta.get("type") or "normal")
        block = dict(pe.get(eid) or {})
        pages = []
        for p in block.get("pages") or []:
            s = strip_pads(str(p))
            if s and s + ("。" if not s.endswith("。") else "") not in pad_set:
                # 去掉纯垫句页
                plain = s if s.endswith(("。", "！", "？", "…")) else s + "。"
                if plain not in pad_set and plain not in pages:
                    pages.append(plain if plain.endswith(("。", "！", "？", "…")) else plain + "。")
        # 角色余温补页
        extras: list[str] = []
        for cid in cids:
            extras.extend(END_MOTIF_PAGES.get(cid) or [])
        if not extras:
            extras = [
                "事情就停在这里。你们都清楚代价。",
                "灯还亮着的时候，有些话已经说完了。",
            ]
        need = need_pages(weight, etype)
        i = 0
        while len(pages) < need and i < 20:
            line = extras[i % len(extras)]
            if line not in pages:
                pages.append(line)
            i += 1
        if pages != (block.get("pages") or []):
            n += 1
        block["pages"] = pages
        pe[eid] = block

    # 序章
    opening = pc.get("opening") or {}
    slides = opening.get("slides") if isinstance(opening, dict) else None
    if isinstance(slides, list):
        for slide in slides:
            if not isinstance(slide, dict):
                continue
            if slide.get("caption"):
                slide["caption"] = strip_pads(str(slide["caption"]))
            if isinstance(slide.get("lines"), list):
                slide["lines"] = [strip_pads(str(x)) for x in slide["lines"] if str(x).strip()]

    PRESENT.write_text(json.dumps(pc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return n


DATE_POLISH: dict[str, list[dict]] = {
    "date_campus_walk": [
        {"text": "校园路上人不多。风从操场吹过来，她把袖口往下拉了拉。", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "campus"},
        {"text": "这种没什么目的的散步，手不知道该往哪放。", "voice": "pc", "sprite": {"outfit": "casual", "emotion": "shy"}, "bg": "campus"},
        {"text": "她侧头看你：要是闷着走完，回头你会后悔。", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "campus"},
        {"text": "……那你先说点什么呗。", "voice": "heroine", "sprite": {"outfit": "casual", "emotion": "shy"}, "bg": "campus"},
    ],
    "date_cafe": [
        {"text": "店里不吵。她把杯子转了半圈，才抬头看你。", "voice": "narration", "sprite": {"outfit": "date", "emotion": "happy"}, "bg": "cafe_evening"},
        {"text": "今天要是只聊天气，回去路上我会后悔。", "voice": "pc", "sprite": {"outfit": "date", "emotion": "shy"}, "bg": "cafe_evening"},
        {"text": "窗外天色慢慢暗了。她把菜单往你这边推。", "voice": "narration", "sprite": {"outfit": "date", "emotion": "happy"}, "bg": "cafe_evening"},
        {"text": "你点吧。我想听你说话多一点。", "voice": "heroine", "sprite": {"outfit": "date", "emotion": "shy"}, "bg": "cafe_evening"},
    ],
    "date_lunch_quick": [
        {"text": "午休很短。她占好靠窗位，面前摆着两杯水。", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "cafe"},
        {"text": "别拖。想见的那句，先说清楚。", "voice": "pc", "sprite": {"outfit": "casual", "emotion": "neutral"}, "bg": "cafe"},
        {"text": "她看了眼手机：还有二十分钟。够吗？", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "shy"}, "bg": "cafe"},
        {"text": "够。快点吃，也快点说正事。", "voice": "heroine", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "cafe"},
    ],
    "date_stargaze": [
        {"text": "山上风比城里大。她指了块平石头，让你坐下。", "voice": "narration", "sprite": {"outfit": "date", "emotion": "happy"}, "bg": "starry_hill"},
        {"text": "星星看不清也没关系。她肯把夜分给你，就够了。", "voice": "pc", "sprite": {"outfit": "date", "emotion": "love"}, "bg": "starry_hill"},
        {"text": "她把外套袖口拉好，声音放得很轻。", "voice": "narration", "sprite": {"outfit": "date", "emotion": "shy"}, "bg": "starry_hill"},
        {"text": "别说话也行。你在就行。", "voice": "heroine", "sprite": {"outfit": "date", "emotion": "love"}, "bg": "starry_hill"},
    ],
    "date_home_dinner": [
        {"text": "家里灯暖。碗筷摆成两人份，像早就算好你会来。", "voice": "narration", "sprite": {"outfit": "home", "emotion": "happy"}, "bg": "home_night"},
        {"text": "这顿饭不像约会，又比约会更让人心虚。", "voice": "pc", "sprite": {"outfit": "home", "emotion": "shy"}, "bg": "home_night"},
        {"text": "蒸汽模糊了眼镜边。她把汤往你这边推。", "voice": "narration", "sprite": {"outfit": "home", "emotion": "happy"}, "bg": "home_night"},
        {"text": "先吃。吃完……再说别的。", "voice": "heroine", "sprite": {"outfit": "home", "emotion": "shy"}, "bg": "home_night"},
    ],
    "date_night_store": [
        {"text": "便利店灯太亮。她拿着关东煮，懒洋洋靠着货架。", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "convenience_night"},
        {"text": "夜色把人都削短了。这种短约会，反而好开口。", "voice": "pc", "sprite": {"outfit": "casual", "emotion": "neutral"}, "bg": "convenience_night"},
        {"text": "她把热饮塞给你一只：别愣着，外面冷。", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "shy"}, "bg": "convenience_night"},
        {"text": "请你喝的。谢一声就行，别整弯弯绕。", "voice": "heroine", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "convenience_night"},
    ],
    "date_office_overtime": [
        {"text": "加班后走廊空荡荡。她解松领口，终于像个人。", "voice": "narration", "sprite": {"outfit": "work", "emotion": "sad"}, "bg": "office"},
        {"text": "这时候约夜宵，不是浪漫，是互相捞一把。", "voice": "pc", "sprite": {"outfit": "work", "emotion": "neutral"}, "bg": "office"},
        {"text": "电梯口风有点凉。她把包换到另一只手。", "voice": "narration", "sprite": {"outfit": "work", "emotion": "shy"}, "bg": "office"},
        {"text": "走吧。今天别谈工作，谈了我会更累。", "voice": "heroine", "sprite": {"outfit": "work", "emotion": "happy"}, "bg": "office"},
    ],
    "date_forest": [
        {"text": "林子里脚步声被落叶吃掉。她走在前面半步，又停住等你。", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "forest_clearing"},
        {"text": "这里安静得像能藏秘密。我也怕藏太深。", "voice": "pc", "sprite": {"outfit": "casual", "emotion": "shy"}, "bg": "forest_clearing"},
        {"text": "光从树缝漏下来。她指了指前方空地。", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "forest_clearing"},
        {"text": "再往里走一点。我想跟你说句……只有这里能说的。", "voice": "heroine", "sprite": {"outfit": "casual", "emotion": "shy"}, "bg": "forest_clearing"},
    ],
}


def polish_dates() -> int:
    cat = json.loads(DATES.read_text(encoding="utf-8"))
    n = 0
    for d in cat.get("dates") or []:
        did = d.get("id")
        pages = DATE_POLISH.get(did)
        if not pages:
            continue
        d["pages"] = pages
        n += 1
    DATES.write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return n


def main() -> None:
    sf, sb = polish_stories()
    en = polish_endings()
    dt = polish_dates()
    print(f"stories_files={sf} beats={sb} endings={en} dates={dt}")


if __name__ == "__main__":
    main()
