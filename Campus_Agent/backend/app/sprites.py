"""Sprite / BG path resolution with fallbacks.

Q-version (`q_*`) is for map / seats / face rails / Talk mood strip —
not the Gal full-body primary (realistic stand remains talk hero).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import data_dir

# Q emotions kept small; missing moods fall back to q_stand_neutral then realistic stand.
Q_EMOTIONS = frozenset({"neutral", "happy", "shy", "sad", "angry"})


def sprites_root() -> Path:
    return data_dir() / "sprites" / "students"


def bgs_root() -> Path:
    return data_dir() / "bgs"


def _exists(path: Path) -> bool:
    try:
        return path.is_file()
    except OSError:
        return False


def _asset_ref(student_id: str, path: Path, *, primary: Path, kind: str = "sprite") -> dict[str, Any]:
    rel = path.relative_to(data_dir()).as_posix()
    return {
        "student_id": student_id,
        "path": f"/api/campus/assets/{rel}",
        "file": path.name,
        "fallback": path != primary,
        "kind": kind,
    }


def resolve_student_sprite(
    student_id: str,
    *,
    outfit: str = "summer",
    action: str = "stand",
    emotion: str = "neutral",
) -> dict[str, Any]:
    """Resolve realistic stand art. Fallback: outfit_stand → identity → none.

    Missing summer_stand can be filled from identity via scripts/link_identity_as_stand.py.
    """
    root = sprites_root() / student_id
    primary = root / f"{outfit}_{action}_{emotion}.png"
    candidates = [
        primary,
        root / f"{outfit}_stand_{emotion}.png",
        root / f"{outfit}_stand_neutral.png",
        root / "_identity_neutral.png",
        root / "neutral.png",
    ]
    for c in candidates:
        if _exists(c):
            return _asset_ref(student_id, c, primary=primary, kind="sprite")
    return {
        "student_id": student_id,
        "path": None,
        "file": None,
        "fallback": True,
        "kind": "sprite",
    }


def resolve_q_sprite(
    student_id: str,
    *,
    emotion: str = "neutral",
    action: str = "stand",
) -> dict[str, Any]:
    """Chibi / Q portrait for info layer (map pins, seats, selection rail).

    Naming: `q_{action}_{emotion}.png` (e.g. q_stand_neutral.png).
    Falls back to realistic stand sprite so UI never blocks on missing Q art.
    """
    emo = emotion if emotion in Q_EMOTIONS else "neutral"
    root = sprites_root() / student_id
    primary = root / f"q_{action}_{emo}.png"
    candidates = [
        primary,
        root / f"q_stand_{emo}.png",
        root / "q_stand_neutral.png",
        root / "q_neutral.png",
    ]
    for c in candidates:
        if _exists(c):
            return _asset_ref(student_id, c, primary=primary, kind="q")
    # Soft fallback: realistic stand (UI scales it as chip) — marked fallback
    stand = resolve_student_sprite(student_id, emotion=emo)
    stand["kind"] = "q"
    stand["fallback"] = True
    return stand


def resolve_bg(location_id: str, weather_id: str | None = None) -> dict[str, Any]:
    root = bgs_root()
    candidates: list[Path] = []
    if weather_id:
        candidates.append(root / f"{location_id}_{weather_id}.png")
    candidates.append(root / f"{location_id}.png")
    candidates.append(root / "default.png")
    for c in candidates:
        if _exists(c):
            rel = c.relative_to(data_dir()).as_posix()
            return {"path": f"/api/campus/assets/{rel}", "file": c.name, "fallback": False}
    return {"path": None, "file": None, "fallback": True}


def resolve_ending_sprite(
    student_id: str,
    *,
    emotion: str = "happy",
    verdict: str | None = None,
) -> dict[str, Any]:
    """Romance ending hero art: prefer end_* ritual sprites, else happy stand.

    Naming: end_stand_{emotion}.png (not in daily resolve chain).
    """
    emo = emotion if emotion in Q_EMOTIONS else "happy"
    # Soft/bad lean shy or sad when present
    order = [emo]
    if verdict in {"soft", "bad"} and "shy" not in order:
        order.append("shy")
    if verdict == "bad" and "sad" not in order:
        order.append("sad")
    if "happy" not in order:
        order.append("happy")
    if "neutral" not in order:
        order.append("neutral")

    root = sprites_root() / student_id
    for e in order:
        primary = root / f"end_stand_{e}.png"
        if _exists(primary):
            ref = _asset_ref(student_id, primary, primary=primary, kind="ending")
            ref["outfit"] = "end"
            ref["action"] = "stand"
            ref["emotion"] = e
            return ref
    # Fallback: daily stand (marked fallback so UI/audit can tell)
    stand = resolve_student_sprite(student_id, emotion=order[0])
    stand["kind"] = "ending"
    stand["fallback"] = True
    stand["outfit"] = stand.get("outfit") or "summer"
    stand["action"] = "stand"
    stand["emotion"] = order[0]
    return stand


def list_student_files(student_id: str) -> list[str]:
    root = sprites_root() / student_id
    if not root.is_dir():
        return []
    return sorted(p.name for p in root.glob("*.png"))
