# -*- coding: utf-8 -*-
"""Emit T1 seasonal act5 YAML + exclusive bad endings into data/."""
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
        "cid": "shizuku",
        "name": "白石雫",
        "winter_id": "story_shizuku_act5_winter_stack",
        "winter_label": "冬夜闭架",
        "winter_flag": "sz_winter_stack",
        "prev_flag": "sz_spoke_aloud",
        "fest_id": "story_shizuku_act5b_midautumn_shelf",
        "fest_label": "中秋·架上月",
        "fest_flag": "sz_midautumn_shelf",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_autumn_midautumn",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_midautumn",
        "bad_id": "ending_shizuku_closed_stack",
        "bad_title": "闭馆之后",
        "bad_desc": "闭馆广播后她不再出声。借书证还在，声音却收进了最里层的闭架。",
        "bad_flag": "shizuku_route_bad",
        "summaries_w": [
            "入冬闭架区暖气很薄；她把手套放在你手边，第一次用完整句子说冷。",
            "她提到答疑室里有人讲边界课——若铃的名字只闪过一句，像旁支书签。",
            "你是陪她守到闭馆，还是让沉默重新合上；声带会被记住或封存。",
        ],
        "summaries_f": [
            "中秋馆里提早闭馆；她换上节日装，却仍抱着一摞未上架的书。",
            "月饼纸折成书签，她轻声问：要不要把今晚读出声——只给你听。",
            "月色进窗；你听或不听，会决定闭架是敞开，还是永久关闭。",
        ],
    },
    {
        "cid": "qiansha",
        "name": "沈千纱",
        "winter_id": "story_qiansha_act5_winter_diff",
        "winter_label": "冬夜 Diff",
        "winter_flag": "qs_winter_diff",
        "prev_flag": "qs_merge",
        "fest_id": "story_qiansha_act5b_newyear_pr",
        "fest_label": "元旦·Reopen",
        "fest_flag": "qs_newyear_pr",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_winter_newyear",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_spring",
        "bad_id": "ending_qiansha_closed_pr",
        "bad_title": "永久 Archive",
        "bad_desc": "PR 永久 Archive。注释清空，分支删除——她不再 @ 你 review 任何心事。",
        "bad_flag": "qiansha_route_bad",
        "summaries_w": [
            "入冬 CI 全绿；她把热咖啡放你桌边，diff 里却还留着未提交的情绪。",
            "她随口提隔壁花店有人重建订单——艾莉只是旁支一行日志，不抢本线。",
            "你是一起看完这页 conflict，还是点 Archive；仓库会被改写。",
        ],
        "summaries_f": [
            "元旦她穿节日装坐回工位，新建一个只有你们能看的 draft PR。",
            "标题写着 Reopen?；描述栏空着，等你填收件人或关掉页面。",
            "年夜将尽；merge 或永久关闭，都会留下不可回档的提交。",
        ],
    },
    {
        "cid": "shiori",
        "name": "三岛栞",
        "winter_id": "story_shiori_act5_winter_shelf",
        "winter_label": "冬夜空白页",
        "winter_flag": "sr_winter_shelf",
        "prev_flag": "sr_blank_page",
        "fest_id": "story_shiori_act5b_midautumn_page",
        "fest_label": "中秋·未读页",
        "fest_flag": "sr_midautumn_page",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_autumn_midautumn",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_midautumn",
        "bad_id": "ending_shiori_unread_page",
        "bad_title": "未读空白",
        "bad_desc": "空白页永远不写你。荐书单还在，收件人栏却被她用修正带盖住。",
        "bad_flag": "shiori_route_bad",
        "summaries_w": [
            "入冬书店暖气不足；她把空白笔记本推过来，笔帽还没拔开。",
            "她说冬天适合写「夏天不敢写的收件人」；指尖在纸边停了很久。",
            "你是留下一笔名字，还是让页保持空白；故事会被装订或撕掉。",
        ],
        "summaries_f": [
            "中秋她穿节日装站在柜台后，月饼旁放着未拆封的新书。",
            "书签夹着一张空卡：「要不要写——只给你看的那页。」",
            "月圆将尽；写或不写，会决定空白页是留给你，还是永久未读。",
        ],
    },
    {
        "cid": "taotao",
        "name": "唐桃夭",
        "winter_id": "story_taotao_act5_winter_stage",
        "winter_label": "冬夜排练厅",
        "winter_flag": "tt_winter_stage",
        "prev_flag": "tt_plain_face",
        "fest_id": "story_taotao_act5b_newyear_encore",
        "fest_label": "元旦·灯牌",
        "fest_flag": "tt_newyear_encore",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_winter_newyear",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_spring",
        "bad_id": "ending_taotao_lights_out",
        "bad_title": "灯牌熄灭",
        "bad_desc": "灯牌放下后你不在前排。安可灯亮起，她的视线掠过空位，不再停留。",
        "bad_flag": "taotao_route_bad",
        "summaries_w": [
            "入冬排练厅暖气刚开；她素颜坐下，把外套披给你，说舞台外也要保暖。",
            "她问你还愿不愿站前排——不是应援，是想确认「有人在」。",
            "你是留下听完整段，还是提前离场；灯牌会被点亮或永久熄灭。",
        ],
        "summaries_f": [
            "元旦特别演出前，她穿节日装却把灯牌塞进你手里：「今晚只认这一支。」",
            "后台镜前她卸下一半妆：「安可之后，我想看见你——不是粉丝。」",
            "倒计时开始；你站不站前排，会决定灯是为你亮，还是为别人亮。",
        ],
    },
    {
        "cid": "miara",
        "name": "米娅拉",
        "winter_id": "story_miara_act5_winter_booth",
        "winter_label": "冬夜摊位",
        "winter_flag": "mi_winter_booth",
        "prev_flag": "mi_oath_real",
        "fest_id": "story_miara_act5b_spring_contract",
        "fest_label": "新春·契约章",
        "fest_flag": "mi_spring_contract",
        "waypoint": "q_winter_onset",
        "fest_wp": "q_spring_festival",
        "winter_outfit": "season_winter",
        "fest_outfit": "festival_spring",
        "bad_id": "ending_miara_void_contract",
        "bad_title": "契约作废",
        "bad_desc": "契约作废成戏言。摊位帘还在，印章却被她收进再也不打开的抽屉。",
        "bad_flag": "miara_route_bad",
        "summaries_w": [
            "入冬展馆提早清场；她把热贴塞给你，说契约草稿还差一个签名。",
            "人偶服头盔摘下，她认真得不像在开玩笑：「这次不是戏言。」",
            "你是并肩收摊，还是笑着推开；印章会被按下或永久作废。",
        ],
        "summaries_f": [
            "春节档漫展她穿新春装坐镇摊位，红章与空白契约并排放着。",
            "她把笔递过来：「收件人栏——写你，或撕掉。」声音轻，却不退让。",
            "年夜将尽；签字或拒绝，都会让契约成真，或退回戏言。",
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
                "小镇还在过节，你们却像走在两条平行的街上。有些选择，不会再给你第二遍。有些选择会留下痕迹，而这一页，是你们共同写下的收束。",
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
    tp = routes.setdefault("tier_policy", {}).setdefault("T1", {})
    tp["acts"] = 5
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
    print("done")


if __name__ == "__main__":
    main()
