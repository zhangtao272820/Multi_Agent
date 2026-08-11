"""立绘大全解锁规则：与 sprite_outfit 门槛同源，供 gallery browse 模式使用。"""

from __future__ import annotations

from typing import Any

from .sprite_outfit import (
    INTIMATE_AFFINITY_MIN,
    INTIMATE_IMPLIED_AFFINITY_MIN,
    INTIMATE_LINGERIE_AFFINITY_MIN,
    INTIMATE_MAX_AFFINITY_MIN,
)
from .world_engine import stage_rank
from .world_store import BondShelf, WorldSave

_BASE_OUTFITS = frozenset(
    {"casual", "home", "work", "school", "date", "rain", "overtime", "sleepy", "sick", "party"}
)
_SEASON_OUTFITS = frozenset({"season_winter", "season_spring", "season_summer", "season_autumn"})
_INTIMATE_CORE = frozenset(
    {
        "intimate_lounge",
        "intimate_lingerie",
        "intimate_implied",
        "silk_slip",
        "after_bath",
        "morning_shirt",
        "lace_night",
        "towel_wrap",
        "backless_home",
        "bedside_hug",
        "window_night",
    }
)
_MAX_OUTFITS = frozenset(
    {
        "max_micro_slip",
        "max_wet_cling",
        "max_garter",
        "max_kneel_pillow",
        "max_strappy",
        "max_choker",
        "max_slit_gown",
        "max_over_shoulder",
        "max_sofa_lie",
        "max_ribbon_cover",
    }
)
# §2.9 私密吊带自拍：门槛与 lingerie 档同源（dating + aff≥85）；linked 故意展示同 max
_SELFIE_OUTFITS = frozenset(
    {
        "intimate_selfie_slip",
        "intimate_selfie_micro",
        "intimate_selfie_strappy",
        "intimate_selfie_shirt",
        "intimate_selfie_backless",
        "intimate_selfie_sofa",
        "intimate_selfie_kneel",
        "intimate_selfie_garter",
        "intimate_selfie_wet",
        "intimate_selfie_ribbon",
        "pr_intimate_selfie_slip",
        "pr_intimate_selfie_micro",
        "pr_intimate_selfie_strappy",
        "pr_intimate_selfie_shirt",
        "pr_intimate_selfie_backless",
        "pr_intimate_selfie_sofa",
        "pr_intimate_selfie_kneel",
        "pr_intimate_selfie_garter",
        "pr_intimate_selfie_wet",
        "pr_intimate_selfie_ribbon",
    }
)
_BATH_OUTFITS = frozenset(
    {
        "bath_foam",
        "shower_foam",
        "foam_chest",
        "bath_scrub",
        "pr_bath_foam",
        "pr_shower_foam",
        "pr_foam_chest",
        "pr_bath_scrub",
        "pr_wrap_low",
        "pr_foam_slide",
        "pr_tub_lean",
        "pr_steam_close",
        "pr_kneel_foam",
        "pr_wet_cling",
        "pr_shoulder_slip",
        "pr_back_glance",
        "pr_edge_sit",
        "pr_rinse_up",
        "pr_foam_hug",
    }
)
_ADVANCE_OUTFITS = frozenset({"bridal", "maternity"})
_ENDING_OUTFITS = frozenset(
    {
        "end_lingerie_set",
        "end_deep_v",
        "end_lace_bra",
        "end_sheer_cover",
        "end_robe_open",
        "end_strappy",
        "end_garter_bed",
        "end_kneel_pillow",
        "end_back_glance",
        "end_sofa_invite",
        "end_choker",
        "end_wet_home",
        "end_window_night",
        "end_morning_after",
        "end_close_embrace",
    }
)
_GALLERY_ONLY = frozenset(
    {
        "q_cleavage",
        "ad_bra_set",
        "ad_lace_campaign",
        "ad_silk_lookbook",
        "ad_editorial",
    }
)


def outfit_tier(outfit_id: str) -> str:
    oid = (outfit_id or "").strip()
    base = oid.split("_sleeping")[0].split("_eating")[0].split("_working_focus")[0]
    if base in _BASE_OUTFITS or oid.startswith(("home_", "casual_", "work_")):
        return "base"
    if base in _SEASON_OUTFITS or oid.startswith("season_"):
        return "season"
    if (
        base in _INTIMATE_CORE
        or base in _MAX_OUTFITS
        or base in _BATH_OUTFITS
        or base in _SELFIE_OUTFITS
        or base.startswith("intimate_selfie_")
        or base.startswith("pr_intimate_selfie_")
    ):
        return "intimate"
    if base in _ADVANCE_OUTFITS:
        return "advance"
    if base in _ENDING_OUTFITS or oid.startswith("end_"):
        return "ending"
    if base in _GALLERY_ONLY or oid.startswith(("ad_", "q_")):
        return "gallery"
    if oid.startswith("menu_"):
        return "menu"
    return "signature"


def _winter_reached(save: WorldSave | None) -> bool:
    if save is None:
        return False
    from .season_waypoints import has_reached_ids

    return has_reached_ids(
        waypoint_id=save.waypoint_id,
        waypoints_reached=list(save.waypoints_reached or []),
        target_id="q_winter_onset",
    )


