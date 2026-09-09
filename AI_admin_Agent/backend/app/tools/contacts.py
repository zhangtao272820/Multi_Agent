from __future__ import annotations

from app.core.tenant_scope import require_request_scope
from app.core.user_preferences import learn_email_contact
from app.db.database import Contact, SessionLocal
from app.tools.common import CONTACT_NOT_FOUND, _EMAIL_RE, _tool_err, _tool_ok


def _owner_filter(query):
    tid, uid = require_request_scope()
    return query.filter(Contact.tenant_id == tid, Contact.user_id == uid), tid, uid


def add_contact(name: str, email: str, description: str = "") -> str:
    db = SessionLocal()
    clean_name = (name or "").strip()
    clean_email = (email or "").strip()
    tid, uid = require_request_scope()
    if not clean_name or not clean_email:
        db.close()
        return _tool_err(
            "添加联系人失败：name 或 email 为空。",
            data={"name": clean_name, "email": clean_email},
            code="missing_required_fields",
        )
    if not _EMAIL_RE.match(clean_email):
        db.close()
        return _tool_err(
            f"添加联系人失败：邮箱「{clean_email}」格式不正确。",
            data={"name": clean_name, "email": clean_email},
            code="invalid_email",
        )

    existing = (
        db.query(Contact)
        .filter(
            Contact.tenant_id == tid,
            Contact.user_id == uid,
            Contact.name.ilike(clean_name),
        )
        .order_by(Contact.id.desc())
        .first()
    )
    if existing:
        existing.email = clean_email
        if description is not None and str(description).strip():
            existing.description = description
        db.commit()
        db.close()
        learn_email_contact(None, clean_name, clean_email)
        return _tool_ok(
            f"已更新联系人: {clean_name} ({clean_email})",
            data={"name": clean_name, "email": clean_email, "updated": True},
            code="updated",
        )

    contact = Contact(
        name=clean_name,
        email=clean_email,
        description=description,
        tenant_id=tid,
        user_id=uid,
    )
    db.add(contact)
    db.commit()
    db.refresh(contact)
    db.close()
    learn_email_contact(None, clean_name, clean_email)
    return _tool_ok(
        f"已添加联系人: {clean_name} ({clean_email})",
        data={"contact_id": contact.id, "name": clean_name, "email": clean_email, "updated": False},
        code="created",
    )


def search_contact(name: str) -> str:
    db = SessionLocal()
    q = (name or "").strip()
    tid, uid = require_request_scope()
    contact = (
        db.query(Contact)
        .filter(
            Contact.tenant_id == tid,
            Contact.user_id == uid,
            Contact.name.ilike(f"%{q}%"),
        )
        .order_by(Contact.id.desc())
        .first()
    )
    db.close()
    if not contact:
        return f"未找到名为 '{name}' 的联系人邮箱。"
    return f"找到联系人 {contact.name} 的邮箱为: {contact.email}"


def list_contacts() -> str:
    """列出联系人（用于邮件/沟通等场景）"""
    db = SessionLocal()
    tid, uid = require_request_scope()
    contacts = (
        db.query(Contact)
        .filter(Contact.tenant_id == tid, Contact.user_id == uid)
        .order_by(Contact.id.desc())
        .all()
    )
    db.close()
    if not contacts:
        return _tool_ok("当前没有联系人。", data={"items": [], "count": 0}, code="empty")
    lines = ["联系人列表："]
    items = []
    for c in contacts[:50]:
        desc = f"（{c.description}）" if (c.description or "").strip() else ""
        lines.append(f"- [{c.id}] {c.name} <{c.email}>{desc}")
        items.append(
            {
                "id": c.id,
                "name": c.name,
                "email": c.email,
                "description": c.description or "",
            }
        )
    return _tool_ok("\n".join(lines), data={"items": items, "count": len(items)})


def get_contact_email(name: str) -> str:
    """供链式调用：仅返回邮箱字符串；找不到则返回固定占位，便于 send_email 识别。"""
    db = SessionLocal()
    q = (name or "").strip()
    tid, uid = require_request_scope()
    contact = (
        db.query(Contact)
        .filter(
            Contact.tenant_id == tid,
            Contact.user_id == uid,
            Contact.name.ilike(f"%{q}%"),
        )
        .order_by(Contact.id.desc())
        .first()
    )
    db.close()
    if not contact or not (contact.email or "").strip():
        return CONTACT_NOT_FOUND
    return contact.email.strip()


def import_contacts(file_path: str, file_format: str = "auto") -> dict:
    """从当前用户 workspace 内 vCard/CSV 文件批量导入联系人。"""
    import os

    from app.core.config import settings
    from app.core.contact_import import parse_contacts_file, summarize_import
    from app.core.tenant_scope import user_workspace_dir

    rel = str(file_path or "").strip().replace("\\", "/").lstrip("/")
    if not rel:
        return _tool_err("请提供通讯录文件路径（相对 workspace）", code="missing_file_path")
    if ".." in rel.split("/"):
        return _tool_err("文件路径不允许包含 ..", code="invalid_path")

    root = user_workspace_dir(settings.WORKSPACE_DIR)
    abs_path = os.path.join(root, rel)
    if not os.path.isfile(abs_path):
        return _tool_err(f"文件不存在: {rel}", code="file_not_found")

    try:
        text = open(abs_path, encoding="utf-8", errors="replace").read()
        rows = parse_contacts_file(text, file_format)
    except Exception as exc:
        return _tool_err(f"解析通讯录失败: {exc}", code="parse_failed")

    if not rows:
        return _tool_ok("文件内没有可导入的联系人。", data={"items": [], "count": 0}, code="empty")

    db = SessionLocal()
    tid, uid = require_request_scope()
    results: list[dict] = []
    try:
        for row in rows:
            name = str(row.get("name") or "").strip()
            email = str(row.get("email") or "").strip()
            desc = str(row.get("description") or "").strip()
            if not name or not email:
                results.append({"name": name, "email": email, "status": "failed", "reason": "missing_fields"})
                continue
            if not _EMAIL_RE.match(email):
                results.append({"name": name, "email": email, "status": "failed", "reason": "invalid_email"})
                continue
            existing = (
                db.query(Contact)
                .filter(
                    Contact.tenant_id == tid,
                    Contact.user_id == uid,
                    Contact.name.ilike(name),
                )
                .order_by(Contact.id.desc())
                .first()
            )
            if existing:
                existing.email = email
                if desc:
                    existing.description = desc
                db.commit()
                learn_email_contact(None, name, email)
                results.append({"name": name, "email": email, "status": "updated", "contact_id": existing.id})
                continue
            dup_email = (
                db.query(Contact)
                .filter(
                    Contact.tenant_id == tid,
                    Contact.user_id == uid,
                    Contact.email.ilike(email),
                )
                .first()
            )
            if dup_email:
                results.append({"name": name, "email": email, "status": "skipped", "reason": "duplicate_email"})
                continue
            contact = Contact(name=name, email=email, description=desc, tenant_id=tid, user_id=uid)
            db.add(contact)
            db.commit()
            db.refresh(contact)
            learn_email_contact(None, name, email)
            results.append({"name": name, "email": email, "status": "created", "contact_id": contact.id})
    finally:
        db.close()

    stats = summarize_import(results)
    human = (
        f"通讯录导入完成：新增 {stats['created']}，更新 {stats['updated']}，"
        f"跳过 {stats['skipped']}，失败 {stats['failed']}。"
    )
    return _tool_ok(human, data={"items": results, "stats": stats, "source": rel}, code="imported")
