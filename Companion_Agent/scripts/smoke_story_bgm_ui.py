"""Lightweight smoke: opening beats, BGM uniqueness/availability, Day1 guidance."""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ok = True


def fail(msg: str) -> None:
    global ok
    ok = False
    print(f"FAIL {msg}")


def main() -> int:
    cat = json.loads((ROOT / "data" / "presentation_catalog.json").read_text(encoding="utf-8"))
    slides = cat.get("opening", {}).get("slides") or []
    brief = cat.get("opening", {}).get("world_brief") or []
    if not (5 <= len(slides) <= 7):
        fail(f"opening slides expected 5–7 beats, got {len(slides)}")
    else:
        print(f"OK opening beats={len(slides)}")

    total_lines = 0
    for i, slide in enumerate(slides):
        lines = slide.get("lines") or []
        if not lines and slide.get("caption"):
            lines = [slide["caption"]]
        if not lines:
            fail(f"slide[{i}] missing lines/caption")
            continue
        if len(lines) < 1:
            fail(f"slide[{i}] empty lines")
        chars = sum(len(str(x)) for x in lines)
        if chars < 80:
            fail(f"slide[{i}] ({slide.get('id')}) expected >=80 chars, got {chars}")
        total_lines += len(lines)
        if "duration_ms" in slide:
            fail(f"slide[{i}] should not auto-advance (duration_ms present)")
    if total_lines < 8:
        fail(f"opening text expected >=8 lines total, got {total_lines}")
    else:
        print(f"OK opening lines={total_lines}")

    joined_brief = "\n".join(str(x) for x in brief)
    if "沈予安" not in joined_brief:
        fail("world_brief should name 沈予安")
    else:
        print("OK world_brief names 沈予安")
    if len(brief) < 3:
        fail(f"world_brief expected >=3, got {len(brief)}")
    else:
        print(f"OK world_brief={len(brief)}")

    bgm_cat = json.loads((ROOT / "data" / "bgm_catalog.json").read_text(encoding="utf-8"))
    if bgm_cat.get("location_cues", {}).get("street") != "loc_rain":
        fail("street cue should be loc_rain")
    else:
        print("OK street -> loc_rain")
    if int(bgm_cat.get("crossfade_ms") or 0) < 400:
        fail("crossfade_ms missing")
    else:
        print(f"OK crossfade_ms={bgm_cat.get('crossfade_ms')}")

    track_ids = [t["id"] for t in bgm_cat.get("tracks") or []]
    bgm_dir = ROOT / "data" / "bgm"
    sizes: list[int] = []
    size_by_id: dict[str, int] = {}
    for tid in track_ids:
        paths = list(bgm_dir.glob(f"{tid}.*"))
        paths = [p for p in paths if p.suffix.lower() in {".mp3", ".ogg", ".wav"}]
        if not paths:
            fail(f"missing bgm file for {tid}")
            continue
        sz = paths[0].stat().st_size
        if sz < 40_000:
            fail(f"bgm {tid} too small ({sz}) — likely empty stub")
            continue
        sizes.append(sz)
        size_by_id[tid] = sz

    # every cue/playlist entry must resolve to an existing track file
    cue_maps = [
        bgm_cat.get("cues") or {},
        bgm_cat.get("location_cues") or {},
        bgm_cat.get("hub_cues") or {},
        bgm_cat.get("ending_type_cues") or {},
    ]
    for cmap in cue_maps:
        for key, tid in cmap.items():
            if tid not in track_ids:
                fail(f"cue {key} -> unknown track {tid}")
            elif not list(bgm_dir.glob(f"{tid}.*")):
                fail(f"cue {key} -> missing file {tid}")
    for plist_name, ids in (bgm_cat.get("playlists") or {}).items():
        for tid in ids or []:
            if tid not in track_ids:
                fail(f"playlist {plist_name} unknown track {tid}")
            paths = [p for p in bgm_dir.glob(f"{tid}.*") if p.suffix.lower() in {".mp3", ".ogg", ".wav"}]
            if not paths:
                fail(f"playlist {plist_name} missing file {tid}")
    print("OK bgm cues/playlists resolve to files")

    # 变奏槽可暂时共用同一 CC0 源文件；仅空壳（过小）视为失败（见上）
    dups = [s for s, c in Counter(sizes).items() if c > 1]
    if dups:
        shared = [tid for tid, sz in size_by_id.items() if sz in dups]
        print(f"WARN shared bgm sources among {sorted(shared)} (ok if intentional variants)")
    print(f"OK bgm files={len(sizes)}")

    # day1_guidance import
    sys.path.insert(0, str(ROOT / "backend"))
    from app.life_briefs import day1_guidance  # noqa: E402
    from app.world_store import _build_blank_world  # noqa: E402

    save = _build_blank_world(save_id="smoke", user_id="smoke", protagonist_name="测试")
    g = day1_guidance(save)
    if not g.get("onboarding_gate"):
        fail("new save should have onboarding_gate")
    else:
        print(
            f"OK day1 gate locs={g.get('day1_recommended_locations')} "
            f"chars={len(g.get('day1_recommended_chars') or [])}"
        )

    fonts = ROOT / "frontend" / "public" / "fonts"
    for name in ("fonts.css", "noto-sans-sc-500.woff2", "noto-serif-sc-600.woff2"):
        if not (fonts / name).exists():
            fail(f"missing font {name}")
        else:
            print(f"OK font {name}")

    # frontend contracts: OpeningIntro no auto timer; useBgm commits track after play
    opening_src = (ROOT / "frontend" / "src" / "components" / "OpeningIntro.tsx").read_text(
        encoding="utf-8"
    )
    if "setTimeout(next" in opening_src or "duration_ms" in opening_src and "setTimeout" in opening_src:
        # allow duration_ms in type but forbid auto timer
        if "window.setTimeout(next" in opening_src or "setTimeout(next," in opening_src:
            fail("OpeningIntro still auto-advances with setTimeout(next)")
        else:
            print("OK OpeningIntro no auto next timer")
    else:
        print("OK OpeningIntro no auto next timer")

    use_bgm = (ROOT / "frontend" / "src" / "hooks" / "useBgm.ts").read_text(encoding="utf-8")
    if "desiredTrackRef" not in use_bgm:
        fail("useBgm missing desiredTrackRef recovery")
    else:
        print("OK useBgm desiredTrackRef")
    if "visibilitychange" not in use_bgm:
        fail("useBgm missing visibilitychange resume")
    else:
        print("OK useBgm visibility resume")

    app_src = (ROOT / "frontend" / "src" / "App.tsx").read_text(encoding="utf-8")
    if "bgmPeriod" not in app_src or "bgmLocationId" not in app_src:
        fail("App.tsx should cue BGM from stable period/location keys")
    else:
        print("OK App BGM stable cue keys")

    # map + face chips: hub should not stage full-body sprites
    hub_src = (ROOT / "frontend" / "src" / "components" / "TownHubScreen.tsx").read_text(
        encoding="utf-8"
    )
    if "TownMapPicker" not in hub_src:
        fail("TownHubScreen should use TownMapPicker")
    else:
        print("OK TownHubScreen TownMapPicker")
    if "gal-vn-sprite" in hub_src or "SpritePortrait" in hub_src:
        fail("TownHubScreen should not show full-body SpritePortrait")
    else:
        print("OK TownHubScreen no full-body portraits")

    loc_src = (ROOT / "frontend" / "src" / "components" / "LocationScreen.tsx").read_text(
        encoding="utf-8"
    )
    if "FaceChip" not in loc_src:
        fail("LocationScreen should use FaceChip")
    else:
        print("OK LocationScreen FaceChip")
    if "SpritePortrait" in loc_src:
        fail("LocationScreen should not show full-body SpritePortrait")
    else:
        print("OK LocationScreen no full-body portraits")

    # hub_public includes present previews
    sys.path.insert(0, str(ROOT / "backend"))
    from app.world_engine import hub_public  # noqa: E402

    save2 = _build_blank_world(save_id="smoke-map", user_id="smoke", protagonist_name="测试")
    hub = hub_public(save2)
    locs = hub.get("locations") or []
    if not locs:
        fail("hub locations empty")
    elif "present" not in locs[0]:
        fail("hub location missing present preview list")
    else:
        print(f"OK hub location present field (sample n={len(locs[0].get('present') or [])})")

    print("PASS" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
