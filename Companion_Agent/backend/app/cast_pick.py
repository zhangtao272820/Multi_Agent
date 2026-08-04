"""立绘大全 / 选角草稿 / 应用 cast_kind。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .character import load_character_bases
from .config import PROJECT_ROOT
from .social_graph import load_social_graph, reload_social_graph

# 当前有高质量情绪基图的角色数 = 可攻略主角人数
MAIN_TARGET = 18


def _sprites_root() -> Path:
    return PROJECT_ROOT / "data" / "sprites"


def _draft_path() -> Path:
    return PROJECT_ROOT / "data" / "cast_pick_draft.json"


def _social_path() -> Path:
    return PROJECT_ROOT / "data" / "social_graph.json"


def list_emotions_for(character_id: str) -> list[str]:
    from .sprite_catalog import resolve_sprite_dir

    folder = resolve_sprite_dir(character_id)
    if not folder or not folder.is_dir():
        return []
    # 只列情绪基图名（无下划线），避免换装刷爆画廊
    emos = []
    for p in folder.glob("*.png"):
        if "_" not in p.stem:
            emos.append(p.stem)
    preferred = ("neutral", "happy", "shy", "sad", "angry", "love", "surprised", "sarcastic")
    rank = {e: i for i, e in enumerate(preferred)}
    return sorted(emos, key=lambda e: (rank.get(e, 99), e))


def list_outfits_for(character_id: str) -> list[str]:
    """磁盘上已有的换装前缀（含 signature / season / state 复合键）。"""
    from .sprite_outfit import available_outfits

    outfits = sorted(available_outfits(character_id))
    # 常用基础档靠前，便于大全默认浏览
    priority = ("casual", "home", "work", "school", "date", "rain")
    rank = {o: i for i, o in enumerate(priority)}
    return sorted(outfits, key=lambda o: (rank.get(o, 50), o))


def build_gallery_payload(
    *,
    save_id: str = "",
    user_id: str = "",
    mode: str = "pick",
) -> dict[str, Any]:
    from .sprite_unlock import enrich_character_gallery
    from .world_store import get_world_save

    graph = load_social_graph()
    draft = load_cast_pick_draft()
    picks = draft.get("picks") or {}
    mode_n = (mode or "pick").strip().lower()
    if mode_n not in {"browse", "pick"}:
        mode_n = "pick"
    save = None
    if save_id:
        save = get_world_save(save_id)
        if save and user_id and save.user_id != user_id:
            save = None
    characters: list[dict[str, Any]] = []
    for base in load_character_bases():
        base_id = str(base.get("id") or "")
        for row in base.get("characters") or []:
            cid = str(row.get("id") or "")
            social = graph.characters.get(cid)
            profile = row.get("profile") or {}
            pick = picks.get(cid) or {}
            emotions = list_emotions_for(cid)
            outfits = list_outfits_for(cid)
            entry = {
                "character_id": cid,
                "name": profile.get("name") or row.get("label") or cid,
                "base_id": base_id,
                "base_label": base.get("label") or base_id,
                "theme_color": base.get("theme_color") or profile.get("theme_color") or "#f472b6",
                "cast_kind": (social.cast_kind if social else "romance"),
                "role_to_pc": social.role_to_pc if social else "",
                "role_hint": social.role_hint if social else "",
                "appearance": profile.get("appearance") or "",
                "emotions": emotions,
                "outfits": outfits,
                "thumb": f"/api/sprites/{cid}/neutral.png" if "neutral" in emotions else (
                    f"/api/sprites/{cid}/{emotions[0]}.png" if emotions else ""
                ),
                "pick": pick.get("kind") or (social.cast_kind if social else "romance"),
                "note": pick.get("note") or "",
            }
            bond = save.bonds.get(cid) if save else None
            entry = enrich_character_gallery(entry, bond, save=save, mode=mode_n)
            characters.append(entry)
    # normalize: UI uses romance for main
    main_count = sum(1 for c in characters if c["pick"] in {"romance", "main_candidate"})
    return {
        "characters": characters,
        "main_count": main_count,
        "main_target": MAIN_TARGET,
        "draft_updated_at": draft.get("updated_at") or "",
        "applied": bool(draft.get("applied")),
        "mode": mode_n,
        "save_id": save.save_id if save else "",
    }


def load_cast_pick_draft() -> dict[str, Any]:
    path = _draft_path()
    if not path.is_file():
        return {"version": 1, "picks": {}, "updated_at": "", "applied": False}
    return json.loads(path.read_text(encoding="utf-8"))


def save_cast_pick_draft(picks: dict[str, Any]) -> dict[str, Any]:
    from datetime import datetime, timezone

    # normalize kinds
    normalized: dict[str, Any] = {}
    for cid, row in (picks or {}).items():
        if isinstance(row, str):
            kind = row
            note = ""
        else:
            kind = str((row or {}).get("kind") or "neutral")
            note = str((row or {}).get("note") or "")
        if kind == "main_candidate":
            kind = "romance"
        if kind not in {"romance", "neutral", "npc"}:
            kind = "neutral"
        normalized[str(cid)] = {"kind": kind, "note": note}

    main_n = sum(1 for v in normalized.values() if v["kind"] == "romance")
    if main_n > MAIN_TARGET:
        raise ValueError(f"主候选不能超过 {MAIN_TARGET} 人（当前 {main_n}）")

    draft = {
        "version": 1,
        "picks": normalized,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "applied": False,
        "main_count": main_n,
        "main_target": MAIN_TARGET,
    }
    _draft_path().write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")
    return draft


def apply_cast_pick_to_social_graph() -> dict[str, Any]:
    """将 draft 写入 social_graph.json cast_kind；不改动任何立绘文件。"""
    draft = load_cast_pick_draft()
    picks = draft.get("picks") or {}
    if not picks:
        raise ValueError("草稿为空，请先在立绘大全中标记选角")
    main_n = sum(1 for v in picks.values() if (v.get("kind") if isinstance(v, dict) else v) == "romance")
    if main_n != MAIN_TARGET:
        raise ValueError(f"应用前请刚好标记 {MAIN_TARGET} 名主候选（当前 {main_n}）")

    path = _social_path()
    raw = json.loads(path.read_text(encoding="utf-8"))
    chars = raw.get("characters") or {}
    changed: list[str] = []
    for cid, row in picks.items():
        kind = row.get("kind") if isinstance(row, dict) else row
        if cid not in chars:
            continue
        old = chars[cid].get("cast_kind")
        chars[cid]["cast_kind"] = kind
        if old != kind:
            changed.append(f"{cid}:{old}->{kind}")
    raw["characters"] = chars
    path.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    reload_social_graph()

    draft["applied"] = True
    _draft_path().write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "changed": changed, "main_count": main_n}
