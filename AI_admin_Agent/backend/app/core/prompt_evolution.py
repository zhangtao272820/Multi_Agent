"""
Prompt 影子进化：从工具失败/审计沉淀短补丁，注入各 LangGraph 阶段 prompt。
晋级后写入 .data/admin-evolved-playbook.json，并追加到 skills/*/skill.md 的 Evolution 段。
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from app.core.admin_env_modes import (
    is_admin_auto_curate_enabled,
    is_admin_prompt_evolution_enabled,
)

PatchStage = Literal["routing", "planning", "executing", "verifying"]
PatchSource = Literal["audit", "tool_failure", "reflection", "manual", "feedback"]

STAGE_SKILL_MAP: dict[PatchStage, str] = {
    "routing": "intent_routing",
    "planning": "task_planning",
    "executing": "task_planning",
    "verifying": "verification",
}

STAGE_LABEL: dict[PatchStage, str] = {
    "routing": "意图路由",
    "planning": "任务规划",
    "executing": "工具执行",
    "verifying": "回复生成",
}


from app.core.admin_data_dir import admin_data_dir


def _data_dir() -> Path:
    return admin_data_dir()


def _shadow_file() -> Path:
    return _data_dir() / "admin-prompt-patches.shadow.json"


def _evolved_file() -> Path:
    return _data_dir() / "admin-evolved-playbook.json"


def _evolution_enabled() -> bool:
    return is_admin_prompt_evolution_enabled()


def _execution_only_evolution() -> bool:
    raw = os.getenv("EVO_AGENT_PROMPT_EXECUTION_ONLY", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _stage_evolution_allowed(stage: PatchStage) -> bool:
    if not _execution_only_evolution():
        return True
    return stage != "routing"


def promote_min_hits() -> int:
    try:
        return max(2, int(os.getenv("ADMIN_PROMOTE_MIN_HITS", "3")))
    except ValueError:
        return 3


def _clip(text: str, n: int = 200) -> str:
    t = re.sub(r"\s+", " ", str(text or "").strip())
    return t if len(t) <= n else t[: n - 1] + "…"


@dataclass
class PromptPatch:
    id: str
    ts: str
    stage: PatchStage
    text: str
    source: PatchSource
    hits: int = 1
    tool_name: str = ""
    code: str = ""
    promoted_at: str | None = None
    promoted_hint_id: str | None = None
    promoted_skill: str | None = None
    session_id: str = ""
    user_message_index: int | None = None
    run_id: str = ""
    voided: bool = False
    voided_at: str | None = None
    void_reason: str | None = None


@dataclass
class EvolvedHint:
    id: str
    stage: PatchStage
    skill_id: str
    text: str
    source_patch_id: str
    promoted_at: str


def _load_shadow() -> list[PromptPatch]:
    p = _shadow_file()
    if not p.is_file():
        return []
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        items = raw.get("patches") if isinstance(raw, dict) else raw
        out: list[PromptPatch] = []
        for row in items or []:
            if not isinstance(row, dict):
                continue
            stage = row.get("stage")
            if stage not in STAGE_SKILL_MAP:
                continue
            out.append(
                PromptPatch(
                    id=str(row.get("id") or ""),
                    ts=str(row.get("ts") or ""),
                    stage=stage,
                    text=str(row.get("text") or ""),
                    source=row.get("source") or "reflection",
                    hits=int(row.get("hits") or 1),
                    tool_name=str(row.get("tool_name") or ""),
                    code=str(row.get("code") or ""),
                    promoted_at=row.get("promoted_at") or row.get("promotedAt"),
                    promoted_hint_id=row.get("promoted_hint_id") or row.get("promotedHintId"),
                    promoted_skill=row.get("promoted_skill") or row.get("promotedSkill"),
                    session_id=str(row.get("session_id") or row.get("sessionId") or ""),
                    user_message_index=(
                        int(row["user_message_index"])
                        if row.get("user_message_index") is not None
                        else (
                            int(row["userMessageIndex"])
                            if row.get("userMessageIndex") is not None
                            else None
                        )
                    ),
                    run_id=str(row.get("run_id") or row.get("runId") or ""),
                    voided=bool(row.get("voided")),
                    voided_at=row.get("voided_at") or row.get("voidedAt"),
                    void_reason=row.get("void_reason") or row.get("voidReason"),
                )
            )
        return out
    except (json.JSONDecodeError, OSError):
        return []


def _save_shadow(patches: list[PromptPatch]) -> None:
    payload = {"patches": [asdict(p) for p in patches[-40:]]}
    _shadow_file().write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _load_evolved() -> list[EvolvedHint]:
    p = _evolved_file()
    if not p.is_file():
        return []
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        hints = raw.get("hints") if isinstance(raw, dict) else raw
        out: list[EvolvedHint] = []
        for row in hints or []:
            if not isinstance(row, dict):
                continue
            stage = row.get("stage")
            if stage not in STAGE_SKILL_MAP:
                continue
            out.append(
                EvolvedHint(
                    id=str(row.get("id") or ""),
                    stage=stage,
                    skill_id=str(row.get("skill_id") or STAGE_SKILL_MAP[stage]),
                    text=str(row.get("text") or ""),
                    source_patch_id=str(row.get("source_patch_id") or ""),
                    promoted_at=str(row.get("promoted_at") or ""),
                )
            )
        return out
    except (json.JSONDecodeError, OSError):
        return []


def _save_evolved(hints: list[EvolvedHint]) -> None:
    payload = {"hints": [asdict(h) for h in hints[-60:]]}
    _evolved_file().write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def append_prompt_patch(
    *,
    stage: PatchStage,
    text: str,
    source: PatchSource = "reflection",
    tool_name: str = "",
    code: str = "",
    session_id: str = "",
    user_message_index: int | None = None,
    run_id: str = "",
) -> None:
    if not _evolution_enabled():
        return
    if not _stage_evolution_allowed(stage):
        return
    t = _clip(text, 220)
    if not t:
        return
    patches = _load_shadow()
    dup = next(
        (
            p
            for p in patches
            if not p.promoted_at
            and not p.voided
            and p.stage == stage
            and p.text == t
            and p.code == (code or "")
        ),
        None,
    )
    now = datetime.now(timezone.utc).isoformat()
    sid = str(session_id or "").strip()
    rid = str(run_id or "").strip()
    if dup:
        dup.hits += 1
        dup.ts = now
        if sid:
            dup.session_id = sid
        if user_message_index is not None:
            dup.user_message_index = int(user_message_index)
        if rid:
            dup.run_id = rid
    else:
        patches.append(
            PromptPatch(
                id=f"p_{int(time.time() * 1000)}_{len(patches)}",
                ts=now,
                stage=stage,
                text=t,
                source=source,
                tool_name=tool_name or "",
                code=code or "",
                session_id=sid,
                user_message_index=user_message_index,
                run_id=rid,
            )
        )
    _save_shadow(patches)


def supersede_prompt_patches_for_revision(
    *,
    session_id: str,
    user_message_index: int | None = None,
    from_user_message_index: int | None = None,
    reason: str = "withdraw",
) -> dict[str, Any]:
    """撤回 / 重新生成 / 编辑重发：作废同会话反馈类影子补丁（对齐总管）。"""
    sid = str(session_id or "").strip()
    if not sid:
        return {"voided": 0}
    uidx = int(user_message_index) if user_message_index is not None else None
    from_idx = (
        int(from_user_message_index)
        if from_user_message_index is not None
        else (uidx if reason == "withdraw" and uidx is not None else None)
    )
    patches = _load_shadow()
    voided = 0
    now = datetime.now(timezone.utc).isoformat()
    for p in patches:
        if p.voided or p.promoted_at:
            continue
        if str(p.session_id or "") != sid:
            continue
        if p.source != "feedback":
            continue
        sig_idx = p.user_message_index if isinstance(p.user_message_index, int) else None
        same_turn = uidx is not None and sig_idx == uidx
        from_turn = from_idx is not None and sig_idx is not None and sig_idx >= from_idx
        withdraw_legacy = reason == "withdraw" and from_idx is not None and sig_idx is None
        if not same_turn and not from_turn and not withdraw_legacy:
            continue
        p.voided = True
        p.voided_at = now
        p.void_reason = reason
        voided += 1
    if voided:
        _save_shadow(patches)
    return {"voided": voided}


def live_shadow_patches() -> list[PromptPatch]:
    return [p for p in _load_shadow() if not p.voided]


# 失败码 → 建议补丁（大步：覆盖 admin 常见失败域）
_FAILURE_PATCH_RULES: list[tuple[str, PatchStage, str]] = [
    ("time_parse_failed", "planning", "日程/待办/提醒的时间参数必须填用户原话（中/英文均可，如「下周五上午9点」或 next Friday 9am），禁止自行写 ISO 或猜测年份。"),
    ("time_parse_failed", "executing", "时间由专用模型解析；若失败应提示用户补充具体日期与时刻（中英文均可），并区分 next Friday 与 this Friday。"),
    ("email_not_found_in_cache", "planning", "回复邮件前必须先调用 list_emails 刷新编号，再 reply_email。"),
    ("email_not_bound", "planning", "用户未绑定邮箱：引导连接国内邮箱授权码，不要编造收件箱，不要口头声称已发送。"),
    ("pending_not_found", "routing", "用户说「确认/取消」时必须带操作编号，例如：确认 12。"),
    ("pending_already_decided", "routing", "待确认操作已处理过，应提示用户查看 list_pending_actions。"),
    ("tool_not_found", "planning", "只使用 ToolCatalog 中列出的工具名，不要编造工具。"),
    ("rag_not_configured", "planning", "知识检索需配置 RAG_AGENT_URL；未配置时改用 web_search 或告知用户。"),
    ("search_failed", "planning", "联网搜索失败时如实告知，不要编造搜索结果。"),
    ("imap_not_configured", "planning", "读邮件需绑定邮箱或配置 IMAP；未配置时不要规划 list_emails/classify_emails。"),
    ("smtp_not_configured", "planning", "发信/回信需绑定邮箱或配置 SMTP；未配置时不要规划 send_email/reply_email。"),
    ("invalid_decision", "routing", "二次确认仅支持「确认 N」或「取消 N」格式。"),
    ("classify_failed", "executing", "邮件分类失败时返回收件箱摘要，不要编造分类统计。"),
]


def learn_from_tool_failure(tool_name: str, code: str, human_message: str = "") -> None:
    if not _evolution_enabled():
        return
    c = str(code or "").strip()
    if not c or c == "ok":
        return
    for rule_code, stage, text in _FAILURE_PATCH_RULES:
        if rule_code in c or c == rule_code:
            append_prompt_patch(
                stage=stage,
                text=text,
                source="tool_failure",
                tool_name=tool_name,
                code=c,
            )
            return
    if any(x in str(human_message) for x in ("失败", "未找到", "不能为空", "错误")):
        append_prompt_patch(
            stage="executing",
            text=_clip(f"工具 {tool_name} 失败（{c}）：避免重复相同参数组合。", 200),
            source="tool_failure",
            tool_name=tool_name,
            code=c,
        )


def get_prompt_patches_for_stage(stage: PatchStage, max_items: int = 4) -> str:
    if not _evolution_enabled():
        return ""
    # 收敛期读侧门禁：routing 补丁不得注入意图识别 prompt（与 append 写侧一致）
    if not _stage_evolution_allowed(stage):
        return ""
    evolved = [h for h in _load_evolved() if h.stage == stage][-3:]
    shadow = sorted(
        [p for p in _load_shadow() if not p.promoted_at and not p.voided and p.stage == stage],
        key=lambda p: -p.hits,
    )[:max_items]
    lines: list[str] = []
    for h in evolved:
        lines.append(f"- [已晋级] {h.text}")
    for p in shadow:
        lines.append(f"- {p.text}")
    if not lines:
        return ""
    return _clip(f"[进化提示·{STAGE_LABEL[stage]}]\n" + "\n".join(lines), 600)


def list_prompt_patches() -> list[dict[str, Any]]:
    return [asdict(p) for p in _load_shadow() if not p.voided]


def list_promotable_patches(min_hits: int | None = None) -> list[dict[str, Any]]:
    th = min_hits if min_hits is not None else promote_min_hits()
    return [
        asdict(p)
        for p in _load_shadow()
        if not p.promoted_at and not p.voided and p.hits >= th and _stage_evolution_allowed(p.stage)
    ]


def list_evolved_hints() -> list[dict[str, Any]]:
    return [asdict(h) for h in _load_evolved()]


def get_prompt_evolution_summary() -> dict[str, Any]:
    patches = [p for p in _load_shadow() if not p.voided]
    th = promote_min_hits()
    return {
        "shadowCount": len([p for p in patches if not p.promoted_at]),
        "promotedCount": len([p for p in patches if p.promoted_at]),
        "evolvedHintCount": len(_load_evolved()),
        "promotableCount": len([p for p in patches if not p.promoted_at and p.hits >= th]),
        "promoteMinHits": th,
        "enabled": _evolution_enabled(),
    }


def _append_evolution_to_skill_md(skill_id: str, line: str) -> None:
    """晋级时追加到 skills/<id>/skill.md 的 ## Evolution 段（若可写）。"""
    roots = [
        Path(__file__).resolve().parents[3] / "skills" / skill_id / "skill.md",
        Path(__file__).resolve().parents[2].parent / "skills" / skill_id / "skill.md",
    ]
    entry = f"- {_clip(line, 180)}"
    for path in roots:
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
            if entry in text:
                return
            if "## Evolution" in text:
                text = text.rstrip() + f"\n{entry}\n"
            else:
                text = text.rstrip() + f"\n\n## Evolution\n\n{entry}\n"
            path.write_text(text, encoding="utf-8")
            from app.core.playbook_loader import clear_playbook_cache

            clear_playbook_cache()
            return
        except OSError:
            continue


