from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.internal_auth import verify_internal_token
from app.core.learning_curator import get_learning_payload, run_learning_curator
from app.core.prompt_evolution import (
    auto_promote_eligible_patches,
    clear_evolved_hints,
    clear_prompt_patches,
    promote_prompt_patch,
    promote_min_hits,
)

router = APIRouter()


class PromoteBody(BaseModel):
    patchId: str | None = None
    auto: bool = False
    minHits: int | None = None


class CurateBody(BaseModel):
    autoPromote: bool = True
    minHits: int | None = None
    ingestAudit: bool = True


class ResetBody(BaseModel):
    scope: str = "shadow"  # shadow | evolved | memory | experience | evolution | learning | all
    session_id: str | None = None
    tenant_id: str | None = None


def _clear_tool_experience(tenant_id: str | None = None) -> dict:
    tid = (tenant_id or os.getenv("AGENT_TENANT_ID") or os.getenv("TENANT_ID") or "default").strip() or "default"
    try:
        import psycopg

        url = (
            os.getenv("AGENT_DATABASE_URL")
            or os.getenv("CLAWHIVE_DATABASE_URL")
            or os.getenv("DATABASE_URL")
            or ""
        ).strip()
        if not url:
            return {"ok": False, "reason": "no_pg"}
        with psycopg.connect(url.replace("postgresql+psycopg2:", "postgresql:")) as conn:
            try:
                cur = conn.execute("DELETE FROM adm_tool_experience WHERE tenant_id = %s", (tid,))
            except Exception:
                cur = conn.execute("DELETE FROM adm_tool_experience")
            conn.commit()
            return {"ok": True, "deleted": getattr(cur, "rowcount", None), "tenant_id": tid}
    except Exception as e:
        return {"ok": False, "reason": str(e)}


def run_learning_reset(body: ResetBody) -> dict:
    scope = str(body.scope or "shadow").strip().lower()
    out: dict = {"ok": True, "scope": scope}
    if scope in ("shadow", "all", "evolution", "learning"):
        clear_prompt_patches()
        out["prompt_shadow"] = True
    if scope in ("evolved", "all", "evolution", "learning"):
        clear_evolved_hints()
        out["evolved"] = True
    if scope in ("experience", "all", "learning"):
        out["experience"] = _clear_tool_experience(body.tenant_id)
        try:
            from app.core.tool_experience_store import hydrate_admin_tool_experience_cache

            hydrate_admin_tool_experience_cache()
        except Exception:
            pass
    if scope in ("memory", "all"):
        from app.core.session_dialogue import delete_session_dialogue

        sid = str(body.session_id or "").strip() or "default"
        out["memory"] = delete_session_dialogue(sid)
    return out


@router.get("/api/learning")
async def learning_get(_: None = Depends(verify_internal_token)):
    return get_learning_payload()


@router.post("/api/learning/promote")
async def learning_promote(body: PromoteBody, _: None = Depends(verify_internal_token)):
    if body.auto:
        th = body.minHits if body.minHits is not None else promote_min_hits()
        promoted = auto_promote_eligible_patches(th)
        return {"ok": True, "promoted": promoted, "count": len(promoted)}
    patch_id = str(body.patchId or "").strip()
    if not patch_id:
        raise HTTPException(status_code=400, detail="请提供 patchId 或 auto=true")
    res = promote_prompt_patch(patch_id)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=str(res.get("reason") or "promote_failed"))
    return {"ok": True, "hintId": res.get("hintId"), "skillId": res.get("skillId")}


@router.post("/api/learning/curate")
async def learning_curate(body: CurateBody, _: None = Depends(verify_internal_token)):
    report = run_learning_curator(
        auto_promote=body.autoPromote,
        min_hits=body.minHits,
        ingest_audit=body.ingestAudit,
    )
    return {"ok": True, "report": report}


@router.post("/api/learning/reset")
async def learning_reset(body: ResetBody, _: None = Depends(verify_internal_token)):
    return run_learning_reset(body)
