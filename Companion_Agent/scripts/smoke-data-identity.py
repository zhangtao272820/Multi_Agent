"""Verify romance/neutral/npc identity catalogs have no contradictions."""

from __future__ import annotations

import json
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data"


def load(name: str):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def main() -> int:
    mr = load("model_roles.json")
    routes = {r["character_id"]: r for r in load("route_catalog.json")["routes"]}
    social = load("social_graph.json")["characters"]
    weights = load("cast_weights.json").get("characters") or {}
    policy = load("romance_policy.json").get("characters") or {}
    errors: list[str] = []

    chars = {}
    for base in mr["bases"]:
        for ch in base.get("characters") or []:
            chars[ch["id"]] = (base["id"], ch)

    # 现行 SSOT：romance×16 + linked×6 + npc×0 = 22（`moran` 已删；路人立绘为无名背景）
    if len(chars) != 22:
        errors.append(f"model_roles characters={len(chars)} want 22")
    if len(social) != 22:
        errors.append(f"social_graph characters={len(social)} want 22")
    if len(routes) != 22:
        errors.append(f"route_catalog routes={len(routes)} want 22")

    romance = [cid for cid, s in social.items() if s.get("cast_kind") == "romance"]
    linked = [cid for cid, s in social.items() if s.get("cast_kind") == "linked"]
    neutral = [cid for cid, s in social.items() if s.get("cast_kind") == "neutral"]
    npc = [cid for cid, s in social.items() if s.get("cast_kind") == "npc"]
    if len(romance) != 16 or len(linked) != 6 or len(neutral) != 0 or len(npc) != 0:
        errors.append(
            f"cast counts romance={len(romance)} linked={len(linked)} "
            f"neutral={len(neutral)} npc={len(npc)}"
        )
    for banned in ("moxi", "luli", "moran"):
        if banned in social or banned in chars or banned in routes:
            errors.append(f"{banned}: still registered as playable cast")

    for cid, s in social.items():
        if cid not in routes:
            errors.append(f"{cid}: missing route")
            continue
        if cid not in chars:
            errors.append(f"{cid}: missing model_roles")
            continue
        base_id, ch = chars[cid]
        rt = routes[cid]
        prof = ch.get("profile") or {}
        emb = ch.get("route") or {}

        if s.get("cast_kind") != rt.get("cast_role"):
            errors.append(f"{cid}: cast_kind={s.get('cast_kind')} != cast_role={rt.get('cast_role')}")
        if s.get("base_id") != rt.get("base_id") or s.get("base_id") != base_id:
            errors.append(f"{cid}: base_id mismatch social/route/model")
        if (prof.get("relationship") or "") != (s.get("role_to_pc") or ""):
            errors.append(
                f"{cid}: relationship={prof.get('relationship')!r} != role_to_pc={s.get('role_to_pc')!r}"
            )
        if (prof.get("occupation") or "") != (s.get("occupation") or ""):
            errors.append(
                f"{cid}: occupation profile={prof.get('occupation')!r} social={s.get('occupation')!r}"
            )
        if emb.get("allowed_endings") != rt.get("allowed_endings"):
            errors.append(f"{cid}: model_roles.route.allowed_endings drift")
        if emb.get("max_stage_id") != rt.get("max_stage_id"):
            errors.append(f"{cid}: model_roles.route.max_stage drift")
        if emb.get("route_label") != rt.get("route_label"):
            errors.append(f"{cid}: route_label drift")

        kind = s.get("cast_kind")
        if kind == "romance":
            if rt.get("max_stage_id") != "married":
                errors.append(f"{cid}: romance max_stage != married")
            if cid not in weights:
                errors.append(f"{cid}: missing cast_weights")
            elif weights[cid].get("name") != prof.get("name"):
                errors.append(
                    f"{cid}: weight name={weights[cid].get('name')!r} != {prof.get('name')!r}"
                )
            if cid not in policy:
                errors.append(f"{cid}: missing romance_policy")
        elif kind == "linked":
            if rt.get("max_stage_id") != "married":
                errors.append(f"{cid}: linked max_stage != married")
            if cid not in weights:
                errors.append(f"{cid}: missing cast_weights")
            else:
                w = weights[cid]
                if w.get("name") != prof.get("name"):
                    errors.append(
                        f"{cid}: weight name={w.get('name')!r} != {prof.get('name')!r}"
                    )
                tier = w.get("tier")
                if cid == "shuli":
                    if tier != "L0":
                        errors.append(f"{cid}: cast_weights.tier={tier!r} want L0")
                elif tier != "N":
                    errors.append(f"{cid}: cast_weights.tier={tier!r} want N")
            if cid in policy:
                errors.append(f"{cid}: linked should not be in romance_policy")
        elif kind == "neutral":
            errors.append(f"{cid}: cast_kind=neutral 已废弃，应改为 linked")
        else:
            if rt.get("max_stage_id") != "close_friend":
                errors.append(f"{cid}: {kind} max_stage != close_friend")
            if cid in weights:
                errors.append(f"{cid}: {kind} should not be in cast_weights")
            if cid in policy:
                errors.append(f"{cid}: {kind} should not be in romance_policy")

    # N 戏份须高于 T2（presence / weekly_focus）
    t2_ids = [cid for cid, w in weights.items() if w.get("tier") == "T2"]
    n_ids = [cid for cid, w in weights.items() if w.get("tier") == "N"]
    if t2_ids and n_ids:
        t2_pres = min(int(weights[c].get("presence") or 0) for c in t2_ids)
        n_pres = min(int(weights[c].get("presence") or 0) for c in n_ids)
        t2_focus = min(int(weights[c].get("weekly_focus") or 0) for c in t2_ids)
        n_focus = min(int(weights[c].get("weekly_focus") or 0) for c in n_ids)
        if n_pres <= t2_pres:
            errors.append(f"N min presence {n_pres} should be > T2 min {t2_pres}")
        if n_focus <= t2_focus:
            errors.append(f"N min weekly_focus {n_focus} should be > T2 min {t2_focus}")

    if "miara" in social and social["miara"].get("role_to_pc") != "漫展偶遇的人":
        errors.append("miara role_to_pc not unified")

    if errors:
        print("FAIL identity align")
        for e in errors:
            print(" -", e)
        return 1
    print(
        f"OK identity align: romance={len(romance)} linked={len(linked)} npc={len(npc)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
