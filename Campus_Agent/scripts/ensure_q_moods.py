#!/usr/bin/env python3
"""Ensure q_stand_happy / q_stand_shy exist (copy from mood stand or neutral Q)."""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPRITES = ROOT / "data" / "sprites" / "students"
MOODS = ("happy", "shy")


def ensure_q(student_dir: Path) -> list[str]:
    done: list[str] = []
    neutral = student_dir / "q_stand_neutral.png"
    for mood in MOODS:
        dest = student_dir / f"q_stand_{mood}.png"
        if dest.is_file():
            continue
        # Prefer realistic stand mood cropped feel → just copy stand as soft Q fallback
        for cand in (
            student_dir / f"summer_stand_{mood}.png",
            student_dir / f"q_stand_neutral.png",
            student_dir / "_identity_neutral.png",
        ):
            if cand.is_file():
                shutil.copy2(cand, dest)
                done.append(dest.name)
                break
        if not dest.is_file() and neutral.is_file():
            shutil.copy2(neutral, dest)
            done.append(dest.name)
    return done


def main() -> int:
    n = 0
    for d in sorted(SPRITES.iterdir()):
        if not d.is_dir():
            continue
        created = ensure_q(d)
        if created:
            print(d.name, ",".join(created))
            n += len(created)
    print(f"created={n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
