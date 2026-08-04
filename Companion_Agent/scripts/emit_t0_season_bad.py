# -*- coding: utf-8 -*-
"""Emit T0 seasonal act5 YAML + bad endings into data/."""
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

SPECS = [
    {
        "cid": "xiaoyou",
        "name": "苏晚悠",
        "winter_id": "story_xiaoyou_act5_winter_frame",
        "winter_label": "冬窗与未干的颜料",
        "winter_flag": "xy_winter_frame",
        "prev_flag": "xy_life_outside_frame",
        "fest_id": "story_xiaoyou_act5b_spring_ink",
        "fest_label": "新春·红笺速写",
        "fest_flag": "xy_spring_ink",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_spring_festival",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_spring",
        "bad_id": "ending_xiaoyou_blank_canvas",
        "bad_title": "空白画布",
        "bad_desc": "她把速写本合上，说邻居之间最好只剩门铃。颜料干了，窗也关了。",
        "bad_flag": "xiaoyou_route_bad",
        "summaries_w": [
            "入冬的阳台结了薄霜；她把围巾递过来，颜料盒却还敞着——冷空气里仍在画你呵出的白气。",
            "她说冬天适合画「没画进夏天的东西」；窗玻璃起雾，你的名字被她用指尖写了又擦掉。",
            "你选择陪她守这扇冬窗，或劝她休息；无论哪边，关系都会被冻得更清晰。",
        ],
        "summaries_f": [
            "除夕夜她穿上新春衣裳，却仍抱着速写本；红灯笼映在纸上，像未完成的祝福。",
            "她问你：要不要留下一笔「收件人」——不是客套贺词，是给彼此的名字。",
            "年夜将尽；你的回答会决定这页红笺是封存，还是一起写下去。",
        ],
    },
    {
        "cid": "wanyu",
        "name": "温晚雨",
        "winter_id": "story_wanyu_act5_winter_steam",
        "winter_label": "冬夜关店蒸汽",
        "winter_flag": "wy_winter_steam",
        "prev_flag": "wy_kept_seat",
        "fest_id": "story_wanyu_act5b_midautumn_cup",
        "fest_label": "中秋·关店一杯",
        "fest_flag": "wy_midautumn_cup",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_autumn_midautumn",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_midautumn",
        "bad_id": "ending_wanyu_cold_counter",
        "bad_title": "冷柜台",
        "bad_desc": "她仍为你留位，却不再倒第二杯。蒸汽散尽，熟客也成了过客。",
        "bad_flag": "wanyu_route_bad",
        "summaries_w": [
            "入冬后最后一个客人走了；她把热毛巾递到你手心，蒸汽模糊了玻璃上的菜单。",
            "她说「店可以关，温度不能关」——话轻，却像把一整季疲惫摊开。",
            "你是留下来帮她收尾，还是把她送回家；选择会改写关店之后的温度。",
        ],
        "summaries_f": [
            "中秋月圆，店里却提早打烊；她换上节日装，却仍系着围裙带。",
            "月饼切开两半，她把有蛋黄的那半推给你：「熟客位——今晚只留你。」",
            "窗外有人放烟花；你接不接这杯，决定她要不要把节庆也留给你。",
        ],
    },
    {
        "cid": "ruolin",
        "name": "顾若铃",
        "winter_id": "story_ruolin_act5_winter_office",
        "winter_label": "冬夜答疑室",
        "winter_flag": "rl_winter_office",
        "prev_flag": "rl_peer_name",
        "fest_id": "story_ruolin_act5b_spring_boundary",
        "fest_label": "新春·边界之外",
        "fest_flag": "rl_spring_boundary",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_spring_festival",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_spring",
        "bad_id": "ending_ruolin_red_pen",
        "bad_title": "红笔判回",
        "bad_desc": "她把师生边界重新划死。答疑室门锁上，你的名字只剩学号。",
        "bad_flag": "ruolin_route_bad",
        "summaries_w": [
            "入冬的办公室只剩她与投影仪的冷光；她把围巾挂好，仍称你「同学」——却语气发软。",
            "她摊开成绩单外的空白页：边界课讲完了，剩下的不能写进教案。",
            "你守边界还是跨过称谓；若铃的底线会记住这一夜。",
        ],
        "summaries_f": [
            "春节她仍穿着端庄节日装，却摘下了名牌；红灯笼下，师生距离忽然无处安放。",
            "她说：「过年也不许越线——除非你先学会用名字叫我。」",
            "你的称呼与距离，会决定真结局的门，还是把关系推回冷战。",
        ],
    },
    {
        "cid": "jingliu",
        "name": "江静流",
        "winter_id": "story_jingliu_act5_winter_rooftop",
        "winter_label": "冬日天台",
        "winter_flag": "jl_winter_rooftop",
        "prev_flag": "jl_equal_choice",
        "fest_id": "story_jingliu_act5b_newyear_card",
        "fest_label": "元旦·工牌背面",
        "fest_flag": "jl_newyear_card",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_winter_newyear",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_spring",
        "bad_id": "ending_jingliu_glass_door",
        "bad_title": "玻璃门内",
        "bad_desc": "她把私人夜谈收进抽屉。你仍是可靠下属——只是再也走不进天台。",
        "bad_flag": "jingliu_route_bad",
        "summaries_w": [
            "入冬的天台风更大；她把大衣领竖起，工牌仍别在内侧——权力差被冷风吹薄一层。",
            "她递来热饮：「汇报语气可以停了。」话短，却像把一整季职场面具摘下。",
            "你接不接这杯，决定她要不要把私人夜谈写进下一年。",
        ],
        "summaries_f": [
            "元旦她穿节日装出现在空办公室，把工牌翻到背面——只有名字。",
            "她说：「新的一年不写职位。」风从走廊尽头来，像在等你表态。",
            "专一与对等；你的选择会通向天台之后，或渐行渐远。",
        ],
    },
    {
        "cid": "aili",
        "name": "夏艾黎",
        "winter_id": "story_aili_act5_winter_greenhouse",
        "winter_label": "冬日温室",
        "winter_flag": "al_winter_greenhouse",
        "prev_flag": "al_choose_again",
        "fest_id": "story_aili_act5b_spring_bouquet",
        "fest_label": "新春·无标签花束",
        "fest_flag": "al_spring_bouquet",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_spring_festival",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_spring",
        "bad_id": "ending_aili_wilted_stem",
        "bad_title": "枯茎",
        "bad_desc": "她仍礼貌点头，却不再把花束递出。重建停在邻里寒暄，旧伤也结成痂。",
        "bad_flag": "aili_route_bad",
        "summaries_w": [
            "入冬温室仍潮热；她剪掉枯枝，说旧婚书早已埋进土里——重建不是回档。",
            "她把暖手套塞给你：「别用同情的眼神。」花香与土腥气缠在一起。",
            "你是并肩修剪，还是退回邻里礼貌；会改写第二次开花的可能。",
        ],
        "summaries_f": [
            "除夕她穿新春装，却递来一束没有祝福签的花：「收件人栏——空着。」",
            "她等你写名字，也等你不写；重建的勇气需要对等的选择。",
            "年夜将尽；接过花束或推开，都会留下不可回档的痕迹。",
        ],
    },
    {
        "cid": "linxi",
        "name": "陆凛汐",
        "winter_id": "story_linxi_act5_winter_rail",
        "winter_label": "冬末班车",
        "winter_flag": "lx_winter_rail",
        "prev_flag": "lx_one_step",
        "fest_id": "story_linxi_act5b_spring_desk",
        "fest_label": "新春·工位一步",
        "fest_flag": "lx_spring_desk",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_spring_festival",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_spring",
        "bad_id": "ending_linxi_missed_train",
        "bad_title": "错过末班",
        "bad_desc": "她仍对桌加班，却不再等你一起走。工位之间那一步，被她自己收回。",
        "bad_flag": "linxi_route_bad",
        "summaries_w": [
            "入冬末班车更空；她把红丝带绕在手套上，说加班可以，逞强不行。",
            "车窗结雾，她把工牌按在玻璃上：「座位之间其实只要一步。」",
            "你并肩挤过车门，或各自下车；实习期的并肩会被改写。",
        ],
        "summaries_f": [
            "春节加班室只亮一盏灯；她换上节日装却仍戴工牌，笑得有点紧。",
            "她把转正名单复印件折成纸飞机：「别再装不熟。」",
            "你接不接这步，决定工位之间是同盟，还是永远差一步。",
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
                "affinity_min": 78,
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
                "affinity_min": 80,
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

    # endings.json — append T0 bad if missing
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

    # presentation_catalog endings pages
    pres = json.loads(PRESENTATION.read_text(encoding="utf-8"))
    pe = pres.setdefault("endings", {})
    for s in SPECS:
        pe[s["bad_id"]] = {
            "bg": "rain.png",
            "bgm": "ending_bad",
            "sprite": {"character_id": s["cid"], "outfit": "casual", "emotion": "sad"},
            "pages": [
                s["bad_desc"],
                "小镇还在过节，你们却像走在两条平行的街上。有些选择，不会再给你第二遍。",
            ],
        }
    PRESENTATION.write_text(json.dumps(pres, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("presentation bad pages ok")

    # route_catalog allowed_endings
    cat = json.loads(ROUTE_CATALOG.read_text(encoding="utf-8"))
    for route in cat.get("routes") or []:
        cid = route.get("character_id")
        spec = next((x for x in SPECS if x["cid"] == cid), None)
        if not spec:
            continue
        allowed = list(route.get("allowed_endings") or [])
        if spec["bad_id"] not in allowed:
            # insert after soft if possible
            allowed.append(spec["bad_id"])
            route["allowed_endings"] = allowed
            print("route allow", cid, spec["bad_id"])
    ROUTE_CATALOG.write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # story_routes: tier policy + act entries + unique endings
    routes = json.loads(STORY_ROUTES.read_text(encoding="utf-8"))
    tp = routes.setdefault("tier_policy", {}).setdefault("T0", {})
    tp["acts"] = 6
    tp["unique_endings"] = "true + good + soft + bad (=4)"
    tp["season_acts"] = "winter + festival waypoint-gated"
    chars = routes.setdefault("characters", {})
    for s in SPECS:
        row = chars.get(s["cid"])
        if not row:
            continue
        acts = list(row.get("acts") or [])
        act_ids = {a.get("id") for a in acts}
        winter_act = {
            "id": s["winter_id"].replace(f"story_{s['cid']}_", ""),
            "title": s["winter_label"],
            "beat": "入冬航点专属幕；冬装必现",
            "sprites": [s["winter_outfit"], "home", "casual"],
            "flags": [s["winter_flag"]],
            "waypoint_min": s["waypoint"],
        }
        fest_act = {
            "id": s["fest_id"].replace(f"story_{s['cid']}_", ""),
            "title": s["fest_label"],
            "beat": "节日航点专属幕；节日装必现",
            "sprites": [s["fest_outfit"], s["winter_outfit"]],
            "flags": [s["fest_flag"]],
            "waypoint_min": s["fest_wp"],
        }
        # normalize ids to short form like act5_...
        winter_act["id"] = "act5_winter"
        fest_act["id"] = "act5b_festival"
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
    print("done")


if __name__ == "__main__":
    main()
