"""Smoke: resolve_outfit only returns outfits that exist for that heroine."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.china_calendar import day_info  # noqa: E402
from app.sprite_outfit import (  # noqa: E402
    available_outfits,
    meal_context_from_save,
    pick_available_outfit,
    resolve_outfit,
    resolve_outfit_for_bond,
)
from app.world_engine import advance_period  # noqa: E402
from app.world_store import create_world_save  # noqa: E402

# 锚定 2026-07-15 → day 154 ≈ 2026-12-15（冬）
WINTER_DAY = 154


def main() -> None:
    # T2 thin pack: no season_winter / intimate — must fall back to base
    thin = "xingnai"
    have = available_outfits(thin)
    assert "casual" in have and "date" in have
    assert "season_winter" not in have
    o = resolve_outfit(
        day_index=1,
        period="morning",
        location_id="home",
        character_id=thin,
        occupation="高中生",
    )
    assert o in have and o in {"casual", "home", "school"}, o

    o_date = resolve_outfit(day_index=1, period="evening", location_id="park", on_date=True, character_id=thin)
    assert o_date == "date", o_date

    # Expanded pack: winter should prefer season_winter when season is winter
    rich = "xiaoyou"
    have_r = available_outfits(rich)
    assert "season_winter" in have_r
    assert pick_available_outfit(rich, ["season_winter", "casual"]) == "season_winter"
    assert pick_available_outfit(thin, ["season_winter", "casual"]) == "casual"

    # Signature when at location
    from app.sprite_outfit import _signature_for_location

    sig = _signature_for_location("wanyu", "cafe")
    if sig:
        o_cafe = resolve_outfit(
            day_index=1,
            period="afternoon",
            location_id="cafe",
            character_id="wanyu",
            occupation="咖啡店员",
        )
        assert o_cafe in available_outfits("wanyu"), o_cafe
        assert o_cafe not in {"", "neutral"}

    save = create_world_save(user_id="smoke_outfit", protagonist_name="测")
    save.location_id = "office"
    save.calendar.period = "afternoon"
    bond = save.bonds["linxi"]
    out = resolve_outfit_for_bond(save, bond)
    assert out in available_outfits("linxi"), out
    # office afternoon → work_working_focus or work
    assert out in {"work_working_focus", "work", "casual", "desk_papers"}, out

    from app.world_engine import hub_public

    hub = hub_public(save)
    for row in hub.get("present_here") or []:
        so = row.get("sprite_outfit") or ""
        if so:
            assert so in available_outfits(row["character_id"]), (row["character_id"], so)

    # --- winter home (jingliu: no home signature hook) ---
    assert day_info(WINTER_DAY).get("season") == "winter", day_info(WINTER_DAY)
    assert "season_winter" in available_outfits("jingliu")
    o_winter = resolve_outfit(
        day_index=WINTER_DAY,
        period="morning",
        location_id="home",
        character_id="jingliu",
        occupation="品牌顾问",
    )
    assert o_winter == "season_winter", o_winter

    # summer must NOT auto-pick season_summer
    o_summer = resolve_outfit(
        day_index=1,
        period="morning",
        location_id="home",
        character_id="jingliu",
        occupation="品牌顾问",
    )
    assert o_summer != "season_summer", o_summer
    assert o_summer in available_outfits("jingliu"), o_summer

    # --- intimate: affinity≥70 + home + evening ---
    assert "intimate_lounge" in have_r
    o_int = resolve_outfit(
        day_index=1,
        period="evening",
        location_id="home",
        character_id=rich,
        occupation="插画师",
        affinity=70,
    )
    assert o_int == "intimate_lounge", o_int

    # --- meal_context → home_eating ---
    assert "home_eating" in have_r
    o_eat = resolve_outfit(
        day_index=1,
        period="afternoon",
        location_id="home",
        character_id=rich,
        occupation="插画师",
        meal_context=True,
    )
    assert o_eat == "home_eating", o_eat

    # save flag: meal_context_period wires through resolve_outfit_for_bond
    save.location_id = "home"
    save.calendar.period = "afternoon"
    save.meal_context_period = "afternoon"
    assert meal_context_from_save(save) is True
    bond_xy = save.bonds[rich]
    o_eat_bond = resolve_outfit_for_bond(save, bond_xy)
    assert o_eat_bond == "home_eating", o_eat_bond
    save = advance_period(save, allow_day_roll=False)
    assert save.meal_context_period == ""
    assert meal_context_from_save(save) is False

    # --- sleeping: home + night + high fatigue ---
    assert "home_sleeping" in have_r
    o_sleep = resolve_outfit(
        day_index=1,
        period="night",
        location_id="home",
        character_id=rich,
        occupation="插画师",
        fatigue=50,
    )
    assert o_sleep == "home_sleeping", o_sleep

    # --- linxi home low affinity must NOT be intimate_lounge ---
    assert _signature_for_location("linxi", "home") == ""
    o_linxi_home = resolve_outfit(
        day_index=1,
        period="morning",
        location_id="home",
        character_id="linxi",
        occupation="实习生",
        affinity=10,
    )
    assert o_linxi_home != "intimate_lounge", o_linxi_home
    assert o_linxi_home in available_outfits("linxi"), o_linxi_home

    # --- advance tiers: hit when on disk, else fall back ---
    have_xy = available_outfits(rich)
    o_impl = resolve_outfit(
        day_index=1,
        period="night",
        location_id="home",
        character_id=rich,
        occupation="插画师",
        affinity=95,
        stage_id="married",
    )
    if "intimate_implied" in have_xy:
        assert o_impl == "intimate_implied", o_impl
    else:
        assert o_impl in have_xy and o_impl != "", o_impl

    # lingerie 档：85 ≤ aff < 88（aff≥88 优先 max_*，见 §2.3）
    o_ling = resolve_outfit(
        day_index=1,
        period="evening",
        location_id="home",
        character_id=rich,
        occupation="插画师",
        affinity=85,
        stage_id="dating",
    )
    if "intimate_lingerie" in have_xy:
        assert o_ling == "intimate_lingerie", o_ling
    else:
        assert o_ling in {"intimate_lounge", "home", "casual"} or o_ling in have_xy, o_ling

    # maternity：日间下午（早晨优先 after_bath/morning_shirt，见扩展计划 §2.2）
    o_mat = resolve_outfit(
        day_index=1,
        period="afternoon",
        location_id="home",
        character_id=rich,
        occupation="插画师",
        affinity=90,
        stage_id="married",
    )
    if "maternity" in have_xy:
        assert o_mat == "maternity", o_mat
    else:
        assert o_mat in have_xy, o_mat

    o_morning = resolve_outfit(
        day_index=1,
        period="morning",
        location_id="home",
        character_id=rich,
        occupation="插画师",
        affinity=75,
        stage_id="dating",
    )
    # §2.5 洗浴泡沫优先于 after_bath / morning_shirt
    if "bath_foam" in have_xy:
        assert o_morning == "bath_foam", o_morning
    elif "after_bath" in have_xy:
        assert o_morning == "after_bath", o_morning
    elif "morning_shirt" in have_xy:
        assert o_morning == "morning_shirt", o_morning
    else:
        assert o_morning in have_xy, o_morning

    # §2.6：photoreal 晨间优先 pr_*（有图时）
    o_pr_morning = resolve_outfit(
        day_index=1,
        period="morning",
        location_id="home",
        character_id=rich,
        occupation="插画师",
        affinity=75,
        stage_id="dating",
        sprite_style="photoreal",
    )
    if "pr_bath_foam" in have_xy:
        assert o_pr_morning == "pr_bath_foam", o_pr_morning
    elif "bath_foam" in have_xy:
        assert o_pr_morning == "bath_foam", o_pr_morning
    else:
        assert o_pr_morning in have_xy, o_pr_morning

    # anime 晨间不得因磁盘有 pr_* 而抢 anime 舞台
    if "bath_foam" in have_xy:
        assert o_morning == "bath_foam", o_morning
    assert o_morning != "q_cleavage"
    assert o_morning not in {
        "ad_bra_set",
        "ad_lace_campaign",
        "ad_silk_lookbook",
        "ad_editorial",
    }

    o_bridal = resolve_outfit(
        day_index=1,
        period="afternoon",
        location_id="park",
        character_id=rich,
        occupation="插画师",
        on_date=True,
        stage_id="married",
    )
    if "bridal" in have_xy:
        assert o_bridal == "bridal", o_bridal
    else:
        assert o_bridal == "date", o_bridal

    # --- neutral：禁 intimate/bridal；close_friend 高亲和可命中 max/浴装；永不 end/q/ad ---
    neu = "shuli"
    have_neu = available_outfits(neu)
    o_neu_wrong_stage = resolve_outfit(
        day_index=1,
        period="night",
        location_id="home",
        character_id=neu,
        occupation="学生",
        affinity=99,
        stage_id="married",
    )
    assert o_neu_wrong_stage not in {
        "intimate_lounge",
        "intimate_lingerie",
        "intimate_implied",
        "bridal",
        "maternity",
        "silk_slip",
        "after_bath",
        "morning_shirt",
        "lace_night",
        "towel_wrap",
        "backless_home",
        "bedside_hug",
        "window_night",
        "max_micro_slip",
        "bath_foam",
        "q_cleavage",
        "ad_bra_set",
        "ad_lace_campaign",
        "ad_silk_lookbook",
        "ad_editorial",
    }, o_neu_wrong_stage

    o_neu_max = resolve_outfit(
        day_index=1,
        period="evening",
        location_id="home",
        character_id=neu,
        occupation="学生",
        affinity=90,
        stage_id="close_friend",
    )
    assert o_neu_max not in {
        "intimate_lingerie",
        "intimate_lounge",
        "bridal",
        "maternity",
        "end_robe_open",
        "q_cleavage",
        "ad_bra_set",
    }, o_neu_max
    if "max_micro_slip" in have_neu:
        assert o_neu_max == "max_micro_slip", o_neu_max

    o_neu_bath = resolve_outfit(
        day_index=1,
        period="morning",
        location_id="home",
        character_id=neu,
        occupation="学生",
        affinity=75,
        stage_id="close_friend",
    )
    assert o_neu_bath not in {"after_bath", "morning_shirt", "intimate_lingerie"}, o_neu_bath
    if "bath_foam" in have_neu:
        assert o_neu_bath == "bath_foam", o_neu_bath

    o_max = resolve_outfit(
        day_index=1,
        period="evening",
        location_id="home",
        character_id=rich,
        occupation="插画师",
        affinity=90,
        stage_id="dating",
    )
    if "max_micro_slip" in have_xy:
        assert o_max == "max_micro_slip", o_max
    else:
        assert o_max in have_xy, o_max

    # §2.4 / §2.7 / §2.8：即使磁盘已有，日常 resolve 也不得返回
    from app.sprite_outfit import _ENDING_CG_OUTFITS, _GALLERY_ONLY_OUTFITS, normalize_story_outfit_hints

    for aff in (70, 85, 88, 92, 99):
        for per in ("evening", "night", "morning"):
            o_end = resolve_outfit(
                day_index=1,
                period=per,
                location_id="home",
                character_id=rich,
                occupation="插画师",
                affinity=aff,
                stage_id="married",
            )
            assert o_end not in _ENDING_CG_OUTFITS, (aff, per, o_end)
            assert o_end not in _GALLERY_ONLY_OUTFITS, (aff, per, o_end)
            assert not str(o_end).startswith("ad_"), (aff, per, o_end)
            assert not str(o_end).startswith("q_"), (aff, per, o_end)

    # 专属故事：sprite_hint 优先出图
    assert "atelier_paint" in have_r
    o_story = resolve_outfit(
        day_index=1,
        period="afternoon",
        location_id="street",
        character_id=rich,
        occupation="插画师",
        story_outfit_hints=["atelier_paint", "home"],
    )
    assert o_story == "atelier_paint", o_story

    # 缺图 hint 回退到链上下一个有图的
    o_miss = resolve_outfit(
        day_index=1,
        period="afternoon",
        location_id="home",
        character_id=rich,
        occupation="插画师",
        story_outfit_hints=["no_such_outfit_zzz", "deadline_lamp", "casual"],
    )
    assert o_miss == "deadline_lamp", o_miss

    # 误写 end_* / q_* / ad_*：normalize 过滤；resolve 不得返回
    cleaned = normalize_story_outfit_hints(
        ["end_robe_open", "atelier_paint", "end_choker", "q_cleavage", "ad_bra_set"]
    )
    assert cleaned == ["atelier_paint"], cleaned
    o_end_hint = resolve_outfit(
        day_index=1,
        period="evening",
        location_id="home",
        character_id=rich,
        occupation="插画师",
        affinity=99,
        stage_id="married",
        story_outfit_hints=["end_robe_open", "q_cleavage", "ad_editorial", "atelier_paint"],
    )
    assert o_end_hint == "atelier_paint", o_end_hint
    assert o_end_hint not in _ENDING_CG_OUTFITS
    assert o_end_hint not in _GALLERY_ONLY_OUTFITS

    from app.story_beats import story_outfit_hints_for_beat
    from app.event_engine import GameEvent, StoryBeat

    fake = GameEvent(
        id="story_xiaoyou_act1_threshold",
        label="门槛",
        beats=[
            StoryBeat(id="b1", summary="开场", sprite_hint=["atelier_paint", "home"]),
        ],
    )
    assert story_outfit_hints_for_beat(fake, 0) == ["atelier_paint", "home"]

    print("smoke-sprite-outfit-time: OK")
    print(
        f"  thin_home={o} date={o_date} linxi_office={out} "
        f"winter={o_winter} intimate={o_int} eat={o_eat} sleep={o_sleep} "
        f"linxi_home={o_linxi_home} implied={o_impl} lingerie={o_ling} "
        f"maternity={o_mat} morning={o_morning} pr_morning={o_pr_morning} "
        f"max={o_max} bridal={o_bridal} shuli_max={o_neu_max} shuli_bath={o_neu_bath}"
    )


if __name__ == "__main__":
    main()
