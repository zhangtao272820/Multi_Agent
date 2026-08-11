"""开局 / 结局演出 catalog。"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import PROJECT_ROOT

_EMOTION_PREF = ("love", "shy", "happy", "neutral", "sad")
_OUTFIT_FALLBACK = (
    "end_lingerie_set",
    "end_robe_open",
    "end_deep_v",
    "end_close_embrace",
    "max_slit_gown",
    "max_sofa_lie",
    "date",
    "casual",
    "home",
    "work",
)
# 婚后日常/怀孕等：点名后优先居家链，禁止先抢 end_* / max_*
_DOMESTIC_OUTFITS = frozenset({"maternity", "bridal", "home", "casual", "date", "work"})
_DOMESTIC_FALLBACK = ("maternity", "bridal", "home", "casual", "date", "work", "")


def _path() -> Path:
    return PROJECT_ROOT / "data" / "presentation_catalog.json"


@lru_cache(maxsize=1)
def load_presentation_catalog() -> dict[str, Any]:
    path = _path()
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def reload_presentation_catalog() -> None:
    load_presentation_catalog.cache_clear()
    _ending_outfits_on_disk.cache_clear()


def public_presentation() -> dict[str, Any]:
    return load_presentation_catalog()


def _sprite_png_exists(character_id: str, outfit: str, emotion: str) -> bool:
    from .sprite_catalog import resolve_sprite_file

    cid = (character_id or "").strip()
    emo = (emotion or "neutral").strip().lower() or "neutral"
    outfit_id = (outfit or "").strip()
    name = f"{outfit_id}_{emo}.png" if outfit_id else f"{emo}.png"
    return resolve_sprite_file(cid, name) is not None


@lru_cache(maxsize=64)
def _ending_outfits_on_disk(character_id: str) -> tuple[str, ...]:
    """该角磁盘上已有的 end_* / max_* / 基础档前缀（供结局回退）。"""
    from .sprite_catalog import resolve_sprite_dir

    folder = resolve_sprite_dir(character_id)
    if not folder or not folder.is_dir():
        return ()
    found: set[str] = set()
    for path in folder.glob("*.png"):
        stem = path.stem
        if stem.startswith("avatar") or stem.startswith("menu_"):
            continue
        matched = False
        for emo in _EMOTION_PREF:
            suf = "_" + emo
            if stem.endswith(suf):
                found.add(stem[: -len(suf)])
                matched = True
                break
        if not matched and stem in _EMOTION_PREF:
            continue
        if not matched:
            found.add(stem)
    return tuple(sorted(found))


def resolve_ending_sprite(
    *,
    character_id: str,
    outfit: str = "",
    emotion: str = "",
    default_emotion: str = "happy",
) -> dict[str, str]:
    """将 catalog 愿景落到磁盘真实存在的 outfit+emotion。"""
    cid = (character_id or "").strip()
    preferred_outfit = (outfit or "").strip()
    preferred_emotion = (emotion or default_emotion or "happy").strip().lower() or "happy"
    if not cid:
        return {"character_id": "", "outfit": preferred_outfit, "emotion": preferred_emotion}

    have = set(_ending_outfits_on_disk(cid))
    outfit_candidates: list[str] = []
    if preferred_outfit:
        outfit_candidates.append(preferred_outfit)

    domestic = preferred_outfit in _DOMESTIC_OUTFITS
    if domestic:
        for key in _DOMESTIC_FALLBACK:
            if key not in outfit_candidates:
                outfit_candidates.append(key)
        for key in _OUTFIT_FALLBACK:
            if key not in outfit_candidates:
                outfit_candidates.append(key)
    else:
        for key in _OUTFIT_FALLBACK:
            if key not in outfit_candidates:
                outfit_candidates.append(key)
    # 其余 end_* / max_* 也参与候选（保持仪式感）；domestic 时排在居家链之后
    for key in sorted(have):
        if key.startswith(("end_", "max_")) and key not in outfit_candidates:
            outfit_candidates.append(key)
    for key in ("date", "casual", "home", "work", ""):
        if key not in outfit_candidates:
            outfit_candidates.append(key)

    emotion_candidates: list[str] = []
    for emo in (preferred_emotion, *_EMOTION_PREF):
        if emo and emo not in emotion_candidates:
            emotion_candidates.append(emo)

    for outfit_id in outfit_candidates:
        for emo in emotion_candidates:
            if _sprite_png_exists(cid, outfit_id, emo):
                return {"character_id": cid, "outfit": outfit_id, "emotion": emo}

    return {"character_id": cid, "outfit": "", "emotion": "neutral"}


def resolve_ending_presentation(
    ending_id: str,
    *,
    ending_type: str = "good",
    character_id: str = "",
) -> dict[str, Any]:
    cat = load_presentation_catalog()
    specific = (cat.get("endings") or {}).get(ending_id) or {}
    defaults = (cat.get("ending_type_defaults") or {}).get(ending_type) or {}
    sprite = dict(specific.get("sprite") or {})
    cid = str(sprite.get("character_id") or character_id or "").strip()
    default_emotion = str(defaults.get("emotion") or "happy")
    if not sprite and cid:
        sprite = {
            "character_id": cid,
            "outfit": "casual",
            "emotion": default_emotion,
        }
    elif sprite and not sprite.get("emotion"):
        sprite = {**sprite, "emotion": default_emotion}

    resolved = resolve_ending_sprite(
        character_id=cid or str(sprite.get("character_id") or ""),
        outfit=str(sprite.get("outfit") or ""),
        emotion=str(sprite.get("emotion") or default_emotion),
        default_emotion=default_emotion,
    )

    pages = specific.get("pages")
    if not isinstance(pages, list):
        pages = []
    pages = [str(p).strip() for p in pages if str(p).strip()]
    return {
        "bg": specific.get("bg") or defaults.get("bg") or "campus.png",
        "bgm": specific.get("bgm") or defaults.get("bgm") or "ending_good",
        "sprite": resolved,
        "pages": pages,
    }
