"""Classmate sprite gallery payload (browse / unlock by acquaintance)."""

from __future__ import annotations

import re
from typing import Any

from . import catalog
from . import relationship as rel
from . import sprites as sprites_mod
from .campus_store import CampusSave, store

_STAGE_LABEL_CN = {
    "stranger": "陌生",
    "acquaintance": "相识",
    "friend": "朋友",
    "close": "亲近",
    "crush": "心动",
    "dating": "约会中",
}

_STAND_EMO_RE = re.compile(r"^summer_stand_([a-z]+)\.png$", re.I)
_FILE_RE = re.compile(
    r"^(?P<outfit>summer|winter|casual|pajama|towel|end)_(?P<action>[a-z0-9_]+)_(?P<emotion>[a-z]+)\.png$",
    re.I,
)
# W7 binary: intimate_selfie_slip_shy.png / pr_intimate_selfie_sofa_love.png
_SELFIE_RE = re.compile(
    r"^(?P<pr>pr_)?intimate_selfie_(?P<slot>[a-z0-9]+)_(?P<emotion>[a-z]+)\.png$",
    re.I,
)
_ACQUAINTANCE_IDX = rel.STAGE_ORDER.index("acquaintance")
_FRIEND_IDX = rel.STAGE_ORDER.index("friend")
_CLOSE_IDX = rel.STAGE_ORDER.index("close")
_CRUSH_IDX = rel.STAGE_ORDER.index("crush")

_ALBUM_LABELS = {
    "summer": "夏装",
    "winter": "冬装",
    "scene": "校园场景",
    "signature": "个性签名",
    "date": "约会",
    "private": "宿舍私密",
    "intimate_selfie": "私密·自拍",
    "pr_intimate_selfie": "私密·自拍·半写实",
    "end": "结局",
}


def _is_met(stage: str) -> bool:
    try:
        return rel.STAGE_ORDER.index(stage) >= _ACQUAINTANCE_IDX
    except ValueError:
        return False


def _stage_idx(stage: str) -> int:
    try:
        return rel.STAGE_ORDER.index(stage)
    except ValueError:
        return 0


def _resolve_save(save_id: str | None) -> CampusSave | None:
    if save_id:
        try:
            return store.peek_save(save_id)
        except LookupError:
            return None
    if store.active is not None:
        return store.active
    return store.latest_save()


def _available_emotions(student_id: str) -> list[str]:
    emos: list[str] = []
    seen: set[str] = set()
    for name in sprites_mod.list_student_files(student_id):
        m = _STAND_EMO_RE.match(name)
        if not m:
            continue
        emo = m.group(1).lower()
        if emo in seen:
            continue
        seen.add(emo)
        emos.append(emo)
    if "neutral" not in seen:
        emos.insert(0, "neutral")
    elif emos and emos[0] != "neutral":
        emos = ["neutral"] + [e for e in emos if e != "neutral"]
    return emos


def _album_id_for(outfit: str, action: str) -> str | None:
    if outfit == "end" or action.startswith("end_"):
        return "end"
    if action.startswith("sig_"):
        return "signature"
    if action.startswith("date_"):
        return "date"
    if action.startswith("sc_"):
        return "scene"
    if outfit in {"casual", "pajama", "towel"}:
        return "private"
    if outfit == "winter":
        return "winter"
    if outfit == "summer":
        return "summer"
    return None


def _album_unlocked(album_id: str, stage: str) -> bool:
    """Relationship gate for deep browse (T0–T2 thickness; thin tiers still list what exists)."""
    idx = _stage_idx(stage)
    if album_id == "summer":
        return idx >= _ACQUAINTANCE_IDX
    if album_id in {"scene", "date"}:
        return idx >= _FRIEND_IDX
    if album_id in {"winter", "signature"}:
        return idx >= _CLOSE_IDX
    if album_id in {"private", "intimate_selfie", "pr_intimate_selfie", "end"}:
        return idx >= _CRUSH_IDX
    return False


