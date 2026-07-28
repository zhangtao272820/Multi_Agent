#!/usr/bin/env python3
"""Generate male baseline sprites (identity + summer_stand + q) as stylized placeholders.

Real photoreal art should replace these under data/sprites/students/{id}/.
Does not overwrite files larger than 80KB (likely real assets).
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "sprites" / "students"

# Distinct cool-tone palettes per male id (shirt / hair / accent)
MALES: dict[str, tuple[tuple[int, int, int], tuple[int, int, int], str]] = {
    "pc": ((62, 88, 110), (36, 42, 52), "林"),
    "m01": ((48, 112, 96), (48, 40, 36), "陆"),
    "m02": ((86, 78, 120), (28, 28, 36), "周"),
    "m03": ((100, 92, 72), (44, 36, 32), "韩"),
    "m04": ((72, 96, 118), (32, 38, 48), "许"),
    "m05": ((90, 70, 88), (40, 32, 40), "沈"),
    "m06": ((58, 100, 88), (36, 40, 38), "顾"),
    "m07": ((78, 86, 104), (30, 34, 44), "方"),
    "m08": ((96, 84, 68), (42, 34, 28), "秦"),
    "m09": ((68, 78, 98), (34, 36, 46), "叶"),
}

STAND_W, STAND_H = 512, 768
Q_W, Q_H = 256, 256
MAX_KEEP_BYTES = 80_000


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def _write_rgba(path: Path, w: int, h: int, pixels: list[tuple[int, int, int, int]]) -> None:
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            r, g, b, a = pixels[y * w + x]
            raw.extend((r, g, b, a))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + _chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def _should_skip(path: Path) -> bool:
    return path.is_file() and path.stat().st_size > MAX_KEEP_BYTES


def _fill_ellipse(
    pix: list[tuple[int, int, int, int]],
    w: int,
    h: int,
    cx: float,
    cy: float,
    rx: float,
    ry: float,
    color: tuple[int, int, int, int],
) -> None:
    for y in range(h):
        for x in range(w):
            nx = (x + 0.5 - cx) / rx
            ny = (y + 0.5 - cy) / ry
            if nx * nx + ny * ny <= 1.0:
                pix[y * w + x] = color


def _fill_rect(
    pix: list[tuple[int, int, int, int]],
    w: int,
    h: int,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    color: tuple[int, int, int, int],
) -> None:
    for y in range(max(0, y0), min(h, y1)):
        for x in range(max(0, x0), min(w, x1)):
            pix[y * w + x] = color


def make_stand(shirt: tuple[int, int, int], hair: tuple[int, int, int]) -> list[tuple[int, int, int, int]]:
    w, h = STAND_W, STAND_H
    pix = [(0, 0, 0, 0)] * (w * h)
    # body
    _fill_ellipse(pix, w, h, w * 0.5, h * 0.62, w * 0.22, h * 0.28, (*shirt, 255))
    # head
    _fill_ellipse(pix, w, h, w * 0.5, h * 0.28, w * 0.14, h * 0.11, (232, 210, 190, 255))
    # hair
    _fill_ellipse(pix, w, h, w * 0.5, h * 0.22, w * 0.15, h * 0.09, (*hair, 255))
    # collar accent
    _fill_rect(pix, w, h, int(w * 0.42), int(h * 0.38), int(w * 0.58), int(h * 0.42), (245, 245, 248, 255))
    return pix


def make_q(shirt: tuple[int, int, int], hair: tuple[int, int, int]) -> list[tuple[int, int, int, int]]:
    w, h = Q_W, Q_H
    pix = [(0, 0, 0, 0)] * (w * h)
    _fill_ellipse(pix, w, h, w * 0.5, h * 0.58, w * 0.32, h * 0.28, (*shirt, 255))
    _fill_ellipse(pix, w, h, w * 0.5, h * 0.38, w * 0.28, h * 0.28, (232, 210, 190, 255))
    _fill_ellipse(pix, w, h, w * 0.5, h * 0.28, w * 0.30, h * 0.18, (*hair, 255))
    return pix


def main() -> int:
    written = 0
    skipped = 0
    for sid, (shirt, hair, _glyph) in MALES.items():
        root = OUT / sid
        files = {
            "_identity_neutral.png": make_stand(shirt, hair),
            "summer_stand_neutral.png": make_stand(shirt, hair),
            "q_stand_neutral.png": make_q(shirt, hair),
        }
        for name, pix in files.items():
            path = root / name
            if _should_skip(path):
                skipped += 1
                continue
            wh = (Q_W, Q_H) if name.startswith("q_") else (STAND_W, STAND_H)
            _write_rgba(path, wh[0], wh[1], pix)
            written += 1
            print("wrote", path.relative_to(ROOT))
    print(f"done: wrote={written} skipped_large={skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
