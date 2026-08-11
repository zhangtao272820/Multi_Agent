"""Thicken character_lores + inject NPC/world echo into story narrations + story_web hooks."""
from __future__ import annotations

import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
EVENTS = DATA / "events"

# Extra codex paragraph (appended once) — short novella soil, still figure-facing
CODEX_EXTRA: dict[str, str] = {  # DISABLED: lores fully rewritten; keep empty to avoid AI append

    "shuli": "镇上宿管周阿姨认得她的晚归字迹；同住枫音抢频道时，她把吃醋写进日程本夹层。哥哥的世界里松节油与咖啡蒸汽会串味，她用提醒晚饭把秘密按回去。",
    "xiaoyou": "对门刘家会在门铃响时帮忙应一声；学妹温悠微是第三支笔。画室通宵时邻里闻得到松节油——真结局不是征服灵感，是敢不画也留下来。",
    "wanyu": "老板娘陈婶的排班表比谁都清楚；死党何雨汐顶班护短。打烊蒸汽散尽，熟客位才可能变成留钥匙的席。",
    "linxi": "组里前辈赵组催进度不催人情；打印室是她喘气处。工牌翻面那天，决定她是临时工还是并肩的人。",
    "ruolin": "助教陈铃可的红笔是门禁；讲台下对等不是反差消费。边界课的闲话会传到图书馆安静读者耳朵里。",
    "jingliu": "堂妹江静宁写观察日记；组里前辈偶遇她玻璃面具裂开的瞬间。粤语口头禅只漏给信任的人。",
    "aili": "花市老金压账单也留好枝；闺蜜程艾辰审核靠近的人。温室安全屋也可能变成牢——第二次选择必须更诚实。",
    "taotao": "经纪人小梁盯通告与作息；舞台铠甲下是冰袋与喘息。素颜被记住，才比应援色更像真结局。",
    "shizuku": "书店常客老周换书时总能遇见安静的她；借书记录比当面告白更大胆。图书馆回声刚好容得下轻声名字。",
    "qiansha": "职场前辈赵组见证过她的 diff 脾气；旧恋像未关 PR。merge 要干净，测不通就拒。",
    "shiori": "常客老周爱听她荐书；窗边折页里藏暗涌。句子先于告白出口。",
    "miara": "漫展与谷子店是铠甲；卸妆后怕被只爱戏服。镇上闲话 sparingly 点到假发与缝纫，不揭穿本体。",
    "xingnai": "青梅回忆比情话管用；家里日程与旧相册缺口互相咬合。别扭靠近时，宿管楼道灯也像在催她别装陌生人。",
    "fengyin": "同住抢频道；隔墙书璃夜灯是信息差。宿管门禁与妹妹标签一起勒着她——恋爱前要先撕开称呼。",
    "qingcai": "韩教练不许把元气当偷懒借口；镜房里谢幕掌声不是成绩。吉祥物外壳裂开时，她突然安静认真。",
    "xiaoyang": "同学壳还在时直球也怕越界；社团海报与实验服味道混在校园门禁里。起哄可以，硬推不行。",
    "luna": "与晚雨同店；老板娘排班把她按在夜班。塔罗挡心，结巴才是认真。",
    "youwei": "对门与画室灯通宵是她的背景音；心动先问苏晚悠脸色。第三支笔能成全也能撕开座位。",
    "yuxi": "陈婶默许她顶班；护短可偏执。靠近温晚雨的人，先过她这一关。",
    "jingning": "观察日记比当面质问诚实；不敢抢堂姐的光。旁观职场面具时，也旁观你靠不靠谱。",
    "lingke": "红笔名单先于温情；对等后才收教鞭。办公室门半掩的闲话，她比谁都清楚。",
    "aichen": "帮核进货单时比花艺师更硬；审核官心软前先冷脸。绕过她找夏艾黎，门会比花茎断得更快。",
}

