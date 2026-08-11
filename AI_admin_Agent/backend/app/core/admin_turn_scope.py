"""
Admin 轮次范围判定：默认 current_only，仅短句承接走 continuation。
对齐总管 turnScope（Rasa conversation boundaries）。
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any

from app.core.admin_chitchat_fastpath import is_admin_chitchat_message
from app.core.llm import qwen_llm


@dataclass
class AdminTurnScope:
    mode: str  # current_only | continuation | topic_shift | chitchat
    suppress_history: bool
    suppress_anchor: bool
    suppress_experience_replay: bool
    turn_kind: str = ""
    narrow_output_followup: bool = False
    rationale: str = ""


def is_admin_turn_scope_llm_enabled() -> bool:
    return os.getenv("ADMIN_TURN_SCOPE_LLM", "1").strip().lower() not in ("0", "false", "no")


def _isolated_mode(mode: str) -> bool:
    return mode in ("current_only", "topic_shift", "chitchat")


def _scope_from_mode(mode: str, rationale: str = "", turn_kind: str = "") -> AdminTurnScope:
    isolated = _isolated_mode(mode)
    kind = turn_kind or (
        "chitchat"
        if mode == "chitchat"
        else "continuation"
        if mode == "continuation"
        else "new_task"
    )
    return AdminTurnScope(
        mode=mode,
        suppress_history=isolated,
        suppress_anchor=isolated,
        suppress_experience_replay=isolated,
        turn_kind=kind,
        rationale=rationale,
    )


def _looks_like_output_followup(last: str) -> bool:
    compact = re.sub(r"\s+", "", str(last or ""))
    if not compact or len(compact) > 28:
        return False
    cues = ("翻译", "详细", "总结", "改成", "换种", "再说", "格式", "要点", "精简", "英文", "中文", "再写")
    return any(c in compact for c in cues)


def _looks_like_continuation(last: str, prev: str) -> bool:
    if not last or not prev:
        return False
    if len(last) > 220:
        return False
    compact = re.sub(r"\s+", "", last)
    refer = ("这个", "那个", "上述", "继续", "呢", "它", "他们", "刚才", "上面")
    if len(compact) <= 8 and any(w in compact for w in refer):
        return True
    # 自包含办公/时间句（非极短续问）→ 非承接
    if len(last) >= 8 and re.search(r"(点|号|日|月|开会|会议|日程|待办|邮件|天气|查|帮我|请)", last):
        if len(last) >= max(8, int(len(prev) * 0.55)):
            return False
    if len(last) <= max(48, int(len(prev) * 0.52)):
        return True
    if len(prev) >= 80 and len(last) / max(len(prev), 1) <= 0.45:
        return True
    return False


def _structural_turn_scope(user_message: str, dialogue: str) -> AdminTurnScope:
    msg = str(user_message or "").strip()
    if not msg:
        return _scope_from_mode("current_only", "empty", "new_task")

    if is_admin_chitchat_message(msg):
        return _scope_from_mode("chitchat", "chitchat_fastpath", "chitchat")

    dlg = str(dialogue or "").strip()
    if not dlg:
        return _scope_from_mode("current_only", "single_turn", "new_task")

    lines = [ln.strip() for ln in dlg.splitlines() if ln.strip()]
    prev_user = ""
    for ln in reversed(lines):
        if ln.startswith("用户："):
            prev_user = ln.replace("用户：", "", 1).strip()
            break

    if _looks_like_output_followup(msg):
        return AdminTurnScope(
            mode="continuation",
            suppress_history=False,
            suppress_anchor=False,
            suppress_experience_replay=False,
            turn_kind="output_followup",
            narrow_output_followup=True,
            rationale="structural_output_followup",
        )

    if _looks_like_continuation(msg, prev_user):
        return AdminTurnScope(
            mode="continuation",
            suppress_history=False,
            suppress_anchor=False,
            suppress_experience_replay=False,
            turn_kind="continuation",
            rationale="structural_continuation",
        )

    if len(msg) >= 40 or re.search(r"(帮我|请|添加|查|搜索|天气|邮件|待办|日程|开会|会议|删除|列出)", msg):
        return _scope_from_mode("topic_shift", "new_self_contained_task", "new_task")

    return _scope_from_mode("current_only", "default_isolated", "new_task")


def _structural_turn_scope_is_decisive(scope: AdminTurnScope) -> bool:
    """启发式已足够确定轮次范围时，跳过 turn_scope LLM（非意图路由）。"""
    if scope.mode in ("chitchat", "continuation", "topic_shift"):
        return True
    if scope.mode == "current_only":
        return scope.rationale in (
            "empty",
            "single_turn",
            "default_isolated",
            "new_self_contained_task",
        )
    return False


def _llm_turn_scope(user_message: str, dialogue: str) -> AdminTurnScope | None:
    if not is_admin_turn_scope_llm_enabled():
        return None
    msg = str(user_message or "").strip()
    dlg = str(dialogue or "").strip()
    prompt = (
        "你是 Admin 办公 Agent 的轮次范围判定器。只判断本轮如何携带对话历史，不决定具体意图。\n"
        "mode：chitchat | topic_shift | continuation | current_only\n"
        "末轮为自包含完整办公诉求时选 current_only 或 topic_shift，勿 continuation。\n"
        '只输出 JSON：{"mode":"...","confidence":0-1,"turn_kind":"new_task|continuation|output_followup|chitchat","rationale":"..."}\n\n'
        f"【用户末轮】\n{msg[:900]}\n\n"
        f"【近期对话】\n{dlg[:1600] if dlg else '（无）'}"
    )
    try:
        raw = qwen_llm.chat_text_json([{"role": "user", "content": prompt}]).strip()
        start = raw.find("{")
        end = raw.rfind("}")
        if start < 0 or end <= start:
            return None
        data = json.loads(raw[start : end + 1])
        mode = str(data.get("mode") or "").strip()
        conf = float(data.get("confidence") or 0)
        if conf < 0.42 or mode not in ("current_only", "continuation", "topic_shift", "chitchat"):
            return None
        rationale = str(data.get("rationale") or "")[:480]
        turn_kind = str(data.get("turn_kind") or "").strip()
        if turn_kind not in ("new_task", "continuation", "output_followup", "slot_answer", "chitchat"):
            turn_kind = ""
        if mode == "chitchat":
            return _scope_from_mode("chitchat", rationale, turn_kind or "chitchat")
        if turn_kind == "output_followup":
            return AdminTurnScope(
                mode="continuation",
                suppress_history=False,
                suppress_anchor=False,
                suppress_experience_replay=False,
                turn_kind="output_followup",
                narrow_output_followup=True,
                rationale=rationale or "llm_output_followup",
            )
        if mode == "continuation":
            return AdminTurnScope(
                mode="continuation",
                suppress_history=False,
                suppress_anchor=False,
                suppress_experience_replay=False,
                turn_kind=turn_kind or "continuation",
                rationale=rationale,
            )
        return _scope_from_mode(mode, rationale, turn_kind or "new_task")
    except Exception:
        return None


def classify_admin_turn_scope(
    user_message: str,
    dialogue: str = "",
    *,
    manager_orchestrated: bool = False,
) -> AdminTurnScope:
    structural = _structural_turn_scope(user_message, dialogue)
    # 结构路径已给出 turn_kind（含 output_followup）时优先采纳，少靠 LLM regex 主路径
    if structural.mode in ("chitchat", "continuation") or structural.turn_kind == "output_followup":
        return structural
    if manager_orchestrated:
        return structural
    if _structural_turn_scope_is_decisive(structural):
        return structural
    if not is_admin_turn_scope_llm_enabled():
        return structural
    llm = _llm_turn_scope(user_message, dialogue)
    if llm:
        if structural.mode == "topic_shift" and llm.mode == "continuation":
            return structural
        return llm
    return structural


def dialogue_for_nlu(dialogue: str, scope: AdminTurnScope) -> str:
    if scope.suppress_history:
        return ""
    dlg = str(dialogue or "").strip()
    if not dlg:
        return ""
    if scope.narrow_output_followup or scope.turn_kind == "output_followup":
        lines = [ln.strip() for ln in dlg.splitlines() if ln.strip()]
        # 仅保留最近一条助手 + 可选最近一条用户（窄上下文，禁止全文跑题重分类）
        last_asst = ""
        last_user = ""
        for ln in reversed(lines):
            if not last_asst and ln.startswith("助手："):
                last_asst = ln
            elif not last_user and ln.startswith("用户："):
                last_user = ln
            if last_asst and last_user:
                break
        parts = [p for p in (last_user, last_asst) if p]
        return "\n".join(parts) if parts else last_asst or last_user
    return dlg


def turn_scope_to_dict(scope: AdminTurnScope) -> dict[str, Any]:
    out: dict[str, Any] = {
        "mode": scope.mode,
        "suppress_history": scope.suppress_history,
        "suppress_anchor": scope.suppress_anchor,
        "suppress_experience_replay": scope.suppress_experience_replay,
        "rationale": scope.rationale,
    }
    if scope.turn_kind:
        out["turn_kind"] = scope.turn_kind
    if scope.narrow_output_followup:
        out["narrow_output_followup"] = True
    return out


def scope_from_manager_turn_scope(raw: Any) -> AdminTurnScope | None:
    """总管编排侧车 turn_scope → AdminTurnScope（对齐 shared/turnScope.ts）。"""
    if not isinstance(raw, dict):
        return None
    mode = str(raw.get("mode") or "").strip()
    if mode not in ("current_only", "continuation", "topic_shift", "chitchat"):
        return None
    turn_kind = str(raw.get("turn_kind") or "").strip()
    narrow = raw.get("narrow_output_followup") is True or turn_kind == "output_followup"
    suppress_history = False if narrow else bool(raw.get("suppress_history"))
    suppress_anchor = False if narrow else bool(raw.get("suppress_anchor"))
    suppress_exp = bool(raw.get("suppress_experience_replay"))
    if not narrow and not raw.get("suppress_history") and _isolated_mode(mode):
        suppress_history = True
        suppress_anchor = True
        suppress_exp = True
    return AdminTurnScope(
        mode=mode,
        suppress_history=suppress_history,
        suppress_anchor=suppress_anchor,
        suppress_experience_replay=suppress_exp,
        turn_kind=turn_kind,
        narrow_output_followup=narrow,
        rationale="manager_turn_scope",
    )
