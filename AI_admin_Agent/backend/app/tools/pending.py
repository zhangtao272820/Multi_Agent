from __future__ import annotations

import json
from typing import Any

from app.db.database import PendingAction, SessionLocal
from app.core.time_utils import utc_now_naive
from app.tools.common import _audit, _tool_err, _tool_ok
from app.tools.time_parse import prepare_time_sensitive_tool_args, filter_tool_call_kwargs

def _filter_tool_kwargs(tool_name: str, tool_args: dict) -> dict:
    return filter_tool_call_kwargs(tool_name, tool_args)


def create_pending_action(
    session_id: str,
    tool_name: str,
    tool_args: dict,
    user_message: str = "",
    understanding: dict | None = None,
) -> str:
    """创建待确认动作，返回 action_id（字符串）。"""
    tool_args = dict(tool_args or {})
    tool_args = prepare_time_sensitive_tool_args(
        tool_name, tool_args, user_message, understanding
    )
    if user_message:
        tool_args["__user_message__"] = user_message
    if isinstance(understanding, dict) and understanding:
        tool_args["__understanding__"] = understanding
    db = SessionLocal()
    action = PendingAction(
        session_id=session_id or "default",
        tool_name=tool_name,
        tool_args_json=json.dumps(tool_args or {}, ensure_ascii=False),
        status="pending",
    )
    db.add(action)
    db.commit()
    action_id = str(action.id)
    db.close()
    _audit(session_id, f"pending:{tool_name}", tool_args, f"created:{action_id}", status="pending")
    return action_id


def list_pending_actions(session_id: str = "default") -> str:
    db = SessionLocal()
    actions = (
        db.query(PendingAction)
        .filter(PendingAction.session_id == (session_id or "default"))
        .filter(PendingAction.status == "pending")
        .order_by(PendingAction.created_at.desc())
        .all()
    )
    db.close()
    if not actions:
        return _tool_ok(
            "当前没有待确认的操作。",
            data={"items": [], "count": 0, "session_id": session_id or "default"},
            code="empty",
        )
    lines = ["待确认操作列表："]
    items = []
    for a in actions[:20]:
        lines.append(f"- [{a.id}] {a.tool_name} args={a.tool_args_json}")
        row: dict[str, Any] = {
            "id": a.id,
            "tool_name": a.tool_name,
            "tool_args_json": a.tool_args_json,
            "status": a.status,
        }
        if a.tool_name in ("send_email", "reply_email", "forward_email", "delete_email"):
            try:
                from app.core.mail_pending_preview import format_mail_pending_preview

                preview = format_mail_pending_preview(a.tool_name, a.get_args())
                mc = preview.get("mail_compose")
                if isinstance(mc, dict):
                    row["mail_compose"] = mc
                    row["title"] = preview.get("title") or a.tool_name
            except Exception:
                pass
        items.append(row)
    return _tool_ok(
        "\n".join(lines),
        data={"items": items, "count": len(items), "session_id": session_id or "default"},
    )


