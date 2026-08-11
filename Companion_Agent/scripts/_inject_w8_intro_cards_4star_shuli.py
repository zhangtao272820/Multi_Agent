# -*- coding: utf-8 -*-
"""Inject W8a intro-card SSOT for shuli (5★ L0) + T1 4★ five."""
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
    "shuli": {
        "tier": "L0",
        "story_weight": 5,
        "tier_stars": "★★★★★",
        "tier_label": "戏份·核心女主",
        "name_zh": "沈书璃",
        "name_en": "Shen Shuli",
        "title_banner": "日程本里的名字",
        "tagline": "大学生 · 亲妹妹",
        "faction_tag": "家庭 · 同住",
        "theme_color": "#64748b",
        "intro": "亲妹妹沈书璃，同城念书。日程本夹着说不出口的事，当面只叫哥哥。父母走后，依赖长成暗涌——用晚饭、吃醋和故意展示把你拴住。伦理与嫉妒过了关，才可能偷偷恋爱；不宣称婚孕主包，只扛后果。",
        "story_bg": "沈书璃是亲妹妹，也是最难绕开的那个人。父母走后，依赖长成说不出口的东西：当面叫哥哥，私下用晚饭、日程和吃醋把你拴住。故意展示、撕日程本、把伦理摊开、还要瞒过隔壁枫音——每一步都可能露馅。真要在一起，是一起扛后果，不是甜宠闯关。周阿姨认得她晚归的字迹；你袖口若带着画室味道，她比谁都先闻见。",
        "with_pc": "对沈予安：亲妹妹，同住；公开称呼不变，只叫哥哥。你要是当众告白腔或自称女朋友，她炸；你肯提醒作息、护短时接住她嘴硬、把伦理摊开再走，才可能偷偷恋爱。路线「妹妹的日程本」——目标恋人（难攻略·关系向资源带 L0，无 bridal/maternity 主包）。",
        "genre": "家里的暗涌",
        "quote_vertical": "哥，你又把晚饭忘了吧。",
        "quote_horizontal": "当面只叫哥哥。心里那点事，不说破。",
        "calligraphy": "日程",
        "signature": "沈书璃",
        "footer_tagline": "妹妹的日程本 · 戏份★★★★★",
        "b_pose_hint": "半身正面；米色高领+深蓝长裙全身捧书；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "158 cm"},
            {"label": "年龄", "value": "19"},
            {"label": "职业", "value": "大学生"},
            {"label": "对男主", "value": "亲妹妹"},
            {"label": "MBTI", "value": "ISTJ · 物流师"},
            {"label": "路线", "value": "妹妹的日程本（5★）"},
            {"label": "出场", "value": "第 1 周"},
            {"label": "语气", "value": "日常·短"},
            {"label": "关系目标", "value": "恋人"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "大学生"},
            {"label": "对男主", "value": "亲妹妹 · 同住 · 当面叫哥哥"},
            {"label": "戏份", "value": "★★★★★ 核心女主"},
            {"label": "出场", "value": "第 1 周"},
            {"label": "声线", "value": "话短爱盯作息；吃醋说别太晚"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.75, "gentle": 0.55, "cheerful": 0.35, "clingy": 0.45, "mature": 0.3, "shy": 0.7}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "亲妹妹；同住，当面只叫哥哥。目标：恋人（难攻略）。无 bridal/maternity 主包。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 1 周即在家；linked · 戏份★★★★★ 核心女主（资源带 L0）。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：提醒吃饭睡觉、护短时接嘴硬、称呼只用哥哥。忌：自称女朋友、当众告白腔、故意撩哥哥。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：家/房间；日间校园与图书馆。日程本与晚饭是她的锚点。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "米色高领毛衣+深蓝长裙，圆框眼镜捧书站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见齐肩深色短发与裙摆"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "圆框眼镜与齐肩发，锁基图五官"},
            {"label": "上半身胸部", "hint": "高领到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "长裙裙摆与腿线"},
            {"label": "背面臀部", "hint": "背面臀线与裙褶，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule",
            "cast_intro": "intro_week 1",
            "body_catalog": "158 cm",
            "pc": "沈予安",
        },
    },
    "taotao": {
        "tier": "T1",
        "story_weight": 4,
        "tier_stars": "★★★★",
        "tier_label": "戏份·主力女主",
        "name_zh": "唐桃夭",
        "name_en": "Tang Taoyao",
        "title_banner": "练习室的素颜",
        "tagline": "偶像练习生 · 社团朋友",
        "faction_tag": "校园 · 舞台",
        "theme_color": "#fbbf24",
        "intro": "偶像练习生唐桃夭。镜头前元气足，镜头后膝盖上贴着冰袋。你要是只追舞台，她笑着送客；你记得她喘不上气的那几秒，她会把耳机分你一只。素颜被记住，比应援色要紧。",
        "story_bg": "唐桃夭镜头前元气足，镜头后膝盖上贴着冰袋。经纪人小梁的日程比她自己还清楚。加训一压，别人容易把她当成商品或易碎品——你要是只追舞台，她笑着送客；你记得她喘不上气的那几秒，她会把耳机分你一只。素颜被记住，比应援色要紧。",
        "with_pc": "对沈予安：舞台活动认识的社团搭子。台上要笑，台下喘。你要是粉丝腔或只聊通告，她亮着送客；你分清台上台下、问膝盖和作息，她才肯卸妆后的那一面。路线「练习室的素颜」——可走到恋人/可结婚。",
        "genre": "台前台后",
        "quote_vertical": "嘿嘿！偷偷练完这一遍，也要听你说心里话！",
        "quote_horizontal": "别只追应援色。先记得，我喘不上气的那几秒。",
        "calligraphy": "素颜",
        "signature": "唐桃夭",
        "footer_tagline": "练习室的素颜 · 戏份★★★★",
        "b_pose_hint": "半身正面；桃色练习生舞台装全身；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "157 cm"},
            {"label": "年龄", "value": "19"},
            {"label": "职业", "value": "偶像练习生"},
            {"label": "对男主", "value": "社团朋友"},
            {"label": "MBTI", "value": "ENFP · 竞选者"},
            {"label": "路线", "value": "练习室的素颜（4★）"},
            {"label": "出场", "value": "第 2 周"},
            {"label": "语气", "value": "日常·亮"},
            {"label": "关系目标", "value": "恋人/可结婚"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "偶像练习生"},
            {"label": "对男主", "value": "社团朋友 · 舞台活动搭子"},
            {"label": "戏份", "value": "★★★★ 主力女主"},
            {"label": "出场", "value": "第 2 周"},
            {"label": "声线", "value": "台上亮；私下喘与冰袋更真"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.1, "gentle": 0.55, "cheerful": 0.95, "clingy": 0.65, "mature": 0.25, "shy": 0.2}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "社团朋友；舞台活动认识。目标：恋人/可结婚。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 2 周进入地图锚点；romance · 戏份★★★★ 主力女主。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：分清台上台下、问膝盖和作息、别用粉丝腔。忌：只聊通告、逼她公开、把她当气氛组。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：校园；晚间街道/咖啡店。练习室与通告缝是她喘口气的地方。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "粉樱双丸子/双马尾，桃色点缀练习生舞台装站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见双马尾与舞台装后背线"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "亮粉瞳与粉樱发，锁基图五官"},
            {"label": "上半身胸部", "hint": "舞台装领到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "短裙与腿线、练习鞋"},
            {"label": "背面臀部", "hint": "背面臀线与裙褶，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule",
            "cast_intro": "intro_week 2",
            "body_catalog": "157 cm",
            "pc": "沈予安",
        },
    },
    "shizuku": {
        "tier": "T1",
        "story_weight": 4,
        "tier_stars": "★★★★",
        "tier_label": "戏份·主力女主",
        "name_zh": "白初雪",
        "name_en": "Bai Chuxue",
        "title_banner": "书脊后的声线",
        "tagline": "图书馆助理 · 网友",
        "faction_tag": "校园 · 图书馆",
        "theme_color": "#f9a8d4",
        "intro": "图书馆助理白初雪。线上聊了很久，线下才见过一两面。搬书很轻，怕大声，却记得你借过哪些。闭馆后的层架逼她出声——慢，可退不回去。借书记录里，她其实大胆得很。",
        "story_bg": "白初雪把沉默当成礼貌。逾期条上的小星像只有她懂的暗号。闭馆后的层架逼她出声——慢，可退不回去。图书馆不是躲人的地方，是她学着被听见的地方。常客老周换书时总能碰上她；借书记录里，她其实大胆得很。",
        "with_pc": "对沈予安：线上聊了很久的网友，线下才见过一两面。你要是当众起哄或逼她拍板，她缩；你轻声、留给她时间、从书聊起，她才肯把半截句子说完。路线「书脊后的声线」——可走到恋人/可结婚。",
        "genre": "图书馆的小声",
        "quote_vertical": "……你来了。这本诗集，想和你一起看。",
        "quote_horizontal": "别逼我立刻回答。先从这一页，慢慢看。",
        "calligraphy": "小声",
        "signature": "白初雪",
        "footer_tagline": "书脊后的声线 · 戏份★★★★",
        "b_pose_hint": "半身正面；浅紫针织开衫+白吊带短裙全身捧书；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "155 cm"},
            {"label": "年龄", "value": "20"},
            {"label": "职业", "value": "图书馆助理"},
            {"label": "对男主", "value": "网友"},
            {"label": "MBTI", "value": "INFJ · 提倡者"},
            {"label": "路线", "value": "书脊后的声线（4★）"},
            {"label": "出场", "value": "第 4 周"},
            {"label": "语气", "value": "日常·轻声"},
            {"label": "关系目标", "value": "恋人/可结婚"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "图书馆助理"},
            {"label": "对男主", "value": "网友 · 线下才见一两面"},
            {"label": "戏份", "value": "★★★★ 主力女主"},
            {"label": "出场", "value": "第 4 周"},
            {"label": "声线", "value": "音量小；句子常留半截"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.15, "gentle": 0.9, "cheerful": 0.6, "clingy": 0.55, "mature": 0.45, "shy": 0.4}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "网友；线上很久，线下才见。目标：恋人/可结婚。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 4 周进入地图锚点；romance · 戏份★★★★ 主力女主。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：轻声说话、留给她时间、从书聊起。忌：当众起哄、打断沉默、逼她拍板。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：图书馆；下午也可能在咖啡店。闭馆层架是她学着出声的地方。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "浅紫齐肩短波波，超大针织开衫配白吊带短裙，捧诗集站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见短波波与开衫后背"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "紫瞳与浅紫短发，锁基图五官，不戴眼镜"},
            {"label": "上半身胸部", "hint": "开衫/吊带到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "短裙裙摆与腿线"},
            {"label": "背面臀部", "hint": "背面臀线与裙褶，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule",
            "cast_intro": "intro_week 4",
            "body_catalog": "155 cm",
            "pc": "沈予安",
        },
    },
    "qiansha": {
        "tier": "T1",
        "story_weight": 4,
        "tier_stars": "★★★★",
        "tier_label": "戏份·主力女主",
        "name_zh": "顾千纱",
        "name_en": "Gu Qiansha",
        "title_banner": "未合并的分支",
        "tagline": "前端工程师 · 前女友",
        "faction_tag": "职场 · 代码",
        "theme_color": "#94a3b8",
        "intro": "前女友顾千纱，做前端。讨厌烂摊子与含糊；分手后圈子小，总会再撞上。旧事像没合上的 PR——她宁可说清楚，也不想拖泥带水。尴尬还在，线也没完全断。",
        "story_bg": "顾千纱讨厌烂摊子，前同事圈里跟花店那头有过交集。出事的夜里她会冷着脸回滚，感情也一样：说清楚，或关掉，不爱旁路提交。赵组见过她评审时的脾气。你们分过手，圈子小，总会再撞上——尴尬还在，线也没完全断。",
        "with_pc": "对沈予安：前女友；分过手，圈小会再撞上。你要是装乖或暧昧拖延，她关；你直接说事、少绕弯、尊重边界，才可能重新打开未合并的分支。路线「未合并的分支」——可走到恋人/可结婚。",
        "genre": "前任重逢",
        "quote_vertical": "哦，是你。这次的 bug，谁开的？",
        "quote_horizontal": "别装乖。旧事说清楚，或关掉——不旁路提交。",
        "calligraphy": "回滚",
        "signature": "顾千纱",
        "footer_tagline": "未合并的分支 · 戏份★★★★",
        "b_pose_hint": "半身正面；冷感休闲工装全身持笔记本；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "164 cm"},
            {"label": "年龄", "value": "23"},
            {"label": "职业", "value": "前端工程师"},
            {"label": "对男主", "value": "前女友"},
            {"label": "MBTI", "value": "INTJ · 建筑师"},
            {"label": "路线", "value": "未合并的分支（4★）"},
            {"label": "出场", "value": "第 3 周"},
            {"label": "语气", "value": "日常·硬"},
            {"label": "关系目标", "value": "恋人/可结婚"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "前端工程师"},
            {"label": "对男主", "value": "前女友 · 分手未完全断线"},
            {"label": "戏份", "value": "★★★★ 主力女主"},
            {"label": "出场", "value": "第 3 周"},
            {"label": "声线", "value": "嘴硬；讨厌含糊与旁路"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.8, "gentle": 0.12, "cheerful": 0.2, "clingy": 0.3, "mature": 0.75, "shy": 0.08}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "前女友；分过手，圈小会再撞。目标：恋人/可结婚。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 3 周进入地图锚点；romance · 戏份★★★★ 主力女主。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：直接说事、少绕弯、尊重边界。忌：装乖、翻旧账道德绑架、暧昧拖延。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：办公室；晚间街道/咖啡店。评审与回滚是她的节奏。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "冷感休闲工装+笔记本，利落站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见长发与工装剪裁"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "冷感五官与发色，锁基图"},
            {"label": "上半身胸部", "hint": "领口到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "长裤/裙与腿线"},
            {"label": "背面臀部", "hint": "背面臀线与衣褶，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule",
            "cast_intro": "intro_week 3",
            "body_catalog": "164 cm",
            "pc": "沈予安",
        },
    },
    "shiori": {
        "tier": "T1",
        "story_weight": 4,
        "tier_stars": "★★★★",
        "tier_label": "戏份·主力女主",
        "name_zh": "白诗织",
        "name_en": "Bai Shizhi",
        "title_banner": "空白页上的短句",
        "tagline": "书店店员 · 短文系网友",
        "faction_tag": "小镇 · 书店",
        "theme_color": "#22d3ee",
        "intro": "独立书店店员白诗织。把喜欢写进推荐语里；窗边那本不卖的，才是她真正想递的。只买畅销的人，她礼貌到底。冷门书架拉开时，她才肯把短句念出来。",
        "story_bg": "白诗织把喜欢写进推荐语里。窗边那本不卖的，才是她真正想递的。只买畅销的人，她礼貌到底。冷门书架拉开时，她才肯把短句念出来。老周每周来换书，假装不听，其实听得很清。",
        "with_pc": "对沈予安：短文系网友，先递书后说心。你要是吵着逼问或敷衍她荐的书，她收；你认真看她荐的书、跟窗边的节奏、轻声就好，她才肯把空白页留给你。路线「空白页上的短句」——可走到恋人/可结婚。",
        "genre": "荐书的人",
        "quote_vertical": "这本……也放在窗边。页还没写完，别太急。",
        "quote_horizontal": "别只买畅销。窗边那本不卖的，才是我想递的。",
        "calligraphy": "短句",
        "signature": "白诗织",
        "footer_tagline": "空白页上的短句 · 戏份★★★★",
        "b_pose_hint": "半身正面；书店店员装全身持书；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "166 cm"},
            {"label": "年龄", "value": "25"},
            {"label": "职业", "value": "独立书店店员"},
            {"label": "对男主", "value": "短文系网友"},
            {"label": "MBTI", "value": "INFJ · 提倡者"},
            {"label": "路线", "value": "空白页上的短句（4★）"},
            {"label": "出场", "value": "第 2 周"},
            {"label": "语气", "value": "日常·轻"},
            {"label": "关系目标", "value": "恋人/可结婚"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "独立书店店员"},
            {"label": "对男主", "value": "短文系网友 · 先递书后说心"},
            {"label": "戏份", "value": "★★★★ 主力女主"},
            {"label": "出场", "value": "第 2 周"},
            {"label": "声线", "value": "话不多；记得你看到哪一页"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.15, "gentle": 0.7, "cheerful": 0.65, "clingy": 0.45, "mature": 0.55, "shy": 0.25}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "短文系网友；先递书后说心。目标：恋人/可结婚。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 2 周进入地图锚点；romance · 戏份★★★★ 主力女主。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：认真看她荐的书、跟窗边节奏、轻声。忌：吵着逼问、敷衍荐书、把沉默当没事。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：书店；下午图书馆；晚间公园/街道。窗边不卖的那本是她的暗号。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "书店店员装，窗边持书优雅站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见长发与店员围裙/裙摆"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "锁基图五官与发色"},
            {"label": "上半身胸部", "hint": "领口到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "裙摆与腿线"},
            {"label": "背面臀部", "hint": "背面臀线与衣褶，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule",
            "cast_intro": "intro_week 2",
            "body_catalog": "166 cm",
            "pc": "沈予安",
        },
    },
    "miara": {
        "tier": "T1",
        "story_weight": 4,
        "tier_stars": "★★★★",
        "tier_label": "戏份·主力女主",
        "name_zh": "莫岚纱",
        "name_en": "Mo Lansha",
        "title_banner": "假发下的私约",
        "tagline": "谷子店员 · 漫展偶遇熟人",
        "faction_tag": "小镇 · 谷子店",
        "theme_color": "#22d3ee",
        "intro": "二次元谷子店员莫岚纱。戴上精灵耳就敢得很；卸妆后的胶水味里，藏着怕被当成戏服的人。她要你既尊重台上的人设，也接得住会哭、会累的那个。假发摘下来，才是谈判开始。",
        "story_bg": "莫岚纱戴上精灵耳就敢得很。卸妆后的胶水味里，藏着怕被当成戏服的人。她要你既尊重台上的人设，也接得住会哭、会累的那个。谷子店和漫展是她最熟的地方；假发摘下来，才是谈判开始。",
        "with_pc": "对沈予安：漫展/谷子店偶遇熟人。cos 时敢，卸妆后怕你只爱戏服。你要是只聊人设或当众揭假发，她收；你分清角色和本人、夸她手上的活、卸妆后不起哄，她才肯把私约说出口。路线「假发下的私约」——可走到恋人/可结婚。",
        "genre": "卸妆以后",
        "quote_vertical": "嘿，谷子到了。上次漫展那套……还在回味吗？",
        "quote_horizontal": "别只爱戏服。假发摘下来，才是谈判开始。",
        "calligraphy": "卸妆",
        "signature": "莫岚纱",
        "footer_tagline": "假发下的私约 · 戏份★★★★",
        "b_pose_hint": "半身正面；谷子店员/轻 cos 装全身；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "164 cm"},
            {"label": "年龄", "value": "23"},
            {"label": "职业", "value": "二次元谷子店员"},
            {"label": "对男主", "value": "漫展偶遇熟人"},
            {"label": "MBTI", "value": "ENFP · 竞选者"},
            {"label": "路线", "value": "假发下的私约（4★）"},
            {"label": "出场", "value": "第 5 周"},
            {"label": "语气", "value": "日常·敢"},
            {"label": "关系目标", "value": "恋人/可结婚"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "二次元谷子店员"},
            {"label": "对男主", "value": "漫展偶遇熟人 · cos 后怕只爱戏服"},
            {"label": "戏份", "value": "★★★★ 主力女主"},
            {"label": "出场", "value": "第 5 周"},
            {"label": "声线", "value": "cos 敢；卸妆后怕被当工具人"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.15, "gentle": 0.7, "cheerful": 0.65, "clingy": 0.45, "mature": 0.55, "shy": 0.25}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "漫展偶遇熟人；愿你看见卸妆后的人。目标：恋人/可结婚。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 5 周进入地图锚点；romance · 戏份★★★★ 主力女主。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：分清角色和本人、夸手上的活、卸妆后不起哄。忌：只聊人设、当二次元工具人、当众揭假发。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：谷子店；晚间街道。漫展与卸妆台是她的两条线。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "谷子店员装或轻 cos（可带精灵耳），自然站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见假发/发尾与裙摆"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "锁基图五官；可示意卸妆前后对比之一帧"},
            {"label": "上半身胸部", "hint": "领口到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "裙摆与腿线"},
            {"label": "背面臀部", "hint": "背面臀线与衣褶，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule",
            "cast_intro": "intro_week 5",
            "body_catalog": "164 cm",
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
    preferred = [
        "xiaoyou",
        "wanyu",
        "ruolin",
        "jingliu",
        "aili",
        "linxi",
        "shuli",
        "taotao",
        "shizuku",
        "qiansha",
        "shiori",
        "miara",
    ]
    ordered: dict = {}
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
