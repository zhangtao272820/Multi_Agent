"""学习 Curator：审计扫描 + 影子补丁晋级 + 偏好汇总。"""
from __future__ import annotations

import os

from app.core.admin_env_modes import is_admin_auto_curate_enabled
from datetime import datetime, timezone
from typing import Any

from app.core.audit_learning import get_audit_learning_summary, ingest_audit_failures_to_patches, scan_audit_logs
from app.core.prompt_evolution import (
    get_prompt_evolution_summary,
    get_prompt_patches_for_stage,
    list_evolved_hints,
    list_promotable_patches,
    list_prompt_patches,
    promote_min_hits,
    promote_prompt_patch_verified,
)
from app.core.evolution_verify import verify_admin_evolution_promote
from app.core.user_preferences import get_user_preferences


def _auto_curate_enabled() -> bool:
    return is_admin_auto_curate_enabled()


def run_learning_curator(
    *,
    auto_promote: bool = False,
    min_hits: int | None = None,
    ingest_audit: bool = True,
) -> dict[str, Any]:
    th = min_hits if min_hits is not None else promote_min_hits()
    ingested = ingest_audit_failures_to_patches() if ingest_audit else 0
    verify_gate = verify_admin_evolution_promote()
    # 门禁：默认不自动晋级；须 EVO_ALLOW_EXPERT_AUTO_PROMOTE=1 且调用方显式 auto_promote
    allow_auto = (
        auto_promote
        and _auto_curate_enabled()
        and str(os.getenv("EVO_ALLOW_EXPERT_AUTO_PROMOTE", "0")).strip() in ("1", "true", "yes", "on")
    )
    promoted: list[str] = []
    if allow_auto and verify_gate.get("ok"):
        for row in list_promotable_patches(th):
            res = promote_prompt_patch_verified(str(row.get("id") or ""))
            if res.get("ok"):
                promoted.append(str(res.get("hintId")))
    audit = scan_audit_logs()

    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "ingestedFromAudit": ingested,
        "promotedHints": promoted,
        "verifyGate": verify_gate,
        "autoPromoteRequested": bool(auto_promote),
        "autoPromoteAllowed": allow_auto,
        "shadowPatches": len([p for p in list_prompt_patches() if not p.get("promoted_at")]),
        "promotableRemaining": len(list_promotable_patches(th)),
        "topFailureCodes": audit.get("topFailureCodes") or [],
        "topToolErrors": audit.get("topToolErrors") or [],
        "evolution": get_prompt_evolution_summary(),
    }


def maybe_run_lightweight_curator() -> None:
    if not _auto_curate_enabled():
        return
    try:
        # 轻量 curate：只扫审计写 shadow，不自动晋级
        run_learning_curator(auto_promote=False, ingest_audit=False)
    except Exception:
        pass


def get_learning_payload() -> dict[str, Any]:
    th = promote_min_hits()
    prefs = get_user_preferences()
    return {
        "learning": get_audit_learning_summary(),
        "promptPatches": list_prompt_patches()[-15:],
        "promotablePatches": list_promotable_patches(th),
        "evolvedHints": list_evolved_hints(),
        "evolution": get_prompt_evolution_summary(),
        "userPreferences": prefs,
        "promoteMinHits": th,
    }
