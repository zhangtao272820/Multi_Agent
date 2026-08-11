# -*- coding: utf-8 -*-
"""Soften remaining AI brochure phrases in lores unlocks/gates + opening + social pc."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

UNLOCK_FIX = {
    "youwei": {
        "studio_sketch_done": "画室里多了一支她肯借你的笔。",
        "youwei_open_heart": "她把线稿外的自己也给你看了。",
    },
    "yuxi": {
        "shift_cover_done": "一起顶过班，护短有了出处。",
        "yuxi_shift_confess_ok": "她肯坐你旁边，不只是护晚雨。",
    },
    "jingning": {
        "cousin_watch_done": "观察日记里，她写过放过你的一笔。",
        "jingning_soft_open": "她合上本子，愿用自己的声音说话。",
    },
    "lingke": {
        "boundary_guard_done": "红笔那关过了。",
        "lingke_peer_ok": "她收起红笔，肯对等说话。",
    },
    "aichen": {
        "friend_gate_done": "闺蜜这关，她点了头。",
        "aichen_clear": "她也允许自己被选中。",
    },
}

LINK_FIX = {
    "youwei": {
        "relation_label": "苏晚悠画室学妹",
        "gate_summary": "多半在画室经苏晚悠认识；要她把笔交给你，得先有创作上的同盟，也得学姐不拦。",
    },
    "yuxi": {
        "relation_label": "温晚雨死党 · 店里护短",
        "gate_summary": "常在咖啡店经晚雨碰上；一起顶过班、晚雨不拦，她才肯并排坐下。",
    },
    "jingning": {
        "relation_label": "江静流堂妹",
        "gate_summary": "家族或活动场合经静流出现；观察日记放过你、堂姐默许，她才卸下旁观。",
    },
    "lingke": {
        "relation_label": "顾若铃助教",
        "gate_summary": "办公室与课后经若铃认识；边界守住、导师放行，才谈对等靠近。",
    },
    "aichen": {
        "relation_label": "夏艾黎闺蜜",
        "gate_summary": "花艺圈复联局经艾黎介绍；闺蜜点头、姐姐也点头，她才肯把心交出去。",
    },
    "shuli": {
        "gate_summary": "要先过嫉妒和伦理那两关；破限以后，还得瞒过同住的枫音。",
    },
}

CODEX_PATCH = {
    "youwei": "温悠微是苏晚悠工作室的学妹，改图改到熟。把你当固定模特也行，真动心会先看学姐脸色。她能帮晚悠，也能在座位上跟你较劲。对门通宵的灯，她比谁都熟。",
    "aichen": "程艾辰是夏艾黎闺蜜，复联后负责盘问靠近的人。心软前先冷脸，爱问账单和动机。想绕过她找艾黎，门关得很快。进货单她也帮着核。",
}


def main() -> None:
    lore_path = DATA / "character_lores.json"
    lore = json.loads(lore_path.read_text(encoding="utf-8"))
    for cid, unlocks in UNLOCK_FIX.items():
        row = lore["characters"][cid]
        row["unlocks"] = {**(row.get("unlocks") or {}), **unlocks}
    for cid, link in LINK_FIX.items():
        row = lore["characters"][cid]
        row.setdefault("link", {}).update(link)
    for cid, codex in CODEX_PATCH.items():
        lore["characters"][cid]["codex"] = codex
    lore_path.write_text(json.dumps(lore, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("lores unlock/link softened")

    # opening
    cat_path = DATA / "presentation_catalog.json"
    cat = json.loads(cat_path.read_text(encoding="utf-8"))
    op = cat["opening"]
    op["world_brief"] = [
        "我叫沈予安。父母早年离异又各自成家；亲妹妹沈书璃同城念书，义妹沈枫音跟我们住一起。",
        "为了工作搬来这座小镇。公司、学校、咖啡店、家——来回就这几条路。",
        "顾千纱、夏艾黎、程星宁，还有隔壁的苏晚悠……以前亲近过的人，也在这镇里。",
    ]
    for slide in op.get("slides") or []:
        if slide.get("id") == "town":
            slide["lines"] = [
                "我叫沈予安。半年前调来这座不算大的镇——梧桐夹道，校门对着商业街，再往里是出租公寓和一片老住宅。没什么戏剧性，只是项目挪到这边，合同签了，房子也就定了。晨光里校门口的石狮子还沾着露水，我提着行李下车，想着：就在这儿过吧。",
                "镇上节奏慢。工作日去公司，周末常在咖啡店、书店和校园外的小路晃。路灯一盏盏亮起来时，回家的路短得像一句话。日子久了你会发现，这座镇记得你点的糖、晚归的脚步，还有你有没有敲门。",
            ]
        elif slide.get("id") == "begin":
            slide["lines"] = [
                "灯灭之前，书璃在客厅翻书，枫音把水杯放回厨房。窗外是这座镇惯有的安静：远处校门口偶尔有车灯扫过。",
                "我把钥匙握在手里。明天还是要去公司，巷口也许会遇见熟人，回家还是推开这扇门。先从下一声门铃，或下一顿晚饭开始吧。",
            ]
            slide["caption"] = "钥匙在手。日子还在这座镇。"
    cat_path.write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("opening softened")

    # social graph pc summary
    sg_path = DATA / "social_graph.json"
    sg = json.loads(sg_path.read_text(encoding="utf-8"))
    sg["pc"]["summary"] = (
        "沈予安：为工作落脚小镇的职员。父母早年离异重组；亲妹妹沈书璃同城念书，义妹沈枫音同住。"
        "工作日去公司，周末在咖啡店、书店与校园之间晃。恋爱可以发生在女主线，也可以发生在难攻略的关系向——"
        "关系向得先认识锚点、过了门。镇上的店主、前辈、宿管会出入生活，但都不是恋爱对象。"
    )
    sg_path.write_text(json.dumps(sg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("social pc summary softened")

    # neutralize CODEX_EXTRA in thicken script so re-run won't re-AI append
    thicken = ROOT / "scripts" / "_thicken_world_echoes.py"
    text = thicken.read_text(encoding="utf-8")
    if "CODEX_EXTRA: dict[str, str] = {" in text and "DISABLED" not in text:
        text = text.replace(
            "CODEX_EXTRA: dict[str, str] = {",
            "CODEX_EXTRA: dict[str, str] = {  # DISABLED: lores fully rewritten; keep empty to avoid AI append\n",
            1,
        )
        # simpler: replace thicken_lores body to no-op append
        text = text.replace(
            "def thicken_lores() -> None:\n    path = DATA / \"character_lores.json\"\n    lore = json.loads(path.read_text(encoding=\"utf-8\"))\n    n = 0\n    for cid, extra in CODEX_EXTRA.items():",
            "def thicken_lores() -> None:\n    # no-op: character_lores already human-rewritten; do not append brochure extras\n    print(\"lores thicken skipped (human rewrite SSOT)\")\n    return\n    path = DATA / \"character_lores.json\"\n    lore = json.loads(path.read_text(encoding=\"utf-8\"))\n    n = 0\n    for cid, extra in CODEX_EXTRA.items():",
        )
        thicken.write_text(text, encoding="utf-8")
        print("thicken_lores no-op guarded")


if __name__ == "__main__":
    main()
