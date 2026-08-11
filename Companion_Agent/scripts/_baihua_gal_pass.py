"""白话 + 约会剧本页一次性落盘（galgame美德演绎升级 Phase 2）。

- 书璃 6 幕：narration/pc_thought 白话 + pages
- date_catalog：每条约会补 pages（≥3）
- presentation 书璃结局 pages 白话加厚
- 其余 story_*.yaml：对明显文艺句做白话替换（不改 flags）
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events"
DATE_PATH = ROOT / "data" / "date_catalog.json"
PRESENT_PATH = ROOT / "data" / "presentation_catalog.json"

SHULI_BAIHUA: dict[str, list[dict]] = {
    "story_shuli_act1_dinner": [
        {
            "id": "b1",
            "narration": "晚饭热气糊在窗上。日程本摊在碗边，她用筷子点着格子问：这周你又晚回来几天。话像家里人在管事，笔却把你的行踪圈进她的表里。厨房饭香扑过来，周阿姨大概又在念晚归名单。",
            "pc_thought": "顺着她说像交作业；不说又怕她把关心拧成规矩。我还当这是妹妹在唠叨。",
            "brief": "晚饭点名；她用日程本追问晚归。紧张却要显得只是管家事。",
            "pages": [
                {"text": "晚饭热气糊在窗上。日程本摊在碗边，她用筷子点着格子问你这周晚回来几天。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "neutral"}},
                {"text": "顺着说像交作业；不说又怕她把关心拧成规矩。我还当这是妹妹唠叨。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
            ],
        },
        {
            "id": "b2",
            "narration": "她把「家人」两个字敲在桌上：关心可以，别把妹妹当恋爱参谋，更别拿她挡别人的枪。笑还在，眼神先冷了半寸。",
            "pc_thought": "这一句不是谈恋爱，是划线。我居然松了口气，心里又有点空。",
            "brief": "她强调家人边界；怕被当恋爱工具。等你承认或反驳。",
            "pages": [
                {"text": "她敲着桌子说：关心可以，别把妹妹当恋爱参谋，也别拿她挡枪。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "angry"}},
                {"text": "这一句是在划线。我松了口气，心里又有点空。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "sad"}},
            ],
        },
        {
            "id": "b3",
            "narration": "洗碗水声里她忽然停住：你最近见的人，名字可以不说——但别在家门口留下香水味。日程本夹层多了一行被划掉的字。",
            "pc_thought": "划掉的是什么？我不敢问。当哥哥该装没看见，可我还是想掀开那一页。",
            "brief": "她嗅到外人痕迹却自称不在意；留下划掉的字迹试探你会不会追问。",
            "pages": [
                {"text": "她说名字可以不说，但别在家门口留下别人的香水味。本子夹层有一行被划掉的字。", "voice": "narration", "sprite": {"outfit": "kitchen_helper", "emotion": "shy"}},
                {"text": "划掉的是什么？我不敢问，却还是想掀开看。", "voice": "pc", "sprite": {"outfit": "kitchen_helper", "emotion": "neutral"}},
            ],
        },
        {
            "id": "b4",
            "narration": "本子合上前她松口：家稳了，外面的事才站得住。灯下她像只管晚饭的妹妹——你却听出她把家里管得更紧了。",
            "pc_thought": "是我先让她管日程的吗？谢谢她，也有点怕她。",
            "brief": "她松口愿站你这边，前提是日子先稳。等一句不把她卷进戏的承诺。",
            "pages": [
                {"text": "她说家稳了，外面的事才站得住。灯下她还像只管晚饭的妹妹。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "happy"}},
                {"text": "谢谢她管事，也有点怕她把我管得太死。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
            ],
        },
    ],
    "story_shuli_act2_ally": [
        {
            "id": "b1",
            "narration": "她把家务和你「外面的安排」并排写在日程上：再撞车，她不愿一个人背锅。笔尖顿了顿，像在吃谁的醋，却只写「家务优先」。",
            "pc_thought": "同盟先从分活开始。她肯帮我，但不许我把她写成恋爱军师。",
            "brief": "她要分清家务与外面的安排；吃醋却只写家务优先。",
            "pages": [
                {"text": "她把家务和你外面的安排写在一起：再撞车，她不愿一个人背锅。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "neutral"}},
                {"text": "她肯帮我，但不许我把她当成恋爱军师。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
            ],
        },
        {
            "id": "b2",
            "narration": "门外有人来找你，她先去开门，笑着说「哥哥在忙」。关上门后声音压低：可以帮你挡，别把亲妹妹当工具。",
            "pc_thought": "挡外人时她像恋人，转头又把自己按回妹妹位。我感激，也发冷。",
            "brief": "她替你挡门，又强调别工具化妹妹。等你表态。",
            "pages": [
                {"text": "有人来找你，她先开门说哥哥在忙。关上门又说：可以帮你挡，别把妹妹当工具。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "happy"}},
                {"text": "挡门时她像恋人，转头又变回妹妹。我感激，也发冷。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
            ],
        },
        {
            "id": "b3",
            "narration": "本子中央落下「同盟」两个字。她说：家人站队，不等于给你写恋爱剧本；真结局不靠她点头，靠她不拆台。",
            "pc_thought": "不拆台——像誓言，又像警告。我该松口气，还是该怕她太懂？",
            "brief": "她写下同盟：可站队，不写恋爱剧本。等你是否接受。",
            "pages": [
                {"text": "她在本子上写下「同盟」：可以站队，但不给你写恋爱剧本。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "neutral"}},
                {"text": "不拆台像誓言，也像警告。我该放心，还是该怕？", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "sad"}},
            ],
        },
        {
            "id": "b4",
            "narration": "本子合上。她抬眼提起枫音也住同一屋檐下——别让两个妹妹一起跟着乱。走廊尽头门缝里，游戏声忽然静了一拍。",
            "pc_thought": "枫音听见没有？家这层壳，比我想的薄。",
            "brief": "她提醒枫音同住；走廊有动静。你要收声还是装作没事。",
            "pages": [
                {"text": "她提醒你：枫音也住这里，别让两个妹妹一起乱。走廊游戏声静了一拍。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
                {"text": "枫音听见没有？这层家门，比我想的薄。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "neutral"}},
            ],
        },
    ],
    "story_shuli_act3_display": [
        {
            "id": "b1",
            "narration": "浴室门开，雾气涌出来。她只围着浴巾站在客厅灯下——愣了半秒，故意没躲，手指却把角攥白了。",
            "pc_thought": "我知道不该看。可还是没把眼睛挪开。当哥哥的身份，这一秒烫得慌。",
            "brief": "浴巾出场；她故意不躲又紧张。等你的反应。",
            "pages": [
                {"text": "浴室门开，雾气涌出来。她只围浴巾站在灯下，愣了半秒，故意没躲。", "voice": "narration", "sprite": {"outfit": "home", "emotion": "shy"}},
                {"text": "我知道不该看，还是没挪开眼睛。", "voice": "pc", "sprite": {"outfit": "home", "emotion": "love"}},
            ],
        },
        {
            "id": "b2",
            "narration": "她坐近一步，膝盖几乎碰到你：不能当恋人，也不想只当你的工具妹妹。日程夹层鼓起来，像藏着见不得光的字。",
            "pc_thought": "影子席的邀请——我要是伸手，就再也装不成纯家人。",
            "brief": "她靠近表白矛盾：不当恋人，也不只当工具妹妹。",
            "pages": [
                {"text": "她坐近一步说：不能当恋人，也不想只当你的工具妹妹。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
                {"text": "我要是伸手，就再也装不成纯家人。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "love"}},
            ],
        },
        {
            "id": "b3",
            "narration": "她在本子写下「影子」：花园里可以有不被名义承认的位置——展示只给你，称呼与姓氏不许改。写完立刻用手心盖住，像后悔刚才的勇敢。",
            "pc_thought": "展示成功后的羞耻比欲望更刺。我怕自己享受这份越界。",
            "brief": "她写影子席又立刻盖住；羞耻与勇敢来回切换。",
            "pages": [
                {"text": "她写下「影子」：可以只给你看，但称呼不能改。写完又用手盖住。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
                {"text": "我怕自己其实很享受这份越界。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "sad"}},
            ],
        },
        {
            "id": "b4",
            "narration": "灯关掉前她说：枫音也在同屋檐下。隔壁键盘声忽然停，又响起来——像有人只是换了首歌。她假装没听见。",
            "pc_thought": "隔墙有没有人？我答应守家，手里却还记得浴巾的温度。",
            "brief": "她提醒枫音在；隔墙有动静。你是否装作没事。",
            "pages": [
                {"text": "她提醒枫音也在家。隔壁键盘声停了一下又响，她假装没听见。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "neutral"}},
                {"text": "隔墙有没有人？我答应守家，手心却还热。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
            ],
        },
    ],
    "story_shuli_act4_jealous": [
        {
            "id": "b1",
            "narration": "她撞见你和其他女主说话回来，进门不换鞋，把日程本撕下一页揉皱。眼睛红着，嘴上却说「随便你」。",
            "pc_thought": "她在哭还是在骂？我该解释，还是该先认错？",
            "brief": "她嫉妒发作撕日程；哭和攻击来回。等你态度。",
            "pages": [
                {"text": "她撞见你和其他人说话回来，进门就把日程本撕下一页揉皱，嘴上说随便你。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "angry"}},
                {"text": "她在哭还是在骂？我该解释，还是先认错？", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "sad"}},
            ],
        },
        {
            "id": "b2",
            "narration": "冷战一夜。第二天早饭她把你的那格空着，只写自己的课表。走廊里枫音探头问：你们吵什么呢？",
            "pc_thought": "不能让枫音听懂。家要散的话，会从这一句开始。",
            "brief": "冷战；枫音追问。你要圆场还是沉默。",
            "pages": [
                {"text": "冷战一夜。早饭她把你那格空着。枫音探头问你们吵什么。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "sad"}},
                {"text": "不能让枫音听懂。家要散，会从这一句开始。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "neutral"}},
            ],
        },
        {
            "id": "b3",
            "narration": "她终于开口：不是要你不交朋友——是别把家里当旅馆，回来还带着别人的笑。日程本封皮裂了一道。",
            "pc_thought": "她要的是位置，不是垄断全世界。我听懂了，也更怕。",
            "brief": "她说明嫉妒点：别把家当旅馆。等你承诺。",
            "pages": [
                {"text": "她说不是不许你交朋友，是别把家当旅馆，回来还带着别人的笑。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "sad"}},
                {"text": "她要的是家里有位置，不是垄断全世界。我听懂了，也更怕。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
            ],
        },
        {
            "id": "b4",
            "narration": "和好没有拥抱，只有她把撕掉的那页贴回去，字迹歪歪扭扭。她说：下次再这样，我会真的不管你的日程。",
            "pc_thought": "威胁像爱。我该高兴她还肯管，还是该退一步？",
            "brief": "她贴回撕页并警告。和好但不甜。",
            "pages": [
                {"text": "她把撕掉的那页贴回去，说下次再这样就真不管你的日程。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "neutral"}},
                {"text": "威胁像爱。我该高兴她还肯管，还是该退一步？", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
            ],
        },
    ],
    "story_shuli_act5_ethics": [
        {
            "id": "b1",
            "narration": "夜很静。她把日程本推到你面前：要说清楚吗？说清楚就再也回不去「只是兄妹」。灯管嗡了一声。",
            "pc_thought": "说破不是高潮，是往下沉。我怕伤她，也怕自己想要的不只是家人。",
            "brief": "她逼你把禁忌说清楚。紧张、害怕、又想听实话。",
            "pages": [
                {"text": "夜里她把日程本推过来：要说清楚吗？说清楚就回不去只是兄妹了。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
                {"text": "说破不是开心，是往下沉。我怕伤她，也怕自己想要更多。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "sad"}},
            ],
        },
        {
            "id": "b2",
            "narration": "她说愿意承担闲话和家规，但不许你把责任全推给「妹妹不懂事」。眼睛红着，背却挺直。",
            "pc_thought": "她比我更敢认。我要是逃，就是最孬的那种哥哥。",
            "brief": "她愿共担，不许你推责。等你是否一起扛。",
            "pages": [
                {"text": "她说愿意扛闲话和家规，但不许你把责任推给妹妹不懂事。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "sad"}},
                {"text": "她比我更敢认。我要是逃，就是最孬的哥哥。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "neutral"}},
            ],
        },
        {
            "id": "b3",
            "narration": "你们试探「假退出」：要不要停、要不要告诉枫音一半。茶凉了两轮，谁也没把话说死。",
            "pc_thought": "停下来会安全，继续会疼。我两样都想要，两样都怕。",
            "brief": "讨论停或说一半；没有立刻定论。",
            "pages": [
                {"text": "你们试着问：要不要停，要不要告诉枫音一半。茶凉了，谁也没说死。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "neutral"}},
                {"text": "停下来安全，继续会疼。我两样都想要，两样都怕。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
            ],
        },
        {
            "id": "b4",
            "narration": "最后她只写下一句：先别散。称呼当面仍是哥哥妹妹，私下你们都知道那是罩子。",
            "pc_thought": "罩子能遮多久？够我们把明天过完，就不错了。",
            "brief": "她选择先别散；当面称呼不变。秘密压着往前。",
            "pages": [
                {"text": "她写下：先别散。当面仍叫哥哥妹妹，私下你们都知道那是罩子。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "love"}},
                {"text": "罩子能遮多久？够把明天过完，就不错了。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
            ],
        },
    ],
    "story_shuli_act6_secret": [
        {
            "id": "b1",
            "narration": "同屋檐下的日子忽然变甜，也变吓人。她半夜来敲你门，只为确认你还在——又怕门响惊动枫音。",
            "pc_thought": "甜蜜和暴露只隔一层薄门。我伸手开门，手心全是汗。",
            "brief": "她夜敲确认你在；又怕惊动枫音。",
            "pages": [
                {"text": "她半夜轻敲你的门，只为确认你还在，又怕惊动枫音。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
                {"text": "甜蜜和暴露只隔一层门。我开门时手心全是汗。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "love"}},
            ],
        },
        {
            "id": "b2",
            "narration": "差点穿帮：拖鞋摆错、两只杯子、走廊夜灯忘关。她把证据一件件收起，眼圈却红了。",
            "pc_thought": "再大意一次，家就不是家了。我是心疼她，还是心疼自己的秘密？",
            "brief": "险些暴露；她收拾痕迹又难受。",
            "pages": [
                {"text": "拖鞋摆错、多一只杯子、夜灯忘关——差点穿帮。她把痕迹一件件收起。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "sad"}},
                {"text": "再大意一次，家就不是家了。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "sad"}},
            ],
        },
        {
            "id": "b3",
            "narration": "屋顶风大。她说真结局不是公开庆祝，是两个人一起扛闲话；坏结局也很简单——门被撞开的那一秒。",
            "pc_thought": "我握住她的手，不知道这是保护还是把她拖下水。",
            "brief": "屋顶谈话：真结局要共担，坏结局是被撞破。",
            "pages": [
                {"text": "屋顶风大。她说真结局是一起扛闲话；坏结局就是门被撞开的那一秒。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "neutral"}},
                {"text": "我握住她的手，不知道这是保护还是拖她下水。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "love"}},
            ],
        },
        {
            "id": "b4",
            "narration": "下楼时枫音房门缝亮着。她松开你的手，恢复成「妹妹回屋写功课」的样子。秘密还在，裂痕也在。",
            "pc_thought": "今晚没散。可我知道分叉就在前面：扛下去，或被拆穿。",
            "brief": "差点被枫音察觉；她恢复妹妹模样。秘密未破。",
            "pages": [
                {"text": "下楼时枫音房门缝亮着。她松开手，又变回写功课的妹妹。", "voice": "narration", "sprite": {"outfit": "home_sibling", "emotion": "shy"}},
                {"text": "今晚没散。分叉就在前面：扛下去，或被拆穿。", "voice": "pc", "sprite": {"outfit": "home_sibling", "emotion": "sad"}},
            ],
        },
    ],
}

DATE_PAGES: dict[str, list[dict]] = {
    "date_campus_walk": [
        {"text": "校园路上人不多。风从操场那边吹过来，她把袖口往下拉了拉。", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "campus"},
        {"text": "这种没什么目的的散步，反而让人不知道手该往哪放。", "voice": "pc", "sprite": {"outfit": "casual", "emotion": "shy"}, "bg": "campus"},
        {"text": "她侧头看你一眼：要是闷着走完全程，回头你会后悔的。", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "campus"},
        {"text": "……那你先说点什么呗。", "voice": "heroine", "sprite": {"outfit": "casual", "emotion": "shy"}, "bg": "campus"},
    ],
    "date_cafe": [
        {"text": "咖啡店不吵。她把杯子转了半圈，才抬头看你。", "voice": "narration", "sprite": {"outfit": "date", "emotion": "happy"}, "bg": "cafe_evening"},
        {"text": "要是今天只聊天气，回去路上我会后悔。", "voice": "pc", "sprite": {"outfit": "date", "emotion": "shy"}, "bg": "cafe_evening"},
        {"text": "窗外天色慢慢暗下来。她把菜单往你这边推了推。", "voice": "narration", "sprite": {"outfit": "date", "emotion": "happy"}, "bg": "cafe_evening"},
        {"text": "你点吧。我今天……想听你说话多一点。", "voice": "heroine", "sprite": {"outfit": "date", "emotion": "shy"}, "bg": "cafe_evening"},
    ],
    "date_lunch_quick": [
        {"text": "午休时间很短。她已经占好靠窗的位子，面前摆着两杯水。", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "cafe"},
        {"text": "别拖太长。把想见的那句先说清楚就行。", "voice": "pc", "sprite": {"outfit": "casual", "emotion": "neutral"}, "bg": "cafe"},
        {"text": "她看了眼手机：还有二十分钟。够吗？", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "shy"}, "bg": "cafe"},
        {"text": "够。快点吃，也快点……说正事。", "voice": "heroine", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "cafe"},
    ],
    "date_stargaze": [
        {"text": "山上风比城里大。她指着一块还算平的石头，让你坐下。", "voice": "narration", "sprite": {"outfit": "date", "emotion": "happy"}, "bg": "starry_hill"},
        {"text": "星星看不清也没关系。要紧的是她肯把夜分给你。", "voice": "pc", "sprite": {"outfit": "date", "emotion": "love"}, "bg": "starry_hill"},
        {"text": "她把外套袖口拉好，声音放得很轻。", "voice": "narration", "sprite": {"outfit": "date", "emotion": "shy"}, "bg": "starry_hill"},
        {"text": "别说话也行。你在就行。", "voice": "heroine", "sprite": {"outfit": "date", "emotion": "love"}, "bg": "starry_hill"},
    ],
    "date_home_dinner": [
        {"text": "家里灯暖。她把碗筷摆成两人份，像早就算好你会来。", "voice": "narration", "sprite": {"outfit": "home", "emotion": "happy"}, "bg": "home_night"},
        {"text": "这顿饭不像约会，又比约会更让人心虚。", "voice": "pc", "sprite": {"outfit": "home", "emotion": "shy"}, "bg": "home_night"},
        {"text": "蒸汽模糊了她的眼镜边。她把汤往你这边推了推。", "voice": "narration", "sprite": {"outfit": "home", "emotion": "happy"}, "bg": "home_night"},
        {"text": "先吃。吃完……再说别的。", "voice": "heroine", "sprite": {"outfit": "home", "emotion": "shy"}, "bg": "home_night"},
    ],
    "date_night_store": [
        {"text": "便利店灯太亮。她拿着关东煮，懒洋洋靠在货架边。", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "convenience_night"},
        {"text": "夜色把人都削短了。这种短约会，反而好开口。", "voice": "pc", "sprite": {"outfit": "casual", "emotion": "neutral"}, "bg": "convenience_night"},
        {"text": "她把热饮塞给你一只：别愣着，外面冷。", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "shy"}, "bg": "convenience_night"},
        {"text": "请你喝的。谢一声就行，别整那些弯弯绕。", "voice": "heroine", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "convenience_night"},
    ],
    "date_office_overtime": [
        {"text": "加班后的走廊空荡荡。她解松领口，终于像个人，不像工牌。", "voice": "narration", "sprite": {"outfit": "work", "emotion": "sad"}, "bg": "office"},
        {"text": "这时候约夜宵，不是浪漫，是互相捞一把。", "voice": "pc", "sprite": {"outfit": "work", "emotion": "neutral"}, "bg": "office"},
        {"text": "电梯口风有点凉。她把包换到另一只手。", "voice": "narration", "sprite": {"outfit": "work", "emotion": "shy"}, "bg": "office"},
        {"text": "走吧。今天别谈工作，谈了我会更累。", "voice": "heroine", "sprite": {"outfit": "work", "emotion": "happy"}, "bg": "office"},
    ],
    "date_forest": [
        {"text": "林子里脚步声被落叶吃掉。她走在你前面半步，又忽然停住等你。", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "forest_clearing"},
        {"text": "这里安静得像能藏住秘密。我也怕藏太深。", "voice": "pc", "sprite": {"outfit": "casual", "emotion": "shy"}, "bg": "forest_clearing"},
        {"text": "光从树缝漏下来。她指了指前方的空地。", "voice": "narration", "sprite": {"outfit": "casual", "emotion": "happy"}, "bg": "forest_clearing"},
        {"text": "再往里走一点。我想跟你说句……只有这里能说的。", "voice": "heroine", "sprite": {"outfit": "casual", "emotion": "shy"}, "bg": "forest_clearing"},
    ],
}

SHULI_ENDINGS = {
    "ending_shuli_taboo_true": [
        "嫉妒撕开日程本之后，她终于把话说完整：外面仍是兄妹，私下一起扛后果。",
        "薄墙另一侧，枫音的笑声偶尔传来。她把你的名字写进夹层，却不改当面的称呼。",
        "真结局不是轻飘飘的甜。是两个人一起扛闲话、家规，还有可能散掉的屋檐。",
        "你握着她的手。日程本合上，家里的灯还亮着。",
        "只要门没被撞开，这一晚就能算赢了一小步。",
    ],
    "ending_shuli_careful_good": [
        "伦理那道线破了之后，你们选择对枫音说一半：不讲细节，只说「我们在认真」。",
        "客厅灯下三人对坐。家没有散，秘密少了一半重量。",
        "她仍管日程，只是写字的手不抖了。你好好吃饭，也好好做人。",
        "这不是最烈的结局，但是能过下去的结局。",
    ],
    "ending_shuli_ethics_rift": [
        "嫉妒砸开了家，却没人敢把禁忌说完整。称呼卡住，晚饭也冷了。",
        "她仍住同一屋檐下，却不再递日程本。裂开的是名字，也是信任。",
        "你想解释，她只摇头：现在说什么都像找补。",
    ],
    "ending_shuli_roof_exposed": [
        "门被枫音撞开的那一秒，薄墙塌了。秘密碎在三个人的沉默里。",
        "家散了一角。称呼再也回不去——无论你怎么解释。",
        "她抱着日程本站在走廊尽头，没再看你。",
    ],
    "ending_shuli_family_ally": [
        "她把同盟写进日程本：家人站队，不等于恋爱通关。",
        "你少了一份秘密军师，多了一个敢挡门的妹妹。",
        "晚饭还是热的。这就够了——至少今天够了。",
    ],
    "ending_shuli_schedule_soft": [
        "日程还在，心却退半步。她把格子填满，把你的名字写淡。",
        "家没有散，故事也没有走远。软着陆，有时比摔碎好看一点。",
        "你道谢。她只说：先吃饭。",
    ],
    "ending_shuli_shadow_garden": [
        "影子席定了：展示只给你，称呼不许改。",
        "花园里能站的位置很窄。你们都挤着，也不肯松手。",
        "灯关掉前，她说：明天还是妹妹。你点头，喉咙发干。",
    ],
}

# 其余故事：常见文艺 → 白话（保守替换，不改语义结构）
REPLACEMENTS = [
    (r"像怕你不应", "像怕你不开门"),
    (r"兄长身份在这一秒发烫", "我知道不该这么看，还是没挪开眼睛"),
    (r"合法亲近", "说得过去的亲近"),
    (r"撕开一道缝", "露出破绽"),
    (r"信息差", "她不知道的事"),
    (r"心跳加速", "心里一紧"),
    (r"目光还是黏住了", "眼睛还是没挪开"),
    (r"像誓言，又像威胁", "像保证，也像警告"),
    (r"软枷锁咔哒一声", "家里的规矩又紧了一扣"),
    (r"薄墙倒塌", "隔墙那点遮掩没了"),
    (r"半文半白", ""),
]


def _dump_yaml(data: dict) -> str:
    return yaml.safe_dump(data, allow_unicode=True, sort_keys=False, width=100)


def patch_shuli() -> int:
    n = 0
    for eid, beats_new in SHULI_BAIHUA.items():
        path = EVENTS / f"{eid}.yaml"
        if not path.is_file():
            continue
        ev = yaml.safe_load(path.read_text(encoding="utf-8"))
        old_beats = {b.get("id"): b for b in (ev.get("beats") or [])}
        merged = []
        for nb in beats_new:
            ob = dict(old_beats.get(nb["id"]) or {})
            ob.update(
                {
                    "id": nb["id"],
                    "narration": nb["narration"],
                    "pc_thought": nb["pc_thought"],
                    "brief": nb.get("brief") or ob.get("brief") or "",
                    "summary": nb.get("brief") or ob.get("summary") or "",
                    "pages": nb["pages"],
                }
            )
            if "sprite_hint" not in ob:
                ob["sprite_hint"] = ["home_sibling", "home", "casual"]
            if "soft_options" not in ob:
                ob["soft_options"] = []
            merged.append(ob)
        ev["beats"] = merged
        path.write_text(_dump_yaml(ev), encoding="utf-8")
        n += 1
    return n


def patch_dates() -> int:
    cat = json.loads(DATE_PATH.read_text(encoding="utf-8"))
    n = 0
    for d in cat.get("dates") or []:
        did = d.get("id")
        pages = DATE_PAGES.get(did)
        if not pages:
            continue
        d["pages"] = pages
        n += 1
    DATE_PATH.write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return n


def patch_shuli_endings() -> int:
    cat = json.loads(PRESENT_PATH.read_text(encoding="utf-8"))
    endings = cat.get("endings") or {}
    n = 0
    for eid, pages in SHULI_ENDINGS.items():
        if eid not in endings:
            continue
        endings[eid]["pages"] = pages
        n += 1
    PRESENT_PATH.write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return n


def patch_other_stories() -> int:
    n = 0
    for path in sorted(EVENTS.glob("story_*.yaml")):
        if path.name.startswith("story_shuli_"):
            continue
        text = path.read_text(encoding="utf-8")
        orig = text
        for pat, rep in REPLACEMENTS:
            text = re.sub(pat, rep, text)
        if text != orig:
            path.write_text(text, encoding="utf-8")
            n += 1
    return n


def main() -> None:
    a = patch_shuli()
    b = patch_dates()
    c = patch_shuli_endings()
    d = patch_other_stories()
    print(f"shuli_yaml={a} dates={b} shuli_endings={c} other_stories_touch={d}")


if __name__ == "__main__":
    main()
