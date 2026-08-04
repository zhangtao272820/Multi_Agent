# -*- coding: utf-8 -*-
"""Emit T2 seasonal act5 YAML + exclusive bad endings into data/."""
from __future__ import annotations

import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"
ENDINGS = ROOT / "data" / "endings.json"
PRESENTATION = ROOT / "data" / "presentation_catalog.json"
ROUTE_CATALOG = ROOT / "data" / "route_catalog.json"
STORY_ROUTES = ROOT / "data" / "story_routes.json"
STORY_WEB = ROOT / "data" / "story_web.json"

SPECS = [
    {
        "cid": "fengyin",
        "name": "沈枫音",
        "winter_id": "story_fengyin_act5_winter_door",
        "winter_label": "冬夜敲门",
        "winter_flag": "fy_winter_door",
        "prev_flag": "fy_equal",
        "fest_id": "story_fengyin_act5b_spring_eaves",
        "fest_label": "新春·屋檐",
        "fest_flag": "fy_spring_eaves",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_spring_festival",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_spring",
        "bad_id": "ending_fengyin_no_knock",
        "bad_title": "再不敲门",
        "bad_desc": "同一屋檐下你们成了平行线。她的房门关死，你再也没有资格敲门。",
        "bad_flag": "fengyin_route_bad",
        "summaries_w": [
            "入冬客厅只开小灯；她把热可可放你手边，却先站在自己房门口等你敲。",
            "她说冬天也要先敲门——不是赌气，是确认你把她当成年人。",
            "你是敲门进去，还是径直推开；界线会被尊重，或永远关上。",
        ],
        "summaries_f": [
            "春节她穿新春装在玄关贴福字，却把房门钥匙别在自己腰上。",
            "她问：过年也想进我的世界，就先敲——一声就够。",
            "年夜将尽；敲或不敲，会决定屋檐下是并肩，还是再也不见。",
        ],
    },
    {
        "cid": "xingnai",
        "name": "程星宁",
        "winter_id": "story_xingnai_act5_winter_album",
        "winter_label": "冬夜相册",
        "winter_flag": "xn_winter_album",
        "prev_flag": "xn_album",
        "fest_id": "story_xingnai_act5b_newyear_gap",
        "fest_label": "元旦·合影缺口",
        "fest_flag": "xn_newyear_gap",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_winter_newyear",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_spring",
        "bad_id": "ending_xingnai_blank_gap",
        "bad_title": "永远的缺口",
        "bad_desc": "合影缺口永远空着。旧相册还在，那一格却被她贴上了空白贴纸。",
        "bad_flag": "xingnai_route_bad",
        "summaries_w": [
            "入冬天台风硬；她把相册翻到缺口那页，围巾捂住半张脸。",
            "她说冬天适合补拍——不是童年作业，是想确认你还愿不愿意入镜。",
            "你是并肩按下快门，还是让缺口继续空着；回忆会被补全或封存。",
        ],
        "summaries_f": [
            "元旦她穿节日装站在旧照相馆前，相机里还留着一张未拍完的合影。",
            "她把自拍杆递给你：「缺口只留给你——填或不填。」",
            "年夜将尽；入镜或躲开，会决定相册是完整，还是永久空白。",
        ],
    },
    {
        "cid": "luna",
        "name": "月露宁",
        "winter_id": "story_luna_act5_winter_tarot",
        "winter_label": "冬夜塔罗",
        "winter_flag": "ln_winter_tarot",
        "prev_flag": "ln_moon_shift",
        "fest_id": "story_luna_act5b_midautumn_charm",
        "fest_label": "中秋·护符",
        "fest_flag": "ln_midautumn_charm",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_autumn_midautumn",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_midautumn",
        "bad_id": "ending_luna_false_charm",
        "bad_title": "玩笑落空",
        "bad_desc": "塔罗与护符都成了再也当真不了的玩笑。月亮班次还在，她却不再翻给你看牌。",
        "bad_flag": "luna_route_bad",
        "summaries_w": [
            "入冬休息室暖气薄；她把塔罗牌摊开，却少了那张「恋人」。",
            "魔女壳卸下一半：冬天适合问一句——你还愿不愿意当真。",
            "你是接住牌面，还是笑着推开；预言会被兑现或永久落空。",
        ],
        "summaries_f": [
            "中秋她穿节日装坐在店后门，月饼旁放着一枚未系绳的护符。",
            "她轻声说：护符只给一个名字——写你，或收进抽屉。",
            "月圆将尽；当真或当玩笑，会决定月亮班次是恋人，还是客人。",
        ],
    },
    {
        "cid": "qingcai",
        "name": "夏晴彩",
        "winter_id": "story_qingcai_act5_winter_mirror",
        "winter_label": "冬练舞室",
        "winter_flag": "qc_winter_mirror",
        "prev_flag": "qc_festival",
        "fest_id": "story_qingcai_act5b_spring_stage",
        "fest_label": "新春·舞台",
        "fest_flag": "qc_spring_stage",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_spring_festival",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_spring",
        "bad_id": "ending_qingcai_empty_stage",
        "bad_title": "空舞台",
        "bad_desc": "舞台亮灯时你不在。她把直球收回胸口，观众席第一排永远空着。",
        "bad_flag": "qingcai_route_bad",
        "summaries_w": [
            "入冬练舞室镜面起雾；她把外套扔给你，汗还没干就问你还看不看。",
            "直球放慢了一拍：冬天适合确认——你是观众，还是她要对着说的那个人。",
            "你是留下看完整段，还是提前离场；舞台会被点亮或永久空着。",
        ],
        "summaries_f": [
            "春节特别公演前，她穿节日装却把第一排座位牌写上你的名字。",
            "后台她擦汗：「灯亮时我想看见你——不是观众席的任何人。」",
            "倒计时开始；你到不到场，会决定舞台是为你亮，还是空空如也。",
        ],
    },
    {
        "cid": "xiaoyang",
        "name": "叶晓阳",
        "winter_id": "story_xiaoyang_act5_winter_club",
        "winter_label": "冬社团",
        "winter_flag": "xyang_winter_club",
        "prev_flag": "xyang_stall",
        "fest_id": "story_xiaoyang_act5b_midautumn_poster",
        "fest_label": "中秋·海报",
        "fest_flag": "xyang_midautumn_poster",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_autumn_midautumn",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_midautumn",
        "bad_id": "ending_xiaoyang_poster_torn",
        "bad_title": "撕掉的名字",
        "bad_desc": "海报上你的名字被撕掉。同班还在，她却再也不把你写进社团栏。",
        "bad_flag": "xiaoyang_route_bad",
        "summaries_w": [
            "入冬社团室暖气刚开；她把新海报铺开，名字栏还空着一格。",
            "她说冬天适合问清楚——你还愿不愿让名字和她并排。",
            "你是认领那一格，还是让她撕掉草稿；海报会被贴上或永远缺席。",
        ],
        "summaries_f": [
            "中秋文化祭预热，她穿节日装举着半成品海报：「名字——写你还是撕掉？」",
            "烤盘旁她小声说：同班可以，但这一格只想留给认真的人。",
            "月色进窗；写或不写，会决定海报是并肩，还是撕成两半。",
        ],
    },
]