def promote_prompt_patch(patch_id: str) -> dict[str, Any]:
    patches = _load_shadow()
    patch = next((p for p in patches if p.id == patch_id), None)
    if not patch:
        return {"ok": False, "reason": "patch_not_found"}
    if patch.voided:
        return {"ok": False, "reason": "patch_voided"}
    if patch.promoted_at:
        return {"ok": False, "reason": "already_promoted"}
    if not _stage_evolution_allowed(patch.stage):
        return {"ok": False, "reason": "stage_not_allowed_in_execution_only_mode"}

    skill_id = STAGE_SKILL_MAP[patch.stage]
    hint_id = f"evolved_{patch.stage}_{patch.id[-8:]}"
    now = datetime.now(timezone.utc).isoformat()

    hints = _load_evolved()
    hints.append(
        EvolvedHint(
            id=hint_id,
            stage=patch.stage,
            skill_id=skill_id,
            text=patch.text,
            source_patch_id=patch.id,
            promoted_at=now,
        )
    )
    _save_evolved(hints)

    patch.promoted_at = now
    patch.promoted_hint_id = hint_id
    patch.promoted_skill = skill_id
    _save_shadow(patches)

    _append_evolution_to_skill_md(skill_id, patch.text)
    return {"ok": True, "hintId": hint_id, "skillId": skill_id}


def promote_prompt_patch_verified(patch_id: str) -> dict[str, Any]:
    from app.core.evolution_verify import verify_admin_evolution_promote

    verify = verify_admin_evolution_promote()
    if not verify.get("ok"):
        return {"ok": False, "reason": f"verify_failed:{verify.get('reason') or verify.get('gate')}"}
    return promote_prompt_patch(patch_id)


def auto_promote_eligible_patches(min_hits: int | None = None) -> list[str]:
    th = min_hits if min_hits is not None else promote_min_hits()
    promoted: list[str] = []
    for row in list_promotable_patches(th):
        res = promote_prompt_patch_verified(str(row.get("id") or ""))
        if res.get("ok"):
            promoted.append(str(res.get("hintId")))
    return promoted


def clear_prompt_patches() -> None:
    _save_shadow([])


def clear_evolved_hints() -> None:
    _save_evolved([])
