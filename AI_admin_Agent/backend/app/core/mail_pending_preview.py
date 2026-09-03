"""AM-4：邮件 RISKY 待确认预览文案（纯函数，可 smoke）。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from app.core.mail_compose import build_mail_compose


def _clip(text: str, n: int = 280) -> str:
    s = str(text or "").strip()
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


def _list_field(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, list):
        return ", ".join(str(x).strip() for x in v if str(x).strip())
    return str(v).strip()


def _attachment_names(paths: Any) -> list[str]:
    raw: list[str] = []
    if isinstance(paths, str) and paths.strip():
        raw = [p.strip() for p in paths.replace(";", ",").split(",") if p.strip()]
    elif isinstance(paths, list):
        raw = [str(x).strip() for x in paths if str(x).strip()]
    names: list[str] = []
    for p in raw[:8]:
        names.append(Path(p).name or p)
    return names


def resolve_bound_from_address(user_id: str | None) -> str:
    """绑定箱发件身份；未绑定则标明未绑定（不读明文授权码）。"""
    uid = str(user_id or "").strip()
    if not uid:
        return "（未指定用户 / 未绑定）"
    try:
        from app.core.mailbox_binding import get_binding_row

        row = get_binding_row(uid)
        if row and getattr(row, "email_address", None):
            return str(row.email_address).strip()
    except Exception:
        pass
    return "（未绑定邮箱）"


def _enrich_from_mail_cache(args: dict[str, Any]) -> dict[str, Any]:
    """reply/forward/delete 常缺 to/subject；从会话 mail cache 补全预览字段。"""
    out = dict(args)
    eid = out.get("email_id")
    if eid is None:
        return out
    try:
        from app.tools.common import get_mail_cache

        uid = str(out.get("user_id") or "").strip()
        sid = str(out.get("session_id") or "default").strip() or "default"
        meta = get_mail_cache(uid, sid).get(int(eid)) or {}
        if not out.get("to") and meta.get("from_email"):
            out["to"] = meta.get("from_email")
        if not out.get("subject") and meta.get("subject"):
            out["subject"] = meta.get("subject")
    except Exception:
        pass
    return out


def format_mail_pending_preview(
    tool_name: str,
    tool_args: dict[str, Any] | None,
    *,
    from_address: str | None = None,
) -> dict[str, Any]:
    """
    返回 pending 卡字段：
    - title: 短标题
    - message: 用户可见确认文案（含 from/to/cc/subject/body 摘要）
    - mail_compose: Compose Card 结构化载荷（可编辑后 commit）
    """
    args = _enrich_from_mail_cache(dict(tool_args or {}))
    name = str(tool_name or "").strip()
    from_addr = (from_address or "").strip() or resolve_bound_from_address(
        str(args.get("user_id") or "").strip() or None
    )
    mail_compose = build_mail_compose(name, args, from_address=from_addr)

    if name == "delete_email":
        eid = args.get("email_id")
        subj = str(args.get("subject") or args.get("__subject__") or "").strip() or "(未知主题)"
        permanent = bool(args.get("permanent"))
        action = "永久删除" if permanent else "移入废纸篓"
        title = f"{action}邮件 #{eid}"
        lines = [
            f"【待确认】将{action}邮件。",
            f"发件身份（绑定箱）：{from_addr}",
            f"邮件编号：{eid}",
            f"主题：{subj}",
            "",
            "请点击下方「确认」或「取消」按钮。",
        ]
        mail_compose["subject"] = subj
        mail_compose["digest"] = build_mail_compose(name, {**args, "subject": subj}, from_address=from_addr)[
            "digest"
        ]
        return {
            "title": title,
            "message": "\n".join(lines),
            "tool": name,
            "mail_compose": mail_compose,
        }

    to = _list_field(args.get("to") or args.get("recipient") or "")
    cc = _list_field(args.get("cc") or "")
    bcc = _list_field(args.get("bcc") or "")
    subject = str(mail_compose.get("subject") or "").strip() or "(无主题)"
    body = str(mail_compose.get("content") or "")
    body_preview = _clip(body, 320)
    atts = _attachment_names(args.get("attachment_paths"))

    if name == "reply_email":
        eid = args.get("email_id")
        verb = "回复"
        title = f"回复邮件 #{eid}" if eid is not None else "回复邮件"
    elif name == "forward_email":
        eid = args.get("email_id")
        verb = "转发"
        title = f"转发邮件 #{eid}" if eid is not None else "转发邮件"
    else:
        verb = "发送"
        title = f"发送邮件：{_clip(subject, 40)}"

    lines = [
        f"【待确认】将{verb}以下邮件。可在下方 Compose 卡中修改后再确认。",
        f"发件人（绑定箱）：{from_addr}",
        f"收件人：{to or '（未填）'}",
    ]
    if cc:
        lines.append(f"抄送：{cc}")
    if bcc:
        lines.append(f"密送：{bcc}")
    lines.append(f"主题：{subject}")
    if atts:
        lines.append(f"附件：{', '.join(atts)}")
    lines.append("正文摘要：")
    lines.append(body_preview or "（空）")
    lines.append("")
    lines.append("请在 Compose 卡编辑后点「确认发送」，或「取消」。取消则不会发送。")
    return {
        "title": title,
        "message": "\n".join(lines),
        "tool": name,
        "mail_compose": mail_compose,
    }
