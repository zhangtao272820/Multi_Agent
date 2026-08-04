"""Generate data/sprite_gen_manifest.json from on-disk sprites + social_graph + body_catalog.

Always merges intimate / 擦边 / max / end_* / bath foam (§2.5) outfit labels + hints +
signature_hooks so a single rebuild cannot leave a half-broken manifest
(see apply_intimate_expansion).
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
from body_catalog_lib import body_lock_short, get_body_row, load_body_catalog  # noqa: E402

EMOTIONS = ["neutral", "happy", "shy", "sad", "angry", "love", "surprised", "sarcastic"]
OUTFITS = [
    {"id": "school", "label": "校服/学生装"},
    {"id": "casual", "label": "日常便服"},
    {"id": "work", "label": "通勤/工装"},
    {"id": "home", "label": "居家服"},
    {"id": "festival_spring", "label": "新春节日装"},
    {"id": "festival_midautumn", "label": "中秋节日装"},
    {"id": "date", "label": "约会装"},
    {"id": "rain", "label": "雨天装"},
]
STATES = [
    {"id": "sleepy", "label": "犯困"},
    {"id": "sick", "label": "生病"},
    {"id": "party", "label": "派对"},
    {"id": "overtime", "label": "加班疲惫"},
]

# 居家不要签名抢 season_winter / intimate（见扩展计划 §5.2）
_CLEAR_HOME_HOOKS = frozenset({"linxi", "jingliu"})

EXTRA_OUTFITS = [
    {"id": "season_spring", "label": "春装"},
    {"id": "season_summer", "label": "夏装"},
    {"id": "season_autumn", "label": "秋装"},
    {"id": "season_winter", "label": "冬装"},
    {"id": "home_eating", "label": "居家用餐"},
    {"id": "home_sleeping", "label": "居家睡眠"},
    {"id": "work_working_focus", "label": "工位专注"},
    {"id": "intimate_lounge", "label": "私密·软"},
    {"id": "intimate_lingerie", "label": "私密·内衣"},
    {"id": "intimate_implied", "label": "私密·暗示"},
    {"id": "bridal", "label": "婚纱"},
    {"id": "maternity", "label": "怀孕日常"},
    {"id": "silk_slip", "label": "擦边·吊带睡裙"},
    {"id": "after_bath", "label": "擦边·浴后"},
    {"id": "morning_shirt", "label": "擦边·晨起衬衫"},
    {"id": "lace_night", "label": "擦边·蕾丝睡衣"},
    {"id": "towel_wrap", "label": "擦边·浴巾"},
    {"id": "backless_home", "label": "擦边·露背"},
    {"id": "bedside_hug", "label": "擦边·床边"},
    {"id": "window_night", "label": "擦边·窗边夜"},
    {"id": "max_micro_slip", "label": "魅力·极短睡裙"},
    {"id": "max_wet_cling", "label": "魅力·湿衣贴身"},
    {"id": "max_garter", "label": "魅力·吊带袜"},
    {"id": "max_kneel_pillow", "label": "魅力·跪坐抱枕"},
    {"id": "max_strappy", "label": "魅力·绑带蕾丝"},
    {"id": "max_choker", "label": "魅力·颈环"},
    {"id": "max_slit_gown", "label": "魅力·高开衩"},
    {"id": "max_over_shoulder", "label": "魅力·回眸露背"},
    {"id": "max_sofa_lie", "label": "魅力·沙发半躺"},
    {"id": "max_ribbon_cover", "label": "魅力·缎带遮挡"},
    {"id": "end_lingerie_set", "label": "结局·成套内衣"},
    {"id": "end_deep_v", "label": "结局·深V"},
    {"id": "end_lace_bra", "label": "结局·蕾丝文胸"},
    {"id": "end_sheer_cover", "label": "结局·薄纱遮挡"},
    {"id": "end_robe_open", "label": "结局·敞袍内衣"},
    {"id": "end_strappy", "label": "结局·绑带内衣"},
    {"id": "end_garter_bed", "label": "结局·吊带袜床沿"},
    {"id": "end_kneel_pillow", "label": "结局·跪坐抱枕"},
    {"id": "end_back_glance", "label": "结局·回眸露背"},
    {"id": "end_sofa_invite", "label": "结局·沙发邀约"},
    {"id": "end_choker", "label": "结局·颈环"},
    {"id": "end_wet_home", "label": "结局·湿发家居"},
    {"id": "end_window_night", "label": "结局·窗边夜"},
    {"id": "end_morning_after", "label": "结局·晨间半敞"},
    {"id": "end_close_embrace", "label": "结局·近拥抱前"},
    {"id": "bath_foam", "label": "私密·浴缸泡沫"},
    {"id": "shower_foam", "label": "私密·淋浴泡沫"},
    {"id": "foam_chest", "label": "私密·泡沫捂胸"},
    {"id": "bath_scrub", "label": "私密·擦背"},
    {"id": "pr_bath_foam", "label": "真人浴·浴缸泡沫"},
    {"id": "pr_shower_foam", "label": "真人浴·淋浴泡沫"},
    {"id": "pr_foam_chest", "label": "真人浴·泡沫捂胸"},
    {"id": "pr_bath_scrub", "label": "真人浴·擦背"},
    {"id": "pr_wrap_low", "label": "真人浴·低领裹身"},
    {"id": "pr_foam_slide", "label": "真人浴·泡沫下滑"},
    {"id": "pr_tub_lean", "label": "真人浴·俯身桶沿"},
    {"id": "pr_steam_close", "label": "真人浴·近景水雾"},
    {"id": "pr_kneel_foam", "label": "真人浴·跪坐仰视"},
    {"id": "pr_wet_cling", "label": "真人浴·湿裹贴身"},
    {"id": "pr_shoulder_slip", "label": "真人浴·肩带将落"},
    {"id": "pr_back_glance", "label": "真人浴·湿背回眸"},
    {"id": "pr_edge_sit", "label": "真人浴·坐桶沿"},
    {"id": "pr_rinse_up", "label": "真人浴·举手冲洗"},
    {"id": "pr_foam_hug", "label": "真人浴·环抱泡沫"},
    {"id": "q_cleavage", "label": "Q版·性感"},
    {"id": "ad_bra_set", "label": "广告·成套内衣"},
    {"id": "ad_lace_campaign", "label": "广告·蕾丝企划"},
    {"id": "ad_silk_lookbook", "label": "广告·丝质 lookbook"},
    {"id": "ad_editorial", "label": "广告·杂志写真"},
]

BASE_ADVANCE = {
    "bridal": "婚纱进阶：白色或角色色点缀婚纱/轻婚纱+头纱或捧花，全身 VN；站姿或微侧，可轻提裙摆；浪漫庄重；禁止工作服与露点",
    "maternity": "怀孕日常：柔软孕妇装或宽松针织裙/家居裙，可见圆润孕肚轮廓；一手轻抚腹部，居家温柔；禁止紧身情趣与露点",
    "intimate_lingerie": "情趣内衣档：吊带睡裙或蕾丝内衣套装+丝袜/吊带袜，遮挡充分不露点；害羞亲昵站姿或坐姿；禁止裸露、性器官与性行为姿势",
    "intimate_implied": "暗示私密：床单/薄被/手臂遮挡或背影剪影，敏感部位不可辨；纯黑背景 VN；禁止露点、性器官与性行为姿势",
    "silk_slip": "擦边吊带睡裙：浅粉/奶白丝质短睡裙，露肩腿，可抱速写本作遮挡道具；害羞亲昵站或坐；禁止露点、性器官与性行为姿势",
    "after_bath": "浴后擦边：湿发披肩+薄白浴袍松系，锁骨与腿线可见，可持毛巾角；禁止露点与基图针织套",
    "morning_shirt": "晨起男友衬衫：过大沾淡颜料点的白衬衫只到大腿+短裤，袖口过长，睡眼惺忪害羞；禁止露点与情趣内衣",
    "lace_night": "蕾丝睡衣：柔粉蕾丝吊带睡裙+薄纱，遮挡充分，抱靠枕；禁止露点、性器官与性行为姿势",
    "towel_wrap": "浴巾遮挡：同色浴巾裹身到胸上，湿发，双手抓紧浴巾角害羞；禁止露点与性器官",
    "backless_home": "露背家居：背后交叉细带短睡裙或露背吊带，侧身回眸，遮挡充分；禁止露点",
    "bedside_hug": "床边抱膝：短睡裙坐床沿抱膝或抱枕挡胸，害羞低头；床单道具级；禁止露点与性行为姿势",
    "window_night": "窗边夜衣：薄睡裙侧光剪影级，一手拉窗帘一手护胸，敏感部位不可辨；禁止露点",
}

MAX_BASE = {
    "max_micro_slip": "魅力极限：极短丝质吊带睡裙，大腿根将露未露，遮挡充分不露点；害羞或心动；禁止露点、乳晕、性器官与性行为姿势",
    "max_wet_cling": "魅力极限：湿发+贴身不透明薄衣/白衫，曲线贴合但不透点；禁止透视乳头、露点与性器官",
    "max_garter": "魅力极限：蕾丝内衣+吊带袜袜夹，站姿或微抬腿，遮挡充分；禁止露点、性器官与性行为姿势",
    "max_kneel_pillow": "魅力极限：床沿跪坐抱枕挡胸，仰视害羞，非性行为姿势；禁止露点与性器官",
    "max_strappy": "魅力极限：细带绑带蕾丝内衣套装，遮挡充分；禁止露点、性器官与性行为姿势",
    "max_choker": "魅力极限：颈环+泰迪式蕾丝连体，手指可钩环，遮挡充分；禁止露点与性器官",
    "max_slit_gown": "魅力极限：高开衩丝质睡袍，侧腿一线，前襟仍遮挡；禁止露点与性器官",
    "max_over_shoulder": "魅力极限：露背回眸，肩带滑落将落未落，遮挡充分；禁止露点与性器官",
    "max_sofa_lie": "魅力极限：沙发半躺，睡裙上移仍遮挡胸臀；禁止露点、性器官与性行为姿势",
    "max_ribbon_cover": "魅力极限：缎带/薄纱战略遮挡，敏感部位不可辨；禁止露点、性器官与性行为姿势",
}

# §2.5 洗浴泡沫（romance T0–T2；进 resolve 晨间/晚间候选）
# GenerateImage 过审措辞：侧面描写（高机位/水雾/泡泡云贴/低领白棉裹身），少用 bath/nude/bare 直述
BATH_BASE = {
    "bath_foam": "洗浴泡沫：高机位俯视；湿发；白棉裹身低领至锁骨下；厚白泡泡如云朵贴覆中段与髋；木桶泡泡道具；上胸曲线上半在领线处可见；禁止露点、乳晕、性器官与性行为姿势",
    "shower_foam": "淋浴泡沫：高机位俯视水雾与水珠；站姿；白棉裹身低领；厚白泡泡云贴覆中段；上胸曲线上半可见；禁止露点、乳晕、性器官与性行为姿势",
    "foam_chest": "泡沫捂胸：高机位俯视；白棉裹身；双手捧厚白泡泡团于锁骨前，泡泡云贴覆中段；上胸曲线上半仍露；禁止露点、乳晕、性器官与性行为姿势",
    "bath_scrub": "擦背洗浴：高机位俯视；白棉裹身；木浴刷过肩擦上背；肩发白泡泡；上胸曲线上半可见；禁止露点、乳晕、性器官与性行为姿势",
}

# §2.6 洗浴半写实（全 15 id 定义保留；完成线 T0/T1×30 · T2×20）
# GenerateImage：侧面描写加深 scoop/cling/lean，少用 bath/nude/cleavage/bra 直述
# T2 不挂下列 5 套 hints（不生成）
PR_BATH_T2_SKIP = frozenset(
    {
        "pr_wet_cling",
        "pr_shoulder_slip",
        "pr_back_glance",
        "pr_rinse_up",
        "pr_foam_hug",
    }
)
PR_BATH_BASE = {
    "pr_bath_foam": "半写实美型2.5D洗浴：同 bath_foam 构图；高机位俯视；白棉裹身+泡泡云贴；禁止纪实毛孔路人脸、露点与性器官",
    "pr_shower_foam": "半写实美型2.5D淋浴：同 shower_foam 构图；水雾水珠；白棉裹身+泡泡云贴；禁止纪实摄影、露点与性器官",
    "pr_foam_chest": "半写实美型2.5D泡沫捂胸：同 foam_chest 构图；双手捧泡泡团；禁止纪实摄影、露点与性器官",
    "pr_bath_scrub": "半写实美型2.5D擦背：同 bath_scrub 构图；木浴刷过肩；禁止纪实摄影、露点与性器官",
    "pr_wrap_low": "半写实美型2.5D加码：高机位；白棉裹身 scoop 更低至锁骨下更深处，上胸曲线压线仍遮点；厚泡贴髋；禁止纪实摄影、露点与性器官",
    "pr_foam_slide": "半写实美型2.5D加码：高机位；厚白泡泡沿胸前下滑将落未落，髋仍厚泡遮挡；白棉裹身；禁止纪实摄影、露点与性器官",
    "pr_tub_lean": "半写实美型2.5D加码：高机位；俯身双手扶木桶沿对镜头，低领裹身乳沟压线仍遮点；禁止纪实摄影、露点与性器官",
    "pr_steam_close": "半写实美型2.5D加码：更近3/4身+水雾水珠；低领白棉裹身；泡泡云贴中段；禁止纪实摄影、露点与性器官",
    "pr_kneel_foam": "半写实美型2.5D加码：桶内跪坐厚泡沫仰视男主；白棉裹身低领；非性行为姿势；禁止纪实摄影、露点与性器官",
    "pr_wet_cling": "半写实美型2.5D加码：湿白棉裹身贴合曲线但不透点；水珠；高机位；禁止透视乳头、纪实摄影、露点与性器官",
    "pr_shoulder_slip": "半写实美型2.5D加码：裹身肩带/边沿滑落将落未落；上胸上半可见仍遮点；禁止纪实摄影、露点与性器官",
    "pr_back_glance": "半写实美型2.5D加码：湿背回眸；裹身低背仍遮挡；泡沫贴髋；禁止纪实摄影、露点与性器官",
    "pr_edge_sit": "半写实美型2.5D加码：坐桶沿腿入水；白棉裹身偏短至大腿；上胸曲线可见仍遮点；禁止纪实摄影、露点与性器官",
    "pr_rinse_up": "半写实美型2.5D加码：双手举过头顶梳头冲洗；躯干拉长；低领裹身+泡贴中段；禁止纪实摄影、露点与性器官",
    "pr_foam_hug": "半写实美型2.5D加码：双臂环抱厚白泡泡团挡下半身；上胸曲线上半仍露；禁止纪实摄影、露点与性器官",
}

# §2.7 Q版性感（仅图鉴）
Q_BASE = {
    "q_cleavage": "成年Q版/chibi约2.5～3头身；白棉裹身或泡沫遮挡；上胸曲线上半可见；禁止幼化脸、露点、性器官与性行为姿势",
}

# §2.8 内衣广告（仅图鉴；拒图用 loungewear 措辞）
AD_BASE = {
    "ad_bra_set": "内衣广告棚拍：成套蕾丝内衣或优雅蕾丝家居套装站姿；柔光；上胸曲线明确仍遮挡；禁止露点与性器官",
    "ad_lace_campaign": "品牌蕾丝企划海报：蕾丝+吊带袜；一手扶腰或理肩带；广告灯；禁止露点与性器官",
    "ad_silk_lookbook": "丝质内衣 lookbook：坐姿或微侧；上胸上半可见仍遮挡；杂志感；禁止露点与性器官",
    "ad_editorial": "杂志写真：薄纱外搭仍遮点；回眸或对镜；广告棚；禁止露点、性器官与性行为姿势",
}

# §2.4 结局展示（仅 presentation / 图鉴；不进 resolve_outfit）
END_BASE = {
    "end_lingerie_set": "结局CG：成套蕾丝内衣（文胸+内裤），站姿或微侧，上胸曲线明确，遮挡充分不露点；男友视角；禁止露点、乳晕、性器官与性行为姿势",
    "end_deep_v": "结局CG：深V薄吊带或低领薄衣，乳沟压线仍遮挡，不露点；男友视角；禁止透视乳头与性器官",
    "end_lace_bra": "结局CG：蕾丝文胸为主的全身立绘，双手交叠或抱臂挡胸，遮挡充分；男友视角；禁止露点与性器官",
    "end_sheer_cover": "结局CG：薄纱/缎带战略遮挡，敏感部位不可辨；男友视角；禁止露点、性器官与性行为姿势",
    "end_robe_open": "结局CG：丝质睡袍敞开露出内衣套装，前襟仍遮挡充分；男友视角；禁止露点与性器官",
    "end_strappy": "结局CG：细带绑带蕾丝内衣套装，遮挡充分；男友视角；禁止露点、性器官与性行为姿势",
    "end_garter_bed": "结局CG：蕾丝内衣+吊带袜袜夹，床沿坐或跪，仰视男主，非性行为姿势；禁止露点与性器官",
    "end_kneel_pillow": "结局CG：跪坐抱枕挡胸，仰视告白感；禁止露点、性器官与性行为姿势",
    "end_back_glance": "结局CG：露背回眸，肩带将落未落，遮挡充分；男友视角；禁止露点与性器官",
    "end_sofa_invite": "结局CG：沙发半躺邀约姿态，睡裙/内衣仍遮挡胸臀；禁止露点、性器官与性行为姿势",
    "end_choker": "结局CG：颈环+泰迪式蕾丝，手指可钩环，遮挡充分；男友视角；禁止露点与性器官",
    "end_wet_home": "结局CG：湿发+贴身不透明家居薄衣，曲线贴合但不透点；禁止透视乳头、露点与性器官",
    "end_window_night": "结局CG：窗边夜衣剪影级私密，一手拉帘一手护胸，敏感部位不可辨；禁止露点",
    "end_morning_after": "结局CG：晨间仅内衣或男友衬衫半敞到大腿，遮挡充分；男友视角；禁止露点与性器官",
    "end_close_embrace": "结局CG：近距离拥抱前姿势（伸手/侧身靠近），内衣或薄睡裙仍遮挡；禁止性行为姿势、露点与性器官",
}

FLAVOR = {
    "xiaoyou": "插画师发色与淡颜料点可保留；可抱速写本作遮挡道具",
    "wanyu": "咖啡店员卸妆柔软向；发带/暖杏配色",
    "ruolin": "知性成熟；眼镜可摘置旁",
    "jingliu": "品牌黑/酒红；金饰卸大半",
    "aili": "蜜金波浪；可有干花/花瓣道具级遮挡",
    "linxi": "红丝带点缀；傲娇害羞",
    "yeyu": "设计师面料感；剪裁利落蕾丝",
    "taotao": "偶像卸妆后私服；禁舞台装整套照搬",
    "shizuku": "紫发软萌反差；禁图书馆员制服情趣化",
    "qiansha": "宅感褪下后的家居极限；禁工位装",
    "shiori": "文静书店员反差；禁店员围裙",
    "miara": "卸 elf cos 后本体；可留耳饰级小道具",
    "xingnai": "成年青梅私服/家居；禁止校服情趣与幼化",
    "fengyin": "大学生义妹；运动后家居向；禁止幼化",
    "qingcai": "舞者柔韧；跪坐/开衩强调腿线；禁止幼化",
    "xiaoyang": "成年同学私服；禁止校服情趣与幼化",
    "luna": "咖啡星象风；颈环/薄纱可带新月小饰",
    # 中立 N：禁忌情愫 + 故意展示（对齐 T2 包；禁幼化）
    "shuli": "男主亲妹；居家故意展示给兄长看；圆框眼镜可留；禁幼化与校服情趣",
    "jingning": "堂亲；茶席旁故意露一点；小金花耳饰；禁幼化",
    "youwei": "画室学妹；递速写本时故意贴近；沾颜料小道具；禁幼化",
    "yuxi": "咖啡馆死党；顶班间隙故意整理衣领/围裙；禁幼化",
    "lingke": "助教；办公室门半掩时的故意低领/姿态；工牌可留；禁幼化",
    "aichen": "女主闺蜜守门人；对男主也有情愫时的故意展示；襟花/花束道具；禁幼化",
}

STOCK_BASE = {
    "school": "学院私服或便装校园向：衬衫/针织+裙或裤；全身 VN；禁基图整套不动",
    "date": "精致便装约会向：略正式裙装或衬衫长裤；可微露锁骨；禁基图整套不动",
    "festival_spring": "新春节日装：红或暖色元素连衣裙/套装；可捧小福袋；禁基图整套不动",
    "festival_midautumn": "中秋节日装：月白/藕粉旗袍风或端庄裙装；可持月饼盒道具级；禁基图整套不动",
    "rain": "雨天外出装：风衣或透明雨衣罩便装；可持折叠伞；禁只改原衣织理",
    "season_winter": "冬日便装：厚毛衣+裙或长裤+靴；保暖居家外出感；禁只改大衣内层",
    "home_eating": "居家用餐：家居服捧碗或持筷坐姿；生活互动；禁基图整套站桩",
    "home_sleeping": "居家睡眠：睡裙或睡衣侧躺/坐床沿低能量；禁露点",
    "work_working_focus": "工位专注：工装或便装坐姿看文件/屏；认真；禁基图整套不动",
}

T0 = {"xiaoyou", "wanyu", "ruolin", "jingliu", "aili", "linxi"}
T2 = {"xingnai", "fengyin", "qingcai", "xiaoyang", "luna"}
NEUTRAL_IDS = {"shuli", "jingning", "youwei", "yuxi", "lingke", "aichen"}
# 中立 advance 包对齐 T2（§2.6×20）
NEUTRAL_DISPLAY_SUFFIX = "姿态带「故意让他看见」的心虚与试探，非合法情侣 enticement"


def _load_expansion_packs() -> dict:
    archive = ROOT / "scripts" / "_archive" / "update_sprite_expansion_manifest.py"
    if not archive.is_file():
        return {}
    spec = importlib.util.spec_from_file_location("sprite_expansion_archive", archive)
    if not spec or not spec.loader:
        return {}
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return dict(getattr(mod, "PACKS", {}) or {})


def apply_intimate_expansion(manifest: dict) -> dict:
    """Merge intimate/max/end outfits, hints, signature_hooks; refresh files from disk."""
    existing_ids = {o["id"] for o in (manifest.get("outfits") or [])}
    for o in EXTRA_OUTFITS:
        if o["id"] not in existing_ids:
            manifest.setdefault("outfits", []).append(o)
            existing_ids.add(o["id"])

    packs = _load_expansion_packs()
    chars = manifest.setdefault("characters", {})
    for cid, pack in list(chars.items()):
        cast = pack.get("cast_kind") or "romance"
        folder = ROOT / "data" / "sprites" / cast / cid
        if folder.is_dir():
            files = sorted(f.name for f in folder.glob("*.png"))
            pack["existing_files"] = files
            pack["existing_emotions"] = [e for e in EMOTIONS if f"{e}.png" in files]
            pack["sprite_dir"] = str(folder.relative_to(ROOT)).replace("\\", "/")

        archived = packs.get(cid) or {}
        if archived:
            hooks = dict(archived.get("hooks") or {})
            if cid in _CLEAR_HOME_HOOKS:
                hooks.pop("home", None)
                hooks.pop("room", None)
            pack["signature_hooks"] = hooks
            if archived.get("sigs"):
                pack["signature_plan"] = list(archived["sigs"])
            oh = pack.setdefault("outfit_hints", {})
            for k, v in (archived.get("outfit_hints") or {}).items():
                oh.setdefault(k, v)

        if cid not in FLAVOR:
            continue
        oh = pack.setdefault("outfit_hints", {})
        flavor = FLAVOR[cid]
        if cast == "neutral" and cid in NEUTRAL_IDS:
            for k, v in STOCK_BASE.items():
                oh.setdefault(k, f"{v}；角色差分：{flavor}")
            for k, v in MAX_BASE.items():
                oh[k] = f"{v}；角色差分：{flavor}；{NEUTRAL_DISPLAY_SUFFIX}"
            for k, v in END_BASE.items():
                oh[k] = f"{v}；角色差分：{flavor}；{NEUTRAL_DISPLAY_SUFFIX}"
            for k, v in BATH_BASE.items():
                oh[k] = f"{v}；角色差分：{flavor}；{NEUTRAL_DISPLAY_SUFFIX}"
            for k, v in PR_BATH_BASE.items():
                if k in PR_BATH_T2_SKIP:
                    oh.pop(k, None)
                    continue
                oh[k] = f"{v}；角色差分：{flavor}；{NEUTRAL_DISPLAY_SUFFIX}"
            for k, v in Q_BASE.items():
                oh[k] = f"{v}；角色差分：{flavor}；{NEUTRAL_DISPLAY_SUFFIX}"
            for k, v in AD_BASE.items():
                oh[k] = f"{v}；角色差分：{flavor}；{NEUTRAL_DISPLAY_SUFFIX}"
            continue
        if cast != "romance":
            continue
        if cid in T0:
            for k, v in BASE_ADVANCE.items():
                oh.setdefault(k, v)
            if cid == "xiaoyou":
                oh.update(BASE_ADVANCE)
        for k, v in MAX_BASE.items():
            oh[k] = f"{v}；角色差分：{flavor}"
        for k, v in END_BASE.items():
            oh[k] = f"{v}；角色差分：{flavor}"
        for k, v in BATH_BASE.items():
            oh[k] = f"{v}；角色差分：{flavor}"
        for k, v in PR_BATH_BASE.items():
            if cid in T2 and k in PR_BATH_T2_SKIP:
                oh.pop(k, None)
                continue
            oh[k] = f"{v}；角色差分：{flavor}"
        for k, v in Q_BASE.items():
            oh[k] = f"{v}；角色差分：{flavor}"
        for k, v in AD_BASE.items():
            oh[k] = f"{v}；角色差分：{flavor}"
    return manifest


def main() -> None:
    roles = json.loads((ROOT / "data" / "model_roles.json").read_text(encoding="utf-8"))
    sg = json.loads((ROOT / "data" / "social_graph.json").read_text(encoding="utf-8"))
    body_catalog = load_body_catalog()
    characters: dict = {}
    for base in roles.get("bases") or []:
        for row in base.get("characters") or []:
            cid = str(row.get("id") or "")
            prof = row.get("profile") or {}
            social = (sg.get("characters") or {}).get(cid) or {}
            cast_kind = str(social.get("cast_kind") or "romance")
            # linked 角色落盘在 neutral/；manifest 仍保留 cast_kind=linked
            if cast_kind == "linked":
                disk_cast = "neutral"
            elif cast_kind in {"romance", "neutral", "npc"}:
                disk_cast = cast_kind
            else:
                cast_kind = "romance"
                disk_cast = "romance"
            # 正式分档：sprites/{romance|neutral|npc}/{id}/；兼容旧顶层 sprites/{id}/
            folder = ROOT / "data" / "sprites" / disk_cast / cid
            if not folder.is_dir():
                folder = ROOT / "data" / "sprites" / cid
            files = sorted(f.name for f in folder.glob("*.png")) if folder.is_dir() else []
            emotion_bases = [e for e in EMOTIONS if f"{e}.png" in files]
            appearance = str(prof.get("appearance") or "")
            body_row = get_body_row(body_catalog, cid)
            entry = {
                "name": prof.get("name") or cid,
                "base_id": base.get("id"),
                "cast_kind": cast_kind,
                "sprite_dir": str(folder.relative_to(ROOT)).replace("\\", "/") if folder.is_dir() else "",
                "role_to_pc": social.get("role_to_pc") or "",
                "appearance_lock": appearance,
                "existing_emotions": emotion_bases,
                "existing_files": files,
                "priority": "stock_keep",
                "outfit_plan": [o["id"] for o in OUTFITS],
                "state_plan": [s["id"] for s in STATES],
                "prompt_seed": (
                    f"visual novel anime character sprite, same face and hair, {appearance}"
                ),
                "gen_policy": "image_edit_from_live_neutral",
            }
            if body_row:
                entry["body_ref"] = cid
                entry["body_lock"] = body_lock_short(body_row)
            characters[cid] = entry

    # 合并旧 manifest 手工字段，避免 rebuild 丢掉扩包元数据
    old_path = ROOT / "data" / "sprite_gen_manifest.json"
    old_outfits = list(OUTFITS)
    old_states = list(STATES)
    if old_path.is_file():
        old = json.loads(old_path.read_text(encoding="utf-8"))
        if old.get("outfits"):
            old_outfits = list(old["outfits"])
        if old.get("states"):
            old_states = list(old["states"])
        for cid, old_row in (old.get("characters") or {}).items():
            if cid not in characters:
                continue
            for key in (
                "clothing_forbid",
                "outfit_hints",
                "signature_hooks",
                "signature_plan",
                "state_hints",
                "gen_policy",
                "body_ref",
                "body_lock",
            ):
                if old_row.get(key) and not characters[cid].get(key):
                    characters[cid][key] = old_row[key]
            for plan_key in ("outfit_plan", "state_plan"):
                old_plan = old_row.get(plan_key) or []
                if not old_plan:
                    continue
                cur = list(characters[cid].get(plan_key) or [])
                for item in old_plan:
                    if item not in cur:
                        cur.append(item)
                characters[cid][plan_key] = cur

    manifest = {
        "version": 1,
        "naming": {
            "default": "{emotion}.png",
            "outfit": "{outfit}_{emotion}.png",
            "outfit_state": "{outfit}_{state}_{emotion}.png",
            "fallback": "If outfit/state file missing, use {emotion}.png",
        },
        "core_emotions": EMOTIONS,
        "outfits": old_outfits,
        "states": old_states,
        "staging_dir": "data/sprites/_staging",
        "body_catalog": "data/body_catalog.json",
        "policy": {
            "never_delete_existing": True,
            "main_cast_target": 12,
            "non_main_reuse_stock": True,
            "generate_after_pick": True,
        },
        "characters": characters,
    }
    apply_intimate_expansion(manifest)

    out = ROOT / "data" / "sprite_gen_manifest.json"
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    xy = (manifest.get("characters") or {}).get("xiaoyou") or {}
    print(f"wrote {out} ({len(characters)} characters)")
    print(f"outfits {len(manifest.get('outfits') or [])}")
    print(f"xiaoyou files {len(xy.get('existing_files') or [])} hints {len(xy.get('outfit_hints') or {})}")


if __name__ == "__main__":
    main()
