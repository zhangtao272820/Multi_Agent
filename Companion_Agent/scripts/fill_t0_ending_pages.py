# -*- coding: utf-8 -*-
"""加厚 T0 secret/good 结局 pages（合计≥120 字，≥2 段）；保留 end_* 绑定。"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "data" / "presentation_catalog.json"

# ending_id -> pages (keep sprite/bg/bgm untouched)
PAGES: dict[str, list[str]] = {
    # 已较厚：微调补足 good
    "ending_xiaoyou_atelier_partner": [
        "通贩打包台上并排两双手：一双裁刀，一双贴胶带。恋爱之外，你们更像能互相改稿的搭档。",
        "她偶尔会用马克笔在你手背点一下：「这里漏了。」然后假装很忙地低头。那比钻戒更早宣告了关系。",
        "交稿日她仍会熬夜，但桌上会多出第二杯水。画框外的日子，从这些小事开始被你们一起过完。",
    ],
    "ending_wanyu_shop_anchor": [
        "雨窗上的水珠慢下来。她记住你的糖度，也记住你哪天会晚到——像把你编进店里的隐形菜单。",
        "店还是那家店，座位还是那个座位——只是她看你的眼神，终于不再像在服务，而像在等一个人回家。",
        "打烊后她不再赶你走。关灯的权利，变成两个人轮流按开关的默契；店门钥匙，也多了一份安心。",
    ],
    # —— 顾若铃 ——
    "ending_ruolin_peer_true": [
        "成绩提交截止的当晚，她把通讯录里「学生」一类的标签全部清掉，像卸下一层必须正确的壳。",
        "雨打在办公室窗上。她第一次只用名字叫你，声音轻，却把讲台与座位之间的高度差抹平。",
        "此后课堂仍在，伦理仍在；只是雨停之后，你们终于能以对等的步伐走下同一段走廊——灯是灯，人也是人。",
    ],
    "ending_ruolin_lamp_guide": [
        "你们确认了关系，她却仍是你迷茫时愿意亮起的那盏灯——差别是，灯也会伸手要一点温度。",
        "课堂与课后散步并存，并不彼此取消。粉笔灰落在袖口时，她会笑着问你：今天想听课，还是想听心里话。",
        "学期手册翻到空白页，她写下你们的约定：尊重规则，也尊重爱。讲台之外，名字比职称更响。",
    ],
    # —— 沈静流 ——
    "ending_jingliu_rooftop_true": [
        "天台夜风里，她把工牌翻过去，城市灯火在脚下碎成一片。她说：今晚开始，请看见沈静流，而不是总监。",
        "未公开的胸针贴在你掌心，像一枚私人密钥。品牌会发布下一季，而她把「专一」留给你。",
        "回到玻璃隔间之前，她碰了碰你的指尖——合同之外的条款，终于有了不被会议室审议的签名。",
    ],
    "ending_jingliu_lookbook_heart": [
        "她把私人行程写进你的日历：周末样衣间、不接工作电话的两小时、以及一顿不必拍照的晚饭。",
        "董事会仍在，酒会仍在；但 lookbook 翻到最后一页时，旁边多了你的批注，像共同署名的生活样稿。",
        "她摘下耳麦笑说：面具可以上班用。下班后，她只想当能跟你拌嘴、也能靠一下的人。",
    ],
    # —— 艾莉 ——
    "ending_aili_second_bloom_true": [
        "花店打烊后，干花与新芽并置的台面还留着水珠。她说第二次选择必须更诚实——不再为面子留下。",
        "你把名字写进新的花卡；她没有急着办酒，只是把店钥与家钥放进同一串，像把呼吸的日常交给共担。",
        "温室雾气散开时，她靠着你肩线轻声道：旧的茎可以剪掉，新的花会从伤口附近重新开。这一次，有你浇水。",
    ],
    "ending_aili_gentle_remarry": [
        "你们没有急着办酒。花店打烊后的厨房灯，已足够像一份新的婚书——纸短，情却写得很长。",
        "早餐时她把花剪放在桌上：「今天的订单我们一起看。」再婚不是仪式的堆砌，是并肩修剪的清晨。",
        "闺蜜来访时她大方介绍你。守门人放下戒备那天，她才真正相信：幸福可以第二次，且不必藏着。",
    ],
    # —— 沈凛汐 ——
    "ending_linxi_onestep_true": [
        "天台风把红丝带吹到你手边。她说工位之间其实只要一步，却练了整个季度才敢迈——现在，她问你迈不迈。",
        "你迈了。电梯下行时她握着你的手不放，像把转正通知书与恋爱入职手续订成同一本。",
        "回到工位，隔板依旧；但她探头的角度变了：不是道歉占道，是确认「我们」还在同一层楼。",
    ],
    "ending_linxi_overtime_pair": [
        "恋爱没有让效率下降。打印机旁的拌嘴，成了公司里公开的甜蜜噪音——同事装作听不见，其实都在笑。",
        "加班夜她仍会慌，但会把文件转到你这边：「一起改。」依赖不再像违规，而像被允许的协作。",
        "下班路灯下，她把围巾分你一半。实习生存手册的最后一章，标题改成了：有人同行。",
    ],
    # 中立结局文案校对（随 B2 换装）
    "ending_shuli_family_ally": [
        "她把日程本拍到你胸口：「恋爱随便你——但先按时吃饭。」这是妹妹能给的最高认证，也是最硬的家规。",
        "餐桌上多一副碗筷的位置。她不拦你的故事，只拦你熬夜；家的边界，从此有人替你守着。",
        "你晚归时灯还亮着。她假装看书，其实在听门——亲情这门课，她打分一向严格，却很少不及格。",
    ],
    "ending_youwei_studio_ally": [
        "她把马克笔塞给你：「学姐的线我改不了——你负责让她睡觉。」语气半玩笑，眼神却认真。",
        "打包台旁她点头承认：你通过了工作室的非正式考核。守门打开后，画室的灯可以更早灭一点。",
        "此后赶稿夜她会敲邻桌：「人呢？」——不是查岗，是确认有人能把苏晚悠从线稿堆里拽出来透气。",
    ],
    "ending_yuxi_shift_ally": [
        "她把围裙抛给你：「今晚你收桌。温晚雨去睡觉——这是死党许可。」笑里带着警告与祝福。",
        "咖啡香散尽时她拍拍你肩：伤害晚雨，她第一个拆台；真心对她，她第一个帮腔。",
        "排班表多了一行备注：若熟客先生来晚，留给靠窗那位。死党的同盟，写得比菜单还清楚，也比糖度更死板。",
    ],
    "ending_jingning_watch_ally": [
        "她碰杯：「堂姐的面子我护着。你若真心，我帮腔；你若玩弄，我拆台。」酒液晃出一圈锋利的光。",
        "家族聚会上她把你介绍得很短，观察却很长。过关的那天，她只说了句：别让她独自撑场面。",
        "此后酒局她仍坐主位旁听。堂妹的守门一旦抬起，你就再也找不到「只是玩玩」的借口。",
    ],
    "ending_lingke_boundary_ally": [
        "她收起红笔：「规则你守过了。以后办公室的门——对你和导师，我不再拦。」尾音仍留着助教的严谨。",
        "走廊里她与你错身，点头像盖章：伦理过关，心意才被允许靠近。守门人退开半步，故事才能向前。",
        "答疑名单上她把你的时段标成「已核验」。边界仍在，只是门内多了一份被信任的自由。",
    ],
    "ending_aichen_gate_ally": [
        "她把一枝备用花材塞给你：「送给她。下次再让她哭，花圈我先备好。」语气却是笑着的。",
        "花店门口她挥手：闺蜜的幸福要亲眼验货。你接过花茎的那一刻，等于接过一份沉甸甸的信任。",
        "此后订单里偶尔夹一张便签：别忘浇水。闺蜜守门通过后，她教你的不是花艺，是怎么好好爱人。",
    ],
}


def main() -> None:
    pc = json.loads(CATALOG.read_text(encoding="utf-8"))
    endings = pc["endings"]
    for eid, pages in PAGES.items():
        if eid not in endings:
            raise SystemExit(f"missing ending {eid}")
        total = sum(len(p) for p in pages)
        if len(pages) < 2 or total < 120:
            raise SystemExit(f"pages too thin {eid}: {len(pages)} pages / {total} chars")
        endings[eid]["pages"] = pages

    # verify T0 secret/good still have correct outfits/emotions
    t0_check = {
        "ending_aili_gentle_remarry": ("end_robe_open", "love"),
        "ending_jingliu_lookbook_heart": ("end_robe_open", "love"),
        "ending_linxi_overtime_pair": ("end_robe_open", "love"),
        "ending_ruolin_lamp_guide": ("end_robe_open", "love"),
        "ending_shuli_family_ally": ("home_sibling", "happy"),
    }
    for eid, (outfit, emo) in t0_check.items():
        sp = endings[eid]["sprite"]
        if sp.get("outfit") != outfit or sp.get("emotion") != emo:
            raise SystemExit(f"sprite drift {eid}: {sp}")

    CATALOG.write_text(json.dumps(pc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # report T0 totals
    t0_ids = [
        "ending_xiaoyou_frame_true",
        "ending_xiaoyou_atelier_partner",
        "ending_wanyu_last_cup_true",
        "ending_wanyu_shop_anchor",
        "ending_ruolin_peer_true",
        "ending_ruolin_lamp_guide",
        "ending_jingliu_rooftop_true",
        "ending_jingliu_lookbook_heart",
        "ending_aili_second_bloom_true",
        "ending_aili_gentle_remarry",
        "ending_linxi_onestep_true",
        "ending_linxi_overtime_pair",
    ]
    for eid in t0_ids:
        pages = endings[eid]["pages"]
        print(eid, "pages", len(pages), "chars", sum(len(p) for p in pages))
    print("fill_t0_ending_pages: OK")


if __name__ == "__main__":
    main()
