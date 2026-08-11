#!/usr/bin/env python3
"""Smoke: T0–T2 signature wiring + gallery albums + ending resolve (in-process)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def main() -> int:
    from app import catalog
    from app import gallery as gallery_mod
    from app import sprite_context as sprite_ctx
    from app import sprites as sprites_mod

    catalog.class_roster.cache_clear()
    catalog.sprite_budget.cache_clear()
    catalog.weekly_events_catalog.cache_clear()

    roster = catalog.class_roster()
    budget = catalog.sprite_budget()
    focus = set()
    fb = budget.get("female_by_beauty") or {}
    for key in ("school_belle", "extreme", "high"):
        focus.update((fb.get(key) or {}).get("ids") or [])

    with_plan = 0
    for s in roster.get("students") or []:
        if str(s.get("id")) not in focus:
            continue
        plan = s.get("signature_plan") or []
        assert isinstance(plan, list) and len(plan) >= 2, s.get("id")
        with_plan += 1
    assert with_plan == 20, with_plan

    # Signature preferred when location matches (even if PNG missing — first pair in candidates)
    f01 = next(s for s in roster["students"] if s["id"] == "f01")
    pairs = sprite_ctx.build_oa_candidates(
        location_id="library",
        period_kind="free",
        weather_id="sunny",
        verb=None,
        gender="female",
        student_id="f01",
        prefer_scene=True,
        student=f01,
    )
    assert pairs, pairs
    assert pairs[0][1].startswith("sig_"), pairs[:5]
    assert "library" in pairs[0][1] or pairs[0][1] == "sig_library_essay", pairs[0]

    # Date verb maps to date_* then chat fallback (ahead of private bunk poses)
    date_pairs = sprite_ctx.build_oa_candidates(
        location_id="rooftop",
        period_kind="free_day",
        weather_id="sunny",
        verb="date_stroll",
        gender="female",
        student_id="f21",
        prefer_scene=True,
    )
    actions = [a for _, a in date_pairs]
    assert "date_stroll" in actions, actions[:20]
    # First non-signature action should be the date pose
    non_sig = [a for a in actions if not str(a).startswith("sig_")]
    assert non_sig[0] == "date_stroll", non_sig[:8]
    assert actions.index("date_stroll") < actions.index("sit_bunk"), actions[:20]

    # Ending resolve soft-fallback
    end = sprites_mod.resolve_ending_sprite("f21", emotion="happy", verdict="good")
    assert end.get("path"), end
    assert end.get("kind") == "ending", end

    # Gallery albums shape
    gal = gallery_mod.build_gallery_payload()
    assert gal["total"] >= 30
    sample = next(c for c in gal["characters"] if c["id"] == "f21")
    # stranger → no albums
    assert sample.get("albums") in ([], None) or not sample.get("met")

    # Weekly hints present
    events = catalog.weekly_events_catalog().get("events") or []
    hinted = [e for e in events if isinstance(e.get("sprite_hint"), dict)]
    assert len(hinted) >= 5, len(hinted)

    # W7: crush + dorm evening → intimate selfie candidates (pr_* first); male never
    f24_pairs = sprite_ctx.build_oa_candidates(
        location_id="dorm_f5",
        period_kind="dorm",
        weather_id="clear",
        verb=None,
        gender="female",
        student_id="f24",
        prefer_scene=True,
        stage="crush",
    )
    selfie_outfits = [o for o, a in f24_pairs if "intimate_selfie" in o and a == ""]
    assert selfie_outfits, f24_pairs[:15]
    assert selfie_outfits[0].startswith("pr_"), selfie_outfits[:5]
    assert any(o == "intimate_selfie_slip" for o in selfie_outfits), selfie_outfits[:10]
    # Ahead of casual private pack
    first_casual = next(i for i, (o, _) in enumerate(f24_pairs) if o == "casual")
    first_selfie = next(i for i, (o, a) in enumerate(f24_pairs) if "intimate_selfie" in o and a == "")
    assert first_selfie < first_casual, (first_selfie, first_casual)

    no_stage = sprite_ctx.build_oa_candidates(
        location_id="dorm_f5",
        period_kind="dorm",
        weather_id="clear",
        verb=None,
        gender="female",
        student_id="f24",
        stage="friend",
    )
    assert not any("intimate_selfie" in o and a == "" for o, a in no_stage), no_stage[:12]

    male_pairs = sprite_ctx.build_oa_candidates(
        location_id="dorm_m1",
        period_kind="dorm",
        weather_id="clear",
        verb=None,
        gender="male",
        student_id="m01",
        stage="dating",
    )
    assert not any("intimate_selfie" in o for o, _ in male_pairs), male_pairs[:12]

    # Soft-fallback when selfie PNGs absent: still resolves private/school pack
    miss = sprite_ctx.resolve_contextual_sprite(
        "f01",
        emotion="shy",
        location_id="dorm_f1",
        period_kind="dorm",
        gender="female",
        stage="crush",
    )
    assert miss.get("path"), miss
    # Without selfie files on disk, must not claim a missing intimate selfie hit
    if "intimate_selfie" in str(miss.get("file") or ""):
        assert (sprites_mod.sprites_root() / "f01" / str(miss["file"])).is_file()

    # Gallery recognizes selfie albums when files exist (f24 after promote)
    from app.gallery import _ALBUM_LABELS, _SELFIE_RE

    assert "intimate_selfie" in _ALBUM_LABELS
    assert "pr_intimate_selfie" in _ALBUM_LABELS
    f24_files = sprites_mod.list_student_files("f24")
    selfie_files = [n for n in f24_files if "intimate_selfie" in n]
    if selfie_files:
        assert any(_SELFIE_RE.match(n) for n in selfie_files), selfie_files[:3]

    print("OK sprite variety wiring: signature/date/end/gallery/weekly/W7")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
