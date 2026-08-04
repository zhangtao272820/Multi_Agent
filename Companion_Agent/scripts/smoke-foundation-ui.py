"""Smoke：基础 UI 契约 — bond summary / save list / gallery unlock。"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.cast_pick import build_gallery_payload  # noqa: E402
from app.sprite_unlock import outfit_tier, outfit_unlocked  # noqa: E402
from app.world_store import (  # noqa: E402
    BondLiving,
    create_world_save,
    list_world_saves,
    public_bond_summary,
    upsert_world_save,
)


def fail(msg: str) -> None:
    print(f"FAIL {msg}")
    raise SystemExit(1)


def main() -> None:
    save = create_world_save(user_id="smoke_foundation_ui", protagonist_name="测")
    bond = save.bonds.get("xiaoyou") or next(iter(save.bonds.values()))
    cid = bond.character_id

    # unmet → no story_soft personality leak; still has difficulty
    pub0 = public_bond_summary(bond, day_index=save.calendar.day_index, save=save)
    if "difficulty_band" not in pub0 or "difficulty_label" not in pub0:
        fail("public_bond_summary missing difficulty fields")
    if "life_notes" not in pub0 or "living_soft" not in pub0:
        fail("public_bond_summary missing living fields")
    if "endings_unlocked_count" not in pub0:
        fail("missing endings_unlocked_count")

    # met + soft cold
    bond.relationship_state = bond.relationship_state.model_copy(
        update={"turns": 3, "affinity": 55, "stage_id": "friend", "stage_label": "朋友"}
    )
    bond.messages = []  # turns>0 ⇒ met
    bond.living = BondLiving(talked_day_index=1, fatigue=60, soft_cold_until_day=20)
    flags = dict(bond.relationship_state.flags or {})
    flags["neglect_cold"] = True
    bond.relationship_state = bond.relationship_state.model_copy(update={"flags": flags})
    save.bonds[cid] = bond
    save.calendar = save.calendar.model_copy(update={"day_index": 10})
    upsert_world_save(save)
    pub = public_bond_summary(bond, day_index=10, save=save)
    if not pub.get("met"):
        fail("expected met after turns")
    if not pub.get("living_soft", {}).get("soft_cold"):
        fail("expected soft_cold")
    notes = pub.get("life_notes") or []
    if not any("疏远" in n or "话少" in n or "疲惫" in n for n in notes):
        fail(f"life_notes missing soft/fatigue hint: {notes}")

    # save list enrichment
    rows = list_world_saves("smoke_foundation_ui")
    if not rows:
        fail("list_world_saves empty")
    row = rows[0]
    for key in (
        "season_label",
        "waypoint_label",
        "location_label",
        "money",
        "focus_names",
        "unlocked_endings_count",
        "period_label",
    ):
        if key not in row:
            fail(f"save summary missing {key}")

    # gallery browse lock
    gal = build_gallery_payload(save_id=save.save_id, user_id="smoke_foundation_ui", mode="browse")
    if gal.get("mode") != "browse":
        fail("gallery mode not browse")
    chars = {c["character_id"]: c for c in gal.get("characters") or []}
    x = chars.get(cid)
    if not x:
        fail("gallery missing xiaoyou")
    if not x.get("met"):
        fail("gallery should mark met character")
    if "unlocked_outfits" not in x or "outfit_locks" not in x:
        fail("gallery missing unlock fields")

    # unmet stranger locked name
    stranger = next((c for c in gal["characters"] if not c.get("met")), None)
    if stranger and stranger.get("name") != "？？？":
        fail(f"unmet should lock name, got {stranger.get('name')}")

    # outfit rules
    if outfit_tier("season_winter") != "season":
        fail("season_winter tier")
    if outfit_tier("intimate_lounge") != "intimate":
        fail("intimate tier")
    if not outfit_unlocked("casual", bond, save=save, met=True):
        fail("casual should unlock when met")
    if outfit_unlocked("intimate_lounge", bond, save=save, met=True):
        fail("intimate should stay locked at friend/55")

    # neutral：close_friend 高亲和可解锁 max/浴/ad；仍禁 intimate 核心
    from app.game_judge import check_endings  # noqa: E402
    from app.route_catalog import get_route  # noqa: E402

    shuli = save.bonds.get("shuli")
    if not shuli:
        fail("missing shuli bond")
    shuli.relationship_state = shuli.relationship_state.model_copy(
        update={
            "turns": 5,
            "affinity": 90,
            "trust": 80,
            "stage_id": "close_friend",
            "stage_label": "挚友",
            "flags": {
                "sibling_talk_done": True,
                "bond_ally_done": True,
                "deliberate_display": True,
                "shuli_soft_bloom": True,
                "kin_garden_ready": True,
            },
        }
    )
    shuli.messages = []
    shuli.unlocked_endings = ["ending_shuli_shadow_garden"]
    save.bonds["shuli"] = shuli
    save.unlocked_endings = list(
        dict.fromkeys([*(save.unlocked_endings or []), "ending_shuli_shadow_garden"])
    )
    upsert_world_save(save)

    if outfit_unlocked("intimate_lingerie", shuli, save=save, met=True):
        fail("neutral must not unlock intimate_lingerie")
    if outfit_unlocked("bridal", shuli, save=save, met=True):
        fail("neutral must not unlock bridal")
    if not outfit_unlocked("max_micro_slip", shuli, save=save, met=True):
        fail("neutral close_friend+aff should unlock max_*")
    if not outfit_unlocked("bath_foam", shuli, save=save, met=True):
        fail("neutral close_friend+aff should unlock bath")
    if not outfit_unlocked("ad_bra_set", shuli, save=save, met=True):
        fail("neutral close_friend+aff should unlock ad_*")
    if not outfit_unlocked("end_lingerie_set", shuli, save=save, met=True):
        fail("neutral with unlocked ending should unlock end_*")

    route = get_route("shuli")
    if not route or "ending_shuli_shadow_garden" not in (route.allowed_endings or []):
        fail("shuli route missing ending_shuli_shadow_garden")
    eid = check_endings(
        character_id="shuli",
        state=shuli.relationship_state,
        runtime={
            "flags": shuli.relationship_state.flags,
            "trust": shuli.relationship_state.trust,
            "cast_role": "neutral",
        },
    )
    if eid != "ending_shuli_shadow_garden":
        fail(f"expected ending_shuli_shadow_garden, got {eid}")

    gal2 = build_gallery_payload(save_id=save.save_id, user_id="smoke_foundation_ui", mode="browse")
    s_row = next((c for c in gal2.get("characters") or [] if c.get("character_id") == "shuli"), None)
    if not s_row or not s_row.get("met"):
        fail("gallery shuli should be met")
    unlocked = set(s_row.get("unlocked_outfits") or [])
    if "max_micro_slip" in (s_row.get("outfits") or []) and "max_micro_slip" not in unlocked:
        fail("gallery browse should unlock shuli max_micro_slip when on disk")

    print("OK smoke-foundation-ui")


if __name__ == "__main__":
    main()
