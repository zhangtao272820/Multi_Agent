# -*- coding: utf-8 -*-
"""Expand opening.slides to ~11 pages per 开局结局演出与场景音乐.md §1.2."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "data" / "presentation_catalog.json"

SLIDES = [
    {
        "id": "arrive",
        "bg": "campus.png",
        "period": "morning",
        "title": "抵达",
        "lines": [
            "你是普通公司职员。带着不多的行李，落脚这座还算安静的小镇。",
            "晨光里校门与街道都陌生——但房租已付，生活得开始。",
        ],
        "caption": "普通职员，行李落脚小镇。",
    },
    {
        "id": "sister_blood",
        "bg": "home.png",
        "period": "afternoon",
        "title": "亲妹",
        "sprite": {"character_id": "shuli", "outfit": "casual", "emotion": "happy"},
        "lines": [
            "亲妹妹沈书璃同城念书，常回这间屋。",
            "晚饭、借书、唠叨——她比谁都懂你的底细。",
        ],
        "caption": "亲妹妹沈书璃同城念书。",
    },
    {
        "id": "sister_step",
        "bg": "home.png",
        "period": "evening",
        "title": "义妹",
        "sprite": {"character_id": "fengyin", "outfit": "casual", "emotion": "shy"},
        "lines": [
            "义妹沈枫音同住。屋檐下亲近，不等于没有边界。",
            "先学会敲门——她要被当成平等的人，不是被照顾的小孩。",
        ],
        "caption": "义妹同住，先学会敲门。",
    },
    {
        "id": "workday",
        "bg": "office.png",
        "period": "afternoon",
        "title": "工位",
        "sprites": [
            {"character_id": "linxi", "outfit": "work", "emotion": "neutral"},
            {"character_id": "jingliu", "outfit": "work", "emotion": "neutral"},
        ],
        "lines": [
            "工作日去公司。工位之间往往只差一步。",
            "实习同事的追问，或是上司隔着玻璃的目光——都会变成故事。",
        ],
        "caption": "工作日公司：同事与上司。",
    },
    {
        "id": "cafe_weekend",
        "bg": "cafe.png",
        "period": "afternoon",
        "title": "咖啡",
        "sprite": {"character_id": "wanyu", "outfit": "work", "emotion": "happy"},
        "lines": [
            "周末在咖啡店晃。有人会把热拿铁推到你面前。",
            "像记得你的糖度——熟客座位，是一点点被记住的。",
        ],
        "caption": "周末咖啡，记得糖度。",
    },
    {
        "id": "neighbor",
        "bg": "room.png",
        "period": "evening",
        "title": "隔壁",
        "sprite": {"character_id": "xiaoyou", "outfit": "casual", "emotion": "shy"},
        "lines": [
            "隔壁住着插画师苏晚悠。门铃有时会响两下。",
            "也许只是借个盐——门槛里外，是邻居与更近一点的距离。",
        ],
        "caption": "隔壁门铃。",
    },
    {
        "id": "night_store",
        "bg": "store.png",
        "period": "night",
        "title": "夜班",
        "sprite": {"character_id": "yeyu", "outfit": "work", "emotion": "neutral"},
        "lines": [
            "便利店的荧光灯整夜不熄。",
            "夜班柜台后，也有人在等一句不赶客的闲聊。",
        ],
        "caption": "便利店夜班灯。",
    },
    {
        "id": "town_more",
        "bg": "starry.png",
        "period": "night",
        "title": "镇上",
        "lines": [
            "校园、图书馆、坡上书店……这座镇还有很多人。",
            "恋爱只发生在愿意靠近之后——不是名单，是选择。",
        ],
        "caption": "镇上还有很多人。",
    },
    {
        "id": "limits",
        "bg": "home.png",
        "period": "morning",
        "title": "心力",
        "lines": [
            "心力有限，钱要算——一天只能认真见几个人。",
            "选地点、见面、聊聊，就是你的日常；结束今天，世界会往前走。",
        ],
        "caption": "心力有限，一天认真见几个人。",
    },
    {
        "id": "near",
        "bg": "campus.png",
        "period": "morning",
        "title": "最近",
        "sprites": [
            {"character_id": "xiaoyou", "outfit": "casual", "emotion": "happy"},
            {"character_id": "wanyu", "outfit": "casual", "emotion": "neutral"},
            {"character_id": "shuli", "outfit": "casual", "emotion": "happy"},
        ],
        "lines": [
            "今天可以从最近的人开始。",
            "邻居、咖啡店熟人，或是回家看见妹妹——故事不远。",
        ],
        "caption": "从最近的人开始。",
    },
    {
        "id": "begin",
        "bg": "starry.png",
        "period": "night",
        "title": "启程",
        "sprites": [
            {"character_id": "xiaoyou", "outfit": "casual", "emotion": "happy"},
            {"character_id": "wanyu", "outfit": "casual", "emotion": "neutral"},
            {"character_id": "linxi", "outfit": "casual", "emotion": "shy"},
            {"character_id": "ruolin", "outfit": "casual", "emotion": "neutral"},
            {"character_id": "jingliu", "outfit": "casual", "emotion": "neutral"},
            {"character_id": "aili", "outfit": "casual", "emotion": "happy"},
        ],
        "lines": [
            "故事从今天开始。",
            "出门吧——去见她。",
        ],
        "caption": "故事从今天开始。出门吧——去见她。",
    },
]


def main() -> None:
    data = json.loads(PATH.read_text(encoding="utf-8"))
    opening = data.setdefault("opening", {})
    opening["bgm"] = opening.get("bgm") or "opening_prologue"
    opening["skip_label"] = opening.get("skip_label") or "跳过序章"
    opening["world_brief"] = [
        "你是落脚小镇的普通公司职员，与亲妹妹沈书璃、义妹沈枫音同住。",
        "工作日去公司，周末在咖啡店、书店与校园之间晃——偶遇会变成故事。",
        "心力有限，一天只能认真见几个人；专属路线靠好感一点点推开。",
    ]
    opening["slides"] = SLIDES
    PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"opening slides={len(SLIDES)}")


if __name__ == "__main__":
    main()