def patch_pending_mail_compose(
    session_id: str,
    action_id: int,
    *,
    content: str | None = None,
    subject: str | None = None,
    to: str | None = None,
    cc: str | None = None,
) -> dict:
    """更新仍 pending 的邮件写操作 args（就地改稿，不执行）。"""
    # 在 close() 前拷贝标量，避免 DetachedInstanceError
    tool_name = ""
    args: dict = {}
    err: dict | None = None
    db = SessionLocal()
    try:
        action = (
            db.query(PendingAction)
            .filter(PendingAction.id == int(action_id))
            .filter(PendingAction.session_id == (session_id or "default"))
            .first()
        )
        if not action:
            err = _tool_err(
                "未找到待确认操作。",
                data={"action_id": action_id},
                code="pending_not_found",
            )
        elif action.status != "pending":
            err = _tool_err(
                f"操作 [{action_id}] 状态为 {action.status}，无法改稿。",
                data={
                    "action_id": action_id,
                    "status": str(action.status),
                    "tool_name": str(action.tool_name),
                },
                code="pending_already_decided",
            )
        elif action.tool_name not in ("send_email", "reply_email", "forward_email"):
            err = _tool_err(
                "仅邮件发送类待确认可改稿。",
                data={"tool_name": str(action.tool_name)},
                code="not_mail_compose",
            )
        else:
            tool_name = str(action.tool_name)
            args = dict(action.get_args() or {})
            if content is not None:
                args["content"] = str(content)
            if subject is not None and str(subject).strip():
                args["subject"] = str(subject).strip()
            if to is not None and str(to).strip():
                args["to"] = str(to).strip()
            if cc is not None:
                args["cc"] = str(cc).strip()
            action.tool_args_json = json.dumps(args or {}, ensure_ascii=False)
            db.commit()
    finally:
        db.close()

    if err is not None:
        return err

    _audit(
        session_id,
        f"patch_compose:{tool_name}",
        {"action_id": action_id},
        "patched",
        status="ok",
    )
    return _tool_ok(
        f"已更新待确认邮件草稿 [{action_id}]",
        data={"action_id": action_id, "tool_name": tool_name, "tool_args": args},
        code="compose_patched",
    )


def confirm_action(session_id: str, action_id: int, decision: str) -> str:
    """确认/取消待确认动作。decision: confirm/cancel"""
    db = SessionLocal()
    action = (
        db.query(PendingAction)
        .filter(PendingAction.id == int(action_id))
        .filter(PendingAction.session_id == (session_id or "default"))
        .first()
    )
    if not action:
        db.close()
        return _PENDING_NOT_FOUND
    d = (decision or "").strip().lower()
    if d in ("confirm", "confirmed", "yes", "y", "确认"):
        action.status = "confirmed"
    elif d in ("cancel", "cancelled", "no", "n", "取消"):
        action.status = "cancelled"
    else:
        db.close()
        return "decision 仅支持 confirm 或 cancel。"
    action.decided_at = utc_now_naive()
    db.commit()
    tool_name = action.tool_name
    tool_args = action.get_args()
    status = action.status
    db.close()
    _audit(session_id, f"confirm:{tool_name}", {"action_id": action_id, "decision": decision}, status, status="ok")
    return f"已将操作 [{action_id}] 标记为 {status}：{tool_name}"


