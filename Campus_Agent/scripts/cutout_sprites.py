#!/usr/bin/env python3
"""Batch-cutout RGB sprites to RGBA for Gal overlay.

Backs up originals to data/sprites_raw/, writes cutouts to data/sprites/.
Idempotent: skips files that already look like cutouts (RGBA + transparent corners).
Skips environment-interaction sprites (*_sc_* and private-pack env actions)
which keep baked-in scene backgrounds (see doc/archive/立绘生成纪律-升级.md G4).

Usage:
  python scripts/cutout_sprites.py
  python scripts/cutout_sprites.py --student f01
  python scripts/cutout_sprites.py --dry-run
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SPRITES = ROOT / "data" / "sprites" / "students"
SPRITES_RAW = ROOT / "data" / "sprites_raw" / "students"

# Skip if already RGBA and enough fully-transparent pixels near corners.
MIN_TRANSPARENT_RATIO = 0.02
CORNER_SAMPLE = 24


# Private-pack / dorm actions that bake in environment (G4): do not cut out.
_ENV_ACTION_MARKERS = (
    "_sit_bunk_",
    "_door_",
    "_lean_wall_",
    "_window_night_",
    "_bed_edge_",
    "_after_bath_",
    "_hug_pillow_",
)


def is_scene_interaction(path: Path) -> bool:
    """Environment-interaction sprites keep baked-in scene; do not cut out.

    - sc_* e.g. summer_sc_classroom_lean_neutral.png
    - private env e.g. casual_sit_bunk_neutral.png, towel_door_shy.png
    """
    name = path.name
    if "_sc_" in name:
        return True
    return any(m in name for m in _ENV_ACTION_MARKERS)


def _corner_transparent_ratio(im: Image.Image) -> float:
    rgba = im.convert("RGBA")
    w, h = rgba.size
    n = min(CORNER_SAMPLE, w // 4, h // 4)
    if n < 1:
        return 0.0
    regions = [
        (0, 0, n, n),
        (w - n, 0, w, n),
        (0, h - n, n, h),
        (w - n, h - n, w, h),
    ]
    transparent = 0
    total = 0
    for box in regions:
        crop = rgba.crop(box)
        data = crop.get_flattened_data() if hasattr(crop, "get_flattened_data") else crop.getdata()
        for px in data:
            total += 1
            if px[3] == 0:
                transparent += 1
    return transparent / total if total else 0.0


def already_cutout(path: Path) -> bool:
    try:
        with Image.open(path) as im:
            if im.mode not in ("RGBA", "LA") and not (
                im.mode == "P" and "transparency" in im.info
            ):
                return False
            return _corner_transparent_ratio(im) >= MIN_TRANSPARENT_RATIO
    except OSError:
        return False


def list_targets(
    student: str | None,
    *,
    name_contains: str | None = None,
    overlay_only: bool = False,
) -> list[Path]:
    if student:
        root = SPRITES / student
        if not root.is_dir():
            return []
        paths = sorted(root.glob("*.png"))
    else:
        paths = sorted(SPRITES.rglob("*.png"))
    if name_contains:
        needle = name_contains.lower()
        paths = [p for p in paths if needle in p.name.lower()]
    if overlay_only:
        keys = ("_stand_", "_chat_", "_study_", "q_stand_")
        paths = [p for p in paths if any(k in p.name for k in keys)]
    return paths


def cutout_one(src: Path, *, dry_run: bool, session) -> str:
    if is_scene_interaction(src):
        return "skip_sc"

    rel = src.relative_to(SPRITES)
    raw = SPRITES_RAW / rel

    if already_cutout(src):
        return "skip"

    if dry_run:
        return "would_cut"

    raw.parent.mkdir(parents=True, exist_ok=True)
    if not raw.is_file():
        shutil.copy2(src, raw)

    # Prefer raw backup as rembg input (stable if re-run after partial overwrite).
    input_path = raw if raw.is_file() else src
    with Image.open(input_path) as im:
        rgb = im.convert("RGB")
        out = session.remove(rgb)
        out = out.convert("RGBA")
        out.save(src, format="PNG", optimize=True)
    return "cut"


def main() -> int:
    parser = argparse.ArgumentParser(description="Cut out Campus_Agent student sprites to RGBA")
    parser.add_argument("--student", help="Only process one student id, e.g. f01")
    parser.add_argument(
        "--name-contains",
        help="Only files whose name contains this substring, e.g. summer_stand",
    )
    parser.add_argument(
        "--overlay-only",
        action="store_true",
        help="Only stand/chat/study/q_stand overlay layers (skip sc_* already skipped)",
    )
    parser.add_argument("--dry-run", action="store_true", help="List actions without writing")
    args = parser.parse_args()

    targets = list_targets(
        args.student,
        name_contains=args.name_contains,
        overlay_only=args.overlay_only,
    )
    if not targets:
        print("No PNG targets found.", file=sys.stderr)
        return 1

    cuttable = [p for p in targets if not is_scene_interaction(p)]
    skipped_sc = len(targets) - len(cuttable)
    print(
        f"Found {len(targets)} file(s) under {SPRITES} "
        f"({skipped_sc} sc_* skipped, {len(cuttable)} cuttable)"
    )

    if args.dry_run:
        for p in targets:
            if is_scene_interaction(p):
                status = "skip_sc"
            elif already_cutout(p):
                status = "skip"
            else:
                status = "would_cut"
            print(f"  [{status}] {p.relative_to(SPRITES)}")
        return 0

    try:
        from rembg import new_session, remove
    except ImportError:
        print(
            "rembg not installed. Run:\n"
            "  pip install -r scripts/requirements-cutout.txt",
            file=sys.stderr,
        )
        return 1

    # Human segmentation model suits full-body VN sprites.
    session = new_session("u2net_human_seg")

    class _Sess:
        def remove(self, img: Image.Image) -> Image.Image:
            return remove(img, session=session)

    wrap = _Sess()
    counts = {"cut": 0, "skip": 0, "skip_sc": 0, "err": 0}
    for i, path in enumerate(targets, 1):
        try:
            status = cutout_one(path, dry_run=False, session=wrap)
            counts[status] = counts.get(status, 0) + 1
            print(f"[{i}/{len(targets)}] {status}  {path.relative_to(SPRITES)}")
        except Exception as exc:  # noqa: BLE001 — batch must continue
            counts["err"] += 1
            print(f"[{i}/{len(targets)}] ERR   {path.relative_to(SPRITES)}: {exc}", file=sys.stderr)

    print(
        f"Done. cut={counts['cut']} skip={counts['skip']} "
        f"skip_sc={counts['skip_sc']} err={counts['err']}"
    )
    return 1 if counts["err"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
