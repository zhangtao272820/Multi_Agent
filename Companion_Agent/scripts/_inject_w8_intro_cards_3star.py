# -*- coding: utf-8 -*-
"""Inject W8a intro-card SSOT for five 3★ linked heroines."""
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
    "jingning": {
        "tier": "N",
        "story_weight": 3,
        "tier_stars": "★★★",
        "tier_label": "戏份·关系向",
        "name_zh": "江静宁",
        "name_en": "Jiang Jingning",
        "title_banner": "堂姐的观察日记",
        "tagline": "时尚系大学生 · 江静流堂妹",
        "faction_tag": "家族 · 活动边",
        "theme_color": "#c4b5fd",
        "intro": "江静流的堂妹江静宁。跟活动、记观察，私下比台上软，不敢抢堂姐的光。她用看代替问；日记里比当面诚实。你靠不靠谱，她写得一清二楚——想卸下旁观，得先过堂姐那一关。",
        "story_bg": "江静宁是江静流堂妹，跟活动、记观察。私下比台上软，不敢抢堂姐的光。她用看代替问；日记里比当面诚实。家族或活动场合经静流出现；观察日记放过你、堂姐默许，她才卸下旁观。你靠不靠谱，她写得一清二楚。",
        "with_pc": "对沈予安：旁观堂姐职场与恋爱的堂妹；吐槽、守门，心动须过双门。你要是拿她套话伤静流、当透明人或逼她表态，她收；你轻声问、尊重旁观、别推她上台，她才肯把日记里的诚实给你看。路线「堂姐的观察日记」——关系向·难攻略，目标恋人。",
        "genre": "旁观的堂妹",
        "quote_vertical": "堂姐今天又加班？你……对她好一点。",
        "quote_horizontal": "别逼我上台。日记里，我比当面诚实。",
        "calligraphy": "旁观",
        "signature": "江静宁",
        "footer_tagline": "堂姐的观察日记 · 戏份★★★",
        "b_pose_hint": "半身正面；学院风外套全身；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "166 cm"},
            {"label": "年龄", "value": "20"},
            {"label": "职业", "value": "时尚系大学生"},
            {"label": "对男主", "value": "江静流堂妹"},
            {"label": "MBTI", "value": "ENFJ · 主人公"},
            {"label": "路线", "value": "堂姐的观察日记（3★）"},
            {"label": "出场", "value": "第 3 周"},
            {"label": "语气", "value": "日常·轻声"},
            {"label": "关系目标", "value": "恋人"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "时尚系大学生"},
            {"label": "对男主", "value": "江静流堂妹 · 旁观守门"},
            {"label": "戏份", "value": "★★★ 关系向"},
            {"label": "出场", "value": "第 3 周"},
            {"label": "声线", "value": "跟拍记事；私下才软，不抢光"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.35, "gentle": 0.55, "cheerful": 0.45, "clingy": 0.25, "mature": 0.5, "shy": 0.35}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "江静流堂妹；旁观守门，心动须过双门。目标：恋人。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 3 周；linked · 戏份★★★ 关系向；锚点江静流。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：轻声问、尊重旁观、别推她上台。忌：拿她套话伤静流、当透明人、逼她表态。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：校园/街；晚间咖啡店。喜欢跟拍活动、干净搭配；讨厌把堂姐当工具人、放鸽子。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "学院风外套+小金花耳饰，活动边站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见深棕长发与外套剪裁"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "深棕长发与小金花耳饰，锁基图五官"},
            {"label": "上半身胸部", "hint": "学院外套领到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "裙/裤腿线与鞋"},
            {"label": "背面臀部", "hint": "背面臀线与外套褶皱，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule + likes",
            "cast_intro": "intro_week 3",
            "body_catalog": "166 cm",
            "pc": "沈予安",
        },
    },
    "youwei": {
        "tier": "N",
        "story_weight": 3,
        "tier_stars": "★★★",
        "tier_label": "戏份·关系向",
        "name_zh": "温悠微",
        "name_en": "Wen Youwei",
        "title_banner": "画室里的第三支笔",
        "tagline": "插画系学生 · 苏晚悠工作室学妹",
        "faction_tag": "小镇 · 画室",
        "theme_color": "#f9a8d4",
        "intro": "苏晚悠工作室学妹温悠微。改图改到熟，卫衣沾颜料点。把你当固定模特也行，真动心会先看学姐脸色。她能帮晚悠，也能在座位上跟你较劲——想要第三支笔，先问清座位与分寸。",
        "story_bg": "温悠微是苏晚悠工作室的学妹，改图改到熟。把你当固定模特也行，真动心会先看学姐脸色。她能帮晚悠，也能在座位上跟你较劲。对门通宵的灯，她比谁都熟。多半在画室经苏晚悠认识；要她把笔交给你，得先有创作上的同盟，也得学姐不拦。",
        "with_pc": "对沈予安：插画学妹，把你当模特邻居；心动先过学姐那一关。你要是逼她站队、绕过学姐或空谈灵感，她收；你聊座位和稿子、问清分寸、看她改图，她才肯把笔往你这边推一点。路线「画室里的第三支笔」——关系向·难攻略，目标恋人。",
        "genre": "画室学妹",
        "quote_vertical": "学姐说你适合当模特——我可以画两笔吗？",
        "quote_horizontal": "别绕过学姐。座位和稿子，先说清楚。",
        "calligraphy": "改图",
        "signature": "温悠微",
        "footer_tagline": "画室里的第三支笔 · 戏份★★★",
        "b_pose_hint": "半身正面；卫衣画板全身；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "157 cm"},
            {"label": "年龄", "value": "19"},
            {"label": "职业", "value": "插画系学生"},
            {"label": "对男主", "value": "苏晚悠工作室学妹"},
            {"label": "MBTI", "value": "ISFP · 探险家"},
            {"label": "路线", "value": "画室里的第三支笔（3★）"},
            {"label": "出场", "value": "第 4 周"},
            {"label": "语气", "value": "日常·话多"},
            {"label": "关系目标", "value": "恋人"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "插画系学生"},
            {"label": "对男主", "value": "画室学妹 · 模特邻居"},
            {"label": "戏份", "value": "★★★ 关系向"},
            {"label": "出场", "value": "第 4 周"},
            {"label": "声线", "value": "一兴奋就话多；改图时专注"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.15, "gentle": 0.7, "cheerful": 0.65, "clingy": 0.4, "mature": 0.25, "shy": 0.45}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "苏晚悠工作室学妹；模特邻居，心动先过学姐。目标：恋人。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 4 周；linked · 戏份★★★ 关系向；锚点苏晚悠。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：聊座位和稿子、问清分寸、看她改图。忌：逼她站队、绕过学姐、空谈灵感。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：家/街/画室语境；喜欢改图反馈、安静光线。讨厌弄乱画材、敷衍点评。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "浅色短发卫衣夹画板，画室座位旁站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见短发与画板背带"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "浅色短发与亮眼神，锁基图五官"},
            {"label": "上半身胸部", "hint": "卫衣领到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "裤装/裙腿线"},
            {"label": "背面臀部", "hint": "背面臀线与卫衣褶皱，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule + likes",
            "cast_intro": "intro_week 4",
            "body_catalog": "157 cm",
            "pc": "沈予安",
        },
    },
    "yuxi": {
        "tier": "N",
        "story_weight": 3,
        "tier_stars": "★★★",
        "tier_label": "戏份·关系向",
        "name_zh": "何雨汐",
        "name_en": "He Yuxi",
        "title_banner": "顶班的死党",
        "tagline": "高中生兼职 · 温晚雨死党",
        "faction_tag": "小镇 · 咖啡店",
        "theme_color": "#7dd3fc",
        "intro": "温晚雨高中死党何雨汐。店里顶班、挡难客，马尾利落。谁靠近晚雨，她默认警惕。护短护到偏执，关心多半动手不动口——想并排坐下，先一起顶过班，也别油。",
        "story_bg": "何雨汐是温晚雨高中死党，店里顶班、挡难客。谁靠近晚雨，她默认警惕。护短护到偏执，关心多半动手不动口。陈婶默许她顶班，不等于默许你走太近。常在咖啡店经晚雨碰上；一起顶过班、晚雨不拦，她才肯并排坐下。",
        "with_pc": "对沈予安：店里顶班的死党，护温晚雨休息；本人开放后可并排。你要是抢晚雨的位置、油嘴滑舌或当她空气，她硬；你承认她护人、用行动证明、别油，她才肯把警惕收一点。路线「顶班的死党」——关系向·难攻略，目标恋人。",
        "genre": "死党护短",
        "quote_vertical": "温晚雨还在擦杯子呢。你帮我盯着她早点打烊。",
        "quote_horizontal": "别抢她的位置。顶过班，才谈并排。",
        "calligraphy": "护短",
        "signature": "何雨汐",
        "footer_tagline": "顶班的死党 · 戏份★★★",
        "b_pose_hint": "半身正面；店员围裙全身；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "162 cm"},
            {"label": "年龄", "value": "18"},
            {"label": "职业", "value": "高中生·咖啡店兼职"},
            {"label": "对男主", "value": "温晚雨死党"},
            {"label": "MBTI", "value": "ESFJ · 执政官"},
            {"label": "路线", "value": "顶班的死党（3★）"},
            {"label": "出场", "value": "第 2 周"},
            {"label": "语气", "value": "日常·干脆"},
            {"label": "关系目标", "value": "恋人"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "高中生·咖啡店兼职"},
            {"label": "对男主", "value": "温晚雨死党 · 店里护短"},
            {"label": "戏份", "value": "★★★ 关系向"},
            {"label": "出场", "value": "第 2 周"},
            {"label": "声线", "value": "话干脆；关心多半是行动"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.3, "gentle": 0.55, "cheerful": 0.7, "clingy": 0.3, "mature": 0.35, "shy": 0.2}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "温晚雨死党；店里护短，开放后可并排。目标：恋人。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 2 周；linked · 戏份★★★ 关系向；锚点温晚雨。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：承认她护人、用行动证明、别油。忌：抢晚雨位置、油嘴滑舌、当她空气。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：咖啡店/校园；喜欢准时打烊、队友靠谱、夜宵。讨厌难缠熟客、压榨晚雨。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "利落马尾+店员围裙，柜台旁站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见马尾与围裙系带"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "利落马尾与干脆笑，锁基图五官"},
            {"label": "上半身胸部", "hint": "围裙领到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "裤装腿线与鞋"},
            {"label": "背面臀部", "hint": "背面臀线与围裙褶皱，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule + likes",
            "cast_intro": "intro_week 2",
            "body_catalog": "162 cm",
            "pc": "沈予安",
        },
    },
    "lingke": {
        "tier": "N",
        "story_weight": 3,
        "tier_stars": "★★★",
        "tier_label": "戏份·关系向",
        "name_zh": "陈铃可",
        "name_en": "Chen Lingke",
        "title_banner": "助教的红笔",
        "tagline": "大学助教 · 顾若铃助教",
        "faction_tag": "校园 · 办公室",
        "theme_color": "#94a3b8",
        "intro": "顾若铃助教陈铃可。红笔先挡越线，对等了才肯收。办公室门半掩时的闲话，她比谁都清楚。想走近若铃，先过她这关——规则守住，导师放行，才谈对等靠近。",
        "story_bg": "陈铃可是顾若铃助教，红笔先挡越线。对等了才肯收。办公室门半掩时的闲话，她比谁都清楚。想走近若铃，先过她这关。办公室与课后经若铃认识；边界守住、导师放行，才谈对等靠近。",
        "with_pc": "对沈予安：护导师边界，对越线零容忍；破门后才肯对等。你要是绕开门禁献殷勤、拿师生身份开玩笑或情绪勒索，她硬；你守规则、对等说话、接受纠正，她才收起那支红笔。路线「助教的红笔」——关系向·难攻略，目标恋人。",
        "genre": "助教的红笔",
        "quote_vertical": "顾若铃老师的答疑排到九点了。你不是来越界的吧？",
        "quote_horizontal": "别绕门禁献殷勤。对等说话，红笔才收。",
        "calligraphy": "红笔",
        "signature": "陈铃可",
        "footer_tagline": "助教的红笔 · 戏份★★★",
        "b_pose_hint": "半身正面；衬衫西裤工牌全身；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "167 cm"},
            {"label": "年龄", "value": "24"},
            {"label": "职业", "value": "大学助教"},
            {"label": "对男主", "value": "顾若铃助教"},
            {"label": "MBTI", "value": "ESTJ · 总经理"},
            {"label": "路线", "value": "助教的红笔（3★）"},
            {"label": "出场", "value": "第 6 周"},
            {"label": "语气", "value": "正式·短句"},
            {"label": "关系目标", "value": "恋人"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "大学助教"},
            {"label": "对男主", "value": "顾若铃助教 · 边界守门"},
            {"label": "戏份", "value": "★★★ 关系向"},
            {"label": "出场", "value": "第 6 周"},
            {"label": "声线", "value": "短句如批注；对等了才松"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.4, "gentle": 0.4, "cheerful": 0.3, "clingy": 0.1, "mature": 0.75, "shy": 0.2}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "顾若铃助教；护边界，破门后才对等。目标：恋人。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 6 周；linked · 戏份★★★ 关系向；锚点顾若铃。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：守规则、对等说话、接受纠正。忌：绕门禁献殷勤、师生玩笑、情绪勒索。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：校园/图书馆；喜欢准时交稿、边界清晰。讨厌越界搭讪、拖进度。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "低马尾衬衫西裤+工牌，持红笔站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见低马尾与西裤剪裁"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "低马尾与锐利目光，锁基图五官"},
            {"label": "上半身胸部", "hint": "衬衫领到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "西裤腿线与鞋"},
            {"label": "背面臀部", "hint": "背面臀线与西裤褶皱，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule + likes",
            "cast_intro": "intro_week 6",
            "body_catalog": "167 cm",
            "pc": "沈予安",
        },
    },
    "aichen": {
        "tier": "N",
        "story_weight": 3,
        "tier_stars": "★★★",
        "tier_label": "戏份·关系向",
        "name_zh": "程艾辰",
        "name_en": "Cheng Aichen",
        "title_banner": "闺蜜的审核",
        "tagline": "花艺策划 · 夏艾黎闺蜜",
        "faction_tag": "花艺圈 · 复联",
        "theme_color": "#86efac",
        "intro": "夏艾黎闺蜜程艾辰。复联后负责盘问靠近的人；心软前先冷脸，爱问账单和动机。想绕过她找艾黎，门关得很快——答得实在、别急着讨好，过审后话才软。",
        "story_bg": "程艾辰是夏艾黎闺蜜，复联后负责盘问靠近的人。心软前先冷脸，爱问账单和动机。想绕过她找艾黎，门关得很快。进货单她也帮着核。花艺圈复联局经艾黎介绍；闺蜜点头、姐姐也点头，她才肯把心交出去。",
        "with_pc": "对沈予安：离婚托底闺蜜，礼貌审视；过审后才卸下防线。你要是绕过她找艾黎、随口承诺或贬她姐姐的过去，她冷；你答得实在、别急着讨好、尊重她把关，她才肯把话放软。路线「闺蜜的审核」——关系向·难攻略，目标恋人。",
        "genre": "闺蜜把关",
        "quote_vertical": "夏艾黎重新开始不容易。你若靠近她，先过我这关。",
        "quote_horizontal": "别绕过我找她。先把动机和账单说清楚。",
        "calligraphy": "审核",
        "signature": "程艾辰",
        "footer_tagline": "闺蜜的审核 · 戏份★★★",
        "b_pose_hint": "半身正面；大地色大衣+襟花全身；背面全身；身体特写四格",
        "profile_rows": [
            {"label": "身高", "value": "164 cm"},
            {"label": "年龄", "value": "26"},
            {"label": "职业", "value": "花艺圈策划"},
            {"label": "对男主", "value": "夏艾黎闺蜜"},
            {"label": "MBTI", "value": "INFJ · 提倡者"},
            {"label": "路线", "value": "闺蜜的审核（3★）"},
            {"label": "出场", "value": "第 6 周"},
            {"label": "语气", "value": "正式·审视"},
            {"label": "关系目标", "value": "恋人"},
        ],
        "profile_bullets": [
            {"label": "职业", "value": "花艺圈策划"},
            {"label": "对男主", "value": "夏艾黎闺蜜 · 礼貌审视"},
            {"label": "戏份", "value": "★★★ 关系向"},
            {"label": "出场", "value": "第 6 周"},
            {"label": "声线", "value": "先冷脸问清楚；过关才软"},
        ],
        "stats": stats_from_traits(
            {"tsundere": 0.2, "gentle": 0.75, "cheerful": 0.4, "clingy": 0.2, "mature": 0.8, "shy": 0.25}
        ),
        "system_blocks": [
            {
                "title": "与男主",
                "grade": None,
                "desc": "夏艾黎闺蜜；礼貌审视，过审后卸防。目标：恋人。",
            },
            {
                "title": "出场",
                "grade": None,
                "desc": "第 6 周；linked · 戏份★★★ 关系向；锚点夏艾黎。",
            },
            {
                "title": "相处",
                "grade": None,
                "desc": "宜：答得实在、别急讨好、尊重把关。忌：绕过她找艾黎、随口承诺、贬姐姐过去。",
            },
            {
                "title": "足迹",
                "grade": None,
                "desc": "常在：街/咖啡店；喜欢稳妥承诺、花材整齐。讨厌消费伤口、轻浮靠近。",
            },
        ],
        "view_labels": [
            {"label": "正面全身", "hint": "温柔短发大地色大衣+襟花，站姿"},
            {"label": "背面全身", "hint": "同装背面全身，可见短发与大衣剪裁"},
        ],
        "body_crops": [
            {"label": "脸部", "hint": "温柔短发与审视目光，锁基图五官"},
            {"label": "上半身胸部", "hint": "大衣领到胸线裁切，遮挡充分"},
            {"label": "下半身腿部", "hint": "裙/裤腿线与鞋"},
            {"label": "背面臀部", "hint": "背面臀线与大衣褶皱，不露点"},
        ],
        "expr_labels": None,
        "angle_labels": None,
        "sources": {
            "model_roles": "profile + traits + route + opening_line",
            "character_lores": "codex → intro / story_bg",
            "romance_voice_cards": "genre + do/dont → 相处",
            "social_graph": "role_hint + schedule + likes",
            "cast_intro": "intro_week 6",
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
        "jingning",
        "youwei",
        "yuxi",
        "lingke",
        "aichen",
        "xingnai",
        "fengyin",
        "qingcai",
        "xiaoyang",
        "luna",
    ]
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
