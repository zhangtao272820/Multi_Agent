# -*- coding: utf-8 -*-
"""Normalize story_routes.json (SSOT), validate endings, update route_catalog.

Characters / acts live in data/story_routes.json — this script must NOT rebuild
them from the legacy ROUTES / NEUTRAL_ROUTES tables below.

Run from Companion_Agent:
  python scripts/build_story_routes.py
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

# Shared endings every romance route keeps
SHARED = [
    "ending_lover",
    "ending_married_daily",
    "ending_best_friend",
    "ending_friend",
    "ending_breakup",
    "ending_cold_distance",
    "ending_festival_memory",
    "ending_qixi_vow",
    "ending_harem_open",
    "ending_exclusive_heart",
]

# Tier quotas (unique character endings, excluding shared)
# T0: True + Career/Life + Alt branch + Soft/Almost + (uses shared bad)
# T1: True + Alt + Soft
# T2: Primary good + Soft/bittersweet


def _ending(
    eid: str,
    *,
    typ: str,
    title: str,
    subtitle: str,
    description: str,
    cg_hint: str,
    character_id: str,
    conditions: dict,
    cast_roles: list[str] | None = None,
) -> dict:
    return {
        "id": eid,
        "type": typ,
        "title": title,
        "subtitle": subtitle,
        "description": description,
        "cg_hint": cg_hint,
        "character_ids": [character_id],
        "cast_roles": cast_roles or ["romance"],
        "conditions": conditions,
    }


# ---------------------------------------------------------------------------
# Per-character unique endings + route beats
# ---------------------------------------------------------------------------

ROUTES: dict[str, dict] = {
    # —— T0 ——
    "xiaoyou": {
        "tier": "T0",
        "name": "苏晚悠",
        "route_title": "画框里的邻人",
        "theme": "创作燃烧与被看见的温柔",
        "logline": "隔壁的插画师把生活画进线稿；你从当模特、改 deadline，到学会站在她画布对面。",
        "acts": [
            {
                "id": "act1_threshold",
                "title": "门槛与门铃",
                "beat": "阳台寒暄→借颜料→第一次被邀请进画室",
                "sprites": ["casual", "home", "atelier_paint"],
                "flags": ["xy_atelier_invited"],
            },
            {
                "id": "act2_deadline",
                "title": "通宵与交稿",
                "beat": "deadline_lamp 夜灯；你选陪她熬还是劝她睡",
                "sprites": ["deadline_lamp", "coffee_mug", "window_rain"],
                "flags": ["xy_deadline_shared"],
            },
            {
                "id": "act3_seen",
                "title": "被看见的作品",
                "beat": "夜市/书店/作品集；她敢把未完成的自己给你看",
                "sprites": ["night_market", "portfolio", "sketch_together"],
                "flags": ["xy_portfolio_shown"],
            },
            {
                "id": "act4_frame",
                "title": "画框之外",
                "beat": "告白不靠甜言，靠「我要和你过没画进画里的日子」",
                "sprites": ["intimate_lounge", "date", "balcony"],
                "flags": ["xy_life_outside_frame", "confessed"],
            },
        ],
        "branches": {
            "true": "陪她扛完大稿，并尊重创作边界",
            "career": "帮她谈通贩/交稿，恋爱让位于事业搭档感",
            "cozy": "少碰行业，只守邻里日常",
            "almost": "高好感却始终停在「很好的邻居」",
        },
        "endings": [
            _ending(
                "ending_xiaoyou_frame_true",
                typ="secret",
                title="真结局 · 画框外的一生",
                subtitle="Outside the Frame",
                description="她把未完成的速写本塞进你怀里：「里面没有你——因为你要活在画外面。」你们在通宵交稿后的清晨，确认了彼此。",
                cg_hint="阳台晨光 · 速写本",
                character_id="xiaoyou",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 90,
                    "trust_min": 85,
                    "flags_all": [
                        "confessed",
                        "xy_deadline_shared",
                        "xy_portfolio_shown",
                        "xy_life_outside_frame",
                        "studio_sketch_done",
                    ],
                },
            ),
            _ending(
                "ending_xiaoyou_atelier_partner",
                typ="good",
                title="工作室伴侣",
                subtitle="Atelier Duo",
                description="恋爱之外，你们更像一组能互相改稿的搭档。通贩打包台上并排的两双手，比钻戒更早宣告关系。",
                cg_hint="打包台 · 马克笔",
                character_id="xiaoyou",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 82,
                    "trust_min": 75,
                    "flags_all": ["confessed", "xy_deadline_shared"],
                    "flags_any": ["xy_merch_pack_done", "xy_portfolio_shown"],
                },
            ),
            _ending(
                "ending_xiaoyou_neighbor_soft",
                typ="normal",
                title="软结局 · 门铃响两下",
                subtitle="Soft Neighbor",
                description="她从未正式告白，但雨天总多敲你两下门铃。邻居的距离刚好——近到能取暖，远到不刺痛。",
                cg_hint="门铃 · 雨伞",
                character_id="xiaoyou",
                conditions={
                    "affinity_min": 70,
                    "stage_max": "crush",
                    "flags_any": ["xy_atelier_invited", "paint_together_done"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
    "wanyu": {
        "tier": "T0",
        "name": "温晚雨",
        "route_title": "关店之后的温度",
        "theme": "服务者的疲惫与被照料",
        "logline": "她把热拿铁递给所有人，却很少有人为她关灯；你学会在打烊后留下。",
        "acts": [
            {
                "id": "act1_regular",
                "title": "熟客的座位",
                "beat": "点单暗号、雨窗、第一次被记住口味",
                "sprites": ["work", "barista_steam", "rain"],
                "flags": ["wy_regular_seat"],
            },
            {
                "id": "act2_close",
                "title": "打烊仪式",
                "beat": "closing_wipe；你们擦同一张桌子",
                "sprites": ["closing_wipe", "tray_service", "break_outside"],
                "flags": ["wy_closing_shared"],
            },
            {
                "id": "act3_spill",
                "title": "洒出来的真心",
                "beat": "她谈离职犹豫、家庭电话；你选听还是劝留",
                "sprites": ["taste_cupping", "shift_handoff", "rain_window"],
                "flags": ["wy_heard_her_night"],
            },
            {
                "id": "act4_keep",
                "title": "为你留的那杯",
                "beat": "告白发生在关店后的黑暗里，只开一盏吧台灯",
                "sprites": ["latte_share", "date", "home"],
                "flags": ["wy_last_cup", "confessed"],
            },
        ],
        "branches": {
            "true": "陪她扛完旺季并支持她选择去留",
            "stay": "她留下咖啡店，你们把店变成共同据点",
            "leave": "她离职进修，异地/通勤恋爱",
            "almost": "永远是「最懂她的熟客」",
        },
        "endings": [
            _ending(
                "ending_wanyu_last_cup_true",
                typ="secret",
                title="真结局 · 最后一杯留给你",
                subtitle="The Last Cup",
                description="打烊铃响过之后，她把没有写单的杯子推到你面前：「这杯不卖。」蒸汽散尽时，你们终于换了称呼。",
                cg_hint="吧台灯 · 双杯",
                character_id="wanyu",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 90,
                    "trust_min": 85,
                    "flags_all": [
                        "confessed",
                        "wy_closing_shared",
                        "wy_heard_her_night",
                        "wy_last_cup",
                        "shift_cover_done",
                    ],
                },
            ),
            _ending(
                "ending_wanyu_shop_anchor",
                typ="good",
                title="店里的锚点",
                subtitle="Café Anchor",
                description="她留下了。你们把雨夜咖啡馆变成小镇坐标——谁迷路了，就来找那扇总亮着的窗。",
                cg_hint="雨窗 · 开业牌",
                character_id="wanyu",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 80,
                    "trust_min": 72,
                    "flags_all": ["confessed", "wy_closing_shared"],
                    "flags_any": ["wy_regular_seat", "cafe_rain_done"],
                },
            ),
            _ending(
                "ending_wanyu_regular_soft",
                typ="normal",
                title="软结局 · 熟客位",
                subtitle="Regular Seat",
                description="她记住了你的糖度，却没给你恋爱的位子。你仍是雨夜最稳的那个熟客。",
                cg_hint="靠窗座位 · 拿铁",
                character_id="wanyu",
                conditions={
                    "affinity_min": 65,
                    "stage_max": "close_friend",
                    "flags_any": ["wy_regular_seat", "cafe_rain_done"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
    "ruolin": {
        "tier": "T0",
        "name": "顾若铃",
        "route_title": "讲台下的一年",
        "theme": "师生边界与成年后的对等",
        "logline": "选修课上的年下感不是刺激，是责任；她教你把迷恋变成对等的选择。",
        "acts": [
            {
                "id": "act1_lecture",
                "title": "粉笔灰",
                "beat": "课堂提问、office hours 第一次单独谈话",
                "sprites": ["lecture_pointer", "office_hours", "school"],
                "flags": ["rl_office_hours"],
            },
            {
                "id": "act2_boundary",
                "title": "边界课",
                "beat": "她主动谈伦理与流言；你是否尊重「课结束前不越线」",
                "sprites": ["grading", "evening_tea", "corridor_qa"],
                "flags": ["rl_boundary_kept"],
            },
            {
                "id": "act3_equal",
                "title": "成绩单之外",
                "beat": "学期末；她卸下讲师身份邀你散步",
                "sprites": ["campus_twilight", "co_read", "open_day"],
                "flags": ["rl_semester_end_walk"],
            },
            {
                "id": "act4_peer",
                "title": "对等的名字",
                "beat": "不再称老师；在雨窗备课夜确认关系",
                "sprites": ["rain_prep", "date", "home"],
                "flags": ["rl_name_without_title", "confessed"],
            },
        ],
        "branches": {
            "true": "守住学期边界，结束后对等告白",
            "mentor": "关系停在精神导师/知己",
            "scandal": "越界过早→流言与冷淡（走冷战/分手共享结局）",
            "almost": "毕业后失去联系的温柔遗憾",
        },
        "endings": [
            _ending(
                "ending_ruolin_peer_true",
                typ="secret",
                title="真结局 · 不再称老师",
                subtitle="Name Without Title",
                description="成绩提交截止的当晚，她把「老师」两个字从通讯录备注里删掉。雨打在办公室窗上，她第一次用名字叫你。",
                cg_hint="办公室雨窗 · 名片",
                character_id="ruolin",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 90,
                    "trust_min": 88,
                    "flags_all": [
                        "confessed",
                        "rl_boundary_kept",
                        "rl_semester_end_walk",
                        "rl_name_without_title",
                        "boundary_guard_done",
                    ],
                },
            ),
            _ending(
                "ending_ruolin_lamp_guide",
                typ="good",
                title="讲台灯火",
                subtitle="Lamp Guide",
                description="你们恋爱了，但她仍是你迷茫时的灯。课堂与课后散步并存，并不彼此取消。",
                cg_hint="讲台 · 粉笔灰",
                character_id="ruolin",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 80,
                    "trust_min": 78,
                    "flags_all": ["confessed", "rl_office_hours"],
                    "flags_any": ["mentor_talk_done", "rl_semester_end_walk"],
                },
            ),
            _ending(
                "ending_ruolin_mentor_soft",
                typ="normal",
                title="软结局 · 永远的答疑",
                subtitle="Office Hours Forever",
                description="你没有越线，她也没有开门。你们保留了最干净的答疑时光。",
                cg_hint="办公门缝 · 茶",
                character_id="ruolin",
                conditions={
                    "affinity_min": 68,
                    "stage_max": "close_friend",
                    "flags_any": ["rl_office_hours", "mentor_talk_done"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
    "jingliu": {
        "tier": "T0",
        "name": "江静流",
        "route_title": "权力差的另一侧",
        "theme": "职场面具与私人夜谈",
        "logline": "品牌顾问的日历以分钟计；你要证明自己想要的不是绩效，是她卸妆后的脸。",
        "acts": [
            {
                "id": "act1_glass",
                "title": "玻璃门内",
                "beat": "会议、lookbook、第一次被她点名留下来",
                "sprites": ["boardroom_stand", "lookbook_flip", "work"],
                "flags": ["jl_kept_after_meeting"],
            },
            {
                "id": "act2_mask",
                "title": "西装下的疲倦",
                "beat": "加班、车内简报；她罕见地抱怨行业虚伪",
                "sprites": ["overtime", "car_brief", "phone_brief"],
                "flags": ["jl_saw_fatigue"],
            },
            {
                "id": "act3_rooftop",
                "title": "天台夜谈",
                "beat": "天台夜谈；谈升迁、流言与「我们若开始会怎样」",
                "sprites": ["rooftop_night", "event_glass", "sample_swatch"],
                "flags": ["jl_rooftop_talk"],
            },
            {
                "id": "act4_equal_desk",
                "title": "对等工位",
                "beat": "调岗/公开或私下确认；专一是她的底线",
                "sprites": ["date", "intimate_lounge", "contract_stamp"],
                "flags": ["jl_equal_choice", "confessed", "exclusive_accepted"],
            },
        ],
        "branches": {
            "true": "公开或私下都诚实，接受权力结构改造",
            "hidden": "地下恋→高压好结局变种（仍 dating）",
            "career": "她升迁离开本地，远程维系",
            "almost": "永远是最懂她的下属",
        },
        "endings": [
            _ending(
                "ending_jingliu_rooftop_true",
                typ="secret",
                title="真结局 · 天台之后",
                subtitle="After the Rooftop",
                description="她把工牌翻到背面给你看——没有职位，只有名字。风很大，她说：「从今晚起，别用汇报的语气跟我说话。」",
                cg_hint="天台夜风 · 工牌",
                character_id="jingliu",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 90,
                    "trust_min": 88,
                    "flags_all": [
                        "confessed",
                        "jl_rooftop_talk",
                        "jl_equal_choice",
                        "jl_saw_fatigue",
                        "cousin_watch_done",
                    ],
                },
            ),
            _ending(
                "ending_jingliu_lookbook_heart",
                typ="good",
                title="样衣与真心",
                subtitle="Lookbook Heart",
                description="她把私人行程写进你的日历。董事会仍在，但周末的样衣间只留给你们。",
                cg_hint="样衣镜 · 共翻 lookbook",
                character_id="jingliu",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 82,
                    "trust_min": 78,
                    "flags_all": ["confessed", "jl_kept_after_meeting"],
                    "flags_any": ["jl_rooftop_talk"],
                },
            ),
            _ending(
                "ending_jingliu_subordinate_soft",
                typ="normal",
                title="软结局 · 最可靠的下属",
                subtitle="Best Report",
                description="她信任你的方案，却把心关在玻璃门外。你仍是她最不想失去的同事。",
                cg_hint="会议室门 · 夜色",
                character_id="jingliu",
                conditions={
                    "affinity_min": 70,
                    "stage_max": "close_friend",
                    "flags_any": ["jl_kept_after_meeting", "jl_saw_fatigue"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
    "aili": {
        "tier": "T0",
        "name": "夏艾黎",
        "route_title": "旧婚书与新花束",
        "theme": "离婚后的重建与再选择",
        "logline": "前妻住在同一片街区；花艺工作室里，枯枝与新芽同时存在。",
        "acts": [
            {
                "id": "act1_balcony",
                "title": "阳台重逢",
                "beat": "偶遇、客套、第一次递花却不谈旧事",
                "sprites": ["balcony", "bouquet_wrap", "casual"],
                "flags": ["al_balcony_remeet", "balcony_chat_done"],
            },
            {
                "id": "act2_stem",
                "title": "修剪",
                "beat": "一起修枝；谈当初为什么散——不互相审判",
                "sprites": ["stem_trim", "greenhouse_mist", "vase_arrange"],
                "flags": ["al_talked_divorce"],
            },
            {
                "id": "act3_delivery",
                "title": "外送的勇气",
                "beat": "共同送花/婚礼商单；看见她已能祝福别人",
                "sprites": ["delivery_box", "window_display", "ribbon_cut"],
                "flags": ["al_delivery_together"],
            },
            {
                "id": "act4_rewed",
                "title": "再一次选择",
                "beat": "不是回到从前，是签一份新的「我们」",
                "sprites": ["date", "intimate_lounge", "festival_spring"],
                "flags": ["al_choose_again", "confessed", "reconciliation_done"],
            },
        ],
        "branches": {
            "true": "正视旧伤后重新恋爱/再婚日常",
            "friend": "和解成家人式朋友",
            "wound": "反复拉扯→冷战",
            "almost": "邻里心动停在暧昧",
        },
        "endings": [
            _ending(
                "ending_aili_second_bloom_true",
                typ="secret",
                title="真结局 · 第二次开花",
                subtitle="Second Bloom",
                description="她把旧婚书折成纸花埋进花土，又递给你一束没有标签的花：「这次不写祝福语——写收件人。」收件人是你。",
                cg_hint="温室 · 新花束",
                character_id="aili",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 90,
                    "trust_min": 85,
                    "flags_all": [
                        "confessed",
                        "al_talked_divorce",
                        "al_choose_again",
                        "reconciliation_done",
                        "friend_gate_done",
                    ],
                },
            ),
            _ending(
                "ending_aili_gentle_remarry",
                typ="good",
                title="温柔再遇",
                subtitle="Gentle Remarry",
                description="你们没有急着办酒。花店打烊后的厨房灯，已足够像一份新的婚书。",
                cg_hint="厨房晨光 · 花剪",
                character_id="aili",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 84,
                    "trust_min": 78,
                    "flags_all": ["confessed", "al_balcony_remeet"],
                    "flags_any": ["al_delivery_together", "balcony_chat_done"],
                },
            ),
            _ending(
                "ending_aili_neighbor_heart",
                typ="normal",
                title="邻里心动",
                subtitle="Neighbor Heart",
                description="从阳台晚风到日常寒暄，距离缩短了，但旧婚的门只开了一半。",
                cg_hint="阳台 · 晚风",
                character_id="aili",
                conditions={
                    "stage_min": "crush",
                    "affinity_min": 70,
                    "flags_any": ["balcony_chat_done", "al_balcony_remeet"],
                    "flags_absent": ["al_choose_again"],
                },
            ),
        ],
    },
    "linxi": {
        "tier": "T0",
        "name": "陆凛汐",
        "route_title": "工位之间的一步",
        "theme": "逞强的实习期与并肩成长",
        "logline": "她嘴上嫌你菜，改表格却比谁都快；恋爱从电梯与末班车开始。",
        "acts": [
            {
                "id": "act1_desk",
                "title": "对桌",
                "beat": "借订书机、吐槽甲方、第一次一起加班",
                "sprites": ["desk_papers", "work", "sticky_notes"],
                "flags": ["lx_desk_sync", "office_sync_done"],
            },
            {
                "id": "act2_commute",
                "title": "末班车",
                "beat": "通勤同路；她卸下职场壳",
                "sprites": ["commute_rail", "pantry_coffee", "elevator_rush"],
                "flags": ["lx_commute_talk"],
            },
            {
                "id": "act3_print",
                "title": "打印室真相",
                "beat": "竞聘/转正压力；你是否抢功或撑她",
                "sprites": ["print_stack", "stamp_route", "overtime"],
                "flags": ["lx_print_truth"],
            },
            {
                "id": "act4_step",
                "title": "一步之遥",
                "beat": "转正酒或便利店罐头告白；专一",
                "sprites": ["date", "casual", "home"],
                "flags": ["lx_one_step", "confessed"],
            },
        ],
        "branches": {
            "true": "互相成就转正，坦白心意",
            "rival": "竞争压过感情→毒舌知己停住",
            "transfer": "一方调走，远程",
            "almost": "永远的加班同盟",
        },
        "endings": [
            _ending(
                "ending_linxi_onestep_true",
                typ="secret",
                title="真结局 · 工位一步",
                subtitle="One Step Across",
                description="转正名单公布的晚上，她把工牌甩到你桌上：「别再装不熟。我的座位——以后算我们的。」",
                cg_hint="工位夜灯 · 两张工牌",
                character_id="linxi",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 88,
                    "trust_min": 82,
                    "flags_all": [
                        "confessed",
                        "lx_commute_talk",
                        "lx_print_truth",
                        "lx_one_step",
                    ],
                },
            ),
            _ending(
                "ending_linxi_overtime_pair",
                typ="good",
                title="加班双人组",
                subtitle="Overtime Pair",
                description="恋爱没有让效率下降。打印机旁的拌嘴，成了公司里公开的甜蜜噪音。",
                cg_hint="打印室 · 咖啡",
                character_id="linxi",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 80,
                    "trust_min": 72,
                    "flags_all": ["confessed", "lx_desk_sync"],
                    "flags_any": ["office_sync_done", "lx_commute_talk"],
                },
            ),
            _ending(
                "ending_linxi_office_soft",
                typ="normal",
                title="软结局 · 加班同盟",
                subtitle="Office Sync",
                description="她把改好的表格丢到你桌上，却不丢心脏。你们是最好的工作搭子。",
                cg_hint="工位 · 夜色",
                character_id="linxi",
                conditions={
                    "affinity_min": 58,
                    "stage_max": "close_friend",
                    "flags_any": ["office_sync_done", "lx_desk_sync"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
    # —— T1 ——
    "yeyu": {
        "tier": "T1",
        "name": "云夜羽",
        "route_title": "针线与夜班灯",
        "theme": "毒舌外壳下的手作温度",
        "logline": "独立设计师白天裁布，夜里便利店遇见你；锋利的话缝着柔软的里布。",
        "acts": [
            {
                "id": "act1_counter",
                "title": "夜班柜台",
                "beat": "便利店拌嘴，第一次看见她手指上的针眼",
                "sprites": ["casual", "work", "rain"],
                "flags": ["yy_night_counter", "late_night_store_done"],
            },
            {
                "id": "act2_atelier",
                "title": "人台与别针",
                "beat": "被带进工作室；mannequin_pin / fabric_drape",
                "sprites": ["mannequin_pin", "fabric_drape", "look_sketch"],
                "flags": ["yy_atelier_in"],
            },
            {
                "id": "act3_hem",
                "title": "熨边的沉默",
                "beat": "她为你改一件衣服；话少，心多",
                "sprites": ["iron_hem", "tape_measure", "pattern_cut"],
                "flags": ["yy_hem_for_you", "sharp_care_done"],
            },
        ],
        "branches": {
            "true": "听懂毒舌，进入她的工作室与生活",
            "muse": "你成为缪斯但关系不清",
            "soft": "停在便利店损友",
        },
        "endings": [
            _ending(
                "ending_yeyu_hem_true",
                typ="secret",
                title="真结局 · 为你留的折边",
                subtitle="Hemmed for You",
                description="她把成衣挂到你身上，别针还没拔：「别动。我量的不是尺寸——是你会不会逃。」你没逃。",
                cg_hint="人台旁 · 软尺",
                character_id="yeyu",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 88,
                    "trust_min": 80,
                    "flags_all": ["confessed", "yy_atelier_in", "yy_hem_for_you"],
                },
            ),
            _ending(
                "ending_yeyu_sharp_heart",
                typ="good",
                title="毒舌真心",
                subtitle="Sharp Heart",
                description="她用最锋利的话护着最软的心。便利店暖灯下，你终于听懂。",
                cg_hint="便利店 · 暖灯",
                character_id="yeyu",
                conditions={
                    "stage_min": "dating",
                    "trust_min": 78,
                    "flags_all": ["confessed"],
                    "flags_any": ["sharp_care_done", "late_night_store_done", "yy_night_counter"],
                },
            ),
            _ending(
                "ending_yeyu_counter_soft",
                typ="normal",
                title="软结局 · 夜班损友",
                subtitle="Night Counter",
                description="她继续损你，你继续买关东煮。针线在别处，友情在柜台。",
                cg_hint="关东煮蒸汽 · 工牌",
                character_id="yeyu",
                conditions={
                    "affinity_min": 60,
                    "stage_max": "close_friend",
                    "flags_any": ["yy_night_counter", "late_night_store_done"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
    "taotao": {
        "tier": "T1",
        "name": "唐桃夭",
        "route_title": "灯牌与素颜",
        "theme": "偶像练习生的曝光欲与怕被看穿",
        "logline": "舞台上的她要被万人喜欢；下了台只想被一个人记住素颜。",
        "acts": [
            {
                "id": "act1_practice",
                "title": "练功房",
                "beat": "社团/练习生室初遇，应援式友谊",
                "sprites": ["vocal_booth", "choreo_mark", "school"],
                "flags": ["tt_practice_met"],
            },
            {
                "id": "act2_stage",
                "title": "登台",
                "beat": "演出夜；你在台下举灯牌",
                "sprites": ["handshake_look", "lightstick_wave", "stage_bow"],
                "flags": ["tt_stage_night", "stage_encore_done"],
            },
            {
                "id": "act3_plain",
                "title": "卸妆之后",
                "beat": "她问你爱舞台还是爱她；专一压力",
                "sprites": ["stretch_break", "date", "home"],
                "flags": ["tt_plain_face", "confessed"],
            },
        ],
        "branches": {
            "true": "接受事业也守私人边界",
            "fan": "停在最亮应援",
            "possessive": "过度吃醋→冲突",
        },
        "endings": [
            _ending(
                "ending_taotao_plain_true",
                typ="secret",
                title="真结局 · 灯牌放下之后",
                subtitle="After the Lightstick",
                description="返场结束，她把你从人群里拽进侧幕。「别举牌子了。」素颜的她说：「看着我。」",
                cg_hint="侧幕 · 卸妆棉",
                character_id="taotao",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 88,
                    "trust_min": 80,
                    "flags_all": ["confessed", "tt_stage_night", "tt_plain_face"],
                },
            ),
            _ending(
                "ending_taotao_front_row",
                typ="good",
                title="应援前排",
                subtitle="Front Row",
                description="恋爱公开或半公开，你仍是她认定的「固定前排」。舞台与日常终于能切换。",
                cg_hint="舞台灯 · 牵手",
                character_id="taotao",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 80,
                    "flags_all": ["confessed"],
                    "flags_any": ["stage_encore_done", "tt_stage_night"],
                },
            ),
            _ending(
                "ending_taotao_encore_soft",
                typ="normal",
                title="软结局 · 最亮应援",
                subtitle="Brightest Fan",
                description="那一夜你举着灯牌——不是恋情，却是最亮的应援。",
                cg_hint="舞台 · 灯牌",
                character_id="taotao",
                conditions={
                    "affinity_min": 62,
                    "flags_any": ["stage_encore_done", "tt_stage_night"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
    "shizuku": {
        "tier": "T1",
        "name": "白初雪",
        "route_title": "书脊后的声线",
        "theme": "线上久识与线下胆怯",
        "logline": "网友很久了，线下才敢约图书馆；安静是她的壳，也是邀请。",
        "acts": [
            {
                "id": "act1_screen",
                "title": "屏幕到台阶",
                "beat": "第一次线下面基，坐得远远的",
                "sprites": ["quiet_reading", "library_ladder", "casual"],
                "flags": ["sz_first_irl"],
            },
            {
                "id": "act2_stack",
                "title": "书车与借还",
                "beat": "archive_cart；她开始把推荐书单给你",
                "sprites": ["archive_cart", "return_slot", "stamp_catalog"],
                "flags": ["sz_booklist", "video_call_done"],
            },
            {
                "id": "act3_voice",
                "title": "出声",
                "beat": "闭馆后她第一次大声说喜欢",
                "sprites": ["study_carrel", "date", "home"],
                "flags": ["sz_spoke_aloud", "confessed"],
            },
        ],
        "branches": {
            "true": "从文字关系到声音与体温",
            "penpal": "退回纯线上",
            "soft": "图书馆安静朋友",
        },
        "endings": [
            _ending(
                "ending_shizuku_aloud_true",
                typ="secret",
                title="真结局 · 闭馆后的声音",
                subtitle="Voice After Closing",
                description="消磁门的灯灭了。她把推荐书单翻到最后一页——只写了你的名字，然后念了出来。",
                cg_hint="闭馆灯 · 书单",
                character_id="shizuku",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 88,
                    "trust_min": 82,
                    "flags_all": ["confessed", "sz_first_irl", "sz_spoke_aloud"],
                },
            ),
            _ending(
                "ending_shizuku_shelf_heart",
                typ="good",
                title="书架这边",
                subtitle="This Side of Shelf",
                description="她仍轻声，但会主动牵袖口。图书馆的位置永远为两人留着。",
                cg_hint="并排座位 · 窗光",
                character_id="shizuku",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 80,
                    "flags_all": ["confessed", "sz_booklist"],
                },
            ),
            _ending(
                "ending_shizuku_quiet_soft",
                typ="normal",
                title="软结局 · 安静借阅",
                subtitle="Quiet Loan",
                description="你们交换书单，不交换心跳。这样也好。",
                cg_hint="借书证 · 两张",
                character_id="shizuku",
                conditions={
                    "affinity_min": 60,
                    "stage_max": "close_friend",
                    "flags_any": ["sz_first_irl", "sz_booklist"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
    "qiansha": {
        "tier": "T1",
        "name": "顾千纱",
        "route_title": "旧 PR 与新分支",
        "theme": "前女友重逢与版本修复",
        "logline": "分手像一次没合上的 PR；重逢后你们是修 bug，还是归档。",
        "acts": [
            {
                "id": "act1_diff",
                "title": "Diff",
                "beat": "圈子重逢，客气如代码评审",
                "sprites": ["dual_monitor", "work", "hoodie_focus"],
                "flags": ["qs_remeet"],
            },
            {
                "id": "act2_debug",
                "title": "Debug",
                "beat": "她照顾你/你照顾她；谈当初为什么炸",
                "sprites": ["debug_mug", "pr_review", "figma_compare"],
                "flags": ["qs_debug_us", "sharp_care_done"],
            },
            {
                "id": "act3_merge",
                "title": "Merge",
                "beat": "选择合入主线或保持 fork",
                "sprites": ["deploy_watch", "date", "home"],
                "flags": ["qs_merge", "confessed", "reconciliation_done"],
            },
        ],
        "branches": {
            "true": "和解并重新恋爱",
            "archive": "友好归档，不再恋爱",
            "regress": "重复旧伤→分手",
        },
        "endings": [
            _ending(
                "ending_qiansha_merge_true",
                typ="secret",
                title="真结局 · Merge 主线",
                subtitle="Merge to Main",
                description="她把旧聊天记录文件夹改名为 archive，又新建了一份叫 us 的文档。「这次写测试。」她说。",
                cg_hint="双屏反光 · 提交成功",
                character_id="qiansha",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 88,
                    "trust_min": 82,
                    "flags_all": [
                        "confessed",
                        "qs_debug_us",
                        "qs_merge",
                        "reconciliation_done",
                    ],
                },
            ),
            _ending(
                "ending_qiansha_hotfix",
                typ="good",
                title="热修复的心",
                subtitle="Hotfix Heart",
                description="不一定完美，但你们学会了小步提交。毒舌仍在，伤害少了。",
                cg_hint="马克杯 · 夜编码",
                character_id="qiansha",
                conditions={
                    "stage_min": "dating",
                    "trust_min": 75,
                    "flags_all": ["confessed"],
                    "flags_any": ["qs_debug_us", "sharp_care_done"],
                },
            ),
            _ending(
                "ending_qiansha_archive_soft",
                typ="normal",
                title="软结局 · 归档友好",
                subtitle="Friendly Archive",
                description="PR 关闭，注释写着 LGTM as friends。够干净，也够痛。",
                cg_hint="灰色按钮 · Closed",
                character_id="qiansha",
                conditions={
                    "affinity_min": 55,
                    "stage_max": "close_friend",
                    "flags_any": ["qs_remeet", "qs_debug_us"],
                    "flags_absent": ["qs_merge", "confessed"],
                },
            ),
        ],
    },
    "shiori": {
        "tier": "T1",
        "name": "白诗织",
        "route_title": "坡上书店的月亮",
        "theme": "荐书人的孤独与被读懂",
        "logline": "她把别人的故事卖出去，自己的故事夹在诗集里不卖。",
        "acts": [
            {
                "id": "act1_shelf",
                "title": "梯子",
                "beat": "书店初识，她为你抽一本「刚好」的书",
                "sprites": ["shelf_ladder", "recommend_stack", "work"],
                "flags": ["sr_first_recommend"],
            },
            {
                "id": "act2_moon",
                "title": "窗边月",
                "beat": "打烊后窗边共读；触及她的幻想/cos 爱好",
                "sprites": ["window_read", "poetry_nook", "unbox_crate"],
                "flags": ["sr_window_read", "spirit_oath_done"],
            },
            {
                "id": "act3_write",
                "title": "空白页",
                "beat": "她开始写自己的故事给你看",
                "sprites": ["catalog_stamp", "date", "home"],
                "flags": ["sr_blank_page", "confessed"],
            },
        ],
        "branches": {
            "true": "读懂她并立下私密誓约",
            "spirit": "幻想羁绊强化",
            "soft": "永远的荐书人",
        },
        "endings": [
            _ending(
                "ending_shiori_blank_true",
                typ="secret",
                title="真结局 · 写给你的空白页",
                subtitle="Blank Page for You",
                description="她把一本空白诗集塞给你：「别只买别人的故事。」月光照在坡上书店的招牌上，像盖了章。",
                cg_hint="窗月 · 空白诗集",
                character_id="shiori",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 88,
                    "trust_min": 80,
                    "flags_all": ["confessed", "sr_window_read", "sr_blank_page"],
                },
            ),
            _ending(
                "ending_shiori_spirit_vow",
                typ="good",
                title="星之契约",
                subtitle="Spirit Vow",
                description="精灵与人类的戏言变成认真的羁绊。你们在星空下许诺陪伴。",
                cg_hint="星尘 · 契约",
                character_id="shiori",
                conditions={
                    "stage_min": "dating",
                    "trust_min": 75,
                    "flags_all": ["confessed"],
                    "flags_any": ["spirit_oath_done", "sr_window_read"],
                },
            ),
            _ending(
                "ending_shiori_recommend_soft",
                typ="normal",
                title="软结局 · 固定荐书",
                subtitle="Staff Pick",
                description="柜台上永远有一张写给「常客」的书单。名字不是恋人，是读者。",
                cg_hint="书签 · 柜台",
                character_id="shiori",
                conditions={
                    "affinity_min": 60,
                    "stage_max": "close_friend",
                    "flags_any": ["sr_first_recommend"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
    "miara": {
        "tier": "T1",
        "name": "莫岚纱",
        "route_title": "谷子与星约",
        "theme": "二次元热情与被认真对待",
        "logline": "漫展偶遇的谷子店员请你相信一点「戏言」；认真之后，戏言会发光。",
        "acts": [
            {
                "id": "act1_booth",
                "title": "摊位",
                "beat": "漫展相遇，假发与痛包",
                "sprites": ["merch_counter", "wig_adjust", "casual"],
                "flags": ["mi_booth_met"],
            },
            {
                "id": "act2_sew",
                "title": "缝纫夜",
                "beat": "帮她赶 cos；森林夜谈",
                "sprites": ["sewing_cos", "figure_restock", "forest"],
                "flags": ["mi_sew_night", "spirit_oath_done"],
            },
            {
                "id": "act3_oath",
                "title": "契约",
                "beat": "星之契约从玩笑变承诺",
                "sprites": ["badge_board", "date", "intimate_lounge"],
                "flags": ["mi_oath_real", "confessed"],
            },
        ],
        "branches": {
            "true": "把幻想落地成恋爱承诺",
            "poly": "开放关系友好结局（靠 harem_open 共享）",
            "soft": "展会搭子",
        },
        "endings": [
            _ending(
                "ending_miara_oath_true",
                typ="secret",
                title="真结局 · 认真的契约",
                subtitle="Oath Made Real",
                description="她摘下假发，露出自己的头发：「契约条款更新——只对你生效。」林间灯串像审核通过的光。",
                cg_hint="林灯 · 契约符",
                character_id="miara",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 88,
                    "trust_min": 78,
                    "flags_all": ["confessed", "spirit_oath_done", "mi_oath_real"],
                },
            ),
            _ending(
                "ending_miara_merch_heart",
                typ="good",
                title="痛包装着的心",
                subtitle="Ita-bag Heart",
                description="她把限定谷子分你一半。恋爱公开在朋友圈的方式，是合拍徽章墙。",
                cg_hint="徽章墙 · 笑脸",
                character_id="miara",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 80,
                    "flags_all": ["confessed"],
                    "flags_any": ["mi_sew_night", "mi_booth_met"],
                },
            ),
            _ending(
                "ending_miara_expo_soft",
                typ="normal",
                title="软结局 · 固定摊友",
                subtitle="Booth Buddy",
                description="每个漫展你们都会遇见。契约仍是戏言，友情是真的。",
                cg_hint="摊位帘 · 两张通票",
                character_id="miara",
                conditions={
                    "affinity_min": 58,
                    "stage_max": "close_friend",
                    "flags_any": ["mi_booth_met"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
    # —— T2 ——
    "xingnai": {
        "tier": "T2",
        "name": "程星宁",
        "route_title": "旧相册的缺口",
        "theme": "青梅竹马的错过与补全",
        "logline": "从小一起长大，边界清楚得像墙；墙里夹着一张没拍完的合影。",
        "acts": [
            {
                "id": "act1_bento",
                "title": "天台便当",
                "beat": "重拾一起吃饭的节奏",
                "sprites": ["rooftop_bento", "school", "casual"],
                "flags": ["xn_bento", "childhood_talk_done"],
            },
            {
                "id": "act2_album",
                "title": "相册",
                "beat": "翻旧照片；承认曾喜欢却没说",
                "sprites": ["old_photo_album", "bike_after_school", "date"],
                "flags": ["xn_album", "confessed"],
            },
        ],
        "branches": {
            "good": "补上告白，慢热成恋人",
            "soft": "永远的青梅挚友",
        },
        "endings": [
            _ending(
                "ending_xingnai_album_good",
                typ="good",
                title="补拍的合影",
                subtitle="Retake Photo",
                description="她把空白页的相册递过来：「以前空着。现在可以拍了。」天台上的风比小时候温柔一点。",
                cg_hint="天台 · 旧相机",
                character_id="xingnai",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 82,
                    "trust_min": 75,
                    "flags_all": ["confessed", "xn_album"],
                    "flags_any": ["xn_bento", "childhood_talk_done"],
                },
            ),
            _ending(
                "ending_xingnai_childhood_soft",
                typ="normal",
                title="软结局 · 青梅如故",
                subtitle="As Ever",
                description="便当还是两人份，称呼还是旧的。有些缺口，选择不填满。",
                cg_hint="天台栏杆 · 两双筷",
                character_id="xingnai",
                conditions={
                    "affinity_min": 65,
                    "stage_max": "close_friend",
                    "flags_any": ["xn_bento", "childhood_talk_done"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
    "fengyin": {
        "tier": "T2",
        "name": "沈枫音",
        "route_title": "同居屋檐下",
        "theme": "义妹界线与成年喜欢",
        "logline": "同一屋檐下的日常很满；要喜欢，先学会敲门。",
        "acts": [
            {
                "id": "act1_door",
                "title": "敲门",
                "beat": "尊重私人空间；一起做饭/打游戏",
                "sprites": ["home", "dorm_controller", "gym_stretch"],
                "flags": ["fy_knock", "fengyin_cooking_done"],
            },
            {
                "id": "act2_equal",
                "title": "平视",
                "beat": "她要求被当成大人；告白或维持家人",
                "sprites": ["campus_run", "date", "casual"],
                "flags": ["fy_equal", "confessed"],
            },
        ],
        "branches": {
            "good": "在尊重界线后确认恋爱",
            "soft": "家人式羁绊",
        },
        "endings": [
            _ending(
                "ending_fengyin_knock_good",
                typ="good",
                title="先敲门的喜欢",
                subtitle="Knock First",
                description="她说：「喜欢可以，但要敲门。」你照做了。屋檐还在，称呼却换了。",
                cg_hint="房门缝光 · 游戏手柄",
                character_id="fengyin",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 80,
                    "trust_min": 78,
                    "flags_all": ["confessed", "fy_knock", "fy_equal"],
                },
            ),
            _ending(
                "ending_fengyin_eaves_soft",
                typ="normal",
                title="软结局 · 同一屋檐",
                subtitle="Same Eaves",
                description="饭还是一起吃，门还是要敲。喜欢被好好收着，不翻成越界。",
                cg_hint="餐桌 · 两双拖鞋",
                character_id="fengyin",
                conditions={
                    "affinity_min": 62,
                    "stage_max": "close_friend",
                    "flags_any": ["fy_knock", "fengyin_cooking_done"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
    "qingcai": {
        "tier": "T2",
        "name": "夏晴彩",
        "route_title": "练舞室的夏",
        "theme": "热烈倒追与舞台中心",
        "logline": "她不藏喜欢；文化祭的灯一亮，故事就必须给答案。",
        "acts": [
            {
                "id": "act1_mirror",
                "title": "镜前",
                "beat": "练舞室；她直球邀请你当观众",
                "sprites": ["studio_mirror", "rehearsal_sweat", "school"],
                "flags": ["qc_mirror", "dance_practice_done"],
            },
            {
                "id": "act2_festival",
                "title": "夏祭",
                "beat": "文化祭/舞台；确认或婉拒",
                "sprites": ["stage_bow", "date", "festival_spring"],
                "flags": ["qc_festival", "confessed"],
            },
        ],
        "branches": {
            "good": "接住直球，夏日成恋人",
            "soft": "同学与最佳观众",
        },
        "endings": [
            _ending(
                "ending_qingcai_summer_good",
                typ="good",
                title="夏日祭典",
                subtitle="Summer Festival",
                description="谢幕掌声里，她对着你的方向比了心。烟火升起时，答案已经不用喊了。",
                cg_hint="校园烟火 · 舞台",
                character_id="qingcai",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 82,
                    "flags_all": ["confessed"],
                    "flags_any": ["dance_practice_done", "qc_festival", "qc_mirror"],
                },
            ),
            _ending(
                "ending_qingcai_audience_soft",
                typ="normal",
                title="软结局 · 固定观众",
                subtitle="Fixed Audience",
                description="她继续倒追世界，你继续坐在练舞室最后排。位置固定，关系也是。",
                cg_hint="练舞镜 · 水瓶",
                character_id="qingcai",
                conditions={
                    "affinity_min": 58,
                    "stage_max": "close_friend",
                    "flags_any": ["dance_practice_done", "qc_mirror"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
    "xiaoyang": {
        "tier": "T2",
        "name": "叶晓阳",
        "route_title": "社团海报上的名字",
        "theme": "校园节奏里的喜欢",
        "logline": "同班、相约学习；文化祭摊位把暧昧晒成阳光。",
        "acts": [
            {
                "id": "act1_club",
                "title": "海报",
                "beat": "一起做社团事务",
                "sprites": ["club_poster", "lab_coat", "school"],
                "flags": ["xyang_club", "club_festival_done"],
            },
            {
                "id": "act2_stall",
                "title": "摊位",
                "beat": "文化祭并肩；告白或维持同学",
                "sprites": ["culture_stall", "date", "casual"],
                "flags": ["xyang_stall", "confessed"],
            },
        ],
        "branches": {
            "good": "校园恋爱",
            "soft": "最好的同班同学",
        },
        "endings": [
            _ending(
                "ending_xiaoyang_stall_good",
                typ="good",
                title="摊位旁的告白",
                subtitle="By the Stall",
                description="卖完最后一份烤鱿鱼，她把围裙解给你系：「下一班——恋人值班。」",
                cg_hint="文化祭摊 · 夕阳",
                character_id="xiaoyang",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 80,
                    "flags_all": ["confessed"],
                    "flags_any": ["club_festival_done", "xyang_stall"],
                },
            ),
            _ending(
                "ending_xiaoyang_classmate_soft",
                typ="normal",
                title="软结局 · 同班如常",
                subtitle="Classmates",
                description="海报上仍是并列的名字。喜欢被折进书包，不拿出来晒。",
                cg_hint="教室窗 · 两本笔记",
                character_id="xiaoyang",
                conditions={
                    "affinity_min": 55,
                    "stage_max": "close_friend",
                    "flags_any": ["xyang_club", "club_festival_done"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
    "luna": {
        "tier": "T2",
        "name": "月露宁",
        "route_title": "星夜魔女的班次",
        "theme": "轻幻想包装的认真喜欢",
        "logline": "与温晚雨同店的她用塔罗和 cos 开玩笑；当你当真，她会脸红。",
        "acts": [
            {
                "id": "act1_tarot",
                "title": "休息室塔罗",
                "beat": "咖啡店休息时抽牌",
                "sprites": ["break_tarot", "work", "astro_apron"],
                "flags": ["ln_tarot", "witch_charm_done"],
            },
            {
                "id": "act2_moon",
                "title": "月亮班",
                "beat": "夜班收尾；护符与告白",
                "sprites": ["latte_moon", "date", "casual"],
                "flags": ["ln_moon_shift", "confessed"],
            },
        ],
        "branches": {
            "good": "玩笑落地成恋爱",
            "soft": "护符朋友",
        },
        "endings": [
            _ending(
                "ending_luna_moon_good",
                typ="good",
                title="月亮班次的恋人",
                subtitle="Moon Shift",
                description="她把「星夜魔女」护符改成一对。「魔法失效条款——如果你不牵手。」你牵了。",
                cg_hint="夜吧台 · 一对护符",
                character_id="luna",
                conditions={
                    "stage_min": "dating",
                    "affinity_min": 78,
                    "flags_all": ["confessed"],
                    "flags_any": ["witch_charm_done", "ln_moon_shift", "ln_tarot"],
                },
            ),
            _ending(
                "ending_luna_charm_soft",
                typ="normal",
                title="软结局 · 月咒护符",
                subtitle="Charm Only",
                description="护符还在，好运也在。恋爱的咒语，她暂时不念。",
                cg_hint="金粉护符 · 月光",
                character_id="luna",
                conditions={
                    "affinity_min": 58,
                    "stage_max": "close_friend",
                    "flags_any": ["witch_charm_done", "ln_tarot"],
                    "flags_absent": ["confessed"],
                },
            ),
        ],
    },
}

# 中立：2 幕羁绊线（禁恋爱）；NPC 不在此表
SHARED_NEUTRAL = [
    "ending_bond_ally",
    "ending_best_friend",
    "ending_friend",
    "ending_festival_memory",
    "ending_cold_distance",
    "ending_breakup",
]

NEUTRAL_ROUTES: dict[str, dict] = {
    "shuli": {
        "tier": "N",
        "name": "沈书璃",
        "route_title": "妹妹的日程本",
        "theme": "家人边界与被好好照顾的哥哥",
        "logline": "亲妹妹不许你把她当恋爱对象；她用晚饭和借书提醒，把家撑住。",
        "anchor": "pc_family",
        "acts": [
            {
                "id": "act1_dinner",
                "title": "晚饭点名",
                "beat": "她盯你乱作息；第一次认真谈「我们是家人」",
                "sprites": ["home", "school", "casual"],
                "flags": ["sibling_talk_done"],
            },
            {
                "id": "act2_ally",
                "title": "站在同一边",
                "beat": "你尊重边界后，她愿意在关键头替你说话",
                "sprites": ["library", "casual", "home"],
                "flags": ["bond_ally_done", "sibling_ally"],
            },
        ],
        "branches": {
            "good": "家人同盟，绝不越线",
            "soft": "普通兄妹日常",
        },
        "endings": [
            _ending(
                "ending_shuli_family_ally",
                typ="good",
                title="家人同盟",
                subtitle="Sibling Ally",
                description="她把日程本拍到你胸口：「恋爱随便你——但先按时吃饭。」这是妹妹能给的最高认证。",
                cg_hint="餐桌 · 日程本",
                character_id="shuli",
                cast_roles=["neutral"],
                conditions={
                    "stage_min": "close_friend",
                    "affinity_min": 70,
                    "trust_min": 70,
                    "flags_all": ["sibling_talk_done", "bond_ally_done"],
                    "flags_absent": ["confessed"],
                },
            ),
            _ending(
                "ending_shuli_schedule_soft",
                typ="normal",
                title="软结局 · 提醒吃饭的人",
                subtitle="Dinner Reminder",
                description="她仍会念你作息，却不再过问你心里装着谁。",
                cg_hint="玄关灯 · 便当",
                character_id="shuli",
                cast_roles=["neutral"],
                conditions={
                    "affinity_min": 55,
                    "stage_max": "close_friend",
                    "flags_any": ["sibling_talk_done"],
                    "flags_absent": ["confessed", "bond_ally_done"],
                },
            ),
        ],
    },
    "jingning": {
        "tier": "N",
        "name": "江静宁",
        "route_title": "堂姐的观察日记",
        "theme": "旁观职场恋与吐槽同盟",
        "logline": "江静流的堂妹看得一清二楚；她可以吐槽，但不会跟你谈恋爱。",
        "anchor": "jingliu",
        "acts": [
            {
                "id": "act1_watch",
                "title": "旁观",
                "beat": "时尚活动上撞见；她点破你对堂姐的在意",
                "sprites": ["casual", "work", "campus"],
                "flags": ["cousin_watch_done"],
            },
            {
                "id": "act2_toast",
                "title": "吐槽干杯",
                "beat": "她愿做你的情报同盟，条件是别伤害堂姐",
                "sprites": ["cafe", "casual"],
                "flags": ["bond_ally_done", "cousin_ally"],
            },
        ],
        "branches": {
            "good": "吐槽同盟",
            "soft": "点头之交的堂妹",
        },
        "endings": [
            _ending(
                "ending_jingning_watch_ally",
                typ="good",
                title="观察同盟",
                subtitle="Cousin Watch",
                description="她碰杯：「堂姐的面子我护着。你若真心，我帮腔；你若玩弄，我拆台。」",
                cg_hint="咖啡店 · 碰杯",
                character_id="jingning",
                cast_roles=["neutral"],
                conditions={
                    "stage_min": "close_friend",
                    "affinity_min": 68,
                    "trust_min": 65,
                    "flags_all": ["cousin_watch_done", "bond_ally_done"],
                    "flags_absent": ["confessed"],
                },
            ),
            _ending(
                "ending_jingning_nod_soft",
                typ="normal",
                title="软结局 · 活动上点头",
                subtitle="Fashion Nod",
                description="你们在秀场边缘点头致意。她记住你的脸，却不交换心事。",
                cg_hint="秀场外侧 · 名牌",
                character_id="jingning",
                cast_roles=["neutral"],
                conditions={
                    "affinity_min": 52,
                    "stage_max": "close_friend",
                    "flags_any": ["cousin_watch_done"],
                    "flags_absent": ["confessed", "bond_ally_done"],
                },
            ),
        ],
    },
    "youwei": {
        "tier": "N",
        "name": "柚未",
        "route_title": "画室里的第三支笔",
        "theme": "学妹视角的创作同盟",
        "logline": "苏晚悠的工作室学妹把你当可靠模特邻居；恋情留给学姐。",
        "anchor": "xiaoyou",
        "acts": [
            {
                "id": "act1_model",
                "title": "临时模特",
                "beat": "她拉你当速写模特，笑学姐又熬夜",
                "sprites": ["casual", "home", "work"],
                "flags": ["studio_sketch_done"],
            },
            {
                "id": "act2_pack",
                "title": "通贩打包",
                "beat": "一起帮苏晚悠打包；她承认你让学姐更安定",
                "sprites": ["casual", "work"],
                "flags": ["bond_ally_done", "studio_ally"],
            },
        ],
        "branches": {
            "good": "工作室同盟",
            "soft": "偶尔借颜料的学妹",
        },
        "endings": [
            _ending(
                "ending_youwei_studio_ally",
                typ="good",
                title="第三支笔",
                subtitle="Studio Ally",
                description="她把马克笔塞给你：「学姐的线我改不了——你负责让她睡觉。」",
                cg_hint="打包台 · 马克笔",
                character_id="youwei",
                cast_roles=["neutral"],
                conditions={
                    "stage_min": "close_friend",
                    "affinity_min": 68,
                    "trust_min": 64,
                    "flags_all": ["studio_sketch_done", "bond_ally_done"],
                    "flags_absent": ["confessed"],
                },
            ),
            _ending(
                "ending_youwei_borrow_soft",
                typ="normal",
                title="软结局 · 借颜料的人",
                subtitle="Paint Borrow",
                description="她仍会敲门借钛白。故事停在颜料与致谢。",
                cg_hint="颜料盒 · 门铃",
                character_id="youwei",
                cast_roles=["neutral"],
                conditions={
                    "affinity_min": 50,
                    "stage_max": "close_friend",
                    "flags_any": ["studio_sketch_done"],
                    "flags_absent": ["confessed", "bond_ally_done"],
                },
            ),
        ],
    },
    "yuxi": {
        "tier": "N",
        "name": "雨惜",
        "route_title": "顶班的死党",
        "theme": "护短与店里同盟",
        "logline": "温晚雨的高中死党在店里顶班；谁让温晚雨加班，她就瞪谁。",
        "anchor": "wanyu",
        "acts": [
            {
                "id": "act1_cover",
                "title": "顶班",
                "beat": "雨夜她替温晚雨收工，顺便盘问你",
                "sprites": ["work", "casual", "rain"],
                "flags": ["shift_cover_done"],
            },
            {
                "id": "act2_trust",
                "title": "松口",
                "beat": "确认你不会消耗温晚雨后，她把后厨钥匙逻辑讲给你听",
                "sprites": ["work", "casual"],
                "flags": ["bond_ally_done", "shift_ally"],
            },
        ],
        "branches": {
            "good": "死党认证的店内同盟",
            "soft": "只会点单的熟客",
        },
        "endings": [
            _ending(
                "ending_yuxi_shift_ally",
                typ="good",
                title="顶班认证",
                subtitle="Shift Ally",
                description="她把围裙抛给你：「今晚你收桌。温晚雨去睡觉——这是死党许可。」",
                cg_hint="吧台内侧 · 围裙",
                character_id="yuxi",
                cast_roles=["neutral"],
                conditions={
                    "stage_min": "close_friend",
                    "affinity_min": 68,
                    "trust_min": 66,
                    "flags_all": ["shift_cover_done", "bond_ally_done"],
                    "flags_absent": ["confessed"],
                },
            ),
            _ending(
                "ending_yuxi_order_soft",
                typ="normal",
                title="软结局 · 会点单的人",
                subtitle="Regular Order",
                description="她记得你的糖度，却不交换温晚雨以外的话题。",
                cg_hint="小票 · 雨窗",
                character_id="yuxi",
                cast_roles=["neutral"],
                conditions={
                    "affinity_min": 52,
                    "stage_max": "close_friend",
                    "flags_any": ["shift_cover_done"],
                    "flags_absent": ["confessed", "bond_ally_done"],
                },
            ),
        ],
    },
    "lingke": {
        "tier": "N",
        "name": "翎可",
        "route_title": "助教的红笔",
        "theme": "边界卫士与学术同盟",
        "logline": "顾若铃的研究生助教对越线零容忍；过关后她是最稳的答疑盟友。",
        "anchor": "ruolin",
        "acts": [
            {
                "id": "act1_guard",
                "title": "警告",
                "beat": "她明确划线：学期内勿逾矩",
                "sprites": ["work", "school", "casual"],
                "flags": ["boundary_guard_done"],
            },
            {
                "id": "act2_pass",
                "title": "放行",
                "beat": "你守住边界后，她承认你可以平等地站在导师身侧",
                "sprites": ["campus", "work"],
                "flags": ["bond_ally_done", "boundary_pass"],
            },
        ],
        "branches": {
            "good": "边界过关的学术同盟",
            "soft": "只会发通知的助教",
        },
        "endings": [
            _ending(
                "ending_lingke_boundary_ally",
                typ="good",
                title="红笔放行",
                subtitle="Boundary Pass",
                description="她收起红笔：「规则你守过了。以后办公室的门——对你和导师，我不再拦。」",
                cg_hint="办公桌 · 红笔",
                character_id="lingke",
                cast_roles=["neutral"],
                conditions={
                    "stage_min": "close_friend",
                    "affinity_min": 66,
                    "trust_min": 72,
                    "flags_all": ["boundary_guard_done", "bond_ally_done"],
                    "flags_absent": ["confessed"],
                },
            ),
            _ending(
                "ending_lingke_notice_soft",
                typ="normal",
                title="软结局 · 通知栏",
                subtitle="Notice Only",
                description="她只在群里发截止日。你们没有私下话题。",
                cg_hint="课程群 · 通知",
                character_id="lingke",
                cast_roles=["neutral"],
                conditions={
                    "affinity_min": 48,
                    "stage_max": "close_friend",
                    "flags_any": ["boundary_guard_done"],
                    "flags_absent": ["confessed", "bond_ally_done"],
                },
            ),
        ],
    },
    "aichen": {
        "tier": "N",
        "name": "艾忱",
        "route_title": "闺蜜的审核",
        "theme": "复联守门与托底同盟",
        "logline": "夏艾黎的闺蜜礼貌审视；过审后她肯把花艺圈的后路托你一份。",
        "anchor": "aili",
        "acts": [
            {
                "id": "act1_gate",
                "title": "审核",
                "beat": "咖啡桌对面的盘问：你为何回头",
                "sprites": ["casual", "work", "cafe"],
                "flags": ["friend_gate_done"],
            },
            {
                "id": "act2_hold",
                "title": "托底",
                "beat": "她松口：若你再伤夏艾黎，花圈会先找到你",
                "sprites": ["casual", "home"],
                "flags": ["bond_ally_done", "friend_hold"],
            },
        ],
        "branches": {
            "good": "闺蜜过审的托底同盟",
            "soft": "花艺活动上的客气人",
        },
        "endings": [
            _ending(
                "ending_aichen_gate_ally",
                typ="good",
                title="过审托底",
                subtitle="Gate Pass",
                description="她把一枝备用花材塞给你：「送给她。下次再让她哭，花圈我先备好。」语气却是笑着的。",
                cg_hint="花材 · 咖啡桌",
                character_id="aichen",
                cast_roles=["neutral"],
                conditions={
                    "stage_min": "close_friend",
                    "affinity_min": 68,
                    "trust_min": 70,
                    "flags_all": ["friend_gate_done", "bond_ally_done"],
                    "flags_absent": ["confessed"],
                },
            ),
            _ending(
                "ending_aichen_polite_soft",
                typ="normal",
                title="软结局 · 礼貌审视",
                subtitle="Polite Gaze",
                description="她永远客气。审核未结束，同盟也未开始。",
                cg_hint="活动签到台 · 微笑",
                character_id="aichen",
                cast_roles=["neutral"],
                conditions={
                    "affinity_min": 50,
                    "stage_max": "close_friend",
                    "flags_any": ["friend_gate_done"],
                    "flags_absent": ["confessed", "bond_ally_done"],
                },
            ),
        ],
    },
}


# ---------------------------------------------------------------------------
# SSOT：data/story_routes.json（characters / tier_policy）
# 上方 ROUTES / NEUTRAL_ROUTES 为历史草稿，禁止再覆盖 JSON。
# ---------------------------------------------------------------------------

TIER_POLICY_SSOT = {
    "T0": {
        "acts": 7,
        "unique_endings": "true + good + soft + bad (=4)",
        "sprite_drive": "signature / season / intimate 全程可用",
        "gate": "绑定中立同盟 flag 卡真结局",
        "season_acts": "winter + festival waypoint-gated",
        "note": "原6幕+危机转折幕；sprite 挂钩签名/季节/亲密等已有包",
    },
    "T1": {
        "acts": 6,
        "unique_endings": "true + good + soft + bad (=4)",
        "sprite_drive": "扩包签名支撑关键幕",
        "cross_bonds": "部分女主互有 edges",
        "season_acts": "winter + festival waypoint-gated",
        "note": "原5幕+危机幕；充分利用立绘",
    },
    "T2": {
        "acts": 4,
        "unique_endings": "good + soft + bad (=3)",
        "sprite_drive": "维持站姿换装，不依赖扩包",
        "role": "轻副本；少跨线；结局不吃其他角色 flag",
        "season_acts": "winter + festival waypoint-gated",
    },
    "N": {
        "acts": 3,
        "unique_endings": "bond good + soft + shadow garden (=3)",
        "sprite_drive": "C档 + 日常扩装 + T2同列§2.3–§2.8（故意展示）；禁 intimate/bridal",
        "gate": "可卡绑定 T0 真结局；戏份高于 T2；高好感可进影子花园",
        "alias_of": "L",
        "deprecated_note": "旧中立语义；请用 L/linked",
    },
    "L": {
        "acts": 4,
        "unique_endings": "true + good/soft + bad",
        "sprite_drive": "中档冬装/生活态 + 签名",
        "gate": "锚点介绍 + 本人开放 flag + 锚点同盟 flag；未破门 stage cap close_friend",
        "role": "关系向难攻略；可卡绑定女主真结局，也被女主门卡住",
    },
    "L0": {
        "acts": 6,
        "role": "书璃主轴",
        "unique_endings": "true+good+soft+shadow+bad×2",
    },
}

NOTES_SSOT = (
    "romance T0/T1 加厚含危机幕；T2 轻副本；linked 关系向；书璃 L0 主轴；"
    "幕 sprites/事件 sprite_hint 尽量挂钩已有立绘包。"
)


def load_story_routes() -> dict:
    path = DATA / "story_routes.json"
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_story_routes(payload: dict) -> dict:
    """以现有 characters 为 SSOT，只校正外壳字段，绝不从 ROUTES 重建幕。"""
    chars = payload.get("characters") or {}
    if not chars:
        raise SystemExit("story_routes.json characters empty — refuse to rebuild from legacy ROUTES")

    payload["version"] = int(payload.get("version") or 2)
    payload["notes"] = NOTES_SSOT
    payload["pc"] = {
        "summary": "落脚小镇的上班族；亲妹妹沈书璃、义妹沈枫音同住。",
        "home_with": ["shuli", "fengyin"],
    }
    payload["tier_policy"] = dict(TIER_POLICY_SSOT)
    payload["shared_romance_endings"] = list(SHARED)
    payload["shared_neutral_endings"] = list(SHARED_NEUTRAL)
    payload["npc_policy"] = {
        "ids": [],
        "allowed_endings": [],
        "story_branches": False,
        "note": "无有名 NPC；路人立绘仅地点背景装饰，不参与结局与分支",
    }
    # 确保 character_id 字段齐全
    for cid, row in chars.items():
        row["character_id"] = cid
        if cid == "shuli":
            row["tier"] = "L0"
            row["cast_kind"] = "linked"
            row["prime_heroine"] = True
            row["anchor"] = row.get("anchor") or "pc_family"
    payload["characters"] = chars
    return payload


def merge_endings_json(routes: dict | None = None) -> None:
    """清理过期 id；不把 legacy ROUTES 结局覆盖进 endings.json。"""
    path = DATA / "endings.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    existing = {e["id"]: e for e in data.get("endings") or []}

    obsolete = {
        "ending_spirit_bond",
        "ending_tsundere_heart",
        "ending_gentle_forever",
        "ending_cheerful_summer",
        "ending_sharp_honesty",
        "ending_neighbor_heart",
        "ending_cafe_rain",
        "ending_office_sync",
        "ending_chorus_stage",
        "ending_rival_spark",
        "ending_mentor_guide",
        "ending_witch_omen",
        "ending_bond_boost_true",
        "ending_heqing",
        "ending_xiaoke",
        "ending_lele",
        "ending_anran",
    }
    for oid in obsolete:
        existing.pop(oid, None)
    old_neutrals = {"heqing", "xiaoke", "lele", "anran"}
    for eid, e in list(existing.items()):
        cids = set(e.get("character_ids") or [])
        if cids and cids <= old_neutrals:
            existing.pop(eid, None)

    # 校验：routes 声明的 unique endings 必须已在 endings.json
    routes = routes or load_story_routes()
    missing: list[str] = []
    for cid, row in (routes.get("characters") or {}).items():
        for eid in row.get("unique_ending_ids") or []:
            if eid not in existing:
                missing.append(f"{cid}:{eid}")
    if missing:
        raise SystemExit(
            "endings.json missing unique endings from story_routes: " + ", ".join(missing[:20])
        )

    for e in existing.values():
        roles = list(e.get("cast_roles") or [])
        if "npc" in roles:
            e["cast_roles"] = [r for r in roles if r != "npc"]

    type_order = {"secret": 0, "good": 1, "normal": 2, "bad": 3}
    merged = sorted(existing.values(), key=lambda e: (type_order.get(e.get("type"), 9), e["id"]))
    path.write_text(
        json.dumps({"endings": merged}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"endings.json -> {len(merged)} endings (SSOT preserved)")


def update_route_catalog(routes: dict | None = None) -> None:
    """按 story_routes.json characters 同步 route_catalog。"""
    routes = routes or load_story_routes()
    chars = routes.get("characters") or {}
    path = DATA / "route_catalog.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    by_id = {r["character_id"]: r for r in data.get("routes") or []}

    romance_n = linked_n = 0
    for cid, row in chars.items():
        route = by_id.get(cid)
        if not route:
            route = {
                "character_id": cid,
                "base_id": "gentle_lover",
                "growth_mode": "progressive",
                "start_stage_id": "friend",
                "target_stage_id": "dating",
                "max_stage_id": "married",
            }
            data.setdefault("routes", []).append(route)
            by_id[cid] = route

        tier = str(row.get("tier") or "")
        cast_kind = str(row.get("cast_kind") or "romance")
        unique = list(row.get("unique_ending_ids") or [])
        title = str(row.get("route_title") or cid)

        if cast_kind == "linked" or tier in ("L", "L0", "N"):
            linked_n += 1
            shared = list(SHARED_NEUTRAL)
            # 关系向 / L0：可恋爱；共享中立池 + 独有
            route["cast_role"] = "linked"
            route["story_tier"] = tier if tier in ("L", "L0") else "L"
            route["max_stage_id"] = "married"
            if not route.get("target_stage_id") or route.get("target_stage_id") == "close_friend":
                route["target_stage_id"] = "dating"
            if tier == "L0":
                route["route_label"] = f"{title}（L0·主轴女主）"
            else:
                route["route_label"] = f"{title}（关系向·可恋爱）"
        else:
            romance_n += 1
            shared = list(SHARED)
            route["cast_role"] = "romance"
            route["story_tier"] = tier
            route["route_label"] = f"{title}（{tier}）"
            route["max_stage_id"] = route.get("max_stage_id") or "married"

        route["allowed_endings"] = list(dict.fromkeys(unique + shared))

    drop_ids = {"heqing", "xiaoke", "lele", "anran", "moxi", "luli"}
    data["routes"] = [
        r for r in (data.get("routes") or []) if r.get("character_id") not in drop_ids
    ]

    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"route_catalog: romance={romance_n} linked={linked_n} npc=0")


def write_story_routes() -> dict:
    path = DATA / "story_routes.json"
    payload = normalize_story_routes(load_story_routes())
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"story_routes.json -> {len(payload['characters'])} characters (SSOT normalized)")
    return payload


def main() -> None:
    payload = write_story_routes()
    merge_endings_json(payload)
    update_route_catalog(payload)


if __name__ == "__main__":
    main()
