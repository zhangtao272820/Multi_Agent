# -*- coding: utf-8 -*-
"""Write opening.slides: 男主第一人称小说体——家庭与亲近之人的小镇背景。"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "data" / "presentation_catalog.json"

WORLD_BRIEF = [
    "我叫沈予安。父母早年离异又各自重组，亲妹妹沈书璃同城念书，义妹沈枫音与我们同住。",
    "为工作落脚这座小镇：公司、校园、咖啡店与家，构成我如今的全部半径。",
    "顾千纱、夏艾黎、程星宁……还有隔壁的苏晚悠——亲近或曾亲近的人，都在这镇里。",
]

SLIDES = [
    {
        "id": "town",
        "bg": "campus.png",
        "period": "morning",
        "title": "这座镇",
        "lines": [
            "我叫沈予安。半年前调来这座不算大的镇——梧桐夹道，校门对着商业街，再往里走是出租公寓和一小片老住宅。没有什么戏剧性的逃亡，只是总部把项目挪到这边，合同签了，房子也就定了。晨光里校门口的石狮子还沾着露水，我提着不多的行李下车时想：就在这里把日子重新排开吧。",
            "镇上的节奏慢。工作日去公司，周末常在咖啡店、书店和校园外的小路晃。路灯一盏盏亮起来的时候，归途短得像一句话。我渐渐明白，这座镇会记住你点的糖、晚归的脚步，以及你有没有敲门——它不大，却容得下许多说不清的关系。",
        ],
        "caption": "沈予安落脚的小镇。",
    },
    {
        "id": "family_root",
        "bg": "home.png",
        "period": "afternoon",
        "title": "沈家的事",
        "sprites": [
            {"character_id": "shuli", "outfit": "casual", "emotion": "neutral"},
            {"character_id": "fengyin", "outfit": "casual", "emotion": "shy"},
        ],
        "lines": [
            "说到家，就绕不开沈家那本旧账。父母早年离了，后来各自成了家。亲妹妹沈书璃跟我同父同母，从小黏着我；义妹沈枫音是父亲再婚带进门的——户口本上多了一个妹妹，饭桌上却要很多年，才慢慢变成「自己人」。两边大人忙于新生活，我们三个反而更像彼此的锚。",
            "书璃考上同城的大学后，我便把这间公寓定成「兄妹据点」：她住校也常回来抢浴室、盯我作息；枫音高中寄住在这里，说是省事，其实是她不肯回父母各自的新家。房租我出大半，晚饭轮流做。外人问起，我就说——我们是一家人，住在同一屋檐下。",
        ],
        "caption": "父母离异重组；书璃与枫音同住。",
    },
    {
        "id": "sisters",
        "bg": "home.png",
        "period": "evening",
        "title": "两个妹妹",
        "sprites": [
            {"character_id": "shuli", "outfit": "casual", "emotion": "happy"},
            {"character_id": "fengyin", "outfit": "casual", "emotion": "shy"},
        ],
        "lines": [
            "沈书璃最懂我的底细。哪本书我看了一半、哪顿饭我会敷衍、最近心里装了谁——她都能从筷子停顿里听出来。她叫我哥哥，我也只回她妹妹；有些情愫不说破，反而让这间屋子安静得像样。她讨厌我乱作息，更讨厌我把她当恋爱对象试探——亲近归亲近，称呼不能乱。",
            "沈枫音嘴上不饶人，睡前却总会敲两下我的房门，确认灯灭了没有。她要被当成平等的人，不是被照顾的小孩：先敲门，再进来说话。两个妹妹会抢浴室、交换关于我的情报，也会在我晚归时把灯留着。屋檐下的温暖很实在，界线也同样实在。",
        ],
        "caption": "亲妹沈书璃、义妹沈枫音。",
    },
    {
        "id": "past",
        "bg": "rain.png",
        "period": "evening",
        "title": "曾经很近的人",
        "sprites": [
            {"character_id": "qiansha", "outfit": "work", "emotion": "neutral"},
            {"character_id": "aili", "outfit": "casual", "emotion": "neutral"},
            {"character_id": "xingnai", "outfit": "casual", "emotion": "shy"},
        ],
        "lines": [
            "顾千纱是我的前女友。我们分过手，圈子却小得总会再遇见——公司附近的咖啡、共同朋友的局里。尴尬还挂在嘴边，手机里偶尔弹出又被撤回的旧照片。她最讨厌我装作从未发生过；我呢，也还没学会怎样把「曾经」安放得体面。",
            "夏艾黎是我的前妻。手续办得冷静干净，如今仍住同一片区。街上偶遇时礼貌得像陌生人，只有我知道那份礼貌有多贵。程星宁则是青梅，从小一起长大，从不急着把关系钉死，却总能在我想逃的时候拦一句。雨停了又下，袖口总有人轻轻拽着。",
        ],
        "caption": "前女友顾千纱、前妻夏艾黎、青梅程星宁。",
    },
    {
        "id": "neighbors",
        "bg": "cafe.png",
        "period": "afternoon",
        "title": "抬头不见低头见",
        "sprites": [
            {"character_id": "xiaoyou", "outfit": "casual", "emotion": "shy"},
            {"character_id": "wanyu", "outfit": "work", "emotion": "happy"},
            {"character_id": "linxi", "outfit": "work", "emotion": "neutral"},
        ],
        "lines": [
            "隔壁住着插画师苏晚悠。门铃响过几次，多半为了借盐或还快递——熟到会点头，却还不算无话不说的交情。咖啡店里，温晚雨记得我惯点的那杯；我去坐的时候，她会把杯子推到我这一侧。公司里，实习的陆凛汐爱追问，上司江静流的目光隔着玻璃，冷静得让人不敢怠慢。",
            "这些人不是远方的传说，是我每天可能撞见的脸。镇上还有便利店的夜班灯、坡上的书店、校园外尚未开口的人——可眼下，真正撑起我生活半径的，仍是家里的两个妹妹，以及那些曾走近又未走远的旧识。",
        ],
        "caption": "邻居苏晚悠、店里温晚雨、工位旁的人。",
    },
    {
        "id": "begin",
        "bg": "starry.png",
        "period": "night",
        "title": "今夜之后",
        "sprites": [
            {"character_id": "shuli", "outfit": "casual", "emotion": "happy"},
            {"character_id": "fengyin", "outfit": "casual", "emotion": "shy"},
            {"character_id": "xiaoyou", "outfit": "casual", "emotion": "neutral"},
        ],
        "lines": [
            "灯灭之前，书璃在客厅翻书，枫音把水杯放回厨房。窗外是这座镇惯有的安静：远处校门口偶尔有车灯扫过，像有人在提醒我——日子还长，人还在。",
            "我把钥匙握在手里。明天仍要去公司，仍可能在巷口遇见旧识，仍会推开这扇写着「沈」的门。故事不必说得像样板，只要我还住在这里，呼吸着同一屋檐下的空气——那就从下一声门铃，或下一顿晚饭开始吧。",
        ],
        "caption": "钥匙在手。日子还在这座镇里。",
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
