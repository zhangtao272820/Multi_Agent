from __future__ import annotations

from app.core.time_utils import to_utc_naive, utc_naive_to_local_naive, utc_now_naive
from app.db.database import SessionLocal, Task
from app.tools.common import _tool_err, _tool_ok
from app.tools.time_parse import _resolve_stored_event_time

def add_task(title: str, description: str = "") -> str:
    db = SessionLocal()
    task = Task(title=title, description=description)
    db.add(task)
    db.commit()
    db.refresh(task)
    db.close()
    return _tool_ok(
        f"已添加待办事项: {title}",
        data={"task_id": task.id, "title": title, "description": description or ""},
    )


def add_task_with_due(
    title: str,
    due_time_str: str,
    description: str = "",
    due_time_local: str | None = None,
) -> str:
    try:
        # Parse user expression in local time, store as UTC-naive.
        due_at = to_utc_naive(
            _resolve_stored_event_time(due_time_str, due_time_local)
        )
    except ValueError as e:
        return _tool_err(
            str(e),
            data={"title": title, "due_time_str": due_time_str},
            code="time_parse_failed",
        )
    db = SessionLocal()
    task = Task(title=title, description=description, due_at=due_at)
    db.add(task)
    db.commit()
    db.refresh(task)
    db.close()
    due_local = utc_naive_to_local_naive(due_at)
    human = f"已添加待办事项: {title}（截止：{due_local.strftime('%Y-%m-%d %H:%M')}）"
    return _tool_ok(
        human,
        data={
            "task_id": task.id,
            "title": title,
            "description": description or "",
            "due_at_local": due_local.strftime("%Y-%m-%d %H:%M:%S"),
            "due_at_utc_naive": due_at.strftime("%Y-%m-%d %H:%M:%S"),
        },
    )


def modify_task(
    task_id: int,
    title: str | None = None,
    description: str | None = None,
    due_time_str: str | None = None,
    due_time_local: str | None = None,
) -> str:
    """更新待办标题/详细说明/截止时间（人能改的字段 AI 也能改）。"""
    db = SessionLocal()
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        db.close()
        return _tool_err(
            f"未找到ID为 {task_id} 的待办事项。",
            data={"task_id": task_id},
            code="task_not_found",
        )
    if title is not None and str(title).strip():
        task.title = str(title).strip()
    if description is not None:
        task.description = str(description)
    if due_time_str is not None and str(due_time_str).strip():
        try:
            task.due_at = to_utc_naive(_resolve_stored_event_time(str(due_time_str), due_time_local))
        except ValueError as e:
            db.close()
            return _tool_err(
                str(e),
                data={"task_id": task_id, "due_time_str": due_time_str},
                code="time_parse_failed",
            )
    db.commit()
    db.refresh(task)
    due_local = utc_naive_to_local_naive(task.due_at) if task.due_at else None
    title_out = task.title
    desc_out = task.description or ""
    db.close()
    return _tool_ok(
        f"已更新待办事项: {title_out}",
        data={
            "task_id": task_id,
            "title": title_out,
            "description": desc_out,
            "due_at_local": due_local.strftime("%Y-%m-%d %H:%M:%S") if due_local else None,
        },
    )


def list_tasks() -> str:
    db = SessionLocal()
    tasks = db.query(Task).order_by(Task.created_at.desc()).all()
    db.close()
    if not tasks:
        return _tool_ok(
            "当前没有未完成的待办事项。",
            data={"pending": [], "done": [], "count": 0},
            code="empty",
        )
    now = utc_now_naive()
    pending = []
    done = []
    pending_items = []
    done_items = []
    for t in tasks:
        expired = bool(t.due_at and t.due_at < now)
        is_done = bool(t.completed or expired)
        due_text = (
            f"（截止 {utc_naive_to_local_naive(t.due_at).strftime('%Y-%m-%d %H:%M')}）" if t.due_at else ""
        )
        line = f"- [{'x' if is_done else ' '}] [{t.id}] {t.title}{due_text}"
        if is_done:
            done.append(line + ("（已过期）" if (expired and not t.completed) else ""))
            done_items.append(
                {
                    "id": t.id,
                    "title": t.title,
                    "completed": bool(t.completed),
                    "expired": bool(expired),
                    "due_at": utc_naive_to_local_naive(t.due_at).strftime("%Y-%m-%d %H:%M:%S") if t.due_at else None,
                }
            )
        else:
            pending.append(line)
            pending_items.append(
                {
                    "id": t.id,
                    "title": t.title,
                    "completed": False,
                    "expired": False,
                    "due_at": utc_naive_to_local_naive(t.due_at).strftime("%Y-%m-%d %H:%M:%S") if t.due_at else None,
                }
            )
    res = []
    if pending:
        res.append("未完成待办：")
        res.extend(pending)
    if done:
        res.append("\n已完成/已过期：")
        res.extend(done)
    return _tool_ok(
        "\n".join(res),
        data={
            "pending": pending_items,
            "done": done_items,
            "count": len(pending_items) + len(done_items),
            "pending_count": len(pending_items),
            "done_count": len(done_items),
        },
    )

def complete_task(task_id: int) -> str:
    db = SessionLocal()
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        db.close()
        return _tool_err(
            f"未找到ID为 {task_id} 的待办事项。",
            data={"task_id": task_id},
            code="task_not_found",
        )
    task.completed = True
    db.commit()
    title = task.title
    db.close()
    return _tool_ok(
        f"已完成待办事项: {title}",
        data={"task_id": task_id, "title": title},
    )

def delete_task(task_id: int) -> str:
    db = SessionLocal()
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        db.close()
        return _tool_err(
            f"未找到ID为 {task_id} 的待办事项。",
            data={"task_id": task_id},
            code="task_not_found",
        )
    title = task.title
    db.delete(task)
    db.commit()
    db.close()
    return _tool_ok(
        f"已删除待办事项: {title}",
        data={"task_id": task_id, "title": title},
    )