def outfit_unlocked(
    outfit_id: str,
    bond: BondShelf | None,
    *,
    save: WorldSave | None = None,
    met: bool = False,
) -> bool:
    """玩家是否可在图鉴中预览该 outfit（缺图仍可标记 unlocked=false via has_asset）。"""
    if not met or bond is None:
        return False
    oid = (outfit_id or "").strip()
    if not oid:
        return True
    # 复合 state：看主 outfit
    root = oid
    for suf in ("_sleeping", "_eating", "_working_focus"):
        if oid.endswith(suf):
            root = oid[: -len(suf)]
            break
    tier = outfit_tier(root)
    aff = int(bond.relationship_state.affinity or 0)
    st = bond.relationship_state.stage_id or ""
    rank = stage_rank(st)
    cast = bond.cast_kind or "romance"

    if tier == "base" or tier == "menu":
        return True
    if tier == "season":
        if root == "season_winter":
            return _winter_reached(save)
        # 春夏秋弱差分：相识即可
        return True
    if tier == "signature":
        return aff >= 35 or rank >= stage_rank("friend")

    # neutral：故意展示档与 romance 魅力/洗浴同源门槛，用 close_friend 等价 dating；
    # 仍禁 intimate 核心 / bridal / maternity。
    if cast == "neutral":
        if tier == "intimate":
            if root in _INTIMATE_CORE or root in _ADVANCE_OUTFITS:
                return False
            if root in _MAX_OUTFITS or root in _BATH_OUTFITS or root in _SELFIE_OUTFITS:
                return aff >= INTIMATE_MAX_AFFINITY_MIN and rank >= stage_rank("close_friend")
            return False
        if tier == "advance":
            return False
        if tier == "ending":
            unlocked = set(bond.unlocked_endings or [])
            if save:
                unlocked |= set(save.unlocked_endings or [])
            return len(unlocked) > 0 and aff >= 70
        if tier == "gallery":
            return aff >= INTIMATE_MAX_AFFINITY_MIN and rank >= stage_rank("close_friend")
        return False

    if cast != "romance":
        return False
    if tier == "intimate":
        if root in _MAX_OUTFITS or root in _BATH_OUTFITS:
            return aff >= INTIMATE_MAX_AFFINITY_MIN and rank >= stage_rank("dating")
        if root in _SELFIE_OUTFITS:
            return aff >= INTIMATE_LINGERIE_AFFINITY_MIN and rank >= stage_rank("dating")
        if root == "intimate_implied":
            return aff >= INTIMATE_IMPLIED_AFFINITY_MIN and st == "married"
        if root in {"intimate_lingerie", "silk_slip", "lace_night", "towel_wrap", "backless_home", "bedside_hug", "window_night"}:
            return aff >= INTIMATE_LINGERIE_AFFINITY_MIN and rank >= stage_rank("dating")
        if root in {"after_bath", "morning_shirt"}:
            return aff >= INTIMATE_AFFINITY_MIN and rank >= stage_rank("dating")
        return aff >= INTIMATE_AFFINITY_MIN and rank >= stage_rank("crush")
    if tier == "advance":
        return st == "married"
    if tier == "ending":
        unlocked = set(bond.unlocked_endings or [])
        if save:
            unlocked |= set(save.unlocked_endings or [])
        return len(unlocked) > 0 and aff >= 70
    if tier == "gallery":
        return aff >= INTIMATE_MAX_AFFINITY_MIN and rank >= stage_rank("dating")
    return False


def lock_reason(outfit_id: str, *, met: bool) -> str:
    if not met:
        return "尚未相识"
    tier = outfit_tier(outfit_id)
    if tier == "season":
        return "尚未进入对应季节"
    if tier == "intimate":
        return "关系还不够近"
    if tier == "advance":
        return "尚未走到那一步"
    if tier == "ending":
        return "尚未窥见结局"
    if tier == "gallery":
        return "尚未解锁特写"
    if tier == "signature":
        return "再熟一些才会解锁"
    return "尚未解锁"


def enrich_character_gallery(
    row: dict[str, Any],
    bond: BondShelf | None,
    *,
    save: WorldSave | None,
    mode: str,
) -> dict[str, Any]:
    """browse：按解锁裁剪展示；pick：全量。"""
    out = dict(row)
    met = bool(bond and (int(bond.relationship_state.turns or 0) > 0 or bond.messages))
    outfits = list(row.get("outfits") or [])
    emotions = list(row.get("emotions") or [])

    if mode != "browse":
        out["met"] = met
        out["unlocked_outfits"] = outfits
        out["locked_outfits"] = []
        out["outfit_locks"] = {}
        return out

    if not met:
        out["name"] = "？？？"
        out["appearance"] = ""
        out["role_hint"] = ""
        out["met"] = False
        out["unlocked_outfits"] = []
        out["locked_outfits"] = outfits
        out["outfit_locks"] = {o: "尚未相识" for o in outfits}
        out["emotions"] = ["neutral"] if "neutral" in emotions else (emotions[:1] if emotions else [])
        out["thumb"] = ""
        return out

    unlocked: list[str] = []
    locked: list[str] = []
    locks: dict[str, str] = {}
    for oid in outfits:
        if outfit_unlocked(oid, bond, save=save, met=True):
            unlocked.append(oid)
        else:
            locked.append(oid)
            locks[oid] = lock_reason(oid, met=True)
    out["met"] = True
    out["unlocked_outfits"] = unlocked
    out["locked_outfits"] = locked
    out["outfit_locks"] = locks
    # browse 默认只列已解锁 + 锁态分栏由前端处理；outfits 仍全量便于分栏
    out["outfits"] = outfits
    return out
