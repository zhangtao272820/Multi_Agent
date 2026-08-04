# -*- coding: utf-8 -*-
"""加厚 T1/T2/N 故事节拍与结局；强化中立守门对绑定女主的影响。

- beats.summary → 40–80 字
- N 线显式写出守门对象（小悠/晚雨/静流/若铃/艾莉）与 flag 含义
- T1 good 结局 emotion happy→love（磁盘无 happy）
- T1/T2 结局 pages 合计 ≥120 字
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"
ROUTES = ROOT / "data" / "story_routes.json"
CATALOG = ROOT / "data" / "presentation_catalog.json"
SPRITES = ROOT / "data" / "sprites"

from curate_rest_story_beats import CURATED, _dump_event  # noqa: E402

T1 = ["taotao", "shizuku", "qiansha", "shiori", "miara"]
T2 = ["xingnai", "fengyin", "qingcai", "xiaoyang", "luna"]
N = ["shuli", "jingning", "youwei", "yuxi", "lingke", "aichen"]

PAD_CHAIN = [
    "选择会改写后面的路。",
    "气氛忽然认真起来。",
    "这句话比表面更重。",
]

# 中立守门：显式写出绑定女主与同盟代价（覆盖 yaml summary）
N_GATE_THICK: dict[tuple[str, str], str] = {
    # 书璃 — 家庭轴（不卡恋爱真结局，但影响同居节奏）
    ("story_shuli_act1_dinner", "b1"): "晚饭桌上她报校园近况，又装作不经意问你最近见谁——家人雷达比恋爱线更早开机。",
    ("story_shuli_act1_dinner", "b2"): "她强调：你们是家人——关心可以，别把她当恋爱参谋乱使，更别拿妹妹挡女主的枪。",
    ("story_shuli_act1_dinner", "b3"): "洗碗时她松口：关键时候会站你这边，但先把日子过稳；家不稳，外面的故事也站不住。",
    ("story_shuli_act2_ally", "b1"): "她摊开日程本：家务与约会撞车时，她不愿再当背锅的人——同盟从分清楚责任开始。",
    ("story_shuli_act2_ally", "b2"): "若有人让你为难，她可以帮说话——前提是你别把亲妹妹工具化，去替恋爱线擦屁股。",
    ("story_shuli_act2_ally", "b3"): "她在本子写下「同盟」：家人站队，不等于给你写恋爱剧本；真结局不靠她点头，但靠她不拆台。",
    ("story_shuli_act2_ally", "b4"): "本子合上；她说——你稳一点，这个家才稳。枫音也在同屋檐下，别让她们两个一起跟着乱。",
    # 静宁 → 静流
    ("story_jingning_act1_watch", "b1"): "时尚活动边缘她端着茶：看你看堂姐沈静流的眼神，比秀场还直白——观察日记已开页。",
    ("story_jingning_act1_watch", "b2"): "她点破：堂姐不易靠近；你若只是新鲜感，她会提前挡——cousin_watch 从这一句开始计时。",
    ("story_jingning_act1_watch", "b3"): "她合上小本：名字旁勾 cousin_watch_done。堂妹守门打开，静流真结局的门不再虚掩。",
    ("story_jingning_act2_toast", "b1"): "家族聚会她把你介绍成「朋友」：语气平，眼里全是考核——堂姐的面子，由她先护着。",
    ("story_jingning_act2_toast", "b2"): "举杯时她低声：伤堂姐，这杯就是警告；护堂姐，可同盟。cousin_watch_done 此前已落——今晚谈的是站队。",
    ("story_jingning_act2_toast", "b3"): "她在日记勾「同盟」：不是批准恋爱，是批准你继续被看见——真结局还差你自己走到天台。",
    ("story_jingning_act2_toast", "b4"): "散场她拍拍你肩：堂姐的事，你要配得上被旁观。守门此前已开，伤害她等于同时失信于宁。",
    # 悠微 → 小悠
    ("story_youwei_act1_model", "b1"): "画室门开一条缝；学妹抱速写本：学姐苏晚悠出去了——你要不要当十分钟临时模特？",
    ("story_youwei_act1_model", "b2"): "软尺与铅笔之间，她观察你是否尊重创作：对学姐好，不只是夸画，是不打扰她的线。",
    ("story_youwei_act1_model", "b3"): "她递出第三支笔：创作同盟入口打开。studio_sketch_done 落章——小悠真结局的门，从这一刻可以推开。",
    ("story_youwei_act2_pack", "b1"): "通贩打包台旁她把胶带抛给你：学姐又熬夜了——你是来帮忙，还是只想来沾灵感？",
    ("story_youwei_act2_pack", "b2"): "她坦白：学姐把心画进线里；你若只当素材，她会第一个把你请出画室。",
    ("story_youwei_act2_pack", "b3"): "箱子封口时她点头：同盟加固。守门此前已开——小悠那边，你才有资格谈「画框外」。",
    ("story_youwei_act2_pack", "b4"): "她塞给你马克笔：「负责让她睡觉。」同盟不是恋爱许可，是共同守护她的交稿命。",
    # 雨汐 → 晚雨
    ("story_yuxi_act1_cover", "b1"): "咖啡店换班口，她把围裙抛来：温晚雨今天状态不对——你是来喝杯就走，还是愿意顶半班？",
    ("story_yuxi_act1_cover", "b2"): "顶班时她观察你如何对熟客：对晚雨好，不是多点单，是别把她的停靠当成理所当然。",
    ("story_yuxi_act1_cover", "b3"): "收工她记下「可观察」并勾上 shift_cover_done：晚雨真结局的店门，从这一刻可以推开。",
    ("story_yuxi_act2_trust", "b1"): "雨夜她叫你留下来收桌：死党许可要当面验货——你对晚雨的心，经不经得起加班灯。",
    ("story_yuxi_act2_trust", "b2"): "她警告：伤害晚雨，她第一个拆台；真心待她，她第一个帮腔。语气比浓缩更苦。",
    ("story_yuxi_act2_trust", "b3"): "排班表旁写下死党同盟：真结局门此前已开——晚雨才能把「为你留的那杯」说出口。",
    ("story_yuxi_act2_trust", "b4"): "她拍拍你肩：店里的座位可以留，心不能骗。死党同盟，写得比糖度更死板。",
    # 铃可 → 若铃
    ("story_lingke_act1_guard", "b1"): "办公室门口她拦下你：顾老师的答疑有名单——越线的关心，她会用红笔先挡。",
    ("story_lingke_act1_guard", "b2"): "她说明伦理：迷恋可以，越界不行。boundary_guard 是为了保护若铃，也保护你别毁了课。",
    ("story_lingke_act1_guard", "b3"): "走廊里她给你一份须知并落下 boundary_guard_done：守规则的人，才有资格谈对等——若铃真结局门从此可开。",
    ("story_lingke_act2_pass", "b1"): "学期末她核对你的言行：课内距离保持住了——红笔第一次犹豫要不要收起。",
    ("story_lingke_act2_pass", "b2"): "她收起红笔：「规则你守过了。」同盟加固——办公室的门，对你和导师不再硬拦。",
    ("story_lingke_act2_pass", "b3"): "她提醒：守门此前已开不等于立刻恋爱；若铃要的对等，仍要你自己走到雨夜那一幕。",
    ("story_lingke_act2_pass", "b4"): "点头像盖章：伦理过关，心意才被允许靠近。伤了老师，助教的同盟会立刻撤回。",
    # 艾辰 → 艾莉
    ("story_aichen_act1_gate", "b1"): "花店后门她把你拦住：艾莉刚从旧伤里站起来——新鲜感的人，请从侧门离开。",
    ("story_aichen_act1_gate", "b2"): "闺蜜夜语气变硬：再婚不是游戏；你要靠近，先证明不会把承诺变成别人笑话。",
    ("story_aichen_act1_gate", "b3"): "她递给你备用花材：「先学会照顾活的。」friend_gate_done 落章——艾莉真结局的第二次开花，门从此可开。",
    ("story_aichen_act2_hold", "b1"): "订单忙时她观察你是否真的共担：送花、擦水、听她抱怨——不是摆拍的温柔。",
    ("story_aichen_act2_hold", "b2"): "她警告：让艾莉再哭一次，花圈她先备好。玩笑里全是守门人的刀。",
    ("story_aichen_act2_hold", "b3"): "她挥手放行：闺蜜同盟通过——第二次选择的权利交回艾莉；真结局门此前已开。",
    ("story_aichen_act2_hold", "b4"): "便签夹进花束：别忘浇水。闺蜜守门此前已开，教你的不是花艺，是怎么好好爱人。",
}

# T0 绑定女主：在关键幕点出中立守门（不改结构，只加厚 summary）
T0_GATE_HINT: dict[tuple[str, str], str] = {
    ("story_xiaoyou_act3_seen", "b3"): "她问：被看见会不会就不再是「只属于自己的线」？画室门外，学妹悠微其实也在悄悄看着你怎么回答。",
    ("story_xiaoyou_act4_frame", "b3"): "她坦白想过没画进画里的日子——真要走到画框外，还得让守门的学妹相信你不是过客。",
    ("story_wanyu_act3_spill", "b4"): "真心洒出来后她有点慌；死党雨汐若看见你接得潦草，下次换班许可会收得比雨更紧。",
    ("story_wanyu_act4_keep", "b3"): "黑暗里她想被照料、也想不为谁服务——这杯「为你留的」，也需要死党同盟不拆台才站得住。",
    ("story_jingliu_act3_rooftop", "b4"): "她问你愿不愿意看见「沈静流」而非总监——堂妹静宁的观察日记，其实就夹在这句问题后面。",
    ("story_jingliu_act4_equal_desk", "b3"): "告白很克制：不想当丑闻，想当并肩改 lookbook 的伴侣；家族守门过关后，这句话才有重量。",
    ("story_ruolin_act2_boundary", "b4"): "她留下一句：课结束前请把我当负责人。走廊外助教铃可的红笔，正等着看你是否守界。",
    ("story_ruolin_act4_peer", "b3"): "她坦白想被当作同伴而不是永远正确的灯——伦理守门通过后，名字才能真正取代职称。",
    ("story_aili_act2_stem", "b3"): "她坦白怕再婚变成笑话；闺蜜艾辰若觉得你轻浮，温室的门会比花茎折断更快。",
    ("story_aili_act4_rewed", "b2"): "干花与新芽旁她说第二次选择必须更诚实——friend_gate 过了，厨房灯才有资格像新的婚书。",
}

ENDING_PAGES: dict[str, list[str]] = {
    # T1 secret / good
    "ending_yeyu_hem_true": [
        "夜班灯熄后，她把半成品裙摆摊在你膝上，针脚细得像不肯示弱的人终于肯露出线头。",
        "「这件只给你试。」毒舌还在，手却很稳。便利店暖风与工房蒸汽叠在一起，像两种生活被缝成一条缝。",
        "你学会在她口是心非时递热水。锋利之下的心，被你用耐心锁边——从此夜班与赶工，都有人并肩。",
    ],
    "ending_yeyu_sharp_heart": [
        "她仍用最锋利的话护着最软的心；你听懂之后，吵架变成另一种量体，刺也不再真的伤人。",
        "便利店暖灯下，你们确认了关系。布料与关东煮的味道混在一起，竟也不觉得违和。",
        "人台上多了你的肩宽记录。独立设计师的生活依旧忙，但收工路上，终于有人接得住她的刺。",
    ],
    "ending_taotao_plain_true": [
        "卸妆棉放下后，她第一次用不加特效的脸看你：练习生的光关掉，剩下的呼吸很轻，也很真。",
        "「前排可以空着，但请你别只看舞台。」她把应援棒塞回箱底，像把职业与恋爱分成两个可切换的轨道。",
        "此后通告仍在，私信仍吵；只有你看见素颜时的她会笑——那笑容不卖票，却决定了真结局。",
    ],
    "ending_taotao_front_row": [
        "恋爱公开或半公开，你仍是她认定的「固定前排」——闪光灯之外，座位永远留一个。",
        "舞台与日常终于能切换。彩排结束她会找你要水，而不是只对镜头比心。",
        "应援色还在，契约却换了：你守护她的舞台，她允许你看见卸妆后的安静。",
    ],
    "ending_shizuku_aloud_true": [
        "图书馆闭馆铃响过，她第一次大声读出你的名字——声音轻颤，却把屏幕那边的沉默全部撕开。",
        "书页边缘留下她的指温。视频通话里习惯用文字的人，终于肯把心跳交给空气传播。",
        "并排座位成为你们的坐标。她仍轻声，但会主动牵袖口：告白不用扩音器，图书馆的回声已经够了。",
    ],
    "ending_shizuku_shelf_heart": [
        "她仍轻声，但会主动牵袖口。图书馆的位置永远为两人留着，像一本永不外借的双人书。",
        "推荐书单末尾多了你的名字。恋爱没有打破安静，只是让安静有了温度。",
        "窗光落在书脊上。她用气音说「谢谢你等」——那比任何大声告白都更像真的。",
    ],
    "ending_qiansha_merge_true": [
        "冲突分支合并的夜，她把旧 diff 清掉，只留下你们共同提交的那一行：愿意重来，也愿意留下。",
        "毒舌还在，伤害少了。显示器蓝光里，她第一次承认：和解不是认输，是把心重新 checkout。",
        "仓库绿灯亮起。你们学会了小步提交——恋爱像 hotfix，稳了，才敢打上 true 的标签。",
    ],
    "ending_qiansha_hotfix": [
        "不一定完美，但你们学会了小步提交。毒舌仍在，伤害少了，像注释掉会炸的旧代码。",
        "马克杯边写着两人的昵称缩写。夜编码不再只是逃避，而是并排 debug 生活的噪音。",
        "合并请求通过那天，她碰了碰你的肩：下一次冲突，先开 issue，再吵。",
    ],
    "ending_shiori_blank_true": [
        "空白页终于写下第一句不以「精灵」作掩饰的话：她怕被看穿，更怕你只爱那个戏言。",
        "书店夜灯下，她把笔递给你——故事可以合写，但主角必须是愿意落地的人。",
        "星空窗贴还在，契约却变了真。戏言变成认真的羁绊时，空白页不再空白。",
    ],
    "ending_shiori_spirit_vow": [
        "精灵与人类的戏言变成认真的羁绊。你们在星空下许诺陪伴，也许诺不逃回幻想里躲懒。",
        "书架最高层她仍会爬梯，但下来时会伸手给你。恋爱是另一本推荐书，封面写着彼此的名字。",
        "打烊后她锁门，却把你留在灯下：今晚的故事，只讲给愿意相信的人听。",
    ],
    "ending_miara_oath_true": [
        "限定谷子分到最后一枚，她把徽章别在你衣襟：不是营业，是把「同好」升级成「同盟」。",
        "缝纫机停转时她发誓：角色可以换装，心意不换。漫展灯熄后，誓言比闪光灯更亮。",
        "朋友圈合拍徽章墙那天，她笑着说公开方式就这样——真结局，缝在每一针里。",
    ],
    "ending_miara_merch_heart": [
        "她把限定谷子分你一半。恋爱公开在朋友圈的方式，是合拍徽章墙，而不是官宣长文。",
        "工位上的娃还在，旁边多了你的照片夹。谷子店员的日常依旧吵闹，心却有了固定库存。",
        "收摊后她拉你绕路看夜景：角色扮演结束，剩下的是愿意一起排队、一起缝补的人。",
    ],
    # T2 good only
    "ending_xingnai_album_good": [
        "旧相册翻到空白页，她把新拍的合照塞进去：青梅竹马的续集，终于不再只停在校服记忆里。",
        "便当盒盖上多了一格你爱吃的菜。轻副本不需要秘密结局，这一格已经够甜。",
        "天台风里她说「以后也一起吃」。相册合上，故事却打开了可以慢慢写的日常。",
    ],
    "ending_fengyin_knock_good": [
        "敲门不再被当成打扰。义妹沈枫音把游戏手柄分你一半：平等从被当成完整的人开始。",
        "同住屋檐下，边界与亲近终于学会共存。她笑着说——下次请进，也请敲门。",
        "客厅灯下多一副碗筷。轻副本的好结局，是家的温度，而不是抢戏的恋爱高潮。",
    ],
    "ending_qingcai_summer_good": [
        "谢幕掌声里，她对着你的方向比了心。练功房镜子不再只映出汗，也映出被接住的目光。",
        "烟火升起时，答案已经不用喊了。舞蹈社夏日祭的音乐还在响，牵手比旋转更稳。",
        "回家路上她把毛巾挂你肩上：舞台谢幕后，生活的安可只演给你看。",
    ],
    "ending_xiaoyang_stall_good": [
        "卖完最后一份烤鱿鱼，她把围裙解给你系：「下一班——恋人值班。」笑得比摊位灯还亮。",
        "文化祭夕阳里，社团帐本合上，恋爱帐本打开。轻副本的好结局，是愿意一起收摊。",
        "她蹭掉你鼻尖的酱汁：实验室与摊位之间，你选中了会笑出声的那一个夏天。",
    ],
    "ending_luna_moon_good": [
        "她把「星夜魔女」护符改成一对：「魔法失效条款——如果你不牵手。」你牵了。",
        "咖啡店夜班灯下，塔罗收进抽屉。恋爱不是占卜结果，是她愿意把巧合改成选择。",
        "月亮还在窗玻璃上。她碰杯说：今晚的牌阵，只有我们两张。",
    ],
}


def ensure_len(s: str, lo: int = 40, hi: int = 80) -> str:
    s = (s or "").strip()
    if len(s) > hi:
        return s[:hi]
    if len(s) >= lo:
        return s
    for pad in PAD_CHAIN:
        if len(s) >= lo:
            break
        if s.endswith(("。", "——", "？", "！")):
            s = s + pad
        else:
            s = s + "——" + pad
    return s[:hi]


def apply_beats() -> tuple[int, int]:
    routes = json.loads(ROUTES.read_text(encoding="utf-8"))
    updated_events = 0
    updated_beats = 0
    targets = set(T1 + T2 + N)

    # all rest curated + T0 gate hints
    event_ids = set(CURATED.keys())
    for eid, _ in list(N_GATE_THICK.keys()) + list(T0_GATE_HINT.keys()):
        event_ids.add(eid)

    for eid in sorted(event_ids):
        path = EVENTS / f"{eid}.yaml"
        if not path.is_file():
            continue
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        cid = ((raw.get("trigger") or {}).get("character_ids") or [""])[0]
        if cid not in targets and eid not in {k[0] for k in T0_GATE_HINT}:
            continue
        changed = False
        for b in raw.get("beats") or []:
            bid = b.get("id")
            key = (eid, bid)
            if key in N_GATE_THICK:
                new_s = ensure_len(N_GATE_THICK[key])
            elif key in T0_GATE_HINT:
                new_s = ensure_len(T0_GATE_HINT[key])
            else:
                new_s = ensure_len(str(b.get("summary") or ""))
            if b.get("summary") != new_s:
                b["summary"] = new_s
                updated_beats += 1
                changed = True
        if changed:
            path.write_text(_dump_event(raw), encoding="utf-8")
            updated_events += 1

        # sync routes from CURATED when available
        curated = CURATED.get(eid)
        if curated and cid in routes.get("characters", {}):
            m = re.match(rf"story_{re.escape(cid)}_(.+)", eid)
            if m:
                act_id = m.group(1)
                for act in routes["characters"][cid].get("acts") or []:
                    if act.get("id") == act_id:
                        if curated.get("route_beat"):
                            act["beat"] = curated["route_beat"]
                        if curated.get("route_sprites"):
                            act["sprites"] = list(curated["route_sprites"])
                        break

    ROUTES.write_text(json.dumps(routes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return updated_events, updated_beats


def apply_endings() -> None:
    pc = json.loads(CATALOG.read_text(encoding="utf-8"))
    endings = pc["endings"]

    # fix T1 good emotion
    for eid, ent in endings.items():
        sp = ent.get("sprite") or {}
        cid = sp.get("character_id") or ""
        outfit = sp.get("outfit") or ""
        emo = sp.get("emotion") or ""
        if cid in T1 and outfit.startswith("end_") and emo == "happy":
            sp["emotion"] = "love"

    pad_line = "这一页之后，日常继续，心意却不再含糊。"
    for eid, pages in ENDING_PAGES.items():
        if eid not in endings:
            raise SystemExit(f"missing ending {eid}")
        pages = list(pages)
        total = sum(len(p) for p in pages)
        while total < 120:
            pages.append(pad_line)
            total = sum(len(p) for p in pages)
        if len(pages) < 2:
            raise SystemExit(f"pages too few {eid}")
        endings[eid]["pages"] = pages

    # verify files
    for eid, ent in endings.items():
        sp = ent.get("sprite") or {}
        cid = sp.get("character_id") or ""
        if cid not in set(T1 + T2):
            continue
        outfit = (sp.get("outfit") or "").strip()
        emo = (sp.get("emotion") or "").strip() or "love"
        fn = f"{outfit}_{emo}.png" if outfit else f"{emo}.png"
        path = SPRITES / "romance" / cid / fn
        if not path.is_file():
            raise SystemExit(f"missing sprite {eid}: {path}")

    CATALOG.write_text(json.dumps(pc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def verify_summaries() -> None:
    bad: list[str] = []
    for cid in T1 + T2 + N:
        for yf in EVENTS.glob(f"story_{cid}_*.yaml"):
            data = yaml.safe_load(yf.read_text(encoding="utf-8"))
            for b in data.get("beats") or []:
                n = len(str(b.get("summary") or ""))
                if n < 40 or n > 80:
                    bad.append(f"{yf.name}:{b.get('id')}:{n}")
    # T0 gate-hinted events also in range
    for eid, bid in T0_GATE_HINT:
        yf = EVENTS / f"{eid}.yaml"
        data = yaml.safe_load(yf.read_text(encoding="utf-8"))
        for b in data.get("beats") or []:
            if b.get("id") == bid:
                n = len(str(b.get("summary") or ""))
                if n < 40 or n > 80:
                    bad.append(f"{yf.name}:{bid}:{n}")
    if bad:
        raise SystemExit("summary OOR: " + "; ".join(bad[:20]))


def main() -> None:
    ev, beats = apply_beats()
    apply_endings()
    verify_summaries()
    print(f"thicken_rest_stories: events={ev} beats={beats} endings={len(ENDING_PAGES)} OK")


if __name__ == "__main__":
    main()