# (event_file stem, beat_id, narration suffix to append if not present)
ECHOES: list[tuple[str, str, str]] = [
    ("story_xiaoyou_act1_threshold", "b1", "对门刘家阳台那边有人咳了一下，烟味混进松节油里。"),
    ("story_xiaoyou_act2_deadline", "b2", "楼道里飘来隔壁炒菜的油烟，跟松节油缠在一起，赶稿的夜突然有点烟火气。"),
    ("story_wanyu_act1_regular", "b1", "陈婶在吧台后面敲排班表，抬眼扫了一下熟客位，没说话。"),
    ("story_wanyu_act2_close", "b2", "打烊铃响前，老板娘丢过来一句：「雨汐别一个人收。」"),
    ("story_shuli_act1_dinner", "b1", "周阿姨大概又在宿管室念晚归名单。家里饭香扑过来，她的筷子还点着日程本。"),
    ("story_shuli_act4_jealous", "b1", "袖口有点松节油味。她鼻子动了动，没问你去哪儿了，只把筷子搁重了一点。"),
    ("story_linxi_act1_desk", "b2", "赵组路过，在门框上敲了两下：「表还在，人先别倒。」"),
    ("story_linxi_act3_print", "b1", "打印室灯管还在闪。桌上便利贴写着「对齐过了」，字很淡。"),
    ("story_aili_act1_balcony", "b1", "账本边压着老金送来的进货单，边上还夹着几根没卖完的枯枝。"),
    ("story_aili_act2_stem", "b3", "艾辰看人的眼神比花茎硬。老金今天只肯留半打好枝。"),
    ("story_taotao_act1_practice", "b2", "门外小梁看了眼表：「练可以，镜头前别哭。」"),
    ("story_taotao_act4_encore_pressure", "b1", "小梁在催下一场，她膝盖上的冰袋还没揭。"),
    ("story_qingcai_act1_mirror", "b1", "韩教练拍了拍镜框：「别光会笑。动作呢？」"),
    ("story_qingcai_act2_festival", "b2", "教练走了，镜房里只剩汗味和空调声。她把笑收了一点。"),
    ("story_shiori_act1_shelf", "b1", "窗边老周翻着书，耳朵却竖着，像在听她荐什么。"),
    ("story_shizuku_act1_screen", "b2", "老周还书，冲她轻轻点了下头，没多话。"),
    ("story_ruolin_act1_lecture", "b1", "门边贴着铃可的答疑名单，红笔勾得很清楚。"),
    ("story_jingliu_act1_glass", "b2", "静宁在边上翻过一页笔记。走廊尽头有人低头看手机，像不经意。"),
    ("story_qiansha_act1_diff", "b1", "评审会上赵组说「改动要干净」。她手指在键盘边停了一下。"),
    ("story_fengyin_act1_door", "b1", "隔墙还亮着灯，大概是书璃。楼道感应灯闪了闪，又灭了。"),
    ("story_luna_act1_tarot", "b1", "陈婶又把她排在夜班。牌面摊开，倒比人先说话。"),
    ("story_miara_act1_booth", "b2", "她刚掀假发，店铃响了一下。门口风灌进来，胶水味散开一点。"),
    ("story_xingnai_act1_bento", "b1", "便当盒边有道旧刮痕。楼道里隐约传来宿管广播，催人别太晚。"),
    ("story_xiaoyang_act1_club", "b2", "海报油墨还没干透。门口门禁灯闪了一下，她把玩笑收半句。"),
]


def thicken_lores() -> None:
    # no-op: character_lores already human-rewritten; do not append brochure extras
    print("lores thicken skipped (human rewrite SSOT)")
    return
    path = DATA / "character_lores.json"
    lore = json.loads(path.read_text(encoding="utf-8"))
    n = 0
    for cid, extra in CODEX_EXTRA.items():
        block = (lore.get("characters") or {}).get(cid)
        if not block:
            continue
        codex = (block.get("codex") or "").strip()
        marker = extra[:12]
        if marker in codex:
            continue
        block["codex"] = (codex + extra).strip()
        # keep prompt_seed ≤100
        seed = (block.get("prompt_seed") or "").strip()
        if len(seed) > 100:
            block["prompt_seed"] = seed[:100]
        n += 1
    path.write_text(json.dumps(lore, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"lores thickened: {n}")


def inject_echoes() -> None:
    applied = 0
    missing = []
    for stem, beat_id, suffix in ECHOES:
        path = EVENTS / f"{stem}.yaml"
        if not path.is_file():
            missing.append(stem)
            continue
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        beats = data.get("beats") or []
        hit = False
        for b in beats:
            if b.get("id") != beat_id:
                continue
            narr = (b.get("narration") or "").strip()
            key = suffix[:8]
            if key in narr:
                hit = True
                break
            b["narration"] = (narr + suffix).strip()
            hit = True
            applied += 1
            break
        if not hit:
            missing.append(f"{stem}:{beat_id}")
            continue
        path.write_text(
            yaml.dump(data, allow_unicode=True, sort_keys=False, width=1000),
            encoding="utf-8",
        )
    print(f"echoes applied={applied} missing={missing}")


def update_story_web() -> None:
    path = DATA / "story_web.json"
    web = json.loads(path.read_text(encoding="utf-8"))
    web["principle"] = (
        "社会式共世：线与线有联系，又各自独立完整可单线通关。"
        "有名镇民=土壤（town_npcs），不可攻略。禁止必须收集全员 flag 才能开主线。"
    )
    soil = web.setdefault("shared_soil", {})
    soil["town_npcs"] = "town_npcs.json"
    weak = web.setdefault("weak_coupling", [])
    line = "有名镇民只进 world_facts/旁白点名；女主禁止编造未写明的 NPC 秘密，禁止对其恋爱"
    if line not in weak:
        weak.append(line)
    hooks = web.setdefault("batch7_town_echo_hooks", [])
    for stem, beat_id, note in ECHOES:
        entry = {"event_id": stem, "beat_id": beat_id, "note": note[:40]}
        if entry not in hooks:
            hooks.append(entry)
    path.write_text(json.dumps(web, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("story_web updated")


def main() -> None:
    thicken_lores()
    inject_echoes()
    update_story_web()


if __name__ == "__main__":
    main()
