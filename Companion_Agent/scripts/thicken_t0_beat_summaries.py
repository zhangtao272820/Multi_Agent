# -*- coding: utf-8 -*-
"""加厚 T0 六人幕 beats.summary 至约 40–80 字，同步 story_routes.json。

不改 sprite_hint / soft_options / trigger / rewards。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"
ROUTES = ROOT / "data" / "story_routes.json"

# (event_id, beat_id) -> thickened summary (40–80 字)
THICK: dict[tuple[str, str], str] = {
    # —— 苏晚悠 ——
    ("story_xiaoyou_act1_threshold", "b1"): "傍晚阳台寒暄——她手上未干的颜料，门铃响得比往常轻，像在试探你会不会应门。",
    ("story_xiaoyou_act1_threshold", "b2"): "她借稀释剂，话到嘴边又咽下；礼貌邻居的距离忽然变薄，空气里全是松节油与犹豫。",
    ("story_xiaoyou_act1_threshold", "b3"): "进画室：未干的画、暖黄灯、她背对你的肩线——门槛被轻轻推开，却还留着可退的缝。",
    ("story_xiaoyou_act2_deadline", "b1"): "交稿夜：只剩一盏灯，她把线稿铺满桌，眼下青黑，时钟每跳一下都像在催稿。",
    ("story_xiaoyou_act2_deadline", "b2"): "她笑说「习惯了」；你听出逞强，空气里全是咖啡与颜料味，谁也不敢先提睡觉。",
    ("story_xiaoyou_act2_deadline", "b3"): "雨敲窗。她问你会不会嫌烦——创作的火与被看见的怕缠在一起，等你给一个不伤人的答案。",
    ("story_xiaoyou_act2_deadline", "b4"): "文件发出的瞬间她靠椅背喘气；这夜被你们一起记住，像一张终于签上两人名字的校样。",
    ("story_xiaoyou_act3_seen", "b1"): "夜市灯下她速写路人，却把本子护得紧紧，像怕你看见败笔，也像怕你夸得太准。",
    ("story_xiaoyou_act3_seen", "b2"): "书店角落，她终于摊开作品集——未完成页比成品更诚实，铅笔印还留着擦拭的痕迹。",
    ("story_xiaoyou_act3_seen", "b3"): "她问：被看见会不会就不再是「只属于自己的线」？声音很轻，却把选择交到你手里。",
    ("story_xiaoyou_act3_seen", "b4"): "她把一支铅笔推过来：下次……要不要当她的临时模特。邀请里藏着羞耻，也藏着信任。",
    ("story_xiaoyou_act4_frame", "b1"): "同一阳台，日落把颜料桶染成金色；她说画框装不下全部生活，眼神却停在你身上。",
    ("story_xiaoyou_act4_frame", "b2"): "画室沙发上她靠得很近，又忽然退开——怕把感情画成定稿，更怕你把她当成素材。",
    ("story_xiaoyou_act4_frame", "b3"): "她坦白：想要的不是完美构图，是有人陪她过没画进画里的日子——交稿日、雨天、无聊的晚饭。",
    ("story_xiaoyou_act4_frame", "b4"): "门铃不再只是邻居暗号；她笑着说——下次请进，不用隔门。门槛外的世界，终于有了你的位置。",
    # —— 温晚雨 ——
    ("story_wanyu_act1_regular", "b1"): "你成了熟客座位；她放下杯子的角度像记得糖度，营业笑里多了一点「欢迎回来」的温度。",
    ("story_wanyu_act1_regular", "b2"): "雨敲窗；她问你是来躲雨，还是专门来找这杯味道——问题轻，答案却会改写她一天的心情。",
    ("story_wanyu_act1_regular", "b3"): "她在小票上多画一笔笑脸：允许你把这里当成短暂停靠，也允许自己被多看一眼。",
    ("story_wanyu_act2_close", "b1"): "打烊铃响，她翻转「休息」牌，眼神终于卸下营业笑，像把一整班的力气轻轻放下。",
    ("story_wanyu_act2_close", "b2"): "同一张桌子两端擦拭；抹布相碰时她小声说「难得有人留下」，尾音里有点不敢相信。",
    ("story_wanyu_act2_close", "b3"): "后门台阶上她靠墙喘气，像终于把服务者的壳放下一寸，让你看见真实的疲与软。",
    ("story_wanyu_act2_close", "b4"): "她把最后一块糕点掰给你：打烊后的甜，只分给留下的人——比菜单更私密的招待。",
    ("story_wanyu_act3_spill", "b1"): "杯测时她手一抖，热液洒在杯垫上——笑容却还挂着，像习惯用完美服务掩盖走神。",
    ("story_wanyu_act3_spill", "b2"): "电话里传来催她回家的声线；她按静音，指节发白，柜台后的世界忽然变得很窄。",
    ("story_wanyu_act3_spill", "b3"): "雨窗座位上她终于说离职犹豫：怕一离开就只剩「谁的女儿」，店与家都像借来的身份。",
    ("story_wanyu_act3_spill", "b4"): "真心洒出来后她有点慌；你如何接住，会决定她还敢不敢靠——今晚的语气，比糖度更重要。",
    ("story_wanyu_act4_keep", "b1"): "全店熄灯，只留吧台一盏；她拉出两只杯子，动作很慢，像在给告白排练开场。",
    ("story_wanyu_act4_keep", "b2"): "她说这杯不是菜单上的——是「为你留的」，怕你听成营业话，又更怕你听懂后逃走。",
    ("story_wanyu_act4_keep", "b3"): "黑暗里她承认：想被照料，也想选一个不为谁服务的关系——不是客人，是并肩的人。",
    ("story_wanyu_act4_keep", "b4"): "温度留在掌心；她把钥匙放进抽屉——明天的店，你们一起开门也行，像把生活交一半给你。",
    # —— 顾若铃 ——
    ("story_ruolin_act1_lecture", "b1"): "讲台上粉笔灰落在袖口；她点名提问，目光在你身上多停半秒，像不小心泄露一点偏爱。",
    ("story_ruolin_act1_lecture", "b2"): "office hours 门半掩；她把文件夹推开，谈的是课，气场却很近——近到必须更守规矩。",
    ("story_ruolin_act1_lecture", "b3"): "走廊尽头她说「有问题随时来」——像开了一扇必须自重的门，邀请与警戒写在同一句里。",
    ("story_ruolin_act2_boundary", "b1"): "沙发上堆着试卷，她揉眉心：今天改到想把红笔扔了，却仍把最后一份分数算得分毫不差。",
    ("story_ruolin_act2_boundary", "b2"): "晚茶蒸汽里她主动谈伦理与流言：迷恋可以，越线不行——把选择权交还给你，也交给时间。",
    ("story_ruolin_act2_boundary", "b3"): "走廊有人侧目；她放慢脚步，把师生距离重新量给你看，像在公共场合练习克制。",
    ("story_ruolin_act2_boundary", "b4"): "她留下一句：课结束前，请把我当负责人，不是情绪出口。声音平稳，底下却有一点抖。",
    ("story_ruolin_act3_equal", "b1"): "成绩提交后她摘下工牌：今天，想以普通人身份走走——校园暮色第一次不再像讲台的延长。",
    ("story_ruolin_act3_equal", "b2"): "图书馆预约区她笑说终于不是「顾老师的答疑时段」，书架阴影里，称呼忽然变得危险而甜蜜。",
    ("story_ruolin_act3_equal", "b3"): "开放日人潮外，她承认怕你只爱上讲台光环——怕卸下身份后，你看见的只是一个普通疲惫的人。",
    ("story_ruolin_act3_equal", "b4"): "暮色里她伸手又收回：对等，要从你愿意等学期结束开始。手指停在半空，等你给勇气。",
    ("story_ruolin_act4_peer", "b1"): "雨打办公室窗；她合上教案，第一次说「今晚不当老师」——雨声替你们盖住心跳。",
    ("story_ruolin_act4_peer", "b2"): "备课灯下她允许你叫名字；音节落地时，讲台与座位之间的高度差终于被抹平一点。",
    ("story_ruolin_act4_peer", "b3"): "她坦白：想被当作同伴，而不是永远正确的灯——灯也会怕黑，也会想有人并肩。",
    ("story_ruolin_act4_peer", "b4"): "雨停后她把伞偏向你：从今晚起，称呼与距离都由你们自己写规则，不再交给教务处。",
    # —— 沈静流 ——
    ("story_jingliu_act1_glass", "b1"): "玻璃隔间里她站着听汇报，指尖点平板，语速冷而准——却在散会后多看了你一眼。",
    ("story_jingliu_act1_glass", "b2"): "电梯里只剩两人；她摘下耳机，忽然问你周末有没有空——不像上司，像试探。",
    ("story_jingliu_act1_glass", "b3"): "下班后的便利店灯下，她买黑咖啡，笑说「别跟同事说我也会饿」——面具裂开一道细缝。",
    ("story_jingliu_act2_mask", "b1"): "发布会后台，她对着镜子练微笑；妆镜里的完美，比台上更累人。",
    ("story_jingliu_act2_mask", "b2"): "她把样衣夹递给你：帮我看领口——近到能闻见香水，却仍用工作语气掩护。",
    ("story_jingliu_act2_mask", "b3"): "酒会角落她承认：面具戴久了，连自己都分不清哪句是真心。目光第一次躲开镜头。",
    ("story_jingliu_act2_mask", "b4"): "夜风里她问：如果摘下面具，你还会站在这吗？问题比合同条款更重。",
    ("story_jingliu_act3_rooftop", "b1"): "天台夜风掀起她的外套；城市灯火在脚下，她却说这里才像能喘气的办公室。",
    ("story_jingliu_act3_rooftop", "b2"): "她递出一枚未公开的胸针样：不是品牌的，是她私人收藏——像把秘密钥匙给你。",
    ("story_jingliu_act3_rooftop", "b3"): "谈到家庭与继承，她声音发紧：怕恋爱变成谈判桌上的筹码，更怕你被卷进流言。",
    ("story_jingliu_act3_rooftop", "b4"): "她靠着栏杆问你：愿不愿意当那个看见「沈静流」而非「总监」的人——答案会改写路线。",
    ("story_jingliu_act4_equal_desk", "b1"): "并排办公桌，文件堆成墙；她把私人日历滑到你这边，像交出一段不被公司占用的时间。",
    ("story_jingliu_act4_equal_desk", "b2"): "样衣间镜子前，她让你选周末行程——不再用「安排」口吻，而用「我们」。",
    ("story_jingliu_act4_equal_desk", "b3"): "告白很克制：不想当上下级恋爱的丑闻，想当能并肩改 lookbook 的伴侣。",
    ("story_jingliu_act4_equal_desk", "b4"): "她把工牌翻过去：今晚起，桌对面是平等的人。灯还亮着，合同之外的条款由你们签。",
    # —— 艾莉 ——
    ("story_aili_act1_balcony", "b1"): "花店阳台风干花束轻晃；她修剪茎秆，像在整理旧婚书里未说完的句子。",
    ("story_aili_act1_balcony", "b2"): "你问起「前妻」二字，她手一顿：那是别人的标题，她想要的是重新开花的权利。",
    ("story_aili_act1_balcony", "b3"): "她递给你一支备用花材：先学会照顾活的东西，再谈要不要靠近她的温室。",
    ("story_aili_act2_stem", "b1"): "温室雾气里，她示范如何扶正折茎——手法温柔，像在教你如何对待曾受伤的人。",
    ("story_aili_act2_stem", "b2"): "订单簿上写满婚礼与葬礼；她说花材不问故事，人却会把故事插进花瓶。",
    ("story_aili_act2_stem", "b3"): "她坦白怕再婚：不是怕爱，是怕承诺再次变成别人嘴里的笑话。",
    ("story_aili_act2_stem", "b4"): "收工时她把剪刀洗净：今晚的茎都扶正了——问你，人是不是也能再试一次。",
    ("story_aili_act3_delivery", "b1"): "你帮她送花到客户门口；她站在楼梯下看你，像评估一个是否可靠的共担者。",
    ("story_aili_act3_delivery", "b2"): "回程车上她说起闺蜜守门：朋友怕你只是新鲜感，她却更怕自己先心软。",
    ("story_aili_act3_delivery", "b3"): "花泥溅到袖口，她笑了：弄脏也没关系——生活本来就不是橱窗里的完美花束。",
    ("story_aili_act3_delivery", "b4"): "卸货后她握你的手量温度：如果要靠近，请带着耐心，不要带着拯救者的姿态。",
    ("story_aili_act4_rewed", "b1"): "打烊后的厨房灯很暖；她没有急着谈婚礼，只问你愿不愿意先共享一顿普通晚饭。",
    ("story_aili_act4_rewed", "b2"): "干花与新芽并置的台面旁，她说第二次选择必须更诚实——不再为面子留下。",
    ("story_aili_act4_rewed", "b3"): "告白像插花：位置、角度、留白都要商量——她问你，愿不愿意把名字写进新的花卡。",
    ("story_aili_act4_rewed", "b4"): "她把店钥放进同一串：不是仓促的再婚仪式，是两个人决定一起照看会呼吸的日常。",
    # —— 沈凛汐 ——
    ("story_linxi_act1_desk", "b1"): "工位隔板后她探头问报表：红丝带松了一点，紧张却仍写在坐直的脊背上。",
    ("story_linxi_act1_desk", "b2"): "打印室灯管闪烁；她抱着纸堆说「对不起占道」——道歉多过呼吸，像怕成为麻烦。",
    ("story_linxi_act1_desk", "b3"): "你帮她对齐页码时，她耳尖发红：第一次有人把实习的慌张当成值得认真对待的事。",
    ("story_linxi_act2_commute", "b1"): "晚高峰车厢里她抓吊环；肩碰肩时她小声说「公司好远」，像把疲惫借你分担半寸。",
    ("story_linxi_act2_commute", "b2"): "换乘站风很大，她把围巾分你一半：不是暧昧，是实习生存手册里新增的互助条款。",
    ("story_linxi_act2_commute", "b3"): "她问起你当年第一份工：想听的不是成功学，是有人承认「我也慌过」。",
    ("story_linxi_act2_commute", "b4"): "到站前她说：如果可以，想和你走同一段回家路——哪怕只是同方向的沉默。",
    ("story_linxi_act3_print", "b1"): "加班打印室只剩你们；纸张温热，她盯着错误页码，眼眶却先红了。",
    ("story_linxi_act3_print", "b2"): "她承认怕被转正刷掉，也怕依赖你——依赖像违规操作，一旦被看见就写进考核。",
    ("story_linxi_act3_print", "b3"): "你帮她重排文档时，她忽然笑出声：原来并肩改错，比一个人硬撑更像「能干」。",
    ("story_linxi_act3_print", "b4"): "电梯下行，她问能不能把「谢谢同事」改成更私人的话——声音小，决心却不小。",
    ("story_linxi_act4_step", "b1"): "天台风干着她的工牌带；她说工位之间其实只要一步，却练了整个季度才敢迈。",
    ("story_linxi_act4_step", "b2"): "她把转正通知书折好又展开：成绩单之外，想确认你看见的是沈凛汐，不是实习生标签。",
    ("story_linxi_act4_step", "b3"): "告白很短：工位之间，其实只要一步。她问你迈不迈——风把红丝带吹到你手边。",
    ("story_linxi_act4_step", "b4"): "楼层叮一声；她握着你的手不放——这一步，算你们共同的绩效，也算恋爱的入职手续。",
}


def main() -> None:
    routes = json.loads(ROUTES.read_text(encoding="utf-8"))
    updated_events = 0
    updated_beats = 0
    too_long: list[str] = []
    too_short: list[str] = []

    by_event: dict[str, dict[str, str]] = {}
    for (eid, bid), summ in THICK.items():
        by_event.setdefault(eid, {})[bid] = summ

    for eid, beat_map in by_event.items():
        path = EVENTS / f"{eid}.yaml"
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        changed = False
        for b in raw.get("beats") or []:
            bid = b.get("id")
            if bid not in beat_map:
                continue
            new_s = beat_map[bid]
            n = len(new_s)
            if n > 80:
                too_long.append(f"{eid}:{bid}:{n}")
            if n < 40:
                too_short.append(f"{eid}:{bid}:{n}")
            if b.get("summary") != new_s:
                b["summary"] = new_s
                updated_beats += 1
                changed = True
        if changed:
            # rewrite with stable-ish dump via curate helper style
            from curate_t0_story_beats import _dump_event  # type: ignore

            path.write_text(_dump_event(raw), encoding="utf-8")
            updated_events += 1

            # sync route act beat string from joined beat titles (keep existing route_beat if present)
            cid = (raw.get("trigger") or {}).get("character_ids") or [""]
            cid = cid[0] if cid else ""
            char = (routes.get("characters") or {}).get(cid) or {}
            for act in char.get("acts") or []:
                # match by event id embedded in act id or file naming
                act_id = str(act.get("id") or "")
                # story_xiaoyou_act1_threshold <-> act1_threshold
                suffix = eid.split("_", 2)[-1] if eid.startswith("story_") else ""
                # eid = story_{cid}_{act_id}
                m = re.match(rf"story_{re.escape(cid)}_(.+)", eid)
                if m and m.group(1) == act_id:
                    # keep route beat as arrow chain of shortened clauses
                    arrows = "→".join(
                        (b.get("summary") or "")[:18].rstrip("，。；") for b in raw["beats"]
                    )
                    # Prefer not to explode routes: leave route_beat if already good;
                    # only refresh when empty
                    if not act.get("beat"):
                        act["beat"] = arrows

    ROUTES.write_text(json.dumps(routes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # verify all T0 summaries in range
    t0 = ["xiaoyou", "wanyu", "ruolin", "jingliu", "aili", "linxi"]
    out_of_range = []
    for cid in t0:
        for yf in sorted(EVENTS.glob(f"story_{cid}_*.yaml")):
            data = yaml.safe_load(yf.read_text(encoding="utf-8"))
            for b in data.get("beats") or []:
                n = len(str(b.get("summary") or ""))
                if n < 40 or n > 80:
                    out_of_range.append(f"{yf.name}:{b.get('id')}:{n}")

    print(f"updated_events={updated_events} updated_beats={updated_beats}")
    if too_long:
        print("TOO_LONG", too_long)
    if too_short:
        print("TOO_SHORT", too_short)
    if out_of_range:
        print("OUT_OF_RANGE", out_of_range)
        raise SystemExit(1)
    print("thicken_t0_beat_summaries: OK")


if __name__ == "__main__":
    main()
