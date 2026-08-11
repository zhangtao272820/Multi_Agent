# -*- coding: utf-8 -*-
"""Thicken stories + wire rich sprite outfits into routes/events/lores."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPRITES = ROOT / "data" / "sprites"
EVENTS = ROOT / "data" / "events"

T0 = ["xiaoyou", "wanyu", "linxi", "ruolin", "jingliu", "aili"]
T1 = ["taotao", "shizuku", "qiansha", "shiori", "miara"]
LINKED = ["shuli", "youwei", "yuxi", "jingning", "lingke", "aichen"]

EMOS = ("neutral", "happy", "shy", "sad", "angry", "love", "surprised", "sarcastic")


def cast_dir(cid: str) -> Path:
    for lane in ("romance", "neutral"):
        d = SPRITES / lane / cid
        if d.is_dir():
            return d
    return SPRITES / "romance" / cid


def outfit_set(cid: str) -> set[str]:
    d = cast_dir(cid)
    out: set[str] = set()
    if not d.is_dir():
        return out
    for p in d.glob("*.png"):
        if p.name.startswith(("menu_", "avatar")):
            continue
        stem = p.stem
        matched = False
        for em in EMOS:
            suf = "_" + em
            if stem.endswith(suf):
                out.add(stem[: -len(suf)])
                matched = True
                break
        if not matched:
            out.add(stem)
    return out


def pick(have: set[str], *cands: str, fallback: str = "casual") -> list[str]:
    got = [c for c in cands if c in have]
    if not got and fallback in have:
        got = [fallback]
    elif not got:
        # any available non-base
        prefer = [x for x in sorted(have) if x not in {"neutral", "happy", "sad"}]
        got = prefer[:1] or [fallback]
    # dedupe keep order
    seen = set()
    out = []
    for g in got:
        if g not in seen:
            seen.add(g)
            out.append(g)
    return out[:6]


def load_json(name: str):
    return json.loads((ROOT / "data" / name).read_text(encoding="utf-8"))


def dump_json(name: str, data):
    (ROOT / "data" / name).write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


# --- story content packs ---
T0_TWIST = {
    "xiaoyou": {
        "id": "act6_third_pen",
        "title": "第三支笔的阴影",
        "beat": "悠微吃醋摊牌→画室座位争夺→你是否只把晚悠当画框→创作与恋人身份撕裂",
        "flag": "xy_third_pen_crisis",
        "event": "story_xiaoyou_act6_third_pen",
        "sprites": ["atelier_paint", "deadline_lamp", "intimate_lounge", "shared_sketchbook", "floor_sketch", "season_winter"],
        "beats": [
            ("画室多出一支笔：悠微站在门口问，你进门是为了画，还是为了晚悠以外的座位。", ["atelier_paint", "work", "casual"]),
            ("晚悠夹在学妹与恋人之间，颜料手抖；她怕被当成只负责灵感的画框。", ["deadline_lamp", "floor_sketch", "home"]),
            ("你必须说清位置：画布对面、学妹同盟、还是可以并肩的恋人——选择会改写真结局门。", ["intimate_lounge", "atelier_paint", "season_winter"]),
        ],
        "need_flags": ["xy_life_outside_frame"],
        "aff": 82,
        "stage": "crush",
    },
    "wanyu": {
        "id": "act6_cover_storm",
        "title": "顶班风暴",
        "beat": "雨汐护短爆发→打烊对峙→你是熟客还是要留下的人→关店钥匙递给谁",
        "flag": "wy_cover_storm",
        "event": "story_wanyu_act6_cover_storm",
        "sprites": ["closing_wipe", "barista_steam", "rain", "intimate_lounge", "home", "season_winter"],
        "beats": [
            ("雨汐把围裙摔在吧台：顶班不是让你把晚雨掏空的借口。", ["barista_steam", "work", "casual"]),
            ("打烊后只剩蒸汽与沉默；晚雨问你要不要那串关店钥匙。", ["closing_wipe", "rain", "home"]),
            ("你接或不接，都会改写死党门与她的疲惫——蒸汽散尽前必须给一句真话。", ["intimate_lounge", "season_winter", "date"]),
        ],
        "need_flags": ["wy_kept_seat"],
        "aff": 82,
        "stage": "crush",
    },
    "linxi": {
        "id": "act6_overtime_break",
        "title": "工位塌方",
        "beat": "通宵改稿崩溃→红丝带散落→你是前辈还是能并肩的人→打印室坦白",
        "flag": "lx_overtime_break",
        "event": "story_linxi_act6_overtime_break",
        "sprites": ["desk_papers", "print_stack", "work_working_focus", "home_sleeping", "season_winter", "casual"],
        "beats": [
            ("凌晨打印室纸张堆积；她红丝带松了，说自己不是临时工配件。", ["print_stack", "work", "casual"]),
            ("你若只劝她撑住，她会笑着崩溃；若肯一起担责，她才敢卸下实习生壳。", ["desk_papers", "work_working_focus", "home"]),
            ("她把工牌翻面：要的是并肩，不是被拯救的故事。", ["home_sleeping", "season_winter", "date"]),
        ],
        "need_flags": ["lx_step_taken"],
        "aff": 80,
        "stage": "crush",
    },
    "ruolin": {
        "id": "act6_red_pen",
        "title": "红笔与讲台下",
        "beat": "铃可拦门→师生边界二次审判→对等还是越界→办公室夜谈",
        "flag": "rl_red_pen_crisis",
        "event": "story_ruolin_act6_red_pen",
        "sprites": ["lecture_pointer", "office_hours", "work", "intimate_lounge", "season_winter", "casual"],
        "beats": [
            ("铃可堵在办公室门口：红笔还没放下，谁都不许把「老师」消费成恋人剧本。", ["office_hours", "work", "casual"]),
            ("若铃摘下眼镜：她怕重演年轻时的暧昧灾难，也怕你只想要讲台下的反差。", ["lecture_pointer", "work", "home"]),
            ("对等之名要经得起助教的门禁——过关后才准牵手，否则退回师生礼貌。", ["intimate_lounge", "season_winter", "date"]),
        ],
        "need_flags": ["rl_peer_reached"],
        "aff": 84,
        "stage": "crush",
    },
    "jingliu": {
        "id": "act6_cousin_glass",
        "title": "玻璃与观察日记",
        "beat": "静宁摊日记→职场面具裂开→家族局施压→你要真相还是品牌顾问",
        "flag": "jl_cousin_glass",
        "event": "story_jingliu_act6_cousin_glass",
        "sprites": ["boardroom_stand", "lookbook_flip", "event_glass", "intimate_lounge", "season_winter", "casual"],
        "beats": [
            ("静宁把观察日记拍在桌上：堂姐所有「护短」她都记着，也包括对你的破例。", ["event_glass", "work", "casual"]),
            ("静流粤语漏音，面具裂开——家族局要她把恋爱当风险项划掉。", ["boardroom_stand", "lookbook_flip", "home"]),
            ("你若只要品牌顾问，她会戴回玻璃；若要真相，就得一起扛闲话。", ["intimate_lounge", "season_winter", "date"]),
        ],
        "need_flags": ["jl_equal_desk"],
        "aff": 84,
        "stage": "crush",
    },
    "aili": {
        "id": "act6_friend_audit",
        "title": "闺蜜审核夜",
        "beat": "艾辰冷脸审核→温室枯枝→离婚阴影回流→你留下还是只夸花",
        "flag": "al_friend_audit",
        "event": "story_aili_act6_friend_audit",
        "sprites": ["bouquet_wrap", "greenhouse_mist", "intimate_lounge", "home", "season_winter", "casual"],
        "beats": [
            ("艾辰站在温室门口：靠近姐姐的人先过她这关，夸花不算分。", ["greenhouse_mist", "casual", "work"]),
            ("艾黎修剪枯枝，说怕再被辜负；花泥里埋着离婚后的沉默。", ["bouquet_wrap", "home", "casual"]),
            ("审核与真心同时落槌——留下处理账单与枯枝，或礼貌退回客人位置。", ["intimate_lounge", "season_winter", "date"]),
        ],
        "need_flags": ["al_rewed_ready"],
        "aff": 84,
        "stage": "crush",
    },
}

T1_TWIST = {
    "taotao": {
        "id": "act4_encore_pressure",
        "title": "加训后的冰袋",
        "beat": "镜头外崩溃→经纪人施压→你看舞台还是膝盖→练习室耳机分你",
        "flag": "tt_encore_pressure",
        "event": "story_taotao_act4_encore_pressure",
        "sprites": ["vocal_booth", "choreo_mark", "handshake_look", "home", "season_winter", "casual"],
        "beats": [
            ("加训结束她往膝盖上贴冰袋，镜头笑还挂在脸上。", ["choreo_mark", "casual", "work"]),
            ("经纪人催下一场；她问你记住的是舞台还是她喘不上气的间隙。", ["vocal_booth", "handshake_look", "home"]),
            ("耳机分你一只：留下听未发行小样，或当普通粉丝退场。", ["season_winter", "date", "casual"]),
        ],
        "need_flags": ["tt_plain_seen"],
        "aff": 75,
        "stage": "friend",
    },
    "shizuku": {
        "id": "act4_closed_stack",
        "title": "闭馆后的层架",
        "beat": "倒架到闭馆→沉默被打破→逾期条上的小星→她敢出声喜欢",
        "flag": "sz_closed_stack",
        "event": "story_shizuku_act4_closed_stack",
        "sprites": ["library_ladder", "quiet_reading", "archive_cart", "home", "season_winter", "casual"],
        "beats": [
            ("闭馆铃响，她还在最高层架；声音小到像怕惊动书脊。", ["library_ladder", "work", "casual"]),
            ("你帮她搬最后一车书；逾期条角落那颗小星终于被承认是画给你的。", ["archive_cart", "quiet_reading", "home"]),
            ("她第一次大声说「留下来」——像翻开善本，慢而不可退。", ["season_winter", "date", "casual"]),
        ],
        "need_flags": ["sz_voice_heard"],
        "aff": 74,
        "stage": "friend",
    },
    "qiansha": {
        "id": "act4_dirty_diff",
        "title": "脏掉的 diff",
        "beat": "线上事故→前同事圈牵扯→情感也要干净 merge→夜灯对质",
        "flag": "qs_dirty_diff",
        "event": "story_qiansha_act4_dirty_diff",
        "sprites": ["dual_monitor", "debug_mug", "hoodie_focus", "home", "season_winter", "casual"],
        "beats": [
            ("生产事故告警满屏；她冷脸回滚，说感情最讨厌脏 diff。", ["dual_monitor", "work", "casual"]),
            ("旧同事群消息弹出艾莉名字；她问你是不是来看热闹的。", ["debug_mug", "hoodie_focus", "home"]),
            ("PR 标题打成坦白：merge 或关闭——没有第三方旁路。", ["season_winter", "date", "home"]),
        ],
        "need_flags": ["qs_merge_done"],
        "aff": 76,
        "stage": "friend",
    },
    "shiori": {
        "id": "act4_window_read",
        "title": "窗边不卖的那本",
        "beat": "荐书被拒→窗边崩溃→短句变告白→冷门书架敞开",
        "flag": "sr_window_read",
        "event": "story_shiori_act4_window_read",
        "sprites": ["shelf_ladder", "recommend_stack", "window_read", "home", "season_winter", "casual"],
        "beats": [
            ("客人否决她全部推荐；她退回窗边座位，短句写了又撕。", ["recommend_stack", "window_read", "casual"]),
            ("你追问冷门书架；她眼睛亮了，却怕被当成只负责氛围的店员。", ["shelf_ladder", "home", "casual"]),
            ("她把不卖的那本塞给你：留下读完，或只买畅销离开。", ["season_winter", "date", "window_read"]),
        ],
        "need_flags": ["sr_write_shared"],
        "aff": 74,
        "stage": "friend",
    },
    "miara": {
        "id": "act4_wig_off",
        "title": "卸下精灵耳",
        "beat": "漫展返程→胶水味卸妆→怕被当戏服人格→素颜合同",
        "flag": "mr_wig_off",
        "event": "story_miara_act4_wig_off",
        "sprites": ["merch_counter", "wig_adjust", "sewing_cos", "home", "season_winter", "casual"],
        "beats": [
            ("返程列车上她撕掉精灵耳，胶水味混着疲惫。", ["wig_adjust", "casual", "home"]),
            ("她问你喜欢的是 cos 还是卸妆后会哭的人。", ["sewing_cos", "merch_counter", "home"]),
            ("素颜合同：留下帮她收摊缝补，或只追舞台设定。", ["season_winter", "date", "casual"]),
        ],
        "need_flags": ["mr_oath_done"],
        "aff": 75,
        "stage": "friend",
    },
}

LORE_T0 = {
    "xiaoyou": "苏晚悠靠插画养活带天窗的工作室，父母远在外地。她把孤独画进线稿，也把你从临时模特变成「画框外的人」。学妹悠微是第三支笔——创作同盟能成全真结局，也能在座位争夺里撕开她。路线要过 deadline、作品集羞耻、冬窗与学妹风暴；真结局不是征服灵感，是让她敢不画也留下来。",
    "wanyu": "温晚雨的笑容是制服零件，打烊后才允许空。死党雨汐护短到偏执，顶班同盟既是她的门也是她的牢。你要从熟客位走到留钥匙的人，得接住蒸汽、眼泪与「别把我当情绪垃圾桶」。冬与中秋加幕是温度计；风暴幕决定她是否还肯为你留灯。",
    "linxi": "陆凛汐用实习薪水站在这座镇，红丝带是妈妈留下的习惯。打印室是她喘气处，通宵改稿会把「临时工」三个字碾进骨里。她要的不是拯救剧本，是并肩担责。冬日通勤与春日工位加幕之后，工位塌方会逼你选：前辈姿态，还是把工牌翻面站一起。",
    "ruolin": "顾若铃的讲义与边界一样整齐，年轻时的暧昧灾难让她对「老师」身份过敏。助教铃可是红笔门禁——真结局要过边界卫士，也要过她自己的二次审判。讲台下的对等不是反差萌消费，是经得起门禁的成年关系。",
    "jingliu": "江静流走路带风，粤语口头禅偶尔露馅。堂妹静宁的观察日记比她自己更诚实。品牌顾问的玻璃面具在家族局与你之间裂开；你要真相就得一起扛闲话，而不是只要护短后的柔软彩蛋。",
    "aili": "夏艾黎把离婚后的情绪插进花泥，闺蜜艾辰负责审核一切靠近。温室是安全屋也是牢。夸花无效，处理枯枝与账单才计分。复婚恐惧会在审核夜回流——留下的人要能扛闲话，也能扛她的停顿。",
}

LORE_T1 = {
    "taotao": "桃桃镜头前元气、镜头后冰敷。经纪人日程比她清晰。加训压力会撕开商品与易碎品两种误解；你若只追舞台，她笑着送客，若记得喘息间隙，她会把耳机分你。",
    "shizuku": "白霜雫用沉默当礼貌，逾期条小星是密语。闭馆后的层架逼她出声——善本一样慢，却不可退。图书馆不是躲避处，是她学会被听见的地方。",
    "qiansha": "林千纱讨厌脏 diff，前同事圈与艾莉有过交集。生产事故夜她会冷脸回滚，也把感情当 PR：merge 或关闭。没有旁路提交。",
    "shiori": "叶诗织把喜欢藏在推荐语里。窗边不卖的那本是告白容器；只买畅销的人永远只配礼貌。冷门书架敞开时，她才把短句念出口。",
    "miara": "莫米拉的精灵耳是勇气外皮。卸妆后的胶水味里藏着怕被当戏服人格。素颜合同要求你同时尊重人设与会哭的那个人。",
}


def write_event(meta: dict, cid: str, route_title: str, act_no: str):
    have = outfit_set(cid)
    beats = []
    for i, (summary, spr) in enumerate(meta["beats"], 1):
        hints = pick(have, *spr, "casual", "home")
        beats.append(
            {
                "id": f"b{i}",
                "summary": summary,
                "sprite_hint": hints,
                "soft_options": ["认真回应", "先缓一缓", "推开"] if i == 3 else ["留下", "关心一句", "告辞"] if i == 1 else ["靠近", "安静听", "换话题"],
            }
        )
    sprites_route = pick(have, *meta["sprites"], "casual", "home")
    doc = {
        "id": meta["event"],
        "label": meta["title"],
        "priority": 8 if cid in T0 else 7,
        "once": True,
        "chance": 1.0,
        "scene_id": "",
        "trigger": {
            "character_ids": [cid],
            "stage_min": meta["stage"],
            "affinity_min": meta["aff"],
            "flags_present": list(meta["need_flags"]),
            "flags_absent": [meta["flag"]],
        },
        "prompt_snippet": f"【专属故事 · {route_title} · {act_no} · {meta['title']}】\n",
        "advance": "on_player_turn",
        "beats": beats,
        "rewards": {"flags_set": [meta["flag"]]},
        "choice_effects": [
            {"trust_delta": 3, "affinity_delta": 4},
            {"trust_delta": 2, "affinity_delta": 2},
            {"trust_delta": -2, "affinity_delta": -2},
        ],
    }
    # dump yaml-ish via json then simple yaml writer
    path = EVENTS / f"{meta['event']}.yaml"
    lines = []
    def dump(obj, indent=0):
        sp = "  " * indent
        if isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(v, (dict, list)):
                    lines.append(f"{sp}{k}:")
                    dump(v, indent + 1)
                elif isinstance(v, bool):
                    lines.append(f"{sp}{k}: {'true' if v else 'false'}")
                elif isinstance(v, (int, float)):
                    lines.append(f"{sp}{k}: {v}")
                else:
                    s = str(v).replace('"', '\\"')
                    if "\n" in s:
                        lines.append(f"{sp}{k}: |")
                        for part in s.split("\n"):
                            lines.append(f"{sp}  {part}")
                    else:
                        lines.append(f'{sp}{k}: "{s}"')
        elif isinstance(obj, list):
            for item in obj:
                if isinstance(item, (dict, list)):
                    lines.append(f"{sp}-")
                    # inline dict keys at indent+1 with list quirk: use indent+1 but prefix handled
                    if isinstance(item, dict):
                        first = True
                        for k, v in item.items():
                            pref = f"{sp}  "
                            if isinstance(v, list):
                                lines.append(f"{pref}{k}:")
                                for x in v:
                                    lines.append(f"{pref}  - {x}")
                            elif isinstance(v, (dict,)):
                                lines.append(f"{pref}{k}:")
                                dump(v, indent + 2)
                            elif isinstance(v, bool):
                                lines.append(f"{pref}{k}: {'true' if v else 'false'}")
                            elif isinstance(v, (int, float)):
                                lines.append(f"{pref}{k}: {v}")
                            else:
                                lines.append(f'{pref}{k}: "{str(v)}"')
                    else:
                        dump(item, indent + 1)
                else:
                    lines.append(f"{sp}- {item}")
    dump(doc)
    # fix list-of-dict: regenerate with pyyaml if available
    try:
        import yaml  # type: ignore

        path.write_text(
            yaml.safe_dump(doc, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )
    except Exception:
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return sprites_route


def enrich_existing_event_sprites(cid: str):
    """Add richer sprite_hint alternatives into existing story yaml for this cid."""
    have = outfit_set(cid)
    extras = [
        x
        for x in (
            "season_winter",
            "home_eating",
            "home_sleeping",
            "intimate_lounge",
            "bath_foam",
            "max_micro_slip",
            "date",
            "rain",
            "work_working_focus",
        )
        if x in have
    ]
    for path in EVENTS.glob(f"story_{cid}_*.yaml"):
        if "act6_" in path.name or "act4_client" in path.name or "act4_encore" in path.name:
            continue
        if any(x in path.name for x in ("act4_closed", "act4_dirty", "act4_window", "act4_wig", "act6_")):
            continue
        text = path.read_text(encoding="utf-8")
        # skip if already has intimate or season_winter in hints beyond one
        if text.count("season_winter") >= 3 and "intimate_lounge" in text:
            continue
        # lightweight: append comment block? better parse with yaml
        try:
            import yaml  # type: ignore

            data = yaml.safe_load(text)
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        changed = False
        for beat in data.get("beats") or []:
            if not isinstance(beat, dict):
                continue
            hints = list(beat.get("sprite_hint") or [])
            for ex in extras:
                if ex not in hints:
                    hints.append(ex)
                    changed = True
                if len(hints) >= 5:
                    break
            beat["sprite_hint"] = hints[:5]
        if changed:
            path.write_text(
                yaml.safe_dump(data, allow_unicode=True, sort_keys=False),
                encoding="utf-8",
            )


def main():
    sr = load_json("story_routes.json")
    chars = sr.setdefault("characters", {})
    lores = load_json("character_lores.json")
    lore_chars = lores.setdefault("characters", {})

    # --- shuli L0 + linked ---
    OPEN = {
        "youwei": "youwei_open_heart",
        "yuxi": "yuxi_shift_confess_ok",
        "jingning": "jingning_soft_open",
        "lingke": "lingke_peer_ok",
        "aichen": "aichen_clear",
    }
    TRUE = {
        "youwei": "ending_youwei_third_pen_true",
        "yuxi": "ending_yuxi_side_by_side_true",
        "jingning": "ending_jingning_own_voice_true",
        "lingke": "ending_lingke_peer_true",
        "aichen": "ending_aichen_cleared_true",
    }
    BAD = {
        "youwei": "ending_youwei_studio_break",
        "yuxi": "ending_yuxi_friend_rift",
        "jingning": "ending_jingning_family_chill",
        "lingke": "ending_lingke_boundary_fail",
        "aichen": "ending_aichen_gate_slam",
    }

    shuli = chars["shuli"]
    shuli.update(
        {
            "tier": "L0",
            "cast_kind": "linked",
            "route_title": "日程本里的禁忌",
            "theme": "家人依赖扭曲成爱、嫉妒、伦理突破与同屋檐秘密",
            "logline": "最重要的女主是亲妹妹：晚饭与日程撑家，也因你靠近别人而撕裂；正视禁忌后，在枫音隔壁过秘密恋人的日子——每一步都可能毁掉这个家。",
            "anchor": "pc_family",
            "prime_heroine": True,
        }
    )
    shuli_have = outfit_set("shuli")
    shuli["acts"] = [
        {"id": "act1_dinner", "title": "晚饭点名", "beat": "晚饭点名→家人边界→sibling_talk_done", "sprites": pick(shuli_have, "home_sibling", "kitchen_helper", "home", "home_eating", "casual"), "flags": ["sibling_talk_done"]},
        {"id": "act2_ally", "title": "站在同一边", "beat": "同盟却吃醋→sibling_ally", "sprites": pick(shuli_have, "home_sibling", "work", "kitchen_helper", "casual"), "flags": ["bond_ally_done", "sibling_ally"]},
        {"id": "act3_display", "title": "故意让你看见", "beat": "故意展示→kin_garden_ready", "sprites": pick(shuli_have, "bath_foam", "max_micro_slip", "home_sibling", "home", "casual"), "flags": ["deliberate_display", "shuli_soft_bloom", "kin_garden_ready"]},
        {"id": "act4_jealous", "title": "撕开的日程本", "beat": "撞见其他女主→shuli_jealous_break", "sprites": pick(shuli_have, "home_sibling", "casual", "home", "max_micro_slip", "work"), "flags": ["shuli_jealous_break"]},
        {"id": "act5_ethics", "title": "说破的名字", "beat": "正视禁忌→taboo_romance_ok", "sprites": pick(shuli_have, "home_sibling", "home", "home_sleeping", "casual", "intimate_lounge"), "flags": ["ethics_breach_talk", "taboo_romance_ok"]},
        {"id": "act6_secret", "title": "薄墙另一侧", "beat": "同屋檐秘密恋→shuli_secret_roof", "sprites": pick(shuli_have, "home", "home_sleeping", "casual", "season_winter", "morning_shirt"), "flags": ["shuli_secret_roof"]},
    ]
    shuli["unique_ending_ids"] = [
        "ending_shuli_taboo_true",
        "ending_shuli_careful_good",
        "ending_shuli_family_ally",
        "ending_shuli_schedule_soft",
        "ending_shuli_shadow_garden",
        "ending_shuli_ethics_rift",
        "ending_shuli_roof_exposed",
    ]
    shuli["branches"] = {
        "true": "秘密承诺共担",
        "good": "对枫音说一半",
        "soft": "家人同盟",
        "shadow": "影子花园",
        "bad_ethics": "伦理撕裂",
        "bad_exposed": "薄墙倒塌",
    }

    for cid in LINKED:
        if cid == "shuli":
            continue
        row = chars[cid]
        row["tier"] = "L"
        row["cast_kind"] = "linked"
        have = outfit_set(cid)
        acts = list(row.get("acts") or [])
        ids = {a.get("id") for a in acts}
        if "act4_open" not in ids:
            acts.append(
                {
                    "id": "act4_open",
                    "title": "闸门另一侧",
                    "beat": f"本人摊牌→{OPEN[cid]}",
                    "sprites": pick(have, "casual", "home", "work", "season_winter", "date"),
                    "flags": [OPEN[cid]],
                }
            )
        # enrich sprites on existing acts
        for a in acts:
            spr = list(a.get("sprites") or [])
            for x in pick(have, "season_winter", "home_eating", "home_sleeping", "casual", "home", "date"):
                if x not in spr:
                    spr.append(x)
            a["sprites"] = spr[:6]
        row["acts"] = acts
        ends = list(row.get("unique_ending_ids") or [])
        for eid in (TRUE[cid], BAD[cid]):
            if eid not in ends:
                ends.insert(0, eid)
        row["unique_ending_ids"] = ends

    # --- T0 twists + sprite enrich ---
    for cid, meta in T0_TWIST.items():
        row = chars[cid]
        have = outfit_set(cid)
        title = row.get("route_title") or cid
        # thicken logline
        row["logline"] = {
            "xiaoyou": "邻家插画师把你画进线稿；从模特、deadline、冬窗，到学妹第三支笔的风暴——她要的是画框外的留下来。",
            "wanyu": "咖啡店员把温柔分给客人；打烊蒸汽、中秋杯与顶班风暴之后，关店钥匙只交给肯留下的人。",
            "linxi": "实习生红丝带与打印室气味；通宵、冬日车厢与工位塌方，逼你把「前辈」翻成并肩。",
            "ruolin": "讲师边界极清；讲台下对等要过助教红笔与她自己的二次审判，才不是反差消费。",
            "jingliu": "品牌顾问玻璃面具；屋顶、冬夜与堂妹日记一起施压，你要真相还是只要护短。",
            "aili": "花艺师的温室与离婚阴影；闺蜜审核夜决定你是处理枯枝的人，还是只会夸花的客人。",
        }[cid]
        acts = list(row.get("acts") or [])
        # enrich each act sprites
        for a in acts:
            spr = list(a.get("sprites") or [])
            for x in pick(
                have,
                "season_winter",
                "home_eating",
                "home_sleeping",
                "intimate_lounge",
                "bath_foam",
                "date",
                "rain",
            ):
                if x not in spr:
                    spr.append(x)
            a["sprites"] = spr[:7]
        ids = {a.get("id") for a in acts}
        if meta["id"] not in ids:
            spr = write_event(meta, cid, title, "第6幕")
            acts.append(
                {
                    "id": meta["id"],
                    "title": meta["title"],
                    "beat": meta["beat"],
                    "sprites": spr,
                    "flags": [meta["flag"]],
                }
            )
        row["acts"] = acts
        br = dict(row.get("branches") or {})
        br["twist"] = meta["title"]
        row["branches"] = br
        # lore
        if cid in lore_chars:
            lore_chars[cid]["codex"] = LORE_T0[cid]
            seed = lore_chars[cid].get("prompt_seed") or ""
            if len(seed) < 40:
                lore_chars[cid]["prompt_seed"] = LORE_T0[cid][:100]

    # --- T1 twists ---
    for cid, meta in T1_TWIST.items():
        row = chars[cid]
        have = outfit_set(cid)
        title = row.get("route_title") or cid
        row["logline"] = {
            "taotao": "练习生冰敷膝盖；加训压力撕开商品与易碎，耳机只分给记得喘息的人。",
            "shizuku": "图书馆沉默里的小星；闭馆层架逼她出声，善本一样慢却不可退。",
            "qiansha": "前端讨厌脏 diff；事故夜把感情当 PR，merge 或关闭没有旁路。",
            "shiori": "书店窗边短句；不卖的那本是告白，只买畅销的人只配礼貌。",
            "miara": "谷子店员卸下精灵耳；素颜合同要求你同时喜欢戏服与会哭的人。",
        }[cid]
        acts = list(row.get("acts") or [])
        for a in acts:
            spr = list(a.get("sprites") or [])
            for x in pick(have, "season_winter", "home_eating", "home_sleeping", "date", "casual", "home"):
                if x not in spr:
                    spr.append(x)
            a["sprites"] = spr[:7]
        ids = {a.get("id") for a in acts}
        if meta["id"] not in ids:
            spr = write_event(meta, cid, title, "第4幕")
            # insert before winter acts
            insert_at = next((i for i, a in enumerate(acts) if str(a.get("id", "")).startswith("act5")), len(acts))
            acts.insert(
                insert_at,
                {
                    "id": meta["id"],
                    "title": meta["title"],
                    "beat": meta["beat"],
                    "sprites": spr,
                    "flags": [meta["flag"]],
                },
            )
        row["acts"] = acts
        if cid in lore_chars:
            lore_chars[cid]["codex"] = LORE_T1[cid]

    # enrich existing event sprite hints for T0/T1
    for cid in T0 + T1:
        enrich_existing_event_sprites(cid)

    # shuli lore
    lore_chars["shuli"]["codex"] = (
        "沈书璃是亲妹妹，也是最重要、最难的女主。幼失怙恃后依赖长成禁忌情愫；公开叫哥哥，私下用晚饭、日程与嫉妒绑住你。"
        "故意展示、撕日程本、伦理正视、枫音隔壁的秘密恋——每一步都可能暴露。真结局是共担后果，不是甜宠通关。"
    )
    lore_chars["shuli"]["prompt_seed"] = (
        "亲妹沈书璃，主轴女主；幼失怙恃哥哥撑家；敏感护短嫉妒；未破伦理拒恋人称呼，破限后仍瞒同住义妹。"
    )
    lore_chars["shuli"]["link"] = {
        "anchor_id": "",
        "relation_label": "亲妹妹 · 主轴女主 · 同住",
        "gate_summary": "须经嫉妒撕裂与伦理正视；破限后还要瞒过同住义妹。",
        "open_flags": ["taboo_romance_ok"],
        "anchor_gate_flags": [],
    }
    lore_chars["shuli"]["unlocks"] = {
        "sibling_talk_done": "晚饭桌上的家人边界已摊开。",
        "bond_ally_done": "她愿站你这边，却仍拒恋爱军师。",
        "kin_garden_ready": "故意展示后的默契更深更危险。",
        "shuli_jealous_break": "嫉妒爆发过，家几乎被砸裂。",
        "taboo_romance_ok": "你们已正视伦理并自愿承担。",
        "shuli_secret_roof": "同屋檐下的秘密恋正在进行。",
    }

    sr["notes"] = (
        "romance T0/T1 加厚含危机幕；T2 轻副本；linked 关系向；"
        "书璃 L0 主轴；幕 sprites/事件 sprite_hint 尽量挂钩已有立绘包。"
    )
    sr["routes"] = {}
    tp = sr.setdefault("tier_policy", {})
    tp["L0"] = {
        "acts": 6,
        "role": "书璃主轴",
        "unique_endings": "true+good+soft+shadow+bad×2",
    }
    tp["T0"] = {
        **(tp.get("T0") or {}),
        "acts": 7,
        "note": "原6幕+危机转折幕；sprite 挂钩签名/季节/亲密等已有包",
    }
    tp["T1"] = {
        **(tp.get("T1") or {}),
        "acts": 6,
        "note": "原5幕+危机幕；充分利用立绘",
    }

    dump_json("story_routes.json", sr)
    dump_json("character_lores.json", lores)

    # cast_weights shuli
    cw = load_json("cast_weights.json")
    w = cw.setdefault("characters", {})
    w["shuli"] = {
        "name": "沈书璃",
        "label": "亲妹妹 · 主轴女主",
        "tier": "L0",
        "early_meet": 10,
        "weekly_focus": 9,
        "longing": 8,
        "presence": 10,
        "drama": 9,
        "why": "最重要女主；同居亲妹主轴",
    }
    dump_json("cast_weights.json", cw)

    # verify
    for cid in T0:
        print(cid, [a["id"] for a in chars[cid]["acts"]])
    for cid in T1:
        print(cid, [a["id"] for a in chars[cid]["acts"]])
    print("shuli", [a["id"] for a in chars["shuli"]["acts"]], chars["shuli"]["tier"])
    print("OK thicken")


if __name__ == "__main__":
    main()