def write_act(obj: dict) -> None:
    path = EVENTS / f"{obj['id']}.yaml"
    path.write_text(yaml.safe_dump(obj, allow_unicode=True, sort_keys=False), encoding="utf-8")
    print("wrote", path.name)


def main() -> None:
    for s in SPECS:
        winter = {
            "id": s["winter_id"],
            "label": s["winter_label"],
            "priority": 6,
            "once": True,
            "chance": 1.0,
            "scene_id": "",
            "trigger": {
                "character_ids": [s["cid"]],
                "stage_min": "crush",
                "affinity_min": 70,
                "flags_present": [s["prev_flag"]],
                "flags_absent": [s["winter_flag"]],
                "waypoint_min": s["waypoint"],
                "season": "winter",
            },
            "prompt_snippet": f"【专属故事 · {s['name']} · 冬季加幕 · {s['winter_label']}】\n",
            "advance": "on_player_turn",
            "beats": [
                {
                    "id": "b1",
                    "summary": s["summaries_w"][0],
                    "sprite_hint": [s["winter_outfit"], "home"],
                    "soft_options": ["留下", "关心一句", "告辞"],
                },
                {
                    "id": "b2",
                    "summary": s["summaries_w"][1],
                    "sprite_hint": [s["winter_outfit"], "casual"],
                    "soft_options": ["靠近", "安静听", "换话题"],
                },
                {
                    "id": "b3",
                    "summary": s["summaries_w"][2],
                    "sprite_hint": [s["winter_outfit"], "date"],
                    "soft_options": ["认真回应", "先缓一缓", "推开"],
                },
            ],
            "rewards": {"flags_set": [s["winter_flag"]]},
            "choice_effects": [
                {"trust_delta": 3, "affinity_delta": 3},
                {"trust_delta": 2, "affinity_delta": 1},
                {"trust_delta": -3, "affinity_delta": -2},
            ],
        }
        fest = {
            "id": s["fest_id"],
            "label": s["fest_label"],
            "priority": 6,
            "once": True,
            "chance": 1.0,
            "scene_id": "",
            "trigger": {
                "character_ids": [s["cid"]],
                "stage_min": "crush",
                "affinity_min": 72,
                "flags_present": [s["winter_flag"]],
                "flags_absent": [s["fest_flag"]],
                "waypoint_min": s["fest_wp"],
            },
            "prompt_snippet": f"【专属故事 · {s['name']} · 节日加幕 · {s['fest_label']}】\n",
            "advance": "on_player_turn",
            "beats": [
                {
                    "id": "b1",
                    "summary": s["summaries_f"][0],
                    "sprite_hint": [s["fest_outfit"], s["winter_outfit"]],
                    "soft_options": ["夸她", "点头", "沉默"],
                },
                {
                    "id": "b2",
                    "summary": s["summaries_f"][1],
                    "sprite_hint": [s["fest_outfit"], "date"],
                    "soft_options": ["接住", "问清楚", "退一步"],
                },
                {
                    "id": "b3",
                    "summary": s["summaries_f"][2],
                    "sprite_hint": [s["fest_outfit"], "home"],
                    "soft_options": ["承诺", "诚实犹豫", "拒绝"],
                },
            ],
            "rewards": {"flags_set": [s["fest_flag"]]},
            "choice_effects": [
                {"trust_delta": 4, "affinity_delta": 3},
                {"trust_delta": 1, "affinity_delta": 1},
                {
                    "trust_delta": -4,
                    "affinity_delta": -3,
                    "flags": {s["bad_flag"]: True},
                },
            ],
        }
        write_act(winter)
        write_act(fest)

    endings_raw = json.loads(ENDINGS.read_text(encoding="utf-8"))
    endings = endings_raw.setdefault("endings", [])
    existing = {e.get("id") for e in endings}
    for s in SPECS:
        if s["bad_id"] in existing:
            continue
        endings.append(
            {
                "id": s["bad_id"],
                "type": "bad",
                "title": s["bad_title"],
                "subtitle": "Bad End",
                "description": s["bad_desc"],
                "cg_hint": "雨窗 · 背影",
                "character_ids": [s["cid"]],
                "cast_roles": ["romance"],
                "conditions": {
                    "flags_present": [s["bad_flag"]],
                    "affinity_max": 55,
                    "trust_max": 45,
                },
            }
        )
        print("ending", s["bad_id"])
    ENDINGS.write_text(json.dumps(endings_raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    pres = json.loads(PRESENTATION.read_text(encoding="utf-8"))
    pe = pres.setdefault("endings", {})
    for s in SPECS:
        pe[s["bad_id"]] = {
            "bg": "rain.png",
            "bgm": "ending_bad",
            "sprite": {"character_id": s["cid"], "outfit": "casual", "emotion": "sad"},
            "pages": [
                s["bad_desc"],
                (
                    f"雨还在下，{s['name']}的背影越走越远。"
                    "小镇灯火照常亮着，你们却像走在两条平行的街上——"
                    "有些选择不会再给你第二遍，有些痕迹也不会被节日冲淡。"
                    "这一页，是你们共同写下的收束。"
                ),
            ],
        }
    PRESENTATION.write_text(json.dumps(pres, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("presentation bad pages ok")

    cat = json.loads(ROUTE_CATALOG.read_text(encoding="utf-8"))
    for route in cat.get("routes") or []:
        cid = route.get("character_id")
        spec = next((x for x in SPECS if x["cid"] == cid), None)
        if not spec:
            continue
        allowed = list(route.get("allowed_endings") or [])
        if spec["bad_id"] not in allowed:
            allowed.append(spec["bad_id"])
            route["allowed_endings"] = allowed
            print("route allow", cid, spec["bad_id"])
    ROUTE_CATALOG.write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    routes = json.loads(STORY_ROUTES.read_text(encoding="utf-8"))
    tp = routes.setdefault("tier_policy", {}).setdefault("T2", {})
    tp["acts"] = 4
    tp["unique_endings"] = "good + soft + bad (=3)"
    tp["season_acts"] = "winter + festival waypoint-gated"
    chars = routes.setdefault("characters", {})
    for s in SPECS:
        row = chars.get(s["cid"])
        if not row:
            continue
        acts = list(row.get("acts") or [])
        act_ids = {a.get("id") for a in acts}
        winter_act = {
            "id": "act5_winter",
            "title": s["winter_label"],
            "beat": "入冬航点专属幕；冬装必现",
            "sprites": [s["winter_outfit"], "home", "casual"],
            "flags": [s["winter_flag"]],
            "waypoint_min": s["waypoint"],
            "event_id": s["winter_id"],
        }
        fest_act = {
            "id": "act5b_festival",
            "title": s["fest_label"],
            "beat": "节日航点专属幕；节日装必现",
            "sprites": [s["fest_outfit"], s["winter_outfit"]],
            "flags": [s["fest_flag"]],
            "waypoint_min": s["fest_wp"],
            "event_id": s["fest_id"],
        }
        if "act5_winter" not in act_ids:
            acts.append(winter_act)
        if "act5b_festival" not in act_ids:
            acts.append(fest_act)
        row["acts"] = acts
        uids = list(row.get("unique_ending_ids") or [])
        if s["bad_id"] not in uids:
            uids.append(s["bad_id"])
        row["unique_ending_ids"] = uids
        print("story_routes", s["cid"], "acts", len(acts))
    STORY_ROUTES.write_text(json.dumps(routes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if STORY_WEB.is_file():
        web = json.loads(STORY_WEB.read_text(encoding="utf-8"))
        tt = web.setdefault("tier_thickness", {})
        tt["T2"] = "轻副本：2+季节幕；好/软/专属坏；少跨线"
        STORY_WEB.write_text(json.dumps(web, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("story_web T2 thickness updated")

    print("done")


if __name__ == "__main__":
    main()
