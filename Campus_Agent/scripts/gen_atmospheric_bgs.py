#!/usr/bin/env python3
"""Generate atmospheric gradient BGs for campus locations (stdlib only).

Skips files larger than 200KB (likely real art). Replaces flat placeholders.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "bgs"

# location_id -> (top RGB, bottom RGB)
GRADIENTS: dict[str, tuple[tuple[int, int, int], tuple[int, int, int]]] = {
    "default": ((42, 72, 68), (22, 36, 40)),
    "classroom": ((118, 138, 122), (62, 78, 72)),
    "cafeteria": ((148, 118, 88), (78, 58, 42)),
    "library": ((96, 112, 138), (48, 58, 78)),
    "hallway": ((120, 124, 112), (64, 68, 62)),
    "playground": ((92, 148, 108), (48, 78, 58)),
    "rooftop": ((140, 168, 188), (72, 88, 108)),
    "club_room": ((132, 108, 138), (68, 52, 72)),
    "shop": ((152, 128, 92), (82, 64, 48)),
    "dorm_gate": ((108, 116, 124), (52, 58, 66)),
    "dorm_m1": ((96, 108, 128), (46, 54, 68)),
    "dorm_m2": ((90, 102, 122), (42, 50, 64)),
    "dorm_f1": ((128, 108, 122), (62, 48, 60)),
    "dorm_f2": ((122, 102, 118), (58, 44, 56)),
    "dorm_f3": ((116, 98, 114), (54, 42, 54)),
    "dorm_f4": ((110, 94, 110), (50, 40, 52)),
}

W, H = 1280, 720
MAX_KEEP = 200_000


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_gradient_png(path: Path, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> None:
    rows = []
    for y in range(H):
        t = y / max(1, H - 1)
        # slight vignette + horizontal soft band
        band = 0.92 + 0.08 * (0.5 - abs(0.5 - t) * 2)
        r = int((top[0] * (1 - t) + bottom[0] * t) * band)
        g = int((top[1] * (1 - t) + bottom[1] * t) * band)
        b = int((top[2] * (1 - t) + bottom[2] * t) * band)
        # soft floor strip
        if y > int(H * 0.72):
            floor_t = (y - int(H * 0.72)) / (H - int(H * 0.72))
            r = int(r * (1 - 0.25 * floor_t) + 36 * 0.25 * floor_t)
            g = int(g * (1 - 0.25 * floor_t) + 40 * 0.25 * floor_t)
            b = int(b * (1 - 0.25 * floor_t) + 44 * 0.25 * floor_t)
        row = b"\x00" + bytes([max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b))]) * W
        rows.append(row)
    raw = b"".join(rows)
    ihdr = struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(raw, 9)) + _chunk(b"IEND", b"")
    path.write_bytes(png)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    written = 0
    skipped = 0
    for name, (top, bottom) in GRADIENTS.items():
        path = OUT / f"{name}.png"
        if path.is_file() and path.stat().st_size > MAX_KEEP:
            skipped += 1
            continue
        write_gradient_png(path, top, bottom)
        written += 1
        print("wrote", path.relative_to(ROOT))
    print(f"done: wrote={written} skipped_large={skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
