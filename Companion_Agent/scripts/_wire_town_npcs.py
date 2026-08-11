"""Wire town_npcs into social_graph locations + edges; update npc policies."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

LOC_NPC: dict[str, list[str]] = {
    "cafe": ["npc_cafe_owner"],
    "library": ["npc_bookstore_regular"],  # bookstore may map to library; also street
    "office": ["npc_office_lead"],
    "campus": ["npc_dorm_aunt", "npc_dance_coach"],
    "street": ["npc_flower_supplier", "npc_idol_manager"],
    "home": ["npc_neighbor_couple"],
}

# bookstore location may not exist — plan used bookstore; social has library. Put regular at library.
# Also add store? skip.

EDGE_SPECS = [
    ("npc_cafe_owner", "wanyu", "店里老板娘，管排班与打烊", "acquaintance"),
    ("npc_cafe_owner", "luna", "夜班排班常被点名的兼职", "acquaintance"),
    ("npc_cafe_owner", "yuxi", "顶班时被老板娘点头默认的死党", "acquaintance"),
    ("npc_bookstore_regular", "shiori", "每周来换书的常客", "acquaintance"),
    ("npc_bookstore_regular", "shizuku", "在图书馆也碰见的安静读者", "acquaintance"),
    ("npc_office_lead", "linxi", "催进度的组里前辈", "colleague"),
    ("npc_office_lead", "jingliu", "跨组协作时点头的顾问向前辈", "colleague"),
    ("npc_office_lead", "qiansha", "代码评审时遇见的职场前辈", "colleague"),
    ("npc_dorm_aunt", "shuli", "晚归要登记的宿管", "acquaintance"),
    ("npc_dorm_aunt", "fengyin", "偶尔代签到的同住义妹", "acquaintance"),
    ("npc_flower_supplier", "aili", "压账单也留好枝的花市供应", "acquaintance"),
    ("npc_flower_supplier", "aichen", "帮姐姐核进货单的闺蜜", "acquaintance"),
    ("npc_dance_coach", "qingcai", "镜房里不许偷懒的教练", "mentor"),
    ("npc_idol_manager", "taotao", "盯通告与作息的经纪人", "mentor"),
    ("npc_neighbor_couple", "xiaoyou", "对门会帮忙应门铃的邻居", "neighbor"),
    ("npc_neighbor_couple", "youwei", "画室灯通宵时会唠叨的邻居", "neighbor"),
]


def main() -> None:
    town = json.loads((DATA / "town_npcs.json").read_text(encoding="utf-8"))
    # remap bookstore -> library for location field consistency
    for n in town["npcs"]:
        if n.get("location") == "bookstore":
            n["location"] = "library"
    (DATA / "town_npcs.json").write_text(
        json.dumps(town, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    sg = json.loads((DATA / "social_graph.json").read_text(encoding="utf-8"))
    for loc in sg.get("locations") or []:
        lid = loc.get("id")
        if lid in LOC_NPC:
            loc["npc_ids"] = list(LOC_NPC[lid])
        else:
            loc.setdefault("npc_ids", [])

    edges = sg.setdefault("edges", [])
    existing = {(e.get("a"), e.get("b"), e.get("kind")) for e in edges}
    added = 0
    for a, b, rel, kind in EDGE_SPECS:
        key = (a, b, "town")
        # use kind town for all town edges to distinguish
        if (a, b, "town") in existing or (a, b, kind) in existing:
            continue
        edges.append(
            {
                "a": a,
                "b": b,
                "relation": rel,
                "secret": False,
                "kind": "town",
            }
        )
        existing.add((a, b, "town"))
        added += 1

    pc = sg.setdefault("pc", {})
    pc["npc_note"] = (
        "有名镇民见 town_npcs.json：共享土壤，不可攻略、无结局；"
        "路人立绘仍可作 _background 装饰。"
    )
    pc["summary"] = (
        "沈予安：为工作落脚小镇的职员。父母早年离异重组；亲妹妹沈书璃同城念书，义妹沈枫音同住。"
        "工作日去公司，周末在咖啡店、书店与校园之间晃。恋爱可发生在女主线与关系向难攻略线；"
        "关系向须经锚点认识并过闸门。镇上有名店主、前辈、宿管等镇民只作生活土壤与传闻，不可攻略。"
    )

    (DATA / "social_graph.json").write_text(
        json.dumps(sg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"social_graph: npc edges added={added}")

    routes = json.loads((DATA / "story_routes.json").read_text(encoding="utf-8"))
    routes["npc_policy"] = {
        "ids": [n["id"] for n in town["npcs"]],
        "allowed_endings": [],
        "story_branches": False,
        "note": "有名镇民=背景土壤，不可攻略；不参与结局与分支。旁白/world_facts 可点名。",
    }
    (DATA / "story_routes.json").write_text(
        json.dumps(routes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("story_routes npc_policy updated")

    cat = json.loads((DATA / "sprite_catalog.json").read_text(encoding="utf-8"))
    cat["note"] = (
        "玩法 romance + linked（关系向难攻略）；有名镇民见 town_npcs（不可攻略）。"
        "正式立绘目录可暂留 sprites/neutral/{id}。"
    )
    if isinstance(cat.get("notes"), dict):
        pass
    live = cat.get("live") or cat.get("npc_live")
    # update nested note fields if present
    for key in ("npc_live",):
        if key in cat and isinstance(cat[key], str):
            cat[key] = "有名镇民可点名；立绘优先 quarantine/background，本阶段不强制新出图。"
    # structure may use pools
    if "pools" in cat and isinstance(cat["pools"], dict):
        for pk, pv in cat["pools"].items():
            if isinstance(pv, dict) and "label" in pv and "romance×18" in str(pv.get("label")):
                pv["label"] = str(pv["label"]).replace("romance×18", "romance 女主")
    (DATA / "sprite_catalog.json").write_text(
        json.dumps(cat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("sprite_catalog note updated")


if __name__ == "__main__":
    main()
