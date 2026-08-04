# -*- coding: utf-8 -*-
"""Batch A: soft + shared bad presentation pages (≥2 each). Zero new story YAML."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "data" / "presentation_catalog.json"
ENDINGS = ROOT / "data" / "endings.json"

META: dict[str, dict] = {
    "ending_xiaoyou_neighbor_soft": {
        "bg": "home.png",
        "cid": "xiaoyou",
        "pages": [
            "雨天门铃总是响两下。她不说喜欢，只把伞柄朝你那侧递过来，像邻居之间最礼貌的温度。",
            "走廊灯坏了又修好。你们仍隔着一扇门互相取暖——近到能听见画笔落纸，远到不必刺痛彼此。门铃响两下，刚好。",
        ],
    },
    "ending_wanyu_regular_soft": {
        "bg": "cafe.png",
        "cid": "wanyu",
        "pages": [
            "靠窗那个位子永远留给你。糖度写进小票，恋爱却没写进菜单——她记得你，却不给你恋爱的位子。",
            "雨停后她仍会说「慢走」。你是雨夜最稳的那个熟客；这份记住已经够暖，也刚好停在柜台这一侧。",
        ],
    },
    "ending_ruolin_mentor_soft": {
        "bg": "office.png",
        "cid": "ruolin",
        "pages": [
            "答疑室的门缝透出茶香。她改完你的稿，抬头仍称你「同学」，声音干净得像粉笔灰落尽后的安静。",
            "你没有越线，她也没有开门。保留下来的，是整学期最干净的那些办公室时光——边界清晰，也温柔。",
        ],
    },
    "ending_jingliu_subordinate_soft": {
        "bg": "office.png",
        "cid": "jingliu",
        "pages": [
            "会议室的玻璃门外，她点开你的方案又合上：「靠谱。」心却仍关在工牌背面，夜色里看不见。",
            "电梯分开两层。你仍是她最不想失去的同事——职场信任止于这一步，天台的风没有再邀你上去。",
        ],
    },
    "ending_aili_neighbor_heart": {
        "bg": "home.png",
        "cid": "aili",
        "pages": [
            "阳台晚风把花香吹过来。寒暄比从前长了半句，旧婚的门却只开了一半——距离缩短了，勇气还没收齐。",
            "她递来无标签的花枝，又轻轻收回目光。邻里心动存在；重建的勇气，留给还没写完的下一季。",
        ],
    },
    "ending_linxi_office_soft": {
        "bg": "office.png",
        "cid": "linxi",
        "pages": [
            "加班灯下，她把改好的表格丢到你桌上，附一张便利贴：「对齐过了。」心脏不在附件里，只在工位之间。",
            "你们是最好的工作搭子。电梯下行时她会笑一声，然后各自刷卡回家——同盟停在工位，一步未再迈出。",
        ],
    },
    "ending_yeyu_counter_soft": {
        "bg": "store.png",
        "cid": "yeyu",
        "pages": [
            "关东煮蒸汽模糊了工牌。她继续损你买错口味，针线留在别处的工作室——锋利的话，只留给夜班损友。",
            "夜班结束她挥手：「滚回去睡觉。」友情钉在柜台这一侧。她缝衣给人看，心却不给你量尺寸。",
        ],
    },
    "ending_taotao_encore_soft": {
        "bg": "festival.png",
        "cid": "taotao",
        "pages": [
            "安可灯亮起时，你举着灯牌站在最前排。她朝这边笑了一下——像对粉丝，不像对恋人，却足够亮一整夜。",
            "散场后应援棒熄灭。那一夜仍是最亮的应援；恋情的剧本她没有翻开下一页，只把谢幕留给掌声。",
        ],
    },
    "ending_shizuku_quiet_soft": {
        "bg": "library.png",
        "cid": "shizuku",
        "pages": [
            "两张借书证并排放在柜台上。她推来书单，指尖轻轻点过书名，却不点心跳——交换的是阅读进度。",
            "闭馆广播响起。你们交换书单，不交换秘密。安静借阅也是一种完满：书架之间，刚好容得下这份距离。",
        ],
    },
    "ending_qiansha_archive_soft": {
        "bg": "office.png",
        "cid": "qiansha",
        "pages": [
            "PR 状态变成 Closed。注释一行：LGTM as friends。干净得像格式化过的提交记录，也干净得有点疼。",
            "她把分支归档，不再 @ 你 review 心事。够专业，也够痛——友情留下，恋爱那条线合上，不再 reopen。",
        ],
    },
    "ending_shiori_recommend_soft": {
        "bg": "library.png",
        "cid": "shiori",
        "pages": [
            "柜台上永远多一张写给「常客」的书单。墨水干透，收件人写的是读者，不是恋人——名字被轻轻省略。",
            "她把书签夹进你选的那本，轻声说「下次再来」。空白页仍空白；只把温柔留给荐书，不留给告白。",
        ],
    },
    "ending_miara_expo_soft": {
        "bg": "festival.png",
        "cid": "miara",
        "pages": [
            "每个漫展你们都会在摊位帘后撞见。契约仍是戏言，两张通票却是真的——友情缝在布料上，很结实。",
            "收摊时她扔来一把谷子：「摊友价。」恋爱的誓言没有盖章；固定摊友这个称呼，她说刚好。",
        ],
    },
    "ending_xingnai_childhood_soft": {
        "bg": "campus.png",
        "cid": "xingnai",
        "pages": [
            "天台栏杆旁，便当仍是两人份，称呼还是旧的。有些缺口你们选择不填满——青梅如故，不必改口。",
            "风把空饭盒吹得轻响。近到能分享筷子，远到不必把喜欢摊开晒太阳。童年的距离，被你们好好守住。",
        ],
    },
    "ending_fengyin_eaves_soft": {
        "bg": "home.png",
        "cid": "fengyin",
        "pages": [
            "饭还是一起吃，玄关仍摆着两双拖鞋。门要敲，喜欢被好好收着，不翻成越界——同一屋檐下的分寸。",
            "洗碗时她把背影留给你：「明天也来。」软距离刚好够住一整个学期；敲门声，比告白更常响起。",
        ],
    },
    "ending_qingcai_audience_soft": {
        "bg": "campus.png",
        "cid": "qingcai",
        "pages": [
            "练舞镜最末排，你的水瓶位置固定。她继续倒追世界，偶尔朝这边挥一下毛巾——观众席有姓名。",
            "散场灯亮。观众席与舞台之间那条线，你们都没有再往前跨。位置固定，关系也是：固定观众，刚刚好。",
        ],
    },
    "ending_xiaoyang_classmate_soft": {
        "bg": "campus.png",
        "cid": "xiaoyang",
        "pages": [
            "海报上仍是并列的名字。喜欢被折进书包夹层，不拿出来晒太阳——同班如常，是你们共同选择的温度。",
            "下课铃响，她把笔记借你复印：「同班而已。」暖，却不宣告。教室窗边的风，把未说出口的话吹散。",
        ],
    },
    "ending_luna_charm_soft": {
        "bg": "starry.png",
        "cid": "luna",
        "pages": [
            "金粉护符还在口袋里，好运也在。恋爱的咒语，她暂时不念出口——神秘学止于平安，不过问心动。",
            "月光落在塔罗边上。她收起牌面，只留给你一句「平安」。护符生效；关系停在星象之外，也温柔。",
        ],
    },
    "ending_shuli_schedule_soft": {
        "bg": "home.png",
        "cid": "shuli",
        "pages": [
            "玄关灯亮着，便当盒摆在桌上。她仍会念你作息，却不再过问你心里装着谁——提醒吃饭，不问恋爱。",
            "门关上前她丢来一句：「别熬夜。」提醒吃饭的人还在；同盟未开，亲情的分寸刚好守在日程本上。",
        ],
    },
    "ending_jingning_nod_soft": {
        "bg": "festival.png",
        "cid": "jingning",
        "pages": [
            "秀场外侧，她隔着名牌朝你点头致意。记住了脸，不交换心事——闪光灯再亮，也照不进她的私语。",
            "走廊空了。你们保持礼貌的距离。活动上的点头已经是全部剧本；同盟的钥匙，她没有递出。",
        ],
    },
    "ending_youwei_borrow_soft": {
        "bg": "room.png",
        "cid": "youwei",
        "pages": [
            "门铃响，她来借钛白，道谢的声音比颜料还轻。故事停在颜料与致谢之间——敲门可以，钥匙不行。",
            "门缝合上。学姐线的守门仍未松动；你只是那个会敲门借色的人，不是能把苏晚悠拽出画室的同盟。",
        ],
    },
    "ending_yuxi_order_soft": {
        "bg": "cafe.png",
        "cid": "yuxi",
        "pages": [
            "小票上糖度正确。她不谈温晚雨以外的话题，目光却记得你进门的步伐——会点单，不交换秘密。",
            "雨窗模糊。会点单的人可以留下，同盟的钥匙却还在别人围裙口袋里。你被记住，却未被列入例外。",
        ],
    },
    "ending_lingke_notice_soft": {
        "bg": "campus.png",
        "cid": "lingke",
        "pages": [
            "课程群里只有截止日通知。没有私下话题，没有加长的省略号——助理的分寸，守得像格式规范。",
            "她从通知栏前走过，点头比微笑更短。你未被列入例外；若铃那条线的门，她不会替你推开。",
        ],
    },
    "ending_aichen_polite_soft": {
        "bg": "festival.png",
        "cid": "aichen",
        "pages": [
            "活动签到台后，她微笑递笔：「请写全名。」客气得像一场永不结束的审核——礼貌是盾，锋利在内。",
            "名册合上。同盟未开始，审视也未结束。她永远客气；花店那扇门的钥匙，她没有交给你。",
        ],
    },
    "ending_best_friend": {
        "bg": "campus.png",
        "cid": None,
        "pages": [
            "并肩走过校园长廊。你们成为彼此最信任的朋友——虽未恋爱，情谊已经够深，够撑过很多个雨天。",
            "分别时交换一个无需解释的眼神。知己不必戴戒指；有些陪伴，停在告白之前刚刚好，也最长久。",
        ],
    },
    "ending_friend": {
        "bg": "cafe.png",
        "cid": None,
        "pages": [
            "咖啡馆里留下一两句玩笑。关系停在朋友阶段，回忆却依然温暖——账单分开付，心却不必算清楚。",
            "你们挥手再见。不沉重，也不空白，像一本读完却不必续写的短篇；朋友结局，也是一种完整。",
        ],
    },
    "ending_festival_memory": {
        "bg": "festival.png",
        "cid": None,
        "pages": [
            "生日、圣诞或七夕的某一晚，烛光把蛋糕切成两半。那晚被你们共同珍藏，像夹进相册的干燥花瓣。",
            "节日散场，灯串熄灭。回忆留下，恋情的章节可以不打开——有些夜晚本身就是结局，足够发光。",
        ],
    },
    "ending_breakup": {
        "bg": "rain.png",
        "cid": None,
        "type": "bad",
        "pages": [
            "信任与好感跌至谷底。车站月台上，你们选择了各自离开，背影被雨丝割开，谁也没有回头多看一眼。",
            "末班车门合上。有些路一旦分岔，就不会再在同一站台等同一班车——分道扬镳，是你们共同写下的终章。",
        ],
    },
    "ending_cold_distance": {
        "bg": "rain.png",
        "cid": None,
        "type": "bad",
        "pages": [
            "冷战持续太久。雨窗上的雾气散了又起，和解的时机一次次错过，连争执都懒得再捡起来。",
            "对话变成已读不回的空白。渐行渐远之后，沉默成了终局——冷战结局不响，却比分手更冷。",
        ],
    },
}

TARGET_IDS = list(META.keys())


def main() -> None:
    endings_raw = json.loads(ENDINGS.read_text(encoding="utf-8"))
    ending_by_id = {e["id"]: e for e in endings_raw.get("endings") or []}

    pc = json.loads(CATALOG.read_text(encoding="utf-8"))
    pe = pc.setdefault("endings", {})

    for eid, meta in META.items():
        if eid not in ending_by_id:
            raise SystemExit(f"missing in endings.json: {eid}")
        pages = meta["pages"]
        total = sum(len(p) for p in pages)
        if len(pages) < 2 or total < 80:
            raise SystemExit(f"pages too thin {eid}: {len(pages)} / {total}")
        is_bad = meta.get("type") == "bad" or ending_by_id[eid].get("type") == "bad"
        entry: dict = {
            "bg": meta["bg"],
            "bgm": "ending_bad" if is_bad else "ending_soft",
            "pages": pages,
        }
        cid = meta.get("cid")
        if cid:
            entry["sprite"] = {
                "character_id": cid,
                "outfit": "casual",
                "emotion": "sad" if is_bad else "shy",
            }
        pe[eid] = entry
        print("ok", eid, "pages", len(pages), "chars", total)

    CATALOG.write_text(json.dumps(pc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    missing = [eid for eid in TARGET_IDS if len((pe.get(eid) or {}).get("pages") or []) < 2]
    if missing:
        raise SystemExit(f"still missing pages: {missing}")
    print(f"fill_soft_bad_ending_pages: OK ({len(TARGET_IDS)} endings)")


if __name__ == "__main__":
    main()
