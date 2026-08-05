#!/usr/bin/env python3
"""Generate weather BG variants + differentiate dorm clones + campus map plate.

Reads existing baseline PNGs under data/bgs/, writes tinted weather variants and
recolors dorm_* so file hashes diverge. Stdlib + Pillow.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "bgs"

WEATHER_LOCS = ("classroom", "hallway", "playground", "rooftop")
WEATHER_TINTS: dict[str, dict[str, float]] = {
    # colorize + brightness/contrast tweaks
    "sunny": {"brightness": 1.12, "contrast": 1.08, "color": 1.15, "blue": 0.92},
    "rainy": {"brightness": 0.78, "contrast": 1.05, "color": 0.75, "blue": 1.18},
    "cold": {"brightness": 0.88, "contrast": 1.02, "color": 0.85, "blue": 1.22},
}

DORM_SHIFTS: dict[str, tuple[int, int, int]] = {
    "dorm_f1": (18, -6, 8),
    "dorm_f2": (8, -12, 16),
    "dorm_f3": (-4, 6, 14),
    "dorm_f4": (12, 4, -8),
    "dorm_m1": (-10, 4, 18),
    "dorm_m2": (-16, 10, 8),
}


def _clamp(v: int) -> int:
    return max(0, min(255, v))


def _apply_weather(im: Image.Image, weather: str) -> Image.Image:
    cfg = WEATHER_TINTS[weather]
    out = im.convert("RGB")
    out = ImageEnhance.Brightness(out).enhance(cfg["brightness"])
    out = ImageEnhance.Contrast(out).enhance(cfg["contrast"])
    out = ImageEnhance.Color(out).enhance(cfg["color"])
    # channel bias toward cool/warm
    r, g, b = out.split()
    blue = cfg["blue"]
    if blue > 1.0:
        b = b.point(lambda x: _clamp(int(x * blue)))
        r = r.point(lambda x: _clamp(int(x * (2.0 - blue))))
    else:
        r = r.point(lambda x: _clamp(int(x * (1.0 + (1.0 - blue) * 0.4))))
        b = b.point(lambda x: _clamp(int(x * blue)))
    out = Image.merge("RGB", (r, g, b))
    if weather == "rainy":
        # soft vignette + slight blur for wet air
        out = out.filter(ImageFilter.GaussianBlur(radius=0.6))
        overlay = Image.new("RGB", out.size, (36, 48, 62))
        out = Image.blend(out, overlay, 0.12)
    return out


def _shift_rgb(im: Image.Image, delta: tuple[int, int, int]) -> Image.Image:
    out = im.convert("RGB")
    dr, dg, db = delta
    r, g, b = out.split()
    r = r.point(lambda x: _clamp(x + dr))
    g = g.point(lambda x: _clamp(x + dg))
    b = b.point(lambda x: _clamp(x + db))
    return Image.merge("RGB", (r, g, b))


def gen_weather(*, force: bool = False) -> int:
    n = 0
    for loc in WEATHER_LOCS:
        base = OUT / f"{loc}.png"
        if not base.is_file():
            print("skip missing", base.name)
            continue
        with Image.open(base) as im:
            src = im.convert("RGB")
            for weather in WEATHER_TINTS:
                dest = OUT / f"{loc}_{weather}.png"
                if dest.is_file() and not force and dest.stat().st_size > 50_000:
                    print("keep", dest.name)
                    continue
                _apply_weather(src, weather).save(dest, format="PNG", optimize=True)
                print("wrote", dest.name)
                n += 1
    return n


def gen_dorms(*, force: bool = False) -> int:
    n = 0
    for name, delta in DORM_SHIFTS.items():
        path = OUT / f"{name}.png"
        if not path.is_file():
            continue
        with Image.open(path) as im:
            # Always rewrite so hashes diverge even if previously cloned
            shifted = _shift_rgb(im, delta)
            # unique soft label band so content differs even after similar tint
            draw = ImageDraw.Draw(shifted)
            label_y = shifted.height - 36
            hue = tuple(_clamp(80 + delta[i] * 2) for i in range(3))
            draw.rectangle([0, label_y, shifted.width, shifted.height], fill=hue)
            draw.text((16, label_y + 8), name.replace("_", " ").upper(), fill=(240, 240, 245))
            shifted.save(path, format="PNG", optimize=True)
            print("rewrote", path.name)
            n += 1
    return n


def gen_campus_map(*, force: bool = False) -> int:
    dest = OUT / "campus_map.png"
    if dest.is_file() and not force and dest.stat().st_size > 80_000:
        print("keep", dest.name)
        return 0
    w, h = 1600, 1000
    img = Image.new("RGB", (w, h), (58, 92, 78))
    draw = ImageDraw.Draw(img)
    # sky band
    for y in range(0, 220):
        t = y / 220
        c = (
            int(120 + 40 * t),
            int(160 + 20 * t),
            int(190 - 30 * t),
        )
        draw.line([(0, y), (w, y)], fill=c)
    # ground
    draw.rectangle([0, 220, w, h], fill=(72, 108, 84))
    # paths
    draw.rectangle([w // 2 - 28, 240, w // 2 + 28, h - 40], fill=(168, 158, 132))
    draw.rectangle([80, h // 2 - 18, w - 80, h // 2 + 18], fill=(168, 158, 132))
    # building blocks
    blocks = [
        (180, 260, 420, 420, (118, 132, 148), "教学楼"),
        (980, 280, 1280, 430, (132, 122, 108), "食堂"),
        (120, 520, 380, 700, (96, 128, 104), "操场"),
        (1080, 520, 1400, 700, (112, 108, 128), "宿舍"),
        (700, 300, 900, 380, (148, 138, 118), "图书馆"),
    ]
    for x0, y0, x1, y1, color, label in blocks:
        draw.rounded_rectangle([x0, y0, x1, y1], radius=18, fill=color, outline=(40, 48, 44), width=3)
        draw.text(((x0 + x1) // 2 - 24, (y0 + y1) // 2 - 6), label, fill=(245, 245, 240))
    # soft vignette
    vignette = Image.new("RGB", (w, h), (20, 28, 24))
    img = Image.blend(img, vignette, 0.08)
    img = ImageOps.expand(img.filter(ImageFilter.SMOOTH), border=0)
    img.save(dest, format="PNG", optimize=True)
    print("wrote", dest.name)
    return 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--skip-weather", action="store_true")
    ap.add_argument("--skip-dorms", action="store_true")
    ap.add_argument("--skip-map", action="store_true")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    n = 0
    if not args.skip_weather:
        n += gen_weather(force=args.force)
    if not args.skip_dorms:
        n += gen_dorms(force=args.force)
    if not args.skip_map:
        n += gen_campus_map(force=args.force)
    print(f"done files_touched≈{n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
