# -*- coding: utf-8 -*-
"""Inject W8a intro-card SSOT for five 5★ heroines; write prompts sidecar."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CARDS_PATH = ROOT / "data" / "character_intro_cards.json"


def grade_bar(v: float) -> tuple[str, int]:
    bar = int(round(v * 100))
    if v >= 0.85:
        return "A+", bar
    if v >= 0.7:
        return "A", bar
    if v >= 0.55:
        return "A", bar
    if v >= 0.4:
        return "B+", bar
    if v >= 0.25:
        return "B", bar
    return "C", bar


def stats_from_traits(traits: dict) -> list[dict]:
    order = [
        ("gentle", "温柔"),
        ("cheerful", "开朗"),
        ("clingy", "粘人"),
        ("mature", "成熟"),
        ("shy", "害羞"),
        ("tsundere", "傲娇"),
    ]
    out = []
    for key, label in order:
        g, b = grade_bar(float(traits.get(key, 0)))
        out.append({"key": label, "grade": g, "bar": b})
    return out


CARDS = {
    "wanyu": {
        "tier": "T0",
        "story_weight": 5,
        "tier_stars": "★★★★★",
        "tier_label": "戏份·核心女主",
        "name_zh": "温晚雨",
        "name_en": "Wen Wanyu",
        "title_banner": "关店后的温度",
        "tagline": "咖啡店员 · 咖啡店熟人",
        "faction_tag": "小镇 · 咖啡店",
        "theme_color": "#f9a8d4",
        "intro": "咖啡店员温晚雨。店里笑得很稳，像制服的一部分；灯一关，累才露出来。死党何雨汐护短，顶班时谁靠近都得过一遍眼。你从熟客坐到能帮她收钥匙，得先接住她不愿示弱的那些时刻。",
        "story_bg": "温晚雨在店里笑得很稳，像制服的一部分。灯一关，累才露出来。死党何雨汐爱护短，顶班时谁靠近她都得过一遍眼。老板娘陈婶排班排得死。你从熟客坐到能帮她收钥匙，得先接住她那些不愿示弱的时刻——冬夜蒸汽、中秋多做的一杯，都算温度。真翻脸那天，看她还肯不肯给你留灯。",
        "with_pc": "对沈予安：同一家咖啡店的熟人，彼此记得对方喝什么。你要是只在营业里客套，她笑着送客；你肯记她喝什么、帮收尾、别逼她示弱，她才慢慢把钥匙交得出去。路线「关店之后的温度」——可走到恋人/可结婚。",
        "genre": "打烊后的温柔",
        "quote_vertical": "外面在下雨……要不要在店里坐一会儿？",
        "quote_horizontal": "别只在柜台前客套。灯关了，才算认识。",
        "calligraphy": "温度",
        "signature": "温晚雨",
        "footer_tagline": "关店之后的温度 · 戏份★★★★★",
        "b_pose_hint": "半身正面；咖啡店制服全身；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "162 cm"},
            {"label": "年龄", "value": "21"},
            {"label": "职业", "value": "咖啡店员"},
            {"label": "对男主", "value": "咖啡店熟人"},
            {"label": "MBTI", "value": "ISFJ · 守卫者"},
            {"label": "路线", "value": "关店之后的温度（5★）"},
            {"label": "出场", "value": "第 1 周"},
            {"label": "语气", "value": "日常·稳"},
            {"label": "关系目标", "value": "恋人/可结婚"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "咖啡店员"},
            {"label": "对男主", "value": "咖啡店熟人 · 记得对方喝什么"},
            {"label": "戏份", "value": "★★★★★ 核心女主"},
            {"label": "出场", "value": "第 1 周"},
            {"label": "声线", "value": "店里稳，打烊后才漏疲惫"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.15, "gentle": 0.9, "cheerful": 0.6, "clingy": 0.55, "mature": 0.45, "shy": 0.4}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "咖啡店熟人；同店打照面，彼此记得喝什么。目标：恋人/可结婚。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 1 周进入地图锚点；romance · 戏份★★★★★ 核心女主。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：记她喝什么、帮收尾、别逼示弱。忌：营业腔套近乎、把关心说成鸡汤、当众拆穿她累。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：咖啡店；晚间也可能上街。喜欢咖啡、安静（雨天）、被记得小事；讨厌在店里丢人。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "米色风衣+软裙，柜台前站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见灰棕齐肩发与裙摆"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "浅紫瞳与灰棕齐肩发，锁基图五官"},
            {"label": "上半身胸部", "hint": "风衣领口到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "软裙裙摆与腿线"},
            {"label": "背面臀部", "hint": "背面臀线与风衣褶皱，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule + likes",
            "cast_intro": "intro_week 1",
            "body_catalog": "162 cm",
            "pc": "沈予安",
        },
    },
    "ruolin": {
        "tier": "T0",
        "story_weight": 5,
        "tier_stars": "★★★★★",
        "tier_label": "戏份·核心女主",
        "name_zh": "顾若铃",
        "name_en": "Gu Ruolin",
        "title_banner": "讲台下的一年",
        "tagline": "大学讲师 · 选修课讲师",
        "faction_tag": "校园 · 讲台",
        "theme_color": "#a78bfa",
        "intro": "大学讲师顾若铃。讲义和边界一样齐；年轻时栽过暧昧跟头，所以对「老师」二字过敏。助教陈铃可拿红笔挡人——真要走近，先过她，也过若铃自己那关。讲台下想对等，不是玩反差，是你能不能守住她定的规矩。",
        "story_bg": "顾若铃的讲义和她的边界一样齐。年轻时栽过一次暧昧的跟头，所以对「老师」两个字过敏。助教陈铃可拿红笔挡人——真要走近，先过她，也过顾若铃自己那关。讲台下想对等，不是玩反差，是你能不能守住她定的规矩。闲话传得快，图书馆里安静的人也听得到。",
        "with_pc": "对沈予安：选修/讲座认识的老师，客气，偶尔试探边界。你要是当学生撒娇或逼她表态，她先冷；你守分寸、把话说完整、别越线，她才肯卸一点导师腔。路线「讲台下的一年」——可走到恋人/可结婚。",
        "genre": "讲台下的分寸",
        "quote_vertical": "今天的课刚结束……要不要一起走走，慢慢说？",
        "quote_horizontal": "别用学生腔越线。把话说完整，边界才松。",
        "calligraphy": "分寸",
        "signature": "顾若铃",
        "footer_tagline": "讲台下的一年 · 戏份★★★★★",
        "b_pose_hint": "半身正面；学院西装全身；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "167 cm"},
            {"label": "年龄", "value": "28"},
            {"label": "职业", "value": "大学讲师"},
            {"label": "对男主", "value": "选修课讲师"},
            {"label": "MBTI", "value": "INFJ · 提倡者"},
            {"label": "路线", "value": "讲台下的一年（5★）"},
            {"label": "出场", "value": "第 2 周"},
            {"label": "语气", "value": "正式·留白"},
            {"label": "关系目标", "value": "恋人/可结婚"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "大学讲师"},
            {"label": "对男主", "value": "选修课讲师 · 讲台下试探边界"},
            {"label": "戏份", "value": "★★★★★ 核心女主"},
            {"label": "出场", "value": "第 2 周"},
            {"label": "声线", "value": "客气留白；越线先冷，对等才软"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.2, "gentle": 0.75, "cheerful": 0.35, "clingy": 0.3, "mature": 0.9, "shy": 0.15}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "选修课讲师；讲座认识，客气偶试边界。目标：恋人/可结婚。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 2 周进入地图锚点；romance · 戏份★★★★★ 核心女主。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：守分寸、把话说完整、不逼表态。忌：学生式越线、老师幻想调情、逼她当众表态。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：校园/图书馆/办公室；晚间也可能上街或咖啡店。喜欢安静阅读与茶；讨厌被拍进闲话。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "学院西装+丝质衬衫，持讲义站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见盘发与西装剪裁"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "深栗盘发与暖榛瞳，锁基图五官"},
            {"label": "上半身胸部", "hint": "西装领到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "裙摆与腿线、丝袜"},
            {"label": "背面臀部", "hint": "背面臀线与裙褶，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule + likes",
            "cast_intro": "intro_week 2",
            "body_catalog": "167 cm",
            "pc": "沈予安",
        },
    },
    "jingliu": {
        "tier": "T0",
        "story_weight": 5,
        "tier_stars": "★★★★★",
        "tier_label": "戏份·核心女主",
        "name_zh": "江静流",
        "name_en": "Jiang Jingliu",
        "title_banner": "权力差的另一侧",
        "tagline": "品牌顾问 · 上司",
        "faction_tag": "职场 · 品牌",
        "theme_color": "#a78bfa",
        "intro": "品牌顾问江静流。职场冷面、护短，粤语口头禅偶尔漏音。堂妹江静宁跟在活动边上记观察。家族局和你之间会裂开一条缝——要看真相，就得一起扛闲话，别只想捡护短之后的软。",
        "story_bg": "江静流走路带风，粤语口头禅偶尔漏出来。堂妹江静宁跟在活动边上记观察，有时比她自己还诚实。品牌顾问那张脸在家族局和你之间会裂开一条缝——你要看真相，就得一起扛闲话，别只想捡她护短之后的软。天台上她才肯摘一点硬壳；走廊里赵组假装看手机，其实什么都看见了。",
        "with_pc": "对沈予安：公司里常见的前辈型上司。公事硬，私下话少；信得过的人才听得到软的那一面。你要是在同事前示弱或只想捡软，她硬；你肯扛事、把公私分清、天台再谈，她才肯卸一点。路线「权力差的另一侧」——可走到恋人/可结婚。",
        "genre": "职场外的软肋",
        "quote_vertical": "哎呀，你嚟啦。今日点啊，慢慢同我讲。",
        "quote_horizontal": "别只想捡护短之后的软。天台上，才谈真相。",
        "calligraphy": "硬壳",
        "signature": "江静流",
        "footer_tagline": "权力差的另一侧 · 戏份★★★★★",
        "b_pose_hint": "半身正面；黑金旗袍全身；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "170 cm"},
            {"label": "年龄", "value": "27"},
            {"label": "职业", "value": "品牌顾问"},
            {"label": "对男主", "value": "上司"},
            {"label": "MBTI", "value": "ESTJ · 总经理"},
            {"label": "路线", "value": "权力差的另一侧（5★）"},
            {"label": "出场", "value": "第 3 周"},
            {"label": "语气", "value": "正式·偶漏粤语"},
            {"label": "关系目标", "value": "恋人/可结婚"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "品牌顾问"},
            {"label": "对男主", "value": "上司 · 公事硬私下话少"},
            {"label": "戏份", "value": "★★★★★ 核心女主"},
            {"label": "出场", "value": "第 3 周"},
            {"label": "声线", "value": "职场硬壳；天台才肯软一点"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.2, "gentle": 0.75, "cheerful": 0.35, "clingy": 0.3, "mature": 0.9, "shy": 0.15}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "上司；职场前辈型，公事硬私下话少。目标：恋人/可结婚。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 3 周进入地图锚点；romance · 戏份★★★★★ 核心女主。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：公私分清、扛事、天台再谈。忌：同事前示弱、只想捡软、把护短当理所当然。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：办公室；晚间也可能上街/咖啡店。喜欢成事与夜风；讨厌八卦与当众丢人。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "黑金港风旗袍正面站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见长发与旗袍后背线"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "深棕大波浪与暖棕瞳，锁基图五官"},
            {"label": "上半身胸部", "hint": "旗袍领到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "开衩腿线与高跟鞋"},
            {"label": "背面臀部", "hint": "背面臀线与旗袍褶皱，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule + likes",
            "cast_intro": "intro_week 3",
            "body_catalog": "170 cm",
            "pc": "沈予安",
        },
    },
    "aili": {
        "tier": "T0",
        "story_weight": 5,
        "tier_stars": "★★★★★",
        "tier_label": "戏份·核心女主",
        "name_zh": "夏艾黎",
        "name_en": "Xia Aili",
        "title_banner": "枯枝上的新花束",
        "tagline": "花艺师 · 前居",
        "faction_tag": "小镇 · 花店",
        "theme_color": "#a78bfa",
        "intro": "花艺师夏艾黎。离婚后靠花店过活；闺蜜程艾辰负责盘问每一个靠近的人。夸花她听腻了；你肯一起收拾枯枝、对账单，她才记你一笔。她怕再选一次又变成笑话——闲话来时你能不能站住。",
        "story_bg": "夏艾黎离婚后靠花店过活。闺蜜程艾辰负责盘问每一个靠近的人。温室暖和，也闷。夸花她听腻了；你肯一起收拾枯枝、对账单，她才记你一笔。她怕再选一次又变成笑话——闲话来时你能不能站住，她的停顿你能不能等。花市老金账算得紧，熟客才留得到好枝。",
        "with_pc": "对沈予安：离过婚的前居，平静地开着花店；你们还住同一片镇，偶尔碰面。你要是只夸花或追问旧婚，她收；你肯务实帮忙、给她停顿，她才肯再选一次。路线「枯枝上的新花束」——可走到恋人/可结婚。",
        "genre": "花店的余温",
        "quote_vertical": "这些花……是今天新到的。要看看吗？",
        "quote_horizontal": "别只夸好看。先一起把枯枝收干净。",
        "calligraphy": "新枝",
        "signature": "夏艾黎",
        "footer_tagline": "枯枝上的新花束 · 戏份★★★★★",
        "b_pose_hint": "半身正面；花艺裙装全身持花；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "165 cm"},
            {"label": "年龄", "value": "24"},
            {"label": "职业", "value": "花艺师"},
            {"label": "对男主", "value": "前居"},
            {"label": "MBTI", "value": "INFJ · 提倡者"},
            {"label": "路线", "value": "枯枝上的新花束（5★）"},
            {"label": "出场", "value": "第 5 周"},
            {"label": "语气", "value": "正式·慢"},
            {"label": "关系目标", "value": "恋人/可结婚"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "花艺师"},
            {"label": "对男主", "value": "前居 · 同镇偶遇"},
            {"label": "戏份", "value": "★★★★★ 核心女主"},
            {"label": "出场", "value": "第 5 周"},
            {"label": "声线", "value": "夸花听腻；务实才算数"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.2, "gentle": 0.75, "cheerful": 0.35, "clingy": 0.3, "mature": 0.9, "shy": 0.15}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "前居；离过婚，同镇偶遇。目标：恋人/可结婚。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 5 周进入地图锚点；romance · 戏份★★★★★ 核心女主。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：务实帮忙、给她停顿、别追问旧婚。忌：廉价安慰、逼她再选一次、绕过闺蜜审问。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：家/花店语境的咖啡店锚点；喜欢整理花材与阳台。讨厌被当失败品谈资。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "白蕾丝上衣+奶油花裙，持花束站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见金发波浪与裙摆刺绣"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "金发与绿瞳，锁基图五官"},
            {"label": "上半身胸部", "hint": "蕾丝领到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "花裙裙摆与腿线"},
            {"label": "背面臀部", "hint": "背面臀线与裙褶，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule + likes",
            "cast_intro": "intro_week 5",
            "body_catalog": "165 cm",
            "pc": "沈予安",
        },
    },
    "linxi": {
        "tier": "T0",
        "story_weight": 5,
        "tier_stars": "★★★★★",
        "tier_label": "戏份·核心女主",
        "name_zh": "陆凛汐",
        "name_en": "Lu Linxi",
        "title_banner": "工位之外的一步",
        "tagline": "实习生 · 实习同事",
        "faction_tag": "职场 · 实习",
        "theme_color": "#fb7185",
        "intro": "实习生陆凛汐。红丝带是妈妈留下的习惯；打印室是她喘口气的地方。通宵改稿时，「临时工」三个字最刺人。她不要人拯救，要人一起担。通勤的冷、工位的塌，都会把你推到选择前：站在她上面说话，还是把工牌翻过来站旁边。",
        "story_bg": "陆凛汐拿实习工资在这座镇站住，红丝带是妈妈留下的习惯。打印室是她喘口气的地方。通宵改稿时，「临时工」三个字最刺人。她不要人拯救，要人一起担。通勤的冷、工位的塌，都会把你推到选择前：你是站在她上面说话，还是把工牌翻过来站旁边。组里赵组催事不催情，却记得谁赶末班车。",
        "with_pc": "对沈予安：工位旁的实习同事，远看清冷，私下偶尔硬。你要是前辈施舍或空口安慰，她刺；你谈工作边界、一起止损、记得末班车那些小事，她才接得住倔强。路线「工位之外的一步」——可走到恋人/可结婚。",
        "genre": "工位上的倔强",
        "quote_vertical": "……忙完这一段。你的事先放着。",
        "quote_horizontal": "别用前辈腔施舍。把工牌翻过来，站旁边。",
        "calligraphy": "并肩",
        "signature": "陆凛汐",
        "footer_tagline": "工位之外的一步 · 戏份★★★★★",
        "b_pose_hint": "半身正面；白衬衫黑裙全身；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "161 cm"},
            {"label": "年龄", "value": "22"},
            {"label": "职业", "value": "实习生"},
            {"label": "对男主", "value": "实习同事"},
            {"label": "MBTI", "value": "ISTJ · 物流师"},
            {"label": "路线", "value": "工位之外的一步（5★）"},
            {"label": "出场", "value": "第 1 周"},
            {"label": "语气", "value": "日常·硬"},
            {"label": "关系目标", "value": "恋人/可结婚"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "实习生"},
            {"label": "对男主", "value": "实习同事 · 工位旁清冷"},
            {"label": "戏份", "value": "★★★★★ 核心女主"},
            {"label": "出场", "value": "第 1 周"},
            {"label": "声线", "value": "公事硬；私下话少，刺人但不乱跑"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.85, "gentle": 0.45, "cheerful": 0.55, "clingy": 0.4, "mature": 0.2, "shy": 0.5}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "实习同事；工位旁清冷，私下偶尔硬。目标：恋人/可结婚。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 1 周进入地图锚点；romance · 戏份★★★★★ 核心女主。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：谈工作边界、一起止损、记末班车小事。忌：前辈施舍腔、空口安慰、当众揭她临时工。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：办公室/图书馆/校园；晚间也可能上街或咖啡店。喜欢准时与说清楚的事；讨厌含糊汇报。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "白衬衫黑裙+红丝带工牌，持文件夹站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见红丝带与直黑长发"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "黑发红瞳与红丝带，锁基图五官"},
            {"label": "上半身胸部", "hint": "衬衫领到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "铅笔裙与丝袜腿线"},
            {"label": "背面臀部", "hint": "背面臀线与裙褶，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule + likes",
            "cast_intro": "intro_week 1",
            "body_catalog": "161 cm",
            "pc": "沈予安",
        },
    },
}


def main() -> None:
    data = json.loads(CARDS_PATH.read_text(encoding="utf-8"))
    cards = data.setdefault("cards", {})
    for cid, card in CARDS.items():
        cards[cid] = card
        print(f"upsert {cid}")
    # keep xiaoyou first-ish: rewrite ordered
    preferred = ["xiaoyou", "wanyu", "ruolin", "jingliu", "aili", "linxi", "shuli"]
    ordered = {}
    for k in preferred:
        if k in cards:
            ordered[k] = cards[k]
    for k, v in cards.items():
        if k not in ordered:
            ordered[k] = v
    data["cards"] = ordered
    data["version"] = max(int(data.get("version") or 3), 3)
    CARDS_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("wrote", CARDS_PATH, "cards", len(ordered))


if __name__ == "__main__":
    main()
