# -*- coding: utf-8 -*-
"""Write opening.slides: ~6 long-form beats (玩法 → 背景 → 启程)."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "data" / "presentation_catalog.json"

WORLD_BRIEF = [
    "你是沈予安：落脚小镇的普通职员。心力与金钱有限，选地点见面、聊天、结束今天——世界才会往前走。",
    "同住的有亲妹妹沈书璃与义妹沈枫音；镇上还有前女友、前妻、青梅，以及邻居与工位旁那些人。",
    "恋爱不是名单，是你愿意靠近之后才发生的事。专属路线靠好感一点点推开。",
]

SLIDES = [
    {
        "id": "howto",
        "bg": "home.png",
        "period": "morning",
        "title": "怎么过日子",
        "lines": [
            "在这座小镇里，你的日常很具体：打开地图选一个地点，去见想见的人，聊一会儿，再决定要不要结束今天。心力有限，钱也要算——一天往往只能认真对待几个人；敷衍地见很多，故事反而推不动。",
            "工作能赚生活费，吃饭能回体力。傍晚或夜里点「结束今天」，日历会往前翻一格，天气、偶遇与她们的心情都会跟着变。恋爱不会自动发生：你选靠近谁、说什么、是否专一——才会慢慢变成一条专属路线。",
        ],
        "caption": "选地点见面；心力与金钱有限；结束今天推进世界。",
    },
    {
        "id": "who",
        "bg": "campus.png",
        "period": "morning",
        "title": "沈予安",
        "lines": [
            "你是沈予安。普通公司职员，带着不多的行李落脚这座还算安静的小镇——不是逃难，也不是旅行，只是房租已付、工位已定，生活得从今天重新排开。晨光里校门与街道都还陌生，但你知道：工作日去公司，周末在咖啡店、书店与校园之间晃，故事会在这些空隙里长出来。",
            "镇上的人不会把你当成救世主。他们记得你点的糖度、你晚归的脚步、你有没有敲门——你也得一点点学会，怎样在熟人与更近一点的距离之间站稳。",
        ],
        "caption": "沈予安：落脚小镇的普通职员。",
    },
    {
        "id": "family",
        "bg": "home.png",
        "period": "afternoon",
        "title": "一家人",
        "sprites": [
            {"character_id": "shuli", "outfit": "casual", "emotion": "happy"},
            {"character_id": "fengyin", "outfit": "casual", "emotion": "shy"},
        ],
        "lines": [
            "亲妹妹沈书璃同城念书，常回这间屋。晚饭、借书、唠叨日程——她比谁都懂你的底细，也比谁都在意你最近靠近了谁。称呼仍是哥哥与妹妹，情愫不说破；屋檐下的亲近，反而更要小心。",
            "义妹沈枫音同住。她要被当成平等的人，不是被照顾的小孩：先学会敲门，再谈借肩膀。抢浴室、盯作息、交换关于你的情报——两个妹妹把这座家撑成日常，也把边界摆在你面前。",
        ],
        "caption": "亲妹沈书璃、义妹沈枫音同住。",
    },
    {
        "id": "past",
        "bg": "rain.png",
        "period": "evening",
        "title": "未完的过往",
        "sprites": [
            {"character_id": "qiansha", "outfit": "work", "emotion": "neutral"},
            {"character_id": "aili", "outfit": "casual", "emotion": "neutral"},
            {"character_id": "xingnai", "outfit": "casual", "emotion": "shy"},
        ],
        "lines": [
            "前女友顾千纱与你分过手，圈子却小得总会再遇见。尴尬还在，旧照片偶尔弹出又被撤回——装作从没发生过，她最讨厌。前妻夏艾黎把手续办得冷静，如今仍住同一片区；偶遇时礼貌得像陌生人，只有你知道那份礼貌有多贵。",
            "青梅程星宁从小一起长大，不急着定关系，却总能在你想逃的时候拦一句。过往不会替你做选择，但会在你想重新开始时，轻轻拽一下袖口。",
        ],
        "caption": "前女友顾千纱、前妻夏艾黎、青梅程星宁。",
    },
    {
        "id": "town",
        "bg": "cafe.png",
        "period": "afternoon",
        "title": "镇上的人",
        "sprites": [
            {"character_id": "xiaoyou", "outfit": "casual", "emotion": "shy"},
            {"character_id": "wanyu", "outfit": "work", "emotion": "happy"},
            {"character_id": "linxi", "outfit": "work", "emotion": "neutral"},
            {"character_id": "jingliu", "outfit": "work", "emotion": "neutral"},
        ],
        "lines": [
            "隔壁住着插画师苏晚悠，门铃有时只为借盐；咖啡店里温晚雨会把热拿铁推到你记得的那一侧。公司里，实习同事陆凛汐的追问与上司江静流隔着玻璃的目光，都会在工位之间变成故事——还有便利店夜班、坡上书店、校园里尚未点名的人。",
            "她们不是清单。恋爱只发生在你愿意靠近之后：选地点、见面、聊聊，才是把名字变成关系的方式。",
        ],
        "caption": "邻居、咖啡店、工位旁……镇上还有很多人。",
    },
    {
        "id": "begin",
        "bg": "starry.png",
        "period": "night",
        "title": "启程",
        "sprites": [
            {"character_id": "xiaoyou", "outfit": "casual", "emotion": "happy"},
            {"character_id": "wanyu", "outfit": "casual", "emotion": "neutral"},
            {"character_id": "shuli", "outfit": "casual", "emotion": "happy"},
            {"character_id": "linxi", "outfit": "casual", "emotion": "shy"},
        ],
        "lines": [
            "今天可以从最近的人开始：回家看见妹妹，或是去隔壁与店里点个头。心力留给谁，世界就会朝哪边轻轻倾斜；敷衍地路过所有人，日历照样翻页，故事却停在原地。",
            "你已经知道怎么过日子，也知道自己是谁、家里有谁、过往还拽着哪几只袖口。故事从这一刻往前走——出门吧，沈予安，去见她。",
        ],
        "caption": "从最近的人开始。出门吧，沈予安。",
    },
]


def main() -> None:
    data = json.loads(PATH.read_text(encoding="utf-8"))
    opening = data.setdefault("opening", {})
    opening["bgm"] = opening.get("bgm") or "opening_prologue"
    opening["skip_label"] = opening.get("skip_label") or "跳过序章"
    opening["world_brief"] = WORLD_BRIEF
    opening["slides"] = SLIDES
    PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"opening slides={len(SLIDES)}")
    for s in SLIDES:
        n = sum(len(x) for x in (s.get("lines") or []))
        print(f"  {s['id']}: {n} chars")


if __name__ == "__main__":
    main()
