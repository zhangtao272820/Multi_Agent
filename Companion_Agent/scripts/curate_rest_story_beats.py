# -*- coding: utf-8 -*-
"""手写加厚 T1 / T2 / N 全部专属幕，并对齐 story_routes.json。

约定同 curate_t0_story_beats.py：不改 trigger/rewards/choice_effects。
中立线软选项禁止恋爱走向；T2 立绘包瘦，只用磁盘真实 outfit。
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"
ROUTES = ROOT / "data" / "story_routes.json"
SPRITES = ROOT / "data" / "sprites"
_EMOS = frozenset(
    {"angry", "happy", "love", "neutral", "sad", "sarcastic", "shy", "surprised"}
)

GENERIC_OPTS = {
    "认真接话",
    "先观察",
    "轻声提问",
    "表明态度",
    "给她空间",
    "确认她的意思",
    "坦白心意",
    "先缓一缓",
    "诚实说明顾虑",
    "答应站同一边",
}

CURATED: dict[str, dict] = {
    # ========== T1 taotao ==========
    "story_taotao_act1_practice": {
        "route_beat": "声乐棚破音→编舞记号→你当应急观众→练习室第一次被接住",
        "route_sprites": ["vocal_booth", "choreo_mark", "stretch_break", "school"],
        "beats": [
            {
                "id": "b1",
                "summary": "声乐棚里她破了音，却对空气笑：偶像不能露怯。",
                "sprite_hint": ["vocal_booth", "school"],
                "soft_options": ["递水", "说破音也很真", "假装刚进门"],
            },
            {
                "id": "b2",
                "summary": "地板记号旁她喘着数拍；需要一个人当「应急观众」。",
                "sprite_hint": ["choreo_mark", "stretch_break"],
                "soft_options": ["坐下认真看", "给节奏鼓掌", "问要不要休息"],
            },
            {
                "id": "b3",
                "summary": "她写歌词马克笔停住：被看见练习，比登台更可怕一点。",
                "sprite_hint": ["lyric_marker", "casual"],
                "soft_options": ["说秘密只给你", "夸努力看得见", "约下次还来"],
            },
        ],
    },
    "story_taotao_act2_stage": {
        "route_beat": "应援棒海→握手会眼神→卸妆前的空隙→台上万人与台下一人",
        "route_sprites": ["lightstick_wave", "handshake_look", "vocal_booth", "date"],
        "beats": [
            {
                "id": "b1",
                "summary": "演出夜灯牌如潮；她在你那格停了一拍，像怕被淹没。",
                "sprite_hint": ["lightstick_wave", "school"],
                "soft_options": ["举高灯牌", "对口型应援", "安静当锚点"],
            },
            {
                "id": "b2",
                "summary": "握手会她握得比流程更久：台上万人，台下只想确认你在。",
                "sprite_hint": ["handshake_look", "lightstick_wave"],
                "soft_options": ["说「我在」", "小声加油", "不抢话只微笑"],
            },
            {
                "id": "b3",
                "summary": "返场后通道里她还喘着：喜欢被看见，也怕只被当成灯牌。",
                "sprite_hint": ["vocal_booth", "casual"],
                "soft_options": ["说看见的是她", "问卸妆后见不见", "递外套"],
            },
            {
                "id": "b4",
                "summary": "她把一支用过的应援棒塞你：今晚以后，别只当观众。",
                "sprite_hint": ["date", "lightstick_wave"],
                "soft_options": ["收下当信物", "约私下见面", "说会守边界"],
            },
        ],
    },
    "story_taotao_act3_plain": {
        "route_beat": "拉伸卸力→素颜家常→专一压力→灯牌放下之后",
        "route_sprites": ["stretch_break", "home", "date", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "练习后拉伸，素颜汗意未消；她问你还认不认得「台上的她」。",
                "sprite_hint": ["stretch_break", "home"],
                "soft_options": ["说更喜欢现在", "认真看她眼睛", "帮她拉筋计数"],
            },
            {
                "id": "b2",
                "summary": "她坦白怕恋爱变成营业附属：想要一人专一，不是站哥名额。",
                "sprite_hint": ["home", "casual"],
                "soft_options": ["承诺不当站哥恋爱", "谈公开节奏", "问她真正想要"],
            },
            {
                "id": "b3",
                "summary": "灯牌放下的瞬间她说喜欢你——要的是素颜也被选中。",
                "sprite_hint": ["date", "stretch_break"],
                "soft_options": ["素颜告白回应", "说舞台外也陪", "确认彼此界限"],
            },
            {
                "id": "b4",
                "summary": "她把麦克风支架推远：从今晚起，你是观众席外的位置。",
                "sprite_hint": ["date", "home"],
                "soft_options": ["牵她离开练习室", "约一顿无镜头晚饭", "说「我选你」"],
            },
        ],
    },
    # ========== T1 shizuku ==========
    "story_shizuku_act1_screen": {
        "route_beat": "线上久识→图书馆初遇→梯子后的沉默→线下第一句",
        "route_sprites": ["quiet_reading", "library_ladder", "study_carrel", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "书架转角她抱着书愣住：网名对上真人，声音却卡在喉咙。",
                "sprite_hint": ["quiet_reading", "casual"],
                "soft_options": ["轻声叫网名", "先递书当借口", "给她反应时间"],
            },
            {
                "id": "b2",
                "summary": "梯子上她不敢低头看你；线上侃侃，线下只剩翻页声。",
                "sprite_hint": ["library_ladder", "quiet_reading"],
                "soft_options": ["扶稳梯子", "改用短信聊", "低声说不必勉强"],
            },
            {
                "id": "b3",
                "summary": "自习隔间她写下「对不起很吵」——其实一句话都没说出口。",
                "sprite_hint": ["study_carrel", "casual"],
                "soft_options": ["回写「不吵」", "约闭馆前再聊", "并排安静看书"],
            },
        ],
    },
    "story_shizuku_act2_stack": {
        "route_beat": "还书车→推荐书单→盖章目录→视频通话外的靠近",
        "route_sprites": ["archive_cart", "return_slot", "stamp_catalog", "quiet_reading"],
        "beats": [
            {
                "id": "b1",
                "summary": "还书车吱呀作响；她把你的书推进格口，耳尖发红。",
                "sprite_hint": ["archive_cart", "return_slot"],
                "soft_options": ["道谢", "问下一本推什么", "帮她推车"],
            },
            {
                "id": "b2",
                "summary": "盖章目录摊开：她开始敢把推荐书单写成「只给你的」。",
                "sprite_hint": ["stamp_catalog", "quiet_reading"],
                "soft_options": ["认真抄下", "问哪本最像她", "承诺读完回报"],
            },
            {
                "id": "b3",
                "summary": "她提起线上通话：面对面时，想试着把声音留下来。",
                "sprite_hint": ["return_slot", "study_carrel"],
                "soft_options": ["邀请她读一句", "说喜欢她的声线", "不催只等待"],
            },
            {
                "id": "b4",
                "summary": "闭馆铃前她点头：下次，用真声说「这本书送给你」。",
                "sprite_hint": ["archive_cart", "casual"],
                "soft_options": ["约闭馆后五分钟", "替她抱书", "微笑答应"],
            },
        ],
    },
    "story_shizuku_act3_voice": {
        "route_beat": "自习隔间→鼓起勇气出声→告白用真声→书脊后的声线落地",
        "route_sprites": ["study_carrel", "date", "home", "quiet_reading"],
        "beats": [
            {
                "id": "b1",
                "summary": "空馆只剩你们；她把书挡在脸前，呼吸比翻页更响。",
                "sprite_hint": ["study_carrel", "quiet_reading"],
                "soft_options": ["轻声鼓励", "把书缓缓放下", "握住她袖口"],
            },
            {
                "id": "b2",
                "summary": "第一句真声发颤：喜欢你——比任何书评都难写。",
                "sprite_hint": ["study_carrel", "date"],
                "soft_options": ["真声回应", "说听得很清楚", "给她拥抱空间"],
            },
            {
                "id": "b3",
                "summary": "她怕恋爱会逼她每天说话；你如何接，决定她还敢不敢出声。",
                "sprite_hint": ["home", "date"],
                "soft_options": ["尊重她的节奏", "约定文字与声音并存", "说沉默也可以爱"],
            },
            {
                "id": "b4",
                "summary": "她把书脊转向你：从今晚起，声线不再只藏在屏幕后。",
                "sprite_hint": ["date", "casual"],
                "soft_options": ["再听她叫一次名字", "牵手离开图书馆", "约下次一起朗读"],
            },
        ],
    },
    # ========== T1 qiansha ==========
    "story_qiansha_act1_diff": {
        "route_beat": "双屏重逢→旧 PR 阴影→卫衣专注→选择面对或归档",
        "route_sprites": ["dual_monitor", "hoodie_focus", "work", "pr_review"],
        "beats": [
            {
                "id": "b1",
                "summary": "双屏光映着旧头像；她冷冷说「又见面了，Diff 很大」。",
                "sprite_hint": ["dual_monitor", "work"],
                "soft_options": ["承认尴尬", "先谈工作", "问能不能重新认识"],
            },
            {
                "id": "b2",
                "summary": "卫衣帽子压得很低：分手像没合并的 PR，注释全是刺。",
                "sprite_hint": ["hoodie_focus", "pr_review"],
                "soft_options": ["道歉旧伤", "说不是来挖坑", "请求一次复盘"],
            },
            {
                "id": "b3",
                "summary": "她把光标停在 Reject：今晚先不 Merge，也不立刻 Close。",
                "sprite_hint": ["dual_monitor", "casual"],
                "soft_options": ["接受观察期", "约下次 Debug", "保证不施压"],
            },
        ],
    },
    "story_qiansha_act2_debug": {
        "route_beat": "夜咖 Debug→复盘为何炸→Figma 对照→尖锐关怀落地",
        "route_sprites": ["debug_mug", "pr_review", "figma_compare", "deploy_watch"],
        "beats": [
            {
                "id": "b1",
                "summary": "咖啡杯旁堆着报错；她让你别打补丁话术，要根因。",
                "sprite_hint": ["debug_mug", "work"],
                "soft_options": ["老实讲当时为什么炸", "听她列问题", "承认逃避"],
            },
            {
                "id": "b2",
                "summary": "PR 评论里她标红：信任崩过一次，热修不能当永久方案。",
                "sprite_hint": ["pr_review", "figma_compare"],
                "soft_options": ["提出可验证的改变", "问她需要什么证据", "接受暂时 fork"],
            },
            {
                "id": "b3",
                "summary": "设计稿对照时她声音软一点：恨的是失控，不是你这个人。",
                "sprite_hint": ["figma_compare", "hoodie_focus"],
                "soft_options": ["区分人与错", "说想修关系不是刷好感", "感谢她仍谈"],
            },
            {
                "id": "b4",
                "summary": "部署手表亮起；她说今晚日志留下——下次再决定 Merge。",
                "sprite_hint": ["deploy_watch", "casual"],
                "soft_options": ["约固定复盘", "保证透明沟通", "先送她回去"],
            },
        ],
    },
    "story_qiansha_act3_merge": {
        "route_beat": "上线夜→选择主线或保留分支→告白是 Merge→和解不是回档",
        "route_sprites": ["deploy_watch", "date", "home", "dual_monitor"],
        "beats": [
            {
                "id": "b1",
                "summary": "上线夜她盯着进度条：合并很危险，但一直 fork 更累。",
                "sprite_hint": ["deploy_watch", "work"],
                "soft_options": ["问她倾向", "说你愿意进主线", "尊重她保留分支"],
            },
            {
                "id": "b2",
                "summary": "她明确：和解不是回档旧恋爱，是新开版本号。",
                "sprite_hint": ["dual_monitor", "date"],
                "soft_options": ["同意新版本", "谈规则与边界", "否认只想复合快感"],
            },
            {
                "id": "b3",
                "summary": "Merge 键前她问：这次冲突来了，你会不会又静默离开？",
                "sprite_hint": ["date", "home"],
                "soft_options": ["承诺留下对谈", "坦白喜欢并负责", "接受观察仍继续"],
            },
            {
                "id": "b4",
                "summary": "绿灯亮起；她碰你的指节——主线合并，注释写「我们」。",
                "sprite_hint": ["date", "casual"],
                "soft_options": ["回握", "约庆祝但不喧哗", "说「已合并」"],
            },
        ],
    },
    # ========== T1 shiori ==========
    "story_shiori_act1_shelf": {
        "route_beat": "梯子取书→推荐书堆→盖章仪式→第一次为你留下好书",
        "route_sprites": ["shelf_ladder", "recommend_stack", "catalog_stamp", "work"],
        "beats": [
            {
                "id": "b1",
                "summary": "坡上书店，她在梯子上为你抽出一本「刚好」的书。",
                "sprite_hint": ["shelf_ladder", "work"],
                "soft_options": ["接住书", "问为何刚好", "扶稳梯子"],
            },
            {
                "id": "b2",
                "summary": "推荐书堆到肘边；她笑说习惯把别人的故事递出去。",
                "sprite_hint": ["recommend_stack", "catalog_stamp"],
                "soft_options": ["问有没有自己的故事", "认真听推荐理由", "买下第一本"],
            },
            {
                "id": "b3",
                "summary": "盖章时她顿住：这一次推荐，想被你记住推荐人。",
                "sprite_hint": ["catalog_stamp", "casual"],
                "soft_options": ["记住她的名字", "约下周还书闲聊", "夸她眼光好"],
            },
        ],
    },
    "story_shiori_act2_moon": {
        "route_beat": "窗边夜读→诗角坦白→拆箱旧物→灵气/cos 的秘密被轻轻托住",
        "route_sprites": ["window_read", "poetry_nook", "unbox_crate", "recommend_stack"],
        "beats": [
            {
                "id": "b1",
                "summary": "打烊后窗边月光；她读诗读到一半，声音发紧。",
                "sprite_hint": ["window_read", "poetry_nook"],
                "soft_options": ["安静听完", "问卡在哪一句", "递热茶"],
            },
            {
                "id": "b2",
                "summary": "诗角她承认常把真心藏进别人的句子，自己的页是空白。",
                "sprite_hint": ["poetry_nook", "window_read"],
                "soft_options": ["鼓励她写自己", "说空白也可爱", "问怕被看见什么"],
            },
            {
                "id": "b3",
                "summary": "木箱里旧 cos/灵气物件露出来；她观察你是否轻笑或轻视。",
                "sprite_hint": ["unbox_crate", "recommend_stack"],
                "soft_options": ["认真对待", "问故事来源", "保证不对外说"],
            },
            {
                "id": "b4",
                "summary": "她把箱盖合上一半：秘密可以分享，但不许被当成笑料。",
                "sprite_hint": ["unbox_crate", "casual"],
                "soft_options": ["郑重答应", "分享你的怪癖换信任", "道谢她的坦白"],
            },
        ],
    },
    "story_shiori_act3_write": {
        "route_beat": "空白页→她开始写自己→告白写在扉页→坡上月亮落下",
        "route_sprites": ["catalog_stamp", "date", "home", "poetry_nook"],
        "beats": [
            {
                "id": "b1",
                "summary": "她把空白笔记推过来：今晚不荐书，写一句自己的话。",
                "sprite_hint": ["poetry_nook", "home"],
                "soft_options": ["等她写", "也写一句交换", "握住她发抖的手"],
            },
            {
                "id": "b2",
                "summary": "墨迹未干：喜欢你——不是书里的角色，是柜台外的人。",
                "sprite_hint": ["catalog_stamp", "date"],
                "soft_options": ["扉页回应", "朗读她的句子", "问可否交往"],
            },
            {
                "id": "b3",
                "summary": "她怕恋爱后只被当成「会荐书的女友」；要被当成作者本人。",
                "sprite_hint": ["date", "window_read"],
                "soft_options": ["承诺看见作者", "约共同写一页", "否认工具人恋爱"],
            },
            {
                "id": "b4",
                "summary": "章盖在空白页角落；月亮还在坡上，故事改由你们续写。",
                "sprite_hint": ["date", "casual"],
                "soft_options": ["吻她手背", "关店一起走", "说「下一章见」"],
            },
        ],
    },
    # ========== T1 miara ==========
    "story_miara_act1_booth": {
        "route_beat": "谷子柜台→假发调整→戏言契约→展会初遇被钉住",
        "route_sprites": ["merch_counter", "wig_adjust", "badge_board", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "展会柜台她塞来徽章：买谷还是交朋友？语气半真半假。",
                "sprite_hint": ["merch_counter", "casual"],
                "soft_options": ["买谷并要朋友", "只交朋友", "问徽章含义"],
            },
            {
                "id": "b2",
                "summary": "她低头戴假发，镜子里盯你：戏言契约——「星约」算数吗？",
                "sprite_hint": ["wig_adjust", "badge_board"],
                "soft_options": ["说算数", "笑着追问规则", "先把规矩问清"],
            },
            {
                "id": "b3",
                "summary": "人潮里她拉你躲到板后：第一次见面，却像约好再遇。",
                "sprite_hint": ["badge_board", "merch_counter"],
                "soft_options": ["留下联系方式", "约闭展帮忙收摊", "认真记住约定"],
            },
        ],
    },
    "story_miara_act2_sew": {
        "route_beat": "缝制 cos→手办补货→雨夜摊谈→戏言开始变沉",
        "route_sprites": ["sewing_cos", "figure_restock", "price_tag", "rain"],
        "beats": [
            {
                "id": "b1",
                "summary": "针线穿进布料；她让你按住布边，说今晚的契约要缝牢。",
                "sprite_hint": ["sewing_cos", "work"],
                "soft_options": ["帮忙按布", "问怕散的是什么", "夸针脚细"],
            },
            {
                "id": "b2",
                "summary": "补货手办时她叹气：玩梗容易，被当真反而慌。",
                "sprite_hint": ["figure_restock", "price_tag"],
                "soft_options": ["问哪句是认真的", "说你可以当真", "给她反悔权"],
            },
            {
                "id": "b3",
                "summary": "雨打棚顶；她承认星约起初是玩笑，看见你后就不想只是玩笑。",
                "sprite_hint": ["rain", "sewing_cos"],
                "soft_options": ["接住这份认真", "确认彼此节奏", "约雨停再谈"],
            },
            {
                "id": "b4",
                "summary": "价签背面她写新规则：可以玩梗，不许拿心当周边打折。",
                "sprite_hint": ["price_tag", "casual"],
                "soft_options": ["签字同意", "加一条互相坦白", "笑着认真盖章"],
            },
        ],
    },
    "story_miara_act3_oath": {
        "route_beat": "徽章墙→契约生效→告白不再戏言→谷子与星约落地",
        "route_sprites": ["badge_board", "date", "home", "merch_counter"],
        "beats": [
            {
                "id": "b1",
                "summary": "徽章墙前她摘下一枚空位：今晚要把戏言写成生效条款。",
                "sprite_hint": ["badge_board", "merch_counter"],
                "soft_options": ["问条款内容", "准备真心回答", "先握她的手"],
            },
            {
                "id": "b2",
                "summary": "她说喜欢你——不是展会营业，是想把你从谷子清单划进人生。",
                "sprite_hint": ["date", "badge_board"],
                "soft_options": ["回应告白", "说你也划她进去", "确认专一与公开"],
            },
            {
                "id": "b3",
                "summary": "她怕认真后梗会消失；你如何答，决定契约温度。",
                "sprite_hint": ["home", "date"],
                "soft_options": ["说梗可以留认真不减", "承诺不消费玩笑", "一起定新梗边界"],
            },
            {
                "id": "b4",
                "summary": "空位钉上你们的徽章；星约盖章——这次，不许用撤回键。",
                "sprite_hint": ["date", "casual"],
                "soft_options": ["盖章", "拥抱收摊", "约下次非展会见面"],
            },
        ],
    },
    # ========== T2（瘦包：只用真实 outfit）==========
    "story_xingnai_act1_bento": {
        "route_beat": "天台便当→童年缺口→别把关心当理所当然→青梅温度",
        "route_sprites": ["school", "casual", "home", "date"],
        "beats": [
            {
                "id": "b1",
                "summary": "天台风大，她把便当往你这边推一寸，假装不在意。",
                "sprite_hint": ["school", "casual"],
                "soft_options": ["接过一半", "先问她吃饱没", "笑她别扭"],
            },
            {
                "id": "b2",
                "summary": "闲聊童年；她提起一件你忘了、她却记得很清的小事。",
                "sprite_hint": ["school", "home"],
                "soft_options": ["认真回忆", "道歉忘了", "问她为何记得"],
            },
            {
                "id": "b3",
                "summary": "收拾时她说：分当可以，别把关心当成理所当然。",
                "sprite_hint": ["casual", "date"],
                "soft_options": ["答应会珍惜", "承认曾经忽略", "安静点头"],
            },
        ],
    },
    "story_xingnai_act2_album": {
        "route_beat": "旧相册缺口→想补拍合影→告白藏在回忆里→青梅如新",
        "route_sprites": ["home", "date", "school", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "相册缺一角合影；她指着空白：那次你缺席，她等了一下午。",
                "sprite_hint": ["home", "casual"],
                "soft_options": ["道歉", "问能否补拍", "听她把那天说完"],
            },
            {
                "id": "b2",
                "summary": "她说喜欢你很久，却总被「青梅」两个字挡在告白外面。",
                "sprite_hint": ["school", "date"],
                "soft_options": ["撕掉青梅挡箭牌", "坦白也喜欢", "问她怕失去什么"],
            },
            {
                "id": "b3",
                "summary": "风停。她举起手机：这次合影，要不要把缺口补上？",
                "sprite_hint": ["date", "casual"],
                "soft_options": ["靠过去拍照", "牵手入镜", "说「从今天起不算缺席」"],
            },
            {
                "id": "b4",
                "summary": "照片进相册；她笑：青梅可以留，恋人位置也请你坐下。",
                "sprite_hint": ["date", "home"],
                "soft_options": ["答应坐下", "约下次再拍一张", "额头轻碰"],
            },
        ],
    },
    "story_fengyin_act1_door": {
        "route_beat": "半掩房门→敲门尊重→门槛定规矩→同居屋檐下的界线",
        "route_sprites": ["home", "casual", "school", "work"],
        "beats": [
            {
                "id": "b1",
                "summary": "你停在她半掩房门外；游戏音响着，她没立刻应门。",
                "sprite_hint": ["home", "casual"],
                "soft_options": ["再敲一声", "隔门说一句", "先走开"],
            },
            {
                "id": "b2",
                "summary": "她开一条缝盯你：私人空间要被尊重，不是被闯。",
                "sprite_hint": ["home", "school"],
                "soft_options": ["道歉并问方便吗", "说明来意", "退一步等她开门"],
            },
            {
                "id": "b3",
                "summary": "气氛松后她提一起做饭或开黑——仍站在门槛这侧定规矩。",
                "sprite_hint": ["home", "work"],
                "soft_options": ["提议一起做饭", "约一局游戏", "今晚各自安静"],
            },
        ],
    },
    "story_fengyin_act2_equal": {
        "route_beat": "要求被当成年人→同居便利不是借口→告白要先敲门→平视喜欢",
        "route_sprites": ["casual", "date", "school", "home"],
        "beats": [
            {
                "id": "b1",
                "summary": "客厅里她收起玩笑：想被当成年人，不是「住一起就方便」的选项。",
                "sprite_hint": ["home", "casual"],
                "soft_options": ["承认曾图方便", "说尊重她的独立", "问怎样才算平视"],
            },
            {
                "id": "b2",
                "summary": "她强调：喜欢可以，但每次进入她的世界，都要先敲门。",
                "sprite_hint": ["school", "date"],
                "soft_options": ["承诺先敲门", "把告白说清楚", "接受被拒绝的可能"],
            },
            {
                "id": "b3",
                "summary": "门框边她点头：你若愿意平视，她也愿意把喜欢说出口。",
                "sprite_hint": ["date", "home"],
                "soft_options": ["平视告白", "回握她的手", "约正式约会出门"],
            },
            {
                "id": "b4",
                "summary": "同一屋檐下，她把房门钥匙放回自己口袋——界线仍在，心却开了。",
                "sprite_hint": ["casual", "date"],
                "soft_options": ["尊重钥匙归属", "说明天还敲门", "轻轻碰拳"],
            },
        ],
    },
    "story_qingcai_act1_mirror": {
        "route_beat": "镜前练舞→汗水与直球→你当观众→练舞室的夏开始",
        "route_sprites": ["school", "casual", "work", "date"],
        "beats": [
            {
                "id": "b1",
                "summary": "练舞室镜前她汗湿发梢，发现你在看，却没停下动作。",
                "sprite_hint": ["school", "casual"],
                "soft_options": ["继续认真看", "鼓掌打气", "问要不要休息"],
            },
            {
                "id": "b2",
                "summary": "她直球：既然来了，就别假装路过——她需要固定观众。",
                "sprite_hint": ["work", "school"],
                "soft_options": ["答应当固定观众", "问能否给意见", "坦白被吸引"],
            },
            {
                "id": "b3",
                "summary": "音响停。她丢来毛巾：夏天很长，练习却只想给你看。",
                "sprite_hint": ["casual", "date"],
                "soft_options": ["接毛巾", "约下次彩排", "夸她进步"],
            },
        ],
    },
    "story_qingcai_act2_festival": {
        "route_beat": "夏日祭归途→舞台外坦白→告白要你不只当观众→祭典收束",
        "route_sprites": ["festival_spring", "date", "school", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "祭典灯火里她还穿着演出服，笑问你今晚坐第几排心情。",
                "sprite_hint": ["festival_spring", "school"],
                "soft_options": ["说只看着她", "递水", "夸今晚最亮"],
            },
            {
                "id": "b2",
                "summary": "归途她收起偶像腔：想被你喜欢的是练舞的人，不是台上的光。",
                "sprite_hint": ["casual", "date"],
                "soft_options": ["区分舞台与本人", "告白回应", "问她怕什么"],
            },
            {
                "id": "b3",
                "summary": "烟火下她伸手：观众席结束了——要不要改坐到她身边？",
                "sprite_hint": ["date", "festival_spring"],
                "soft_options": ["坐到她身边", "牵手看最后一朵", "说「我改签」"],
            },
            {
                "id": "b4",
                "summary": "祭典散场；她把应援毛巾围你脖子——夏天的答案写在你身上。",
                "sprite_hint": ["date", "casual"],
                "soft_options": ["回围给她", "约明早再练", "认真说喜欢"],
            },
        ],
    },
    "story_xiaoyang_act1_club": {
        "route_beat": "社团海报→名字被写上→你是否认领→校园日常裂开缝",
        "route_sprites": ["school", "casual", "work", "date"],
        "beats": [
            {
                "id": "b1",
                "summary": "社团墙上海报，她的名字旁边多了你的——像玩笑又像试探。",
                "sprite_hint": ["school", "casual"],
                "soft_options": ["问谁写的", "笑着认领", "先观察反应"],
            },
            {
                "id": "b2",
                "summary": "她抱着彩纸：同班太近，喜欢反而难说，只能先写在纸上。",
                "sprite_hint": ["work", "school"],
                "soft_options": ["说纸上不够", "当面问清楚", "帮她撕掉误会"],
            },
            {
                "id": "b3",
                "summary": "她盯着你：若你当没看见，海报明天就换一张普通的。",
                "sprite_hint": ["casual", "date"],
                "soft_options": ["说看见了", "留下名字", "约摊位再谈"],
            },
        ],
    },
    "story_xiaoyang_act2_stall": {
        "route_beat": "文化祭摊位→忙碌缝隙→告白在烤盘旁→同班不再如常",
        "route_sprites": ["school", "date", "casual", "festival_spring"],
        "beats": [
            {
                "id": "b1",
                "summary": "摊位烟雾里她喊你帮忙；袖口沾酱，笑得比营业更真。",
                "sprite_hint": ["school", "festival_spring"],
                "soft_options": ["立刻上手", "给她擦袖口", "负责收钱"],
            },
            {
                "id": "b2",
                "summary": "客流间隙她压低声音：同班可以，但不想永远停在「普通同学」。",
                "sprite_hint": ["casual", "date"],
                "soft_options": ["问想变成什么", "告白回应", "说海报是认真的"],
            },
            {
                "id": "b3",
                "summary": "烤盘滋滋响；她用牙签写你名字——要你亲口承认。",
                "sprite_hint": ["date", "school"],
                "soft_options": ["亲口说喜欢", "把牙签收好", "当众轻轻牵手"],
            },
            {
                "id": "b4",
                "summary": "收摊后她靠箱休息：明天教室见——座位可以照旧，关系不行。",
                "sprite_hint": ["date", "casual"],
                "soft_options": ["约定放学一起走", "碰一下肩", "说「明天见」"],
            },
        ],
    },
    "story_luna_act1_tarot": {
        "route_beat": "塔罗班次→牌面玩笑→真假预言→魔女店的靠近",
        "route_sprites": ["work", "casual", "home", "date"],
        "beats": [
            {
                "id": "b1",
                "summary": "夜班柜台她摊开塔罗：抽到恋人牌时，耳尖先红了。",
                "sprite_hint": ["work", "casual"],
                "soft_options": ["问是营业话术吗", "认真听解牌", "笑她破功"],
            },
            {
                "id": "b2",
                "summary": "她收起戏腔：预言可以假，但想被你留下的心情是真的。",
                "sprite_hint": ["home", "work"],
                "soft_options": ["说想留下", "问怕被看穿什么", "买一杯续摊"],
            },
            {
                "id": "b3",
                "summary": "打烊灯暗；她把护符推过来——不是诅咒，是想被记住。",
                "sprite_hint": ["casual", "date"],
                "soft_options": ["收下护符", "问下次什么班", "保证会再来"],
            },
        ],
    },
    "story_luna_act2_moon": {
        "route_beat": "月夜班次→卸下魔女壳→告白→月亮班次的恋人",
        "route_sprites": ["date", "home", "casual", "work"],
        "beats": [
            {
                "id": "b1",
                "summary": "月圆她提早收摊，拉你到后巷：今晚不卖预言，只谈人。",
                "sprite_hint": ["work", "home"],
                "soft_options": ["跟她出去", "问为何选今天", "先听她说"],
            },
            {
                "id": "b2",
                "summary": "她摘下帽子：喜欢你，不想再用「魔女设定」挡在前面。",
                "sprite_hint": ["casual", "date"],
                "soft_options": ["回应告白", "说设定可爱但更爱本人", "问能否交往"],
            },
            {
                "id": "b3",
                "summary": "她怕日常太素会让你失望；月亮班次之外，她也只是人。",
                "sprite_hint": ["home", "date"],
                "soft_options": ["说素颜也留下", "承诺不消费人设", "约白天见面"],
            },
            {
                "id": "b4",
                "summary": "护符绳系在你腕上；她说——月亮班次，从今晚起有固定客人。",
                "sprite_hint": ["date", "casual"],
                "soft_options": ["系紧回礼", "吻她指尖", "说「我签到了」"],
            },
        ],
    },
    # ========== N 中立（禁恋爱）==========
    "story_shuli_act1_dinner": {
        "route_beat": "晚饭点名→家人边界→洗碗同盟预告→日程本打开",
        "route_sprites": ["home_sibling", "kitchen_helper", "home", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "晚饭桌上她报校园近况，又装作不经意问你最近见谁。",
                "sprite_hint": ["home_sibling", "home"],
                "soft_options": ["如实说", "先问她功课", "打趣岔开"],
            },
            {
                "id": "b2",
                "summary": "她强调：你们是家人——关心可以，别把她当恋爱参谋乱使。",
                "sprite_hint": ["kitchen_helper", "home_sibling"],
                "soft_options": ["道歉边界", "认真听完", "说需要家人意见时会讲清"],
            },
            {
                "id": "b3",
                "summary": "洗碗时她松口：关键时候会站你这边，但先把日子过稳。",
                "sprite_hint": ["kitchen_helper", "casual"],
                "soft_options": ["道谢", "约周末再做饭", "保证不把她卷进恋爱戏"],
            },
        ],
    },
    "story_shuli_act2_ally": {
        "route_beat": "日程冲突→妹妹撑腰→家庭同盟→不是恋爱军师",
        "route_sprites": ["home_sibling", "work", "kitchen_helper", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "她摊开日程本：你家务与约会撞车时，她不愿再当背锅的人。",
                "sprite_hint": ["home_sibling", "work"],
                "soft_options": ["承认安排混乱", "一起改日程", "问她需要什么保证"],
            },
            {
                "id": "b2",
                "summary": "若有人让你为难，她可以帮说话——前提是你别把她当工具人。",
                "sprite_hint": ["kitchen_helper", "home"],
                "soft_options": ["承诺不工具化", "说明具体麻烦", "先听她的条件"],
            },
            {
                "id": "b3",
                "summary": "她在本子写下「同盟」：家人站队，不等于给你写恋爱剧本。",
                "sprite_hint": ["home_sibling", "casual"],
                "soft_options": ["接受同盟定义", "拥抱道谢（兄妹）", "约下周家庭会议"],
            },
            {
                "id": "b4",
                "summary": "本子合上；她说——你稳一点，这个家才稳。",
                "sprite_hint": ["casual", "home"],
                "soft_options": ["答应稳住", "分担家务清单", "说「靠你了，妹妹」"],
            },
        ],
    },
    "story_jingning_act1_watch": {
        "route_beat": "活动旁观→点破你对堂姐→观察日记第一页→守门预热",
        "route_sprites": ["cousin_tea", "work", "family_gather", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "时尚活动边缘她端着茶：看你看堂姐的眼神，比秀场还直白。",
                "sprite_hint": ["cousin_tea", "work"],
                "soft_options": ["承认在意静流", "先寒暄", "问她怎么也在"],
            },
            {
                "id": "b2",
                "summary": "她点破：堂姐不易靠近；你若只是新鲜感，她会提前挡。",
                "sprite_hint": ["family_gather", "cousin_tea"],
                "soft_options": ["说明认真程度", "接受被观察", "问怎样才不算轻浮"],
            },
            {
                "id": "b3",
                "summary": "她合上小本：观察日记第一页写上你的名字——暂记「待审」。",
                "sprite_hint": ["cousin_tea", "casual"],
                "soft_options": ["接受待审", "约下次喝茶细聊", "保证不给堂姐添乱"],
            },
        ],
    },
    "story_jingning_act2_toast": {
        "route_beat": "家族聚会→举杯试探→守门同盟→你可以继续但要经得起看",
        "route_sprites": ["family_gather", "cousin_tea", "home", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "家族聚会她把你介绍成「朋友」：语气平，眼里全是考核。",
                "sprite_hint": ["family_gather", "casual"],
                "soft_options": ["得体应对长辈", "不多提恋爱", "看静流脸色"],
            },
            {
                "id": "b2",
                "summary": "举杯时她低声：若你伤堂姐，这杯酒就是警告；若你护她，可同盟。",
                "sprite_hint": ["cousin_tea", "family_gather"],
                "soft_options": ["承诺不伤人", "请求同盟条件", "承认压力但留下"],
            },
            {
                "id": "b3",
                "summary": "她在日记勾「过」：不是批准恋爱，是批准你继续被看见。",
                "sprite_hint": ["cousin_tea", "home"],
                "soft_options": ["道谢守门", "问还能怎么证明", "保证透明沟通"],
            },
            {
                "id": "b4",
                "summary": "散场她拍拍你肩：堂姐的事，你要配得上被旁观。",
                "sprite_hint": ["casual", "work"],
                "soft_options": ["点头收下", "说会配得上", "改口叫她一声宁姐"],
            },
        ],
    },
    "story_youwei_act1_model": {
        "route_beat": "画室学妹→临时模特→第三支笔→studio_sketch_done 落章",
        "route_sprites": ["studio_junior", "sketch_share", "casual", "work"],
        "beats": [
            {
                "id": "b1",
                "summary": "画室门开一条缝；学妹抱速写本：学姐出去了，你……要不要当十分钟模特？",
                "sprite_hint": ["studio_junior", "casual"],
                "soft_options": ["答应坐下", "问学姐何时回", "先帮她整理笔"],
            },
            {
                "id": "b2",
                "summary": "她分享线稿：怕被当成「插队的妹妹」，更怕你只把她当传话筒。",
                "sprite_hint": ["sketch_share", "studio_junior"],
                "soft_options": ["夸她的线", "说把她当创作者", "问能否一起改"],
            },
            {
                "id": "b3",
                "summary": "她把第三支笔插进笔筒：studio_sketch_done 落章——画室座位多一个人，小悠真结局门从此可开。",
                "sprite_hint": ["sketch_share", "work"],
                "soft_options": ["答应守界", "约固定帮忙", "道谢信任"],
            },
        ],
    },
    "story_youwei_act2_pack": {
        "route_beat": "打包交稿→学妹撑腰→工作室同盟加固→真结局门此前已开",
        "route_sprites": ["studio_junior", "sketch_share", "home", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "交稿夜她帮打包打印件：学姐硬撑时，她需要你别添乱。",
                "sprite_hint": ["studio_junior", "work"],
                "soft_options": ["听从指挥", "分担搬运", "问学姐缺什么"],
            },
            {
                "id": "b2",
                "summary": "她认真说：若你真懂创作，就证明给她看——她才会在学姐面前替你说话。",
                "sprite_hint": ["sketch_share", "studio_junior"],
                "soft_options": ["展示你的尊重方式", "接受考核", "问同盟条件"],
            },
            {
                "id": "b3",
                "summary": "纸箱封口；她点头：工作室素描完成——这是同盟，不是恋爱情书。",
                "sprite_hint": ["sketch_share", "casual"],
                "soft_options": ["确认同盟定义", "感谢守门", "保证不越界追求她"],
            },
            {
                "id": "b4",
                "summary": "她把钥匙留给学姐抽屉：你若伤学姐，这扇门会对你关。",
                "sprite_hint": ["home", "casual"],
                "soft_options": ["郑重接受", "说会护学姐", "约事后复盘工作流"],
            },
        ],
    },
    "story_yuxi_act1_cover": {
        "route_beat": "顶班救场→死党观察→shift_cover_done 落章→晚雨真结局门可开",
        "route_sprites": ["cafe_bestie", "work", "school_memory", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "雨汐系围裙顶班：晚雨请假，她来看你是来喝咖啡还是来消耗人。",
                "sprite_hint": ["cafe_bestie", "work"],
                "soft_options": ["说明来意", "帮忙收杯", "问晚雨是否还好"],
            },
            {
                "id": "b2",
                "summary": "她提起旧同学岁月：死党可以开玩笑，真心被消费会翻脸。",
                "sprite_hint": ["school_memory", "cafe_bestie"],
                "soft_options": ["否认消费", "问怎样算真心", "接受死党审查"],
            },
            {
                "id": "b3",
                "summary": "交班前她勾上 shift_cover_done：顶班通过——晚雨真结局门从此可开。",
                "sprite_hint": ["cafe_bestie", "casual"],
                "soft_options": ["道谢放行", "约她转告保重", "保证不添班次乱"],
            },
        ],
    },
    "story_yuxi_act2_trust": {
        "route_beat": "信任对谈→死党同盟加固→班次交接→真结局门此前已开",
        "route_sprites": ["cafe_bestie", "school_memory", "home", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "闭店后她摘围裙：信任不是口头甜，是你肯在她累时留下。",
                "sprite_hint": ["cafe_bestie", "work"],
                "soft_options": ["举例你会怎么留", "承认以前不够", "听完整条件"],
            },
            {
                "id": "b2",
                "summary": "她伸出拳：死党同盟——你护晚雨，她在圈内替你挡闲话。",
                "sprite_hint": ["school_memory", "cafe_bestie"],
                "soft_options": ["碰拳", "确认非恋爱同盟", "问闲话从哪来"],
            },
            {
                "id": "b3",
                "summary": "交接本签上死党同盟：真结局门此前已开，别飘。",
                "sprite_hint": ["work", "casual"],
                "soft_options": ["收下提醒", "约下次再顶班支援", "谢谢她的眼睛"],
            },
            {
                "id": "b4",
                "summary": "她锁门：晚雨若哭，你第一个到——这才叫过关。",
                "sprite_hint": ["casual", "home"],
                "soft_options": ["答应第一时间到", "把联系方式留给紧急用", "郑重点头"],
            },
        ],
    },
    "story_lingke_act1_guard": {
        "route_beat": "助教红笔→边界提醒→答疑走廊→护若铃的门槛",
        "route_sprites": ["lecture_assist", "ta_office", "work", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "助教席她用红笔点你的名字：来找老师，先过她这关。",
                "sprite_hint": ["lecture_assist", "work"],
                "soft_options": ["说明来意", "预约正规答疑", "承认曾太随便"],
            },
            {
                "id": "b2",
                "summary": "办公室门半掩；她强调伦理：课结束前，别把暧昧带进教案。",
                "sprite_hint": ["ta_office", "lecture_assist"],
                "soft_options": ["承诺守界", "问红线在哪", "接受书面提醒"],
            },
            {
                "id": "b3",
                "summary": "走廊她收起红笔：你可以喜欢，但必须先学会「不越线」。",
                "sprite_hint": ["ta_office", "casual"],
                "soft_options": ["答应不越线", "道谢护老师", "改走正规渠道"],
            },
        ],
    },
    "story_lingke_act2_pass": {
        "route_beat": "红笔放行→助教同盟加固→边界守护→真结局门此前已开",
        "route_sprites": ["ta_office", "lecture_assist", "home", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "学期末她把红笔放下：你若一直守界，她可以在关键处替你说话。",
                "sprite_hint": ["ta_office", "work"],
                "soft_options": ["请求同盟细则", "复盘自己有无擦边", "感谢监督"],
            },
            {
                "id": "b2",
                "summary": "她写「同盟加固」在备忘：不是撮合，是认证你配得上对等；守门此前已开。",
                "sprite_hint": ["lecture_assist", "ta_office"],
                "soft_options": ["接受认证含义", "否认求撮合", "保证公开节奏听老师"],
            },
            {
                "id": "b3",
                "summary": "她提醒：以后若越线，同盟立刻作废——她站老师，不站浪漫脑。",
                "sprite_hint": ["work", "casual"],
                "soft_options": ["接受作废条款", "说理解优先级", "郑重握手"],
            },
            {
                "id": "b4",
                "summary": "办公室灯灭；她说——过关了。去平视，别去偷跑。",
                "sprite_hint": ["casual", "home"],
                "soft_options": ["答应平视", "道谢放行", "说「不会偷跑」"],
            },
        ],
    },
    "story_aichen_act1_gate": {
        "route_beat": "花店闲聊→闺蜜审核→旧婚书阴影→艾莉线入口",
        "route_sprites": ["flower_chat", "girls_night", "work", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "花店角落她修剪叶子：你接近艾莉，得先过闺蜜这关。",
                "sprite_hint": ["flower_chat", "work"],
                "soft_options": ["坦白意图", "问审核标准", "否认猎奇离婚史"],
            },
            {
                "id": "b2",
                "summary": "她提起旧伤：不要把「拯救」当滤镜，艾莉要的是新选择。",
                "sprite_hint": ["girls_night", "flower_chat"],
                "soft_options": ["否认拯救叙事", "说尊重重建", "接受观察期"],
            },
            {
                "id": "b3",
                "summary": "她把一片修好的叶子递你：第一关——别在她面前表演深情。",
                "sprite_hint": ["flower_chat", "casual"],
                "soft_options": ["收起表演", "用行动证明", "约下次闺蜜局旁听规则"],
            },
        ],
    },
    "story_aichen_act2_hold": {
        "route_beat": "闺蜜夜→托底与警告→同盟加固→真结局门此前已开",
        "route_sprites": ["girls_night", "flower_chat", "home", "casual"],
        "beats": [
            {
                "id": "b1",
                "summary": "女孩夜她把酒杯放下：若艾莉哭，你要接得住；接不住就别开始。",
                "sprite_hint": ["girls_night", "home"],
                "soft_options": ["承诺接得住", "承认能力边界", "问怎样算接住"],
            },
            {
                "id": "b2",
                "summary": "她伸出小指：闺蜜审核通过可以帮你，但优先永远是艾莉。",
                "sprite_hint": ["girls_night", "flower_chat"],
                "soft_options": ["勾小指", "接受优先级", "感谢守门"],
            },
            {
                "id": "b3",
                "summary": "备忘录写下闺蜜同盟：放行不是催婚，是允许你继续靠近；真结局门此前已开。",
                "sprite_hint": ["flower_chat", "casual"],
                "soft_options": ["理解放行含义", "保证不催进度", "道谢信任"],
            },
            {
                "id": "b4",
                "summary": "她送你到门口：伤她一次，花店与圈子都会对你关门。",
                "sprite_hint": ["casual", "work"],
                "soft_options": ["郑重接受", "说不会让门关", "鞠躬道别"],
            },
        ],
    },
}


def _cast_folder(cid: str) -> Path:
    romance = SPRITES / "romance" / cid
    if romance.is_dir():
        return romance
    return SPRITES / "neutral" / cid


def _disk_outfits(cid: str) -> set[str]:
    folder = _cast_folder(cid)
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
    lines.append(f'scene_id: "{data.get("scene_id") or ""}"')
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
            d = eff if isinstance(eff, dict) else {}
            parts = []
            for ek in ("trust_delta", "affinity_delta", "mood_delta"):
                if ek in d and d[ek] is not None:
                    parts.append(f"{ek}: {d[ek]}")
            lines.append(f"  - {{ {', '.join(parts)} }}")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    missing: list[str] = []
    bad: list[str] = []
    routes = json.loads(ROUTES.read_text(encoding="utf-8"))
    chars = routes["characters"]

    for eid, curated in CURATED.items():
        path = EVENTS / f"{eid}.yaml"
        if not path.is_file():
            missing.append(eid)
            continue
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        cids = (raw.get("trigger") or {}).get("character_ids") or [""]
        cid = cids[0] if cids else ""
        have = _disk_outfits(cid)
        beats = curated["beats"]
        for b in beats:
            if len(b["summary"]) > 80:
                bad.append(f"{eid}:{b['id']}:summary_len={len(b['summary'])}")
            for h in b["sprite_hint"]:
                if h not in have:
                    bad.append(f"{eid}:{b['id']}:missing_outfit:{h}")
            for o in b["soft_options"]:
                if o in GENERIC_OPTS:
                    bad.append(f"{eid}:{b['id']}:generic_opt:{o}")
            for h in curated.get("route_sprites") or []:
                if h not in have:
                    bad.append(f"{eid}:route_sprite_missing:{h}")
        raw["beats"] = beats
        path.write_text(_dump_event(raw), encoding="utf-8")

        if cid in chars:
            act_key = eid.replace(f"story_{cid}_", "")
            for act in chars[cid].get("acts") or []:
                if act.get("id") == act_key:
                    act["beat"] = curated["route_beat"]
                    act["sprites"] = list(curated["route_sprites"])
                    break

    if missing:
        raise SystemExit("missing: " + ", ".join(missing))
    if bad:
        raise SystemExit("bad:\n" + "\n".join(bad[:50]))

    ROUTES.write_text(json.dumps(routes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"curate_rest_story_beats: OK ({len(CURATED)} events)")


if __name__ == "__main__":
    main()
