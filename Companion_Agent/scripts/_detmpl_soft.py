# -*- coding: utf-8 -*-
from pathlib import Path
import re

OVERRIDES = {
  "story_xiaoyou_act5_winter_frame": [
    ["帮她关窗", "递手套", "问要不要停画"],
    ["只看画框", "夸颜色准", "约加件外套"],
    ["说我不催交稿", "并肩看雪", "送她回家"],
  ],
  "story_wanyu_act5_winter_steam": [
    ["帮她擦吧台", "问要不要关店", "递暖手"],
    ["听蒸汽散尽", "不催关灯", "约最后一杯"],
    ["说我能顶班", "夸她手稳", "送她锁门"],
  ],
  "story_ruolin_act5_winter_office": [
    ["帮她收卷", "问手冷吗", "先关门"],
    ["听红笔落地", "不碰试卷", "约喝热饮"],
    ["说边界我懂", "夸她清醒", "送她出办公室"],
  ],
  "story_jingliu_act5_winter_rooftop": [
    ["递围巾", "问风大吗", "先下楼"],
    ["听她说展品", "不碰玻璃", "约短休"],
    ["说我不催揭面", "并肩看夜景", "送她进电梯"],
  ],
  "story_aili_act5_winter_greenhouse": [
    ["护着花盆", "问温差", "先关温室门"],
    ["递手套", "夸叶子", "约再来"],
    ["说别冻手", "帮她记湿度", "送她回家"],
  ],
  "story_linxi_act5_winter_rail": [
    ["帮她捂杯", "问末班", "先坐一会"],
    ["听她说加班", "不催进度", "约改站台"],
    ["说我等得起", "帮她理围巾", "送她进站"],
  ],
  "story_taotao_act5_winter_stage": [
    ["递暖手宝", "帮她对词", "问要不要停练"],
    ["说台下有我", "帮她擦汗", "先喝热水"],
    ["约加练不加班", "夸一句真听得见", "送她回家"],
  ],
  "story_shizuku_act5_winter_stack": [
    ["帮她抱书", "说外面冷", "先关窗"],
    ["问库存数字", "递手套", "约闭馆后茶"],
    ["说我不催上架", "听她数到完", "护着纸箱"],
  ],
  "story_shizuku_act4_closed_stack": [
    ["帮她锁柜", "问要不要出声", "先关灯"],
    ["安静听完", "递便签", "说我不催借阅"],
    ["说故事还在", "并肩站货架", "送她出馆"],
  ],
  "story_qiansha_act5_winter_diff": [
    ["帮她保存 diff", "说先热饮", "问哪行最脏"],
    ["并肩拍板", "说别一个人 merge", "约短休"],
    ["承诺不摸键盘", "夸她冷静", "送她下楼"],
  ],
  "story_shiori_act5_winter_shelf": [
    ["帮她扶书脊", "递围巾", "先锁柜"],
    ["听她读半页", "说我不抢封面", "约窗边站一会"],
    ["说故事还在", "帮她写便签", "送她出馆"],
  ],
  "story_shiori_act4_window_read": [
    ["站到窗边", "问要不要读出声", "先拉帘"],
    ["安静听完", "递书签", "说我不抢下一页"],
    ["说空白页给你", "夸她声音稳", "送她下楼"],
  ],
  "story_miara_act5_winter_booth": [
    ["帮她压桌布", "递暖贴", "问要不要早收"],
    ["说假发也好看", "帮她理袖", "约摊位后热饮"],
    ["承认我也紧张", "夸她契约清楚", "护着钱箱"],
  ],
  "story_fengyin_act5_winter_door": [
    ["帮她挡风", "问要不要进屋", "递热水"],
    ["听门轴响", "说我不抢钥匙", "约檐下站一会"],
    ["承诺不吵邻居", "夸她门关得稳", "告辞"],
  ],
  "story_luna_act5_winter_tarot": [
    ["扶塔罗盒", "问冷不冷", "先点灯"],
    ["听牌意", "不抢解读", "约再抽一张"],
    ["说我不急答案", "帮她收牌", "送她回家"],
  ],
  "story_qingcai_act5_winter_mirror": [
    ["递热水", "问妆花了吗", "先照镜"],
    ["听她说舞台", "不催开场", "约后台坐"],
    ["说我不抢镜头", "夸她眼神稳", "送她进场"],
  ],
  "story_xiaoyang_act5_winter_club": [
    ["帮她扶箱", "问手套", "先关库门"],
    ["听库存数", "不碰标签", "约短休"],
    ["说我不催上架", "夸她仔细", "送她出库"],
  ],
  "story_xingnai_act5_winter_album": [
    ["帮她理袖标", "问冷不冷", "先停拍"],
    ["听她说镜头", "不抢机位", "约热饮"],
    ["说我不催成片", "夸她节奏稳", "送她回家"],
  ],
}

def replace_soft(text, options_list):
    pattern = re.compile(r"soft_options:\n(?:  - .+\n){3}")
    matches = list(pattern.finditer(text))
    if len(matches) != len(options_list):
        return None, len(matches)
    out = text
    for m, opts in zip(reversed(matches), reversed(options_list)):
        block = "soft_options:\n" + "".join(f"  - {o}\n" for o in opts)
        out = out[: m.start()] + block + out[m.end() :]
    return out, len(matches)

ev = Path(r"e:/Agent/Companion_Agent/data/events")
changed = 0
failed = []
for stem, opts in OVERRIDES.items():
    p = ev / f"{stem}.yaml"
    if not p.exists():
        failed.append((stem, "missing"))
        continue
    t = p.read_text(encoding="utf-8")
    if "- 留下" not in t:
        continue
    new, n = replace_soft(t, opts)
    if new is None:
        failed.append((stem, f"match={n}"))
        continue
    p.write_text(new, encoding="utf-8")
    changed += 1
g = sum(
    1
    for p in ev.glob("story_*.yaml")
    if "- 留下" in p.read_text(encoding="utf-8")
    and "- 关心一句" in p.read_text(encoding="utf-8")
)
print("changed", changed)
print("failed", failed)
print("remaining_generic", g)
