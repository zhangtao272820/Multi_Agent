"""Evolution Hub surface: learning summary / curate / promote / reset. No AUTO_PROMOTE."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

from app.bootstrap import load_special_goldens, tenant_folder
from app.catalog import load_golden
from app.settings import data_dir, get_settings
from app.tenants import Tenant


def _patches_path():
    p = data_dir() / "learning"
    p.mkdir(parents=True, exist_ok=True)
    return p / "patches.json"


def _load_patches() -> list[dict[str, Any]]:
    path = _patches_path()
    if not path.is_file():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    return list(raw) if isinstance(raw, list) else []


def _save_patches(items: list[dict[str, Any]]) -> None:
    _patches_path().write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def auto_promote_allowed() -> bool:
    if str(os.getenv("EVO_ALLOW_EXPERT_AUTO_PROMOTE") or "").strip() == "1":
        return True
    return bool(get_settings().evo_allow_expert_auto_promote)


def learning_summary(tenant: Tenant) -> dict[str, Any]:
    patches = _load_patches()
    # voided = 撤回/重新生成作废，不进学习面
    live = [p for p in patches if str(p.get("status") or "") != "voided"]
    shadow = [p for p in live if str(p.get("status") or "shadow") == "shadow"]
    active = [p for p in live if str(p.get("status") or "") == "active"]
    goldens = load_golden(tenant)
    special = load_special_goldens(tenant_folder(tenant))
    n_special = sum(1 for g in goldens if str(g.get("source") or "") == "special")
    n_template = max(0, len(goldens) - n_special)
    return {
        "learning": {
            "golden": len(goldens),
            "golden_special": n_special,
            "golden_template": n_template,
            "special": len(special),
            "agent": "db",
        },
        "metrics": {
            "golden": len(goldens),
            "golden_special": n_special,
            "golden_template": n_template,
        },
        "promptPatches": live[-12:],
        "promotablePatches": shadow,
        "evolution": {
            "promotableCount": len(shadow),
            "shadowCount": len(shadow),
            "activeCount": len(active),
            "autoPromote": False,
        },
        "sqlTemplates": {
            "golden": len(goldens),
            "golden_special": n_special,
            "golden_template": n_template,
        },
        "experienceVectors": {"hits": 0},
        "userPreferences": {},
    }


def curate(*, auto_promote: bool = False) -> dict[str, Any]:
    promote = bool(auto_promote) and auto_promote_allowed()
    return {
        "ok": True,
        "report": {
            "autoPromote": promote,
            "promoted": [],
            "reason": "expert_auto_promote_disabled" if auto_promote and not promote else "curated",
        },
    }


def promote_patch(patch_id: str) -> dict[str, Any]:
    pid = str(patch_id or "").strip()
    if not pid:
        return {"ok": False, "reason": "missing_patch_id"}
    if pid.startswith("golden:"):
        return {"ok": True, "hintId": pid, "status": "active"}
    patches = _load_patches()
    found = None
    for p in patches:
        if str(p.get("id") or "") == pid:
            found = p
            break
    if not found:
        return {"ok": False, "reason": "patch_not_found"}
    found["status"] = "active"
    found["promoted_at"] = datetime.now(timezone.utc).isoformat()
    _save_patches(patches)
    return {"ok": True, "hintId": pid}


def reset_learning(*, scope: str = "learning") -> dict[str, Any]:
    kind = str(scope or "learning").strip().lower()
    if kind in {"all", "learning", "prompts"}:
        _save_patches([])
    return {"ok": True, "scope": kind}


def _feedback_jsonl_path():
    p = data_dir() / "learning"
    p.mkdir(parents=True, exist_ok=True)
    return p / "feedback.jsonl"


def _load_feedback_rows() -> list[dict[str, Any]]:
    path = _feedback_jsonl_path()
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(raw, dict):
            rows.append(raw)
    return rows


def _save_feedback_rows(rows: list[dict[str, Any]]) -> None:
    path = _feedback_jsonl_path()
    with path.open("w", encoding="utf-8") as f:
        for rec in rows:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def record_feedback(
    *,
    question: str,
    score: int,
    sql: str = "",
    tables: list[str] | None = None,
    comment: str = "",
    tenant_id: str = "p2604",
    session_id: str = "",
    message_id: str = "",
) -> dict[str, Any]:
    """Standalone UI 有用/无用：正反馈可沉淀经验；负反馈进 shadow patch，禁止自动晋级。

    session_id + message_id 用于撤回/重新生成时作废，对齐总管 session-feedback.delete。
    """
    q = str(question or "").strip()
    if not q:
        return {"ok": False, "reason": "question_required"}
    if score not in (1, -1):
        return {"ok": False, "reason": "score_must_be_1_or_-1"}
    sid = str(session_id or "").strip()
    mid = str(message_id or "").strip()
    path = _feedback_jsonl_path()
    rec = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "question": q[:400],
        "score": score,
        "sql": str(sql or "")[:2000],
        "tables": list(tables or [])[:12],
        "comment": str(comment or "").strip()[:400],
        "tenant": tenant_id,
        "session_id": sid,
        "message_id": mid,
        "voided": False,
    }
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    out: dict[str, Any] = {"ok": True, "score": score, "autoPromote": False, "message_id": mid}
    if score == 1 and sql.strip().upper().startswith(("SELECT", "WITH")):
        from app.experience import write_standalone_experience

        xp = write_standalone_experience(
            question=q,
            sql=sql,
            tables=list(tables or []),
            tenant_id=tenant_id,
            data_domain=tenant_id,
            source="vanna_feedback",
            session_id=sid,
            message_id=mid,
        )
        out["experience"] = xp
    if score == -1:
        patches = _load_patches()
        pid = f"fb:{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}:{len(patches)+1}"
        patches.append(
            {
                "id": pid,
                "status": "shadow",
                "stage": "sql",
                "source": "feedback",
                "text": (comment or f"用户标记无用：{q[:80]}").strip()[:200],
                "question": q[:200],
                "session_id": sid,
                "message_id": mid,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        _save_patches(patches)
        out["patchId"] = pid
        out["status"] = "shadow"
    return out


def invalidate_learning_for_messages(
    *,
    session_id: str,
    message_ids: list[str] | None = None,
    questions: list[str] | None = None,
) -> dict[str, Any]:
    """撤回 / 重新生成 / 编辑重发：作废该轮及之后反馈，不进入学习（对齐总管）。"""
    sid = str(session_id or "").strip()
    mids = {str(x or "").strip() for x in (message_ids or []) if str(x or "").strip()}
    qset = {str(x or "").strip()[:400] for x in (questions or []) if str(x or "").strip()}
    if not sid and not mids and not qset:
        return {"ok": True, "voidedFeedback": 0, "voidedPatches": 0, "voidedExperience": 0}

    voided_fb = 0
    rows = _load_feedback_rows()
    changed = False
    for rec in rows:
        if rec.get("voided") is True:
            continue
        hit = False
        mid = str(rec.get("message_id") or "").strip()
        rs = str(rec.get("session_id") or "").strip()
        rq = str(rec.get("question") or "").strip()
        if mid and mid in mids:
            hit = True
        elif sid and rs == sid and mid and mid in mids:
            hit = True
        elif sid and rs == sid and rq and rq in qset:
            # 旧记录无 message_id 时按会话+问句兜底
            hit = True
        elif not mid and rq and rq in qset and (not rs or rs == sid):
            hit = True
        if not hit:
            continue
        rec["voided"] = True
        rec["voided_at"] = datetime.now(timezone.utc).isoformat()
        rec["void_reason"] = "withdraw_or_regenerate"
        voided_fb += 1
        changed = True
    if changed:
        _save_feedback_rows(rows)

    voided_patches = 0
    patches = _load_patches()
    p_changed = False
    for p in patches:
        if str(p.get("status") or "") == "voided":
            continue
        if str(p.get("source") or "") != "feedback":
            continue
        mid = str(p.get("message_id") or "").strip()
        ps = str(p.get("session_id") or "").strip()
        pq = str(p.get("question") or "").strip()
        hit = False
        if mid and mid in mids:
            hit = True
        elif sid and ps == sid and (mid in mids or (pq and pq in qset)):
            hit = True
        elif not mid and pq and pq in qset and (not ps or ps == sid):
            hit = True
        if not hit:
            continue
        p["status"] = "voided"
        p["voided_at"] = datetime.now(timezone.utc).isoformat()
        p["void_reason"] = "withdraw_or_regenerate"
        voided_patches += 1
        p_changed = True
    if p_changed:
        _save_patches(patches)

    voided_xp = 0
    try:
        from app.experience import void_standalone_experience

        voided_xp = int(
            void_standalone_experience(session_id=sid, message_ids=list(mids), questions=list(qset)).get(
                "voided", 0
            )
            or 0
        )
    except Exception:
        voided_xp = 0

    return {
        "ok": True,
        "voidedFeedback": voided_fb,
        "voidedPatches": voided_patches,
        "voidedExperience": voided_xp,
    }
