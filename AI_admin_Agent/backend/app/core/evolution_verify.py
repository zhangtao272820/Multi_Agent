"""进化 promote 前办公 golden 结构门禁。"""
from __future__ import annotations

import os
from pathlib import Path

from app.core.admin_nlu import ADMIN_INTENTS


def evolution_verify_enabled() -> bool:
    return os.getenv("EVO_VERIFY_BEFORE_PROMOTE", "1").strip().lower() not in ("0", "false", "no")


def verify_admin_evolution_promote() -> dict:
    if not evolution_verify_enabled():
        return {"ok": True, "agent": "admin", "gate": "disabled", "checks": [{"id": "disabled", "ok": True}]}

    checks: list[dict] = []
    scripts = Path(__file__).resolve().parents[2] / "scripts"
    for name in ("smoke_batch0.py", "smoke_batch1.py"):
        p = scripts / name
        checks.append({"id": name, "ok": p.is_file()})

    checks.append({"id": "admin_intents_nonempty", "ok": len(ADMIN_INTENTS) >= 8})

    try:
        from app.core.admin_turn_scope import classify_admin_turn_scope

        s1 = classify_admin_turn_scope("明天下午3点开会", "用户：帮我查邮件\n助手：好的")
        checks.append({"id": "turn_scope_topic_shift", "ok": s1.mode in ("topic_shift", "current_only")})

        s2 = classify_admin_turn_scope("员工大会", "用户：帮我安排会议\n助手：标题是什么")
        checks.append({"id": "turn_scope_continuation", "ok": s2.mode == "continuation"})
        s3 = classify_admin_turn_scope("翻译成英文", "用户：帮我写一封请假邮件\n助手：好的，草稿如下…")
        checks.append(
            {
                "id": "turn_scope_output_followup",
                "ok": s3.turn_kind == "output_followup" and s3.narrow_output_followup is True,
            }
        )
        from app.core.admin_turn_scope import dialogue_for_nlu

        wide = "用户：查邮件\n助手：有3封\n用户：安排会议\n助手：标题是什么\n用户：员工大会\n助手：时间呢"
        narrow = dialogue_for_nlu(wide, s3)
        checks.append(
            {
                "id": "dialogue_narrow_output_followup",
                "ok": "查邮件" not in narrow and ("草稿" in narrow or "请假" in narrow or "助手：" in narrow),
            }
        )
    except Exception as e:
        checks.append({"id": "turn_scope_smoke", "ok": False, "detail": str(e)})

    ok = all(c.get("ok") for c in checks)
    return {
        "ok": ok,
        "agent": "admin",
        "gate": "office_golden",
        "reason": None if ok else "admin_golden_failed",
        "checks": checks,
    }
