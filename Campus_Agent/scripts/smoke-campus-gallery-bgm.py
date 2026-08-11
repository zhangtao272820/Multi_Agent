#!/usr/bin/env python3
"""Smoke: gallery payload + BGM catalog v2 tracks."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

BASE = "http://127.0.0.1:13116"
EXPECTED_NEW = {"loc_festival", "loc_forest", "loc_store"}


def call(method: str, path: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=5) as res:
        return json.loads(res.read().decode("utf-8"))


def assert_gallery(gal: dict) -> None:
    assert gal["total"] >= 30, gal["total"]
    assert len(gal["characters"]) == gal["total"]
    locked = [c for c in gal["characters"] if not c.get("met")]
    for c in locked:
        assert c.get("default_sprite") in (None, {}), c
        thumb = c.get("thumb") or {}
        assert not thumb.get("path"), thumb
        assert not c.get("albums"), c.get("id")
    # Deep-browse field present on payload characters
    assert "albums" in (gal["characters"][0] or {})
    assert "sprites_gallery" not in (gal or {})  # gallery payload only
    print(" gallery total=", gal["total"], "met=", gal.get("met_count"), "save=", gal.get("save_id"))


def assert_bgm(cat: dict) -> None:
    ids = {t["id"] for t in cat.get("tracks") or []}
    missing = EXPECTED_NEW - ids
    assert not missing, missing
    for tid in EXPECTED_NEW:
        track = next(t for t in cat["tracks"] if t["id"] == tid)
        assert track.get("available"), tid
    title_pl = cat.get("playlists", {}).get("title") or []
    assert len(title_pl) >= 8, title_pl
    assert cat.get("cues", {}).get("sprites_gallery"), cat.get("cues")
    assert cat.get("location_cues", {}).get("shop") == "loc_store"
    assert cat.get("location_cues", {}).get("club_room") == "loc_festival"
    print(" bgm tracks=", len(ids), "title_playlist=", len(title_pl))


def main() -> int:
    try:
        call("GET", "/api/health")
        use_http = True
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        use_http = False
        print("server offline — in-process smoke")

    if use_http:
        gal = call("GET", "/api/campus/gallery")
        assert_gallery(gal)
        cat = call("GET", "/api/campus/bgm/catalog")
        assert_bgm(cat)
        print("OK http gallery+bgm smoke")
        return 0

    from app import bgm as bgm_mod  # type: ignore
    from app import gallery as gallery_mod  # type: ignore

    gal = gallery_mod.build_gallery_payload()
    assert_gallery(gal)
    cat = bgm_mod.public_bgm_catalog()
    assert_bgm(cat)
    print("OK in-process gallery+bgm smoke")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
