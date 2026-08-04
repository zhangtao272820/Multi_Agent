# -*- coding: utf-8 -*-
"""手写加厚 T0 六人 24 幕 beats，并对齐 story_routes.json 的 beat/sprites。

只改 beats / prompt 标题行 / routes.acts 文案；不改 trigger / rewards / choice_effects。
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"
ROUTES = ROOT / "data" / "story_routes.json"
SPRITE_ROOT = ROOT / "data" / "sprites" / "romance"
_EMOS = frozenset(
    {"angry", "happy", "love", "neutral", "sad", "sarcastic", "shy", "surprised"}
)

# event_id -> curated beats (+ optional route beat/sprites sync)
CURATED: dict[str, dict] = {
    # —— 苏晚悠 ——
    "story_xiaoyou_act1_threshold": {
        "route_beat": "阳台寒暄→借颜料欲言又止→第一次被邀请进画室",
        "route_sprites": ["casual", "home", "atelier_paint", "balcony_sunset"],
        "beats": [
            {
                "id": "b1",
                "summary": "傍晚阳台寒暄——她手上有颜料，门铃响得比往常轻。",
                "sprite_hint": ["balcony_sunset", "casual"],
                "soft_options": ["隔门问一句", "按铃再等", "先回自己家"],
            },
            {
                "id": "b2",
                "summary": "她借稀释剂，话到嘴边又咽下；礼貌邻居的距离忽然变薄。",
                "sprite_hint": ["home", "atelier_paint"],
                "soft_options": ["递过去并进门", "门口交接", "改天再说"],
            },
            {
                "id": "b3",
                "summary": "进画室：未干的画、灯、她背对你的肩线——门槛被轻轻推开。",
                "sprite_hint": ["atelier_paint", "home"],
                "soft_options": ["夸画", "安静看", "懂时退出"],
            },
        ],
    },
    "story_xiaoyou_act2_deadline": {
        "route_beat": "夜灯赶稿→咖啡与争执→你选陪熬或劝睡→共同扛过交稿",
        "route_sprites": ["deadline_lamp", "coffee_sketch", "rain", "convenience_sketch"],
        "beats": [
            {
                "id": "b1",
                "summary": "交稿夜：只剩一盏灯，她把线稿铺满桌，眼下青黑。",
                "sprite_hint": ["deadline_lamp", "home"],
                "soft_options": ["问还差多少", "先递热水", "别打扰只陪坐"],
            },
            {
                "id": "b2",
                "summary": "她笑说「习惯了」；你听出逞强，空气里全是咖啡与颜料味。",
                "sprite_hint": ["coffee_sketch", "deadline_lamp"],
                "soft_options": ["劝她睡两小时", "提议分工帮忙", "说相信她能扛"],
            },
            {
                "id": "b3",
                "summary": "雨敲窗。她问你会不会嫌烦——创作的火与被看见的怕缠在一起。",
                "sprite_hint": ["rain", "convenience_sketch"],
                "soft_options": ["说不烦想留下", "说担心她身体", "说天亮再评"],
            },
            {
                "id": "b4",
                "summary": "文件发出的瞬间她靠椅背喘气；这夜被你们一起记住。",
                "sprite_hint": ["deadline_lamp", "casual"],
                "soft_options": ["恭喜交稿", "让她靠一会儿", "约下次别独扛"],
            },
        ],
    },
    "story_xiaoyou_act3_seen": {
        "route_beat": "夜市速写→作品集摊开→被看见的羞耻与渴望→她敢给你未完成的自己",
        "route_sprites": ["night_market_sketch", "portfolio_spread", "bookstore_browse", "floor_sketch"],
        "beats": [
            {
                "id": "b1",
                "summary": "夜市灯下她速写路人，却把本子护得紧紧，像怕你看见败笔。",
                "sprite_hint": ["night_market_sketch", "casual"],
                "soft_options": ["夸她抓神的准", "问能不能看", "并排安静走"],
            },
            {
                "id": "b2",
                "summary": "书店角落，她终于摊开作品集——未完成页比成品更诚实。",
                "sprite_hint": ["bookstore_browse", "portfolio_spread"],
                "soft_options": ["认真翻每一页", "问哪页最怕被看", "说喜欢未完成"],
            },
            {
                "id": "b3",
                "summary": "她问：被看见会不会就不再是「只属于自己的线」？",
                "sprite_hint": ["portfolio_spread", "floor_sketch"],
                "soft_options": ["说看见不是占有", "说你想站画布对面", "说她可以随时合上"],
            },
            {
                "id": "b4",
                "summary": "她把一支铅笔推过来：下次……要不要当她的临时模特。",
                "sprite_hint": ["floor_sketch", "casual"],
                "soft_options": ["答应当模特", "笑说先练坐姿", "问报酬是不是晚饭"],
            },
        ],
    },
    "story_xiaoyou_act4_frame": {
        "route_beat": "阳台日落→亲密却克制→告白：要过没画进画里的日子→画框之外",
        "route_sprites": ["balcony_sunset", "intimate_lounge", "date", "atelier_paint"],
        "beats": [
            {
                "id": "b1",
                "summary": "同一阳台，日落把颜料桶染成金色；她说画框装不下全部生活。",
                "sprite_hint": ["balcony_sunset", "casual"],
                "soft_options": ["问装不下什么", "握住她沾色的手", "先听她说完"],
            },
            {
                "id": "b2",
                "summary": "画室沙发上她靠得很近，又忽然退开——怕把感情画成定稿。",
                "sprite_hint": ["intimate_lounge", "home"],
                "soft_options": ["先不靠近", "轻声说不怕改稿", "说你不是素材"],
            },
            {
                "id": "b3",
                "summary": "她坦白：想要的不是完美构图，是有人陪她过没画进画里的日子。",
                "sprite_hint": ["atelier_paint", "date"],
                "soft_options": ["回应要一起过", "说想当画框外的人", "先确认彼此节奏"],
            },
            {
                "id": "b4",
                "summary": "门铃不再只是邻居暗号；她笑着说——下次请进，不用隔门。",
                "sprite_hint": ["date", "balcony_sunset"],
                "soft_options": ["约定明天再来", "吻她额角", "认真说「我在」"],
            },
        ],
    },
    # —— 温晚雨 ——
    "story_wanyu_act1_regular": {
        "route_beat": "熟客座位→雨窗问来意→被记住糖度→短暂停靠被允许",
        "route_sprites": ["barista_steam", "rain", "work", "receipt_order"],
        "beats": [
            {
                "id": "b1",
                "summary": "你成了熟客座位；她放下杯子的角度像记得糖度。",
                "sprite_hint": ["barista_steam", "work"],
                "soft_options": ["道谢点单", "开个小玩笑", "安静坐下"],
            },
            {
                "id": "b2",
                "summary": "雨敲窗；她问你是来躲雨，还是专门来找这杯味道。",
                "sprite_hint": ["rain", "barista_steam"],
                "soft_options": ["说专门来的", "说顺便", "问她歇没歇"],
            },
            {
                "id": "b3",
                "summary": "她在小票上多画一笔笑脸：允许你把这里当成短暂停靠。",
                "sprite_hint": ["receipt_order", "casual"],
                "soft_options": ["约定下次还坐这", "多留一会儿", "道谢离开"],
            },
        ],
    },
    "story_wanyu_act2_close": {
        "route_beat": "打烊擦桌→共同收工→门外透气→疲惫第一次被看见",
        "route_sprites": ["closing_wipe", "open_sign", "break_bench", "pastry_platter"],
        "beats": [
            {
                "id": "b1",
                "summary": "打烊铃响，她翻转「休息」牌，眼神终于卸下营业笑。",
                "sprite_hint": ["open_sign", "work"],
                "soft_options": ["问要不要帮忙", "先安静等", "夸她今天辛苦"],
            },
            {
                "id": "b2",
                "summary": "同一张桌子两端擦拭；抹布相碰时她小声说「难得有人留下」。",
                "sprite_hint": ["closing_wipe", "barista_steam"],
                "soft_options": ["说想多懂一点她", "专注把桌擦完", "问能不能每周都帮"],
            },
            {
                "id": "b3",
                "summary": "后门台阶上她靠墙喘气，像终于把服务者的壳放下一寸。",
                "sprite_hint": ["break_bench", "closing_wipe"],
                "soft_options": ["递水", "听她抱怨排班", "并肩不说话"],
            },
            {
                "id": "b4",
                "summary": "她把最后一块糕点掰给你：打烊后的甜，只分给留下的人。",
                "sprite_hint": ["pastry_platter", "casual"],
                "soft_options": ["接过道谢", "问明天还开吗", "说想护送她回去"],
            },
        ],
    },
    "story_wanyu_act3_spill": {
        "route_beat": "杯测走神→家庭电话压住→雨窗真心洒出→你选听还是劝",
        "route_sprites": ["pour_over", "rain_window_seat", "roast_note_card", "milk_steam"],
        "beats": [
            {
                "id": "b1",
                "summary": "杯测时她手一抖，热液洒在杯垫上——笑容却还挂着。",
                "sprite_hint": ["pour_over", "work"],
                "soft_options": ["递纸巾", "问是不是累了", "假装没看见"],
            },
            {
                "id": "b2",
                "summary": "电话里传来催她回家的声线；她按静音，指节发白。",
                "sprite_hint": ["roast_note_card", "milk_steam"],
                "soft_options": ["问要不要出去接", "说你可以回避", "轻轻握住她手腕"],
            },
            {
                "id": "b3",
                "summary": "雨窗座位上她终于说离职犹豫：怕一离开就只剩「谁的女儿」。",
                "sprite_hint": ["rain_window_seat", "break_bench"],
                "soft_options": ["只听不劝", "支持她任何选择", "问她真正想要什么"],
            },
            {
                "id": "b4",
                "summary": "真心洒出来后她有点慌；你如何接住，会决定她还敢不敢靠。",
                "sprite_hint": ["rain_window_seat", "casual"],
                "soft_options": ["说今晚有你", "约打烊后再谈", "保证不转告别人"],
            },
        ],
    },
    "story_wanyu_act4_keep": {
        "route_beat": "关店只留一盏灯→为你留的那杯→黑暗里告白→温度被接住",
        "route_sprites": ["espresso_pull", "date", "home", "closing_wipe"],
        "beats": [
            {
                "id": "b1",
                "summary": "全店熄灯，只留吧台一盏；她拉出两只杯子，动作很慢。",
                "sprite_hint": ["espresso_pull", "closing_wipe"],
                "soft_options": ["问今晚特调叫什么", "帮她擦最后的台", "坐到吧台内侧"],
            },
            {
                "id": "b2",
                "summary": "她说这杯不是菜单上的——是「为你留的」，怕你听成营业话。",
                "sprite_hint": ["espresso_pull", "date"],
                "soft_options": ["认真接过", "问为什么是我", "笑说听成告白了"],
            },
            {
                "id": "b3",
                "summary": "黑暗里她承认：想被照料，也想选一个不为谁服务的关系。",
                "sprite_hint": ["date", "home"],
                "soft_options": ["告白回应", "说想照顾她", "先确认去留意向"],
            },
            {
                "id": "b4",
                "summary": "温度留在掌心；她把钥匙放进抽屉——明天的店，你们一起开门也行。",
                "sprite_hint": ["home", "casual"],
                "soft_options": ["约明天接她下班", "吻她指尖", "说先送她回家"],
            },
        ],
    },
    # —— 顾若铃 ——
    "story_ruolin_act1_lecture": {
        "route_beat": "课堂粉笔→办公室单独谈话→边界尚未越线的紧张靠近",
        "route_sprites": ["lecture_pointer", "office_hours", "school", "chalk_sleeve"],
        "beats": [
            {
                "id": "b1",
                "summary": "讲台上粉笔灰落在袖口；她点名提问，目光在你身上多停半秒。",
                "sprite_hint": ["lecture_pointer", "school"],
                "soft_options": ["认真回答", "课后留问题", "先记笔记"],
            },
            {
                "id": "b2",
                "summary": "office hours 门半掩；她把文件夹推开，谈的是课，气场却很近。",
                "sprite_hint": ["office_hours", "faculty_folder"],
                "soft_options": ["只谈学业", "问她累不累", "坦言紧张"],
            },
            {
                "id": "b3",
                "summary": "走廊尽头她说「有问题随时来」——像开了一扇必须自重的门。",
                "sprite_hint": ["corridor_advise", "chalk_sleeve"],
                "soft_options": ["道谢离开", "约固定答疑", "说会守规则"],
            },
        ],
    },
    "story_ruolin_act2_boundary": {
        "route_beat": "阅卷疲态→晚茶谈伦理→走廊流言阴影→你是否守「课结束前不越线」",
        "route_sprites": ["grading_sofa", "evening_tea", "corridor_advise", "scantron_grade"],
        "beats": [
            {
                "id": "b1",
                "summary": "沙发上堆着试卷，她揉眉心：今天改到想把红笔扔了。",
                "sprite_hint": ["grading_sofa", "scantron_grade"],
                "soft_options": ["帮忙递茶", "问截止日", "劝她歇十分钟"],
            },
            {
                "id": "b2",
                "summary": "晚茶蒸汽里她主动谈伦理与流言：迷恋可以，越线不行。",
                "sprite_hint": ["evening_tea", "office_hours"],
                "soft_options": ["郑重答应守界", "问界线具体在哪", "承认心动但会等"],
            },
            {
                "id": "b3",
                "summary": "走廊有人侧目；她放慢脚步，把师生距离重新量给你看。",
                "sprite_hint": ["corridor_advise", "school"],
                "soft_options": ["拉开半步", "改口称老师", "低声说理解"],
            },
            {
                "id": "b4",
                "summary": "她留下一句：课结束前，请把我当负责人，不是情绪出口。",
                "sprite_hint": ["evening_tea", "casual"],
                "soft_options": ["答应做到", "说值得等", "问学期结束后呢"],
            },
        ],
    },
    "story_ruolin_act3_equal": {
        "route_beat": "学期末卸身份→校园暮色散步→开放日人潮外→成绩单之外的人",
        "route_sprites": ["campus_twilight", "open_day_booth", "library_reserve", "bookshelf_reach"],
        "beats": [
            {
                "id": "b1",
                "summary": "成绩提交后她摘下工牌：今天，想以普通人身份走走。",
                "sprite_hint": ["campus_twilight", "casual"],
                "soft_options": ["答应陪走", "问还能称呼什么", "先看她脸色"],
            },
            {
                "id": "b2",
                "summary": "图书馆预约区她笑说终于不是「顾老师的答疑时段」。",
                "sprite_hint": ["library_reserve", "bookshelf_reach"],
                "soft_options": ["叫她名字试试", "分享一本闲书", "仍尊重距离"],
            },
            {
                "id": "b3",
                "summary": "开放日人潮外，她承认怕你只爱上讲台光环。",
                "sprite_hint": ["open_day_booth", "campus_twilight"],
                "soft_options": ["说喜欢的是她", "否认光环论", "问她真正害怕什么"],
            },
            {
                "id": "b4",
                "summary": "暮色里她伸手又收回：对等，要从你愿意等学期结束开始。",
                "sprite_hint": ["campus_twilight", "date"],
                "soft_options": ["说愿意等", "约定暑假再谈", "轻轻碰她指尖"],
            },
        ],
    },
    "story_ruolin_act4_peer": {
        "route_beat": "雨夜备课→不再称老师→对等的名字→讲台灯火外的选择",
        "route_sprites": ["rain_office_window", "night_prep_lamp", "date", "podium_lean"],
        "beats": [
            {
                "id": "b1",
                "summary": "雨打办公室窗；她合上教案，第一次说「今晚不当老师」。",
                "sprite_hint": ["rain_office_window", "night_prep_lamp"],
                "soft_options": ["叫她若铃", "问可以坐近点吗", "先递热饮"],
            },
            {
                "id": "b2",
                "summary": "她怕对等只是浪漫口号——权力差不会因一句称呼消失。",
                "sprite_hint": ["night_prep_lamp", "evening_tea"],
                "soft_options": ["谈具体边界", "承诺公开节奏由她", "承认你会谨慎"],
            },
            {
                "id": "b3",
                "summary": "空讲台下她说：想听你用名字叫她，而不是头衔。",
                "sprite_hint": ["podium_lean", "date"],
                "soft_options": ["认真叫她名字", "告白并尊重公开", "问她准备好了吗"],
            },
            {
                "id": "b4",
                "summary": "雨停。她把红笔收进袋：从今天起，成绩单外，我们是并肩的人。",
                "sprite_hint": ["date", "campus_twilight"],
                "soft_options": ["牵她的手", "约一顿非校园晚餐", "说「我在你这边」"],
            },
        ],
    },
    # —— 沈静流 ——
    "story_jingliu_act1_glass": {
        "route_beat": "玻璃门会议室→样衣与权力差→第一次被当成可靠下属之外的人",
        "route_sprites": ["boardroom_stand", "sample_swatch", "lookbook_flip", "work"],
        "beats": [
            {
                "id": "b1",
                "summary": "玻璃门内她站定汇报位，声音冷静得像裁好的直线。",
                "sprite_hint": ["boardroom_stand", "work"],
                "soft_options": ["紧跟议程", "会后单独确认", "注意她的疲态"],
            },
            {
                "id": "b2",
                "summary": "散会后她翻看样衣色卡，忽然问你「觉得这季太冷了吗」。",
                "sprite_hint": ["sample_swatch", "lookbook_flip"],
                "soft_options": ["诚实给审美意见", "问她本人喜不喜欢", "只谈市场数据"],
            },
            {
                "id": "b3",
                "summary": "她把一本被否的 lookbook 推过来：在别人面前，她很少露出犹豫。",
                "sprite_hint": ["lookbook_flip", "press_kit"],
                "soft_options": ["认真翻完", "说愿意扛一点压", "保守机密承诺"],
            },
        ],
    },
    "story_jingliu_act2_mask": {
        "route_beat": "客户提案面具→口红补妆裂口→电话简报里的倦→西装下的私人温度",
        "route_sprites": ["client_pitch", "lipstick_touch", "phone_brief", "fitting_mirror"],
        "beats": [
            {
                "id": "b1",
                "summary": "客户提案上她笑得无懈可击；散场后笑容像被拉链拉上。",
                "sprite_hint": ["client_pitch", "work"],
                "soft_options": ["递水", "夸她漂亮撑场", "问要不要推迟下一场"],
            },
            {
                "id": "b2",
                "summary": "化妆镜前她补口红，手微颤：面具比衣服更难脱。",
                "sprite_hint": ["lipstick_touch", "fitting_mirror"],
                "soft_options": ["说这里只有你", "帮她拿纸巾", "别追问只陪着"],
            },
            {
                "id": "b3",
                "summary": "电梯口电话简报里她压低声音，第一次把「我有点撑不住」漏给你。",
                "sprite_hint": ["phone_brief", "event_glass"],
                "soft_options": ["建议推迟回复", "说你可以挡一轮", "约天台透气"],
            },
            {
                "id": "b4",
                "summary": "她收起工牌：今晚不想再当「可靠的沈总」。",
                "sprite_hint": ["fitting_mirror", "casual"],
                "soft_options": ["叫她静流", "护送她下楼", "约定保密"],
            },
        ],
    },
    "story_jingliu_act3_rooftop": {
        "route_beat": "天台夜风→权力差摊开→专一压力与信任→夜谈成为转折",
        "route_sprites": ["rooftop_night", "phone_brief", "moodboard_pin", "date"],
        "beats": [
            {
                "id": "b1",
                "summary": "天台风很大；她靠栏杆，城市灯火比秀场更安静。",
                "sprite_hint": ["rooftop_night", "casual"],
                "soft_options": ["把外套给她", "并排不说话", "问今天哪里最累"],
            },
            {
                "id": "b2",
                "summary": "她直说权力差：喜欢你，也怕你爱上的是位置而不是人。",
                "sprite_hint": ["rooftop_night", "phone_brief"],
                "soft_options": ["否认功利", "承认会怕但想试", "问她要什么证明"],
            },
            {
                "id": "b3",
                "summary": "话题转到专一：她不玩开放游戏，假意会比拒绝更伤。",
                "sprite_hint": ["moodboard_pin", "date"],
                "soft_options": ["承诺认真专一", "坦诚若做不到就离开", "请求时间想清楚"],
            },
            {
                "id": "b4",
                "summary": "夜谈结束她轻碰你手背：从今晚起，允许你看见西装下面的人。",
                "sprite_hint": ["rooftop_night", "date"],
                "soft_options": ["回握", "约下次还上天台", "说会守秘密"],
            },
        ],
    },
    "story_jingliu_act4_equal_desk": {
        "route_beat": "对等工位→合同与真心→告白要并肩不是上下级→天台之后",
        "route_sprites": ["contract_stamp", "logo_redline", "date", "rooftop_night"],
        "beats": [
            {
                "id": "b1",
                "summary": "她把你的工位牌挪到对侧：工作上仍专业，关系上要试着对等。",
                "sprite_hint": ["contract_stamp", "work"],
                "soft_options": ["接受新摆位", "问同事怎么看", "笑说终于平视"],
            },
            {
                "id": "b2",
                "summary": "红线改稿时她停笔：如果恋爱，职场规则要比心动先写清楚。",
                "sprite_hint": ["logo_redline", "lookbook_flip"],
                "soft_options": ["一起订规则", "提议必要时回避", "说你听她主导"],
            },
            {
                "id": "b3",
                "summary": "她告白很克制：要的是并肩，不是被保护的下属戏码。",
                "sprite_hint": ["date", "rooftop_night"],
                "soft_options": ["对等回应告白", "说想成为她的选择", "确认公开时机"],
            },
            {
                "id": "b4",
                "summary": "印章落下的声音很轻；她说——天台之后，这是第一份共同签署。",
                "sprite_hint": ["contract_stamp", "date"],
                "soft_options": ["牵手离开办公室", "约一顿无关工作的饭", "说「我签」"],
            },
        ],
    },
    # —— 林艾莉 ——
    "story_aili_act1_balcony": {
        "route_beat": "阳台重逢→花束与旧记忆→不是复合回档的试探靠近",
        "route_sprites": ["bouquet_wrap", "home", "card_write", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "阳台晾着花剪；她抬头看见你，像把旧日历翻到空白页。",
                "sprite_hint": ["bouquet_wrap", "casual"],
                "soft_options": ["先打招呼", "夸花好看", "问方不方便"],
            },
            {
                "id": "b2",
                "summary": "她写贺卡时停笔：有些话不能再写给「从前的那位」。",
                "sprite_hint": ["card_write", "ribbon_cut"],
                "soft_options": ["问她现在好吗", "说你不是来翻旧账", "安静陪她写完"],
            },
            {
                "id": "b3",
                "summary": "她把一枝花递过来：重逢可以，复合剧本——免了。",
                "sprite_hint": ["bouquet_wrap", "home"],
                "soft_options": ["接花尊重界线", "说想重新认识", "告辞不打扰"],
            },
        ],
    },
    "story_aili_act2_stem": {
        "route_beat": "修枝去旧伤→温室雾气→她谈离婚后的重建→你如何接住",
        "route_sprites": ["greenhouse_mist", "stem_trim", "balm_hands", "petal_sweep"],
        "beats": [
            {
                "id": "b1",
                "summary": "温室雾气里她修掉枯枝：有些部分剪掉，花才活。",
                "sprite_hint": ["greenhouse_mist", "work"],
                "soft_options": ["问哪枝最难剪", "帮忙递剪刀", "说比喻听懂了"],
            },
            {
                "id": "b2",
                "summary": "她擦护手霜，声音很稳：离婚不是失败展览，是重建开工。",
                "sprite_hint": ["balm_hands", "petal_sweep"],
                "soft_options": ["认真倾听", "问需要什么支持", "别急着给建议"],
            },
            {
                "id": "b3",
                "summary": "修枝停住：她怕你把她当成「需要被拯救的前任故事」。",
                "sprite_hint": ["greenhouse_mist", "bouquet_wrap"],
                "soft_options": ["否认拯救叙事", "说看见的是现在的她", "保证不猎奇追问"],
            },
            {
                "id": "b4",
                "summary": "她把修好的花插入新瓶：今天起，旧伤可以留在土里。",
                "sprite_hint": ["ladder_hang", "casual"],
                "soft_options": ["帮她扶梯子", "约下次进货一起", "说想见证新花季"],
            },
        ],
    },
    "story_aili_act3_delivery": {
        "route_beat": "外送勇气→纸箱与门铃→她选择主动走向你→新勇气不是回头",
        "route_sprites": ["delivery_box", "market_crate", "fridge_restock", "corsage_pin"],
        "beats": [
            {
                "id": "b1",
                "summary": "她抱着外送纸箱出现在你家门口，耳尖红得像缎带。",
                "sprite_hint": ["delivery_box", "casual"],
                "soft_options": ["接过箱子", "邀请进屋歇脚", "问是不是顺路"],
            },
            {
                "id": "b2",
                "summary": "市场木箱气味还在；她说这次不是工作派单，是自己想送。",
                "sprite_hint": ["market_crate", "delivery_box"],
                "soft_options": ["问为什么选你", "谢谢她的勇气", "泡茶缓解紧张"],
            },
            {
                "id": "b3",
                "summary": "她别上手花又取下：主动靠近很怕被读成「回头」。",
                "sprite_hint": ["corsage_pin", "card_write"],
                "soft_options": ["说这是新选择", "轻轻帮她别好", "给她反悔空间"],
            },
            {
                "id": "b4",
                "summary": "冰箱被花束挤满；她笑：勇气用掉一格，心倒空出一格。",
                "sprite_hint": ["fridge_restock", "date"],
                "soft_options": ["约正式见面", "说你也很紧张", "送她回店"],
            },
        ],
    },
    "story_aili_act4_rewed": {
        "route_beat": "夜关店→第二次开花→告白是新誓言不是旧婚书→再一次选择",
        "route_sprites": ["night_close", "bouquet_wrap", "date", "bridal"],
        "beats": [
            {
                "id": "b1",
                "summary": "关店夜灯下她清点丝带：旧婚书已归档，双手却还想握花。",
                "sprite_hint": ["night_close", "ribbon_cut"],
                "soft_options": ["问她今晚想听什么", "帮忙卷丝带", "坦白你的心意"],
            },
            {
                "id": "b2",
                "summary": "她说若再选择，不要「回到从前」，只要「愿意重新开始」。",
                "sprite_hint": ["bouquet_wrap", "date"],
                "soft_options": ["答应重新开始", "确认不是将就", "谈节奏与公开"],
            },
            {
                "id": "b3",
                "summary": "告白像第二季花期：温柔，却带剪枝后的清楚力气。",
                "sprite_hint": ["date", "greenhouse_mist"],
                "soft_options": ["回应告白", "交换一个承诺", "问她怕什么"],
            },
            {
                "id": "b4",
                "summary": "她把一枚空白卡片塞给你：这一次，誓言由你们现写。",
                "sprite_hint": ["card_write", "bridal"],
                "soft_options": ["写下第一句", "吻她手背", "约明天一起看日出进货"],
            },
        ],
    },
    # —— 陆凛汐 ——
    "story_linxi_act1_desk": {
        "route_beat": "对桌逞强→文件山→便当缝隙里的破功→工位之间的第一寸",
        "route_sprites": ["desk_papers", "cubicle_bento", "binder_clip", "work"],
        "beats": [
            {
                "id": "b1",
                "summary": "对桌文件堆成山；她说「我可以」，语气像在跟自己较劲。",
                "sprite_hint": ["desk_papers", "work"],
                "soft_options": ["问要不要分一半", "夸她效率", "先别拆穿逞强"],
            },
            {
                "id": "b2",
                "summary": "午间便当她吃得很快，像怕被看成闲着；筷子却顿了一下。",
                "sprite_hint": ["cubicle_bento", "pantry_coffee"],
                "soft_options": ["分享配菜", "约茶水间透气", "聊非工作的事"],
            },
            {
                "id": "b3",
                "summary": "她把长尾夹推过来：工位之间的一步，原来只隔一只手的距离。",
                "sprite_hint": ["binder_clip", "desk_papers"],
                "soft_options": ["接过顺便帮忙", "笑说终于肯借力", "保持专业距离"],
            },
        ],
    },
    "story_linxi_act2_commute": {
        "route_beat": "末班车→伞与沉默→逞强裂缝→示弱被你接住",
        "route_sprites": ["commute_rail", "lobby_umbrella", "overtime_desk", "rain"],
        "beats": [
            {
                "id": "b1",
                "summary": "加班后末班车，她抓吊环睡站着，逞强在颠簸里裂开。",
                "sprite_hint": ["commute_rail", "overtime_desk"],
                "soft_options": ["让她靠座位", "轻声叫站稳", "分享耳机歌单"],
            },
            {
                "id": "b2",
                "summary": "出站遇雨，她坚持「我有伞」——伞骨却断了一根。",
                "sprite_hint": ["lobby_umbrella", "rain"],
                "soft_options": ["共撑一把", "叫车送她", "笑她嘴硬"],
            },
            {
                "id": "b3",
                "summary": "檐下她承认怕被当成需要照顾的实习生，所以总抢着扛。",
                "sprite_hint": ["lobby_umbrella", "casual"],
                "soft_options": ["说求助不是弱", "讲你也有逞强的时候", "约下次一起下班"],
            },
            {
                "id": "b4",
                "summary": "雨小了；她把坏伞塞进袋：今晚破功，只准你一个人知道。",
                "sprite_hint": ["commute_rail", "date"],
                "soft_options": ["保密承诺", "碰拳收工", "说明天文件我先看"],
            },
        ],
    },
    "story_linxi_act3_print": {
        "route_beat": "打印室卡纸→真相是她替人背锅→信任裂缝→并肩而不是替她逞强",
        "route_sprites": ["print_stack", "copier_jam", "filing_cabinet", "meeting_minutes"],
        "beats": [
            {
                "id": "b1",
                "summary": "打印室卡纸声刺耳；她跪着抽纸，袖口沾了碳粉。",
                "sprite_hint": ["copier_jam", "print_stack"],
                "soft_options": ["一起修机器", "问谁催的稿", "先擦她袖口"],
            },
            {
                "id": "b2",
                "summary": "文件柜后她压低声音：有份错不在她，她却把名字签在最前面。",
                "sprite_hint": ["filing_cabinet", "meeting_minutes"],
                "soft_options": ["问为什么扛", "提议一起澄清", "先听完整经过"],
            },
            {
                "id": "b3",
                "summary": "她怕你 intervening 会让她更像「被罩着的小孩」。",
                "sprite_hint": ["print_stack", "desk_papers"],
                "soft_options": ["问她想怎么做", "只提供证据不做主", "说你站她这边"],
            },
            {
                "id": "b4",
                "summary": "复印恢复嗡鸣；她把正确页叠齐：这一次，想试着不一个人逞强。",
                "sprite_hint": ["print_stack", "casual"],
                "soft_options": ["分工对稿", "约会后复盘", "肯定她的选择"],
            },
        ],
    },
    "story_linxi_act4_step": {
        "route_beat": "电梯并肩→导师阴影外→告白只要一步→工位之间的距离消失",
        "route_sprites": ["elevator_rush", "mentor_shadow", "date", "badge_tidy"],
        "beats": [
            {
                "id": "b1",
                "summary": "电梯关门前她挤进来，工牌歪着，第一次没急着扶正。",
                "sprite_hint": ["elevator_rush", "badge_tidy"],
                "soft_options": ["帮她扶工牌", "笑问赶去哪", "安静站她侧"],
            },
            {
                "id": "b2",
                "summary": "她说不想再活在「导师影子」里——喜欢你，也想被看成能并肩的人。",
                "sprite_hint": ["mentor_shadow", "laptop_brief"],
                "soft_options": ["说你看见她本身", "谈对等合作", "承认早心动"],
            },
            {
                "id": "b3",
                "summary": "告白很短：工位之间，其实只要一步。她问你迈不迈。",
                "sprite_hint": ["date", "desk_papers"],
                "soft_options": ["迈出那一步", "牵她出电梯", "认真说愿意"],
            },
            {
                "id": "b4",
                "summary": "楼层叮一声；她握着你的手不放——这一步，算你们共同的绩效。",
                "sprite_hint": ["date", "elevator_rush"],
                "soft_options": ["约下班一起走", "碰额角", "说明天对桌见"],
            },
        ],
    },
}


def _disk_outfits(cid: str) -> set[str]:
    folder = SPRITE_ROOT / cid
    found: set[str] = set()
    if not folder.is_dir():
        return found
    for path in folder.glob("*.png"):
        stem = path.stem
        matched = False
        for emo in _EMOS:
            suf = "_" + emo
            if stem.endswith(suf):
                found.add(stem[: -len(suf)])
                matched = True
                break
        if not matched:
            found.add(stem)
    return found


def _dump_event(data: dict) -> str:
    lines: list[str] = []
    lines.append(f"id: {data['id']}")
    lines.append(f"label: {data['label']}")
    lines.append(f"priority: {data['priority']}")
    lines.append(f"once: {str(data.get('once', True)).lower()}")
    lines.append(f"chance: {data.get('chance', 1.0)}")
    lines.append(f"scene_id: \"{data.get('scene_id') or ''}\"")
    tr = data.get("trigger") or {}
    lines.append("trigger:")
    for k, v in tr.items():
        if isinstance(v, list):
            lines.append(f"  {k}: [{', '.join(str(x) for x in v)}]")
        else:
            lines.append(f"  {k}: {v}")
    title_line = (data.get("prompt_snippet") or "").strip().split("\n")[0]
    if not title_line.startswith("【专属故事"):
        title_line = f"【专属故事 · {data['label']}】"
    lines.append("prompt_snippet: |")
    lines.append(f"  {title_line}")
    lines.append(f"advance: {data.get('advance') or 'on_player_turn'}")
    lines.append("beats:")
    for b in data["beats"]:
        lines.append(f"  - id: {b['id']}")
        summ = str(b["summary"]).replace('"', '\\"')
        lines.append(f'    summary: "{summ}"')
        hints = b.get("sprite_hint") or []
        lines.append(f"    sprite_hint: [{', '.join(str(x) for x in hints)}]")
        opts = b.get("soft_options") or []
        q = ", ".join(f'"{x}"' for x in opts)
        lines.append(f"    soft_options: [{q}]")
    rewards = data.get("rewards") or {}
    flags = rewards.get("flags_set") or []
    lines.append("rewards:")
    lines.append(f"  flags_set: [{', '.join(flags)}]")
    effects = data.get("choice_effects") or []
    if effects:
        lines.append("choice_effects:")
        for eff in effects:
            if isinstance(eff, dict):
                parts = []
                for ek in ("trust_delta", "affinity_delta", "mood_delta"):
                    if ek in eff and eff[ek] is not None:
                        parts.append(f"{ek}: {eff[ek]}")
                if eff.get("label"):
                    parts.append(f'label: "{eff["label"]}"')
                lines.append(f"  - {{ {', '.join(parts)} }}")
            else:
                # pydantic already dumped
                d = eff if isinstance(eff, dict) else getattr(eff, "model_dump", lambda: {})()
                parts = []
                for ek in ("trust_delta", "affinity_delta", "mood_delta"):
                    if d.get(ek) is not None:
                        parts.append(f"{ek}: {d[ek]}")
                lines.append(f"  - {{ {', '.join(parts)} }}")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    missing_files: list[str] = []
    bad_hints: list[str] = []
    generic_opts = {"认真接话", "先观察", "轻声提问", "表明态度", "给她空间", "确认她的意思", "坦白心意", "先缓一缓", "诚实说明顾虑"}

    routes = json.loads(ROUTES.read_text(encoding="utf-8"))
    chars = routes["characters"]

    for eid, curated in CURATED.items():
        path = EVENTS / f"{eid}.yaml"
        if not path.is_file():
            missing_files.append(eid)
            continue
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        cid = (raw.get("trigger") or {}).get("character_ids") or [""]
        cid = cid[0] if cid else ""
        have = _disk_outfits(cid)
        beats = curated["beats"]
        for b in beats:
            assert len(b["summary"]) <= 80, (eid, b["id"], len(b["summary"]))
            for h in b["sprite_hint"]:
                if h not in have:
                    bad_hints.append(f"{eid}:{b['id']}:{h}")
            for o in b["soft_options"]:
                if o in generic_opts:
                    bad_hints.append(f"{eid}:{b['id']}:generic_opt:{o}")
        raw["beats"] = beats
        # keep title line
        path.write_text(_dump_event(raw), encoding="utf-8")

        # sync story_routes act
        if cid in chars:
            act_key = eid.replace(f"story_{cid}_", "")
            for act in chars[cid].get("acts") or []:
                if act.get("id") == act_key:
                    act["beat"] = curated["route_beat"]
                    act["sprites"] = list(curated["route_sprites"])
                    break

    if missing_files:
        raise SystemExit(f"missing event files: {missing_files}")
    if bad_hints:
        raise SystemExit("bad hints/options:\n" + "\n".join(bad_hints[:40]))

    ROUTES.write_text(json.dumps(routes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"curate_t0_story_beats: OK ({len(CURATED)} events)")


if __name__ == "__main__":
    main()
