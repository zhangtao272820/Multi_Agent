"""邮件附件列出与落盘到 workspace（IMAP，免费）。"""
from __future__ import annotations

from email import message_from_bytes
from pathlib import Path
from typing import Any

import imaplib

from app.tools.common import _MAIL_CACHE_BY_SESSION, _tool_err, _tool_ok
from app.tools.email import _decode_mime_text, _imap_credentials
from app.tools.files import _rel_display, _resolve_workspace_path, _workspace_root


def _iter_attachments(msg):
    """Yield (index, filename, part) for MIME attachments (1-based index)."""
    idx = 0
    for part in msg.walk():
        disp = str(part.get("Content-Disposition") or "")
        filename = part.get_filename()
        if filename:
            filename = _decode_mime_text(filename)
        is_att = "attachment" in disp.lower() or bool(filename)
        if not is_att:
            continue
        if part.get_content_maintype() == "multipart":
            continue
        ctype = part.get_content_type() or ""
        if ctype.startswith("text/") and "attachment" not in disp.lower() and not filename:
            continue
        name = filename or f"attachment_{idx + 1}"
        idx += 1
        yield idx, name, part


def _fetch_cached_message(email_id: int, session_id: str = "default"):
    sid = (session_id or "default").strip() or "default"
    cache = _MAIL_CACHE_BY_SESSION.get(sid, {})
    meta = cache.get(int(email_id))
    if not meta:
        return None, None, _tool_err(
            "未找到该邮件，请先 list_emails。",
            data={"email_id": email_id, "session_id": sid},
            code="email_not_found_in_cache",
        )
    imap_uid = meta.get("imap_uid")
    if not imap_uid:
        return None, None, _tool_err("邮件缓存不完整，请刷新收件箱。", code="email_cache_stale")
    server, port, user, password = _imap_credentials()
    if not user or not password:
        return None, None, _tool_err("IMAP 未配置。", code="imap_not_configured")
    mailbox = imaplib.IMAP4_SSL(server, port)
    mailbox.login(user, password)
    mailbox.select("INBOX", readonly=True)
    status, msg_data = mailbox.fetch(str(imap_uid).encode(), "(RFC822)")
    mailbox.logout()
    if status != "OK" or not msg_data or not msg_data[0]:
        return None, None, _tool_err("无法读取邮件。", code="imap_fetch_failed")
    msg = message_from_bytes(msg_data[0][1])
    return meta, msg, None


def list_email_attachments(email_id: int, session_id: str = "default") -> Any:
    """列出某封邮件的附件名（需先 list_emails）。"""
    meta, msg, err = _fetch_cached_message(email_id, session_id)
    if err is not None:
        return err
    items = []
    for idx, name, part in _iter_attachments(msg):
        payload = part.get_payload(decode=True) or b""
        items.append(
            {
                "index": idx,
                "filename": name,
                "content_type": part.get_content_type() or "",
                "size": len(payload),
            }
        )
    if not items:
        return _tool_ok(
            f"邮件 #{email_id} 无附件。",
            data={"email_id": int(email_id), "attachments": [], "count": 0},
            code="empty",
        )
    lines = [f"邮件 #{email_id} 附件（{len(items)}）："]
    for it in items:
        lines.append(f"{it['index']}. {it['filename']} ({it['size']} bytes, {it['content_type']})")
    lines.append("可用 save_email_attachment(email_id, attachment_index=N) 保存到工作区。")
    return _tool_ok(
        "\n".join(lines),
        data={
            "email_id": int(email_id),
            "attachments": items,
            "count": len(items),
            "subject": (meta or {}).get("subject"),
        },
    )


def save_email_attachment(
    email_id: int,
    attachment_index: int = 1,
    filename: str = "",
    dest_path: str = "",
    session_id: str = "default",
) -> Any:
    """将邮件附件保存到工作区（IMAP 免费路径）。"""
    meta, msg, err = _fetch_cached_message(email_id, session_id)
    if err is not None:
        return err
    attachments = list(_iter_attachments(msg))
    if not attachments:
        return _tool_err("该邮件无附件。", code="no_attachments")
    chosen = None
    want_name = (filename or "").strip()
    want_idx = int(attachment_index or 1)
    for idx, name, part in attachments:
        if want_name and name == want_name:
            chosen = (idx, name, part)
            break
        if not want_name and idx == want_idx:
            chosen = (idx, name, part)
            break
    if chosen is None:
        names = [n for _, n, _ in attachments]
        return _tool_err(
            f"未找到附件。可用: {', '.join(names)}",
            data={"filenames": names},
            code="attachment_not_found",
        )
    idx, name, part = chosen
    payload = part.get_payload(decode=True) or b""
    if not payload:
        return _tool_err("附件内容为空。", code="empty_attachment")
    safe_name = Path(name).name.replace("..", "_").strip() or f"attachment_{idx}"
    rel = (dest_path or f"mail_attachments/{int(email_id)}_{safe_name}").strip().replace("\\", "/")
    target = _resolve_workspace_path(rel, allow_missing=True)
    if target is None or target == _workspace_root():
        return _tool_err("非法目标路径。", code="path_escape")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        return _tool_ok(
            f"已保存附件到工作区: {_rel_display(target)}",
            data={
                "email_id": int(email_id),
                "attachment_index": idx,
                "filename": safe_name,
                "file_path": _rel_display(target),
                "size": len(payload),
                "subject": (meta or {}).get("subject"),
            },
        )
    except Exception as e:
        return _tool_err(f"保存附件失败: {e}", code="save_attachment_failed")