def _build_albums(student_id: str, stage: str, *, met: bool) -> list[dict[str, Any]]:
    if not met:
        return []
    buckets: dict[str, list[dict[str, Any]]] = {k: [] for k in _ALBUM_LABELS}
    root = sprites_mod.sprites_root() / student_id
    for name in sprites_mod.list_student_files(student_id):
        if name.startswith("_") or name.startswith("q_"):
            continue
        path = root / name
        sm = _SELFIE_RE.match(name)
        if sm:
            slot = sm.group("slot").lower()
            emotion = sm.group("emotion").lower()
            is_pr = bool(sm.group("pr"))
            album_id = "pr_intimate_selfie" if is_pr else "intimate_selfie"
            outfit = f"{'pr_' if is_pr else ''}intimate_selfie_{slot}"
            ref = sprites_mod._asset_ref(student_id, path, primary=path, kind="sprite")
            buckets[album_id].append(
                {
                    "file": name,
                    "path": ref.get("path"),
                    "outfit": outfit,
                    "action": "selfie",
                    "emotion": emotion,
                    "label": f"{slot}/{emotion}",
                }
            )
            continue
        m = _FILE_RE.match(name)
        if not m:
            continue
        outfit = m.group("outfit").lower()
        action = m.group("action").lower()
        emotion = m.group("emotion").lower()
        album_id = _album_id_for(outfit, action)
        if not album_id:
            continue
        ref = sprites_mod._asset_ref(student_id, path, primary=path, kind="sprite")
        buckets[album_id].append(
            {
                "file": name,
                "path": ref.get("path"),
                "outfit": outfit,
                "action": action,
                "emotion": emotion,
                "label": f"{action}/{emotion}",
            }
        )

    albums: list[dict[str, Any]] = []
    for album_id, label in _ALBUM_LABELS.items():
        items = buckets.get(album_id) or []
        if not items and album_id not in {"summer"}:
            # Still expose empty locked albums for T0–T2 variety roadmap awareness? Keep only non-empty.
            continue
        unlocked = _album_unlocked(album_id, stage)
        albums.append(
            {
                "id": album_id,
                "label": label,
                "unlocked": unlocked,
                "count": len(items) if unlocked else 0,
                "items": items if unlocked else [],
            }
        )
    return albums


def build_gallery_payload(*, save_id: str | None = None) -> dict[str, Any]:
    roster = catalog.class_roster()
    save = _resolve_save(save_id)
    edges = list(save.edges) if save else []
    source_save_id = save.save_id if save else None

    characters: list[dict[str, Any]] = []
    for s in roster.get("students") or []:
        if not isinstance(s, dict):
            continue
        if s.get("is_pc_slot") or str(s.get("id") or "") == "pc":
            continue
        sid = str(s.get("id") or "")
        if not sid:
            continue

        stage = "stranger"
        affinity = 0.0
        if save:
            edge = rel.find_edge(edges, "pc", sid)
            if edge:
                stage = str(edge.get("stage") or "stranger")
                affinity = float(edge.get("affinity") or 0)
        met = _is_met(stage)

        emotions = _available_emotions(sid)
        thumb = sprites_mod.resolve_q_sprite(sid, emotion="neutral")
        default_sprite = None
        if met:
            ref = sprites_mod.resolve_student_sprite(sid, emotion="neutral")
            if ref.get("path"):
                default_sprite = ref
            # Prefer Q thumb only when unlocked; locked cards stay silhouette
            if not thumb.get("path"):
                thumb = {"path": None, "file": None, "fallback": True, "kind": "q"}
        else:
            thumb = {"path": None, "file": None, "fallback": True, "kind": "q", "locked": True}

        albums = _build_albums(sid, stage, met=met) if met else []

        characters.append(
            {
                "id": sid,
                "name": str(s.get("name") or sid),
                "gender": s.get("gender"),
                "mbti": s.get("mbti"),
                "beauty_tier": s.get("beauty_tier"),
                "met": met,
                "stage": stage,
                "stage_label": _STAGE_LABEL_CN.get(stage, stage),
                "affinity": round(affinity, 1) if met else None,
                "emotions": emotions if met else ["neutral"],
                "thumb": thumb,
                "default_sprite": default_sprite,
                "albums": albums,
                "signature_plan": list(s.get("signature_plan") or []) if met else [],
            }
        )

    met_count = sum(1 for c in characters if c.get("met"))
    return {
        "class_name": roster.get("class_name") or "",
        "class_id": roster.get("class_id") or "",
        "save_id": source_save_id,
        "characters": characters,
        "total": len(characters),
        "met_count": met_count,
    }