def decide_action(
    session_id: str,
    action_id: int,
    decision: str,
    mail_compose: dict | None = None,
) -> str:
    """
    二次确认入口：confirm 会执行该 action 绑定的工具；cancel 则取消不执行。
    mail_compose：可选，Compose Card 编辑后的 to/cc/subject/content（仅邮件写操作）。
    """
    db = SessionLocal()
    action = (
        db.query(PendingAction)
        .filter(PendingAction.id == int(action_id))
        .filter(PendingAction.session_id == (session_id or "default"))
        .first()
    )
    if not action:
        db.close()
        return _tool_err(
            "未找到待确认操作。",
            data={"action_id": action_id, "session_id": session_id},
            code="pending_not_found",
        )

    if action.status != "pending":
        tool_name = str(action.tool_name)
        status = str(action.status)
        db.close()
        return _tool_err(
            f"操作 [{action_id}] 当前状态为 {status}，无需重复处理：{tool_name}",
            data={"action_id": action_id, "tool_name": tool_name, "status": status},
            code="pending_already_decided",
        )

    d = (decision or "").strip().lower()
    if d in ("cancel", "cancelled", "no", "n", "取消"):
        action.status = "cancelled"
        action.decided_at = utc_now_naive()
        tool_name = str(action.tool_name)
        db.commit()
        db.close()
        if tool_name in ("send_email", "reply_email", "forward_email", "delete_email"):
            try:
                from app.core.mail_metrics import mail_metric_inc

                mail_metric_inc("mail_hitl_cancel")
            except Exception:
                pass
        _audit(session_id, f"decide:{tool_name}", {"action_id": action_id, "decision": decision}, "cancelled", status="ok")
        return _tool_ok(
            f"已取消操作 [{action_id}]：{tool_name}",
            data={"action_id": action_id, "tool_name": tool_name, "decision": "cancel"},
            code="cancelled",
        )

    if d not in ("confirm", "confirmed", "yes", "y", "确认"):
        tool_name = str(action.tool_name)
        db.close()
        return _tool_err(
            f"无法识别 decision={decision}。请回复：确认 {action_id} 或 取消 {action_id}（工具：{tool_name}）",
            data={"action_id": action_id, "tool_name": tool_name, "decision": decision},
            code="invalid_decision",
        )

    tool_name = str(action.tool_name)
    tool_args = dict(action.get_args() or {})
    if mail_compose and isinstance(mail_compose, dict) and tool_name in (
        "send_email",
        "reply_email",
        "forward_email",
    ):
        from app.core.mail_compose import apply_mail_compose_override

        tool_args = apply_mail_compose_override(tool_args, mail_compose, tool_name=tool_name)
        # 持久化编辑后的 args，避免重复确认用旧稿
        action.tool_args_json = json.dumps(tool_args or {}, ensure_ascii=False)
    action.status = "confirmed"
    action.decided_at = utc_now_naive()
    db.commit()
    db.close()

    # 确认执行前再次锁定时间（待确认参数可能被 LLM 缩写，且确认时无用户原话上下文）
    stored_msg = str(tool_args.get("__user_message__", "") or "")
    stored_understanding = tool_args.get("__understanding__")
    if not isinstance(stored_understanding, dict):
        stored_understanding = None
    tool_args = prepare_time_sensitive_tool_args(
        tool_name, tool_args, stored_msg, stored_understanding
    )

    # 执行真正工具（此处视为已获用户授权，不再二次拦截）
    if tool_name not in _get_available_tools():
        _audit(session_id, f"decide:{tool_name}", {"action_id": action_id}, "tool_not_found", status="error")
        db = SessionLocal()
        action = db.query(PendingAction).filter(PendingAction.id == int(action_id)).first()
        if action:
            action.status = "failed"
            db.commit()
        db.close()
        return _tool_err(
            f"执行失败：工具 {tool_name} 不存在。",
            data={"action_id": action_id, "tool_name": tool_name},
            code="tool_not_found",
        )

    try:
        result = _get_available_tools()[tool_name](**_filter_tool_kwargs(tool_name, tool_args))
        _audit(session_id, tool_name, tool_args, result, status="ok")
        db = SessionLocal()
        action = db.query(PendingAction).filter(PendingAction.id == int(action_id)).first()
        if action:
            action.status = "executed"
            db.commit()
        db.close()
        user_text = ""
        if isinstance(result, dict):
            user_text = str(result.get("human_message", "")).strip()
            data = result.get("data")
            if isinstance(data, dict):
                inner = data.get("tool_result")
                if isinstance(inner, dict) and inner.get("human_message"):
                    user_text = str(inner["human_message"]).strip()
        if not user_text:
            user_text = f"已执行操作 [{action_id}]：{tool_name}"
        return _tool_ok(
            user_text,
            data={
                "action_id": action_id,
                "tool_name": tool_name,
                "tool_result": result,
            },
            code="executed",
        )
    except Exception as e:
        _audit(session_id, tool_name, tool_args, str(e), status="error")
        db = SessionLocal()
        action = db.query(PendingAction).filter(PendingAction.id == int(action_id)).first()
        if action:
            action.status = "failed"
            db.commit()
        db.close()
        return _tool_err(
            f"执行操作 [{action_id}] 失败：{str(e)}",
            data={"action_id": action_id, "tool_name": tool_name},
            code="execute_failed",
        )



def _get_available_tools():
    from app.tools.registry import AVAILABLE_TOOLS
    return AVAILABLE_TOOLS
