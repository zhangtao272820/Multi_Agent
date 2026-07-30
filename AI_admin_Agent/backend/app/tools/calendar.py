from __future__ import annotations

import datetime

from app.core.reminders import reminder_manager
from app.core.time_utils import (
    format_local_display,
    to_utc_naive,
    utc_naive_to_local_naive,
    utc_now_naive,
)
from app.db.database import Event, SessionLocal
from app.tools.common import _tool_err, _tool_ok
from app.tools.time_parse import _resolve_stored_event_time

def add_event(
    title: str,
    start_time_str: str,
    description: str = "",
    start_time_local: str | None = None,
    end_time_str: str | None = None,
    end_time_local: str | None = None,
) -> str:
    try:
        # Parse user expression in local time, store as UTC-naive.
        start_time = to_utc_naive(_resolve_stored_event_time(start_time_str, start_time_local))
    except ValueError as e:
        return _tool_err(
            str(e),
            data={"title": title, "start_time_str": start_time_str},
            code="time_parse_failed",
        )

    end_time = None
    if end_time_str is not None and str(end_time_str).strip():
        try:
            end_time = to_utc_naive(_resolve_stored_event_time(str(end_time_str), end_time_local))
        except ValueError as e:
            return _tool_err(
                str(e),
                data={"title": title, "end_time_str": end_time_str},
                code="end_time_parse_failed",
            )

    db = SessionLocal()
    event = Event(title=title, start_time=start_time, end_time=end_time, description=description or "")
    db.add(event)
    db.commit()
    db.refresh(event)
    db.close()

    now = utc_now_naive()
    start_local_label = format_local_display(start_time)
    if start_time < now:
        human = (
            f"已添加日程: {title}（开始时间 {start_local_label}）。"
            f"开始时间早于当前时间，未设置桌面提醒。"
        )
        return _tool_ok(
            human,
            data={
                "event_id": event.id,
                "title": title,
                "description": description or "",
                "start_time_utc_naive": start_time.strftime("%Y-%m-%d %H:%M:%S"),
                "end_time_utc_naive": end_time.strftime("%Y-%m-%d %H:%M:%S") if end_time else None,
                "reminder_created": False,
            },
            code="created_without_reminder",
        )

    reminder_id = f"event_{event.id}"
    # Scheduler expects local-naive datetime.
    reminder_local = utc_naive_to_local_naive(start_time)
    reminder_manager.add_reminder(title, reminder_local, description, reminder_id=reminder_id)
    human = (
        f"已添加日程并设置提醒: {title}（开始时间 {format_local_display(start_time)}），提醒ID: {reminder_id}"
    )
    return _tool_ok(
        human,
        data={
            "event_id": event.id,
            "title": title,
            "description": description or "",
            "start_time_local": reminder_local.strftime("%Y-%m-%d %H:%M:%S"),
            "start_time_utc_naive": start_time.strftime("%Y-%m-%d %H:%M:%S"),
            "end_time_utc_naive": end_time.strftime("%Y-%m-%d %H:%M:%S") if end_time else None,
            "reminder_created": True,
            "reminder_id": reminder_id,
        },
    )

def list_events() -> str:
    db = SessionLocal()
    events = db.query(Event).order_by(Event.start_time).all()
    db.close()
    if not events:
        return _tool_ok("当前没有日程安排。", data={"items": [], "count": 0}, code="empty")
    res = "日程列表:\n"
    items = []
    for e in events:
        local_time = utc_naive_to_local_naive(e.start_time)
        res += f"- {e.title} ({local_time.strftime('%Y-%m-%d %H:%M')})\n"
        items.append(
            {
                "id": e.id,
                "title": e.title,
                "start_time_local": local_time.strftime("%Y-%m-%d %H:%M:%S"),
                "completed": bool(e.completed),
            }
        )
    return _tool_ok(res.rstrip("\n"), data={"items": items, "count": len(items)})

def modify_event(
    event_id: int,
    title: str = None,
    start_time_str: str = None,
    start_time_local: str | None = None,
    description: str | None = None,
    end_time_str: str | None = None,
    end_time_local: str | None = None,
) -> str:
    db = SessionLocal()
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        db.close()
        return _tool_err(
            f"未找到ID为 {event_id} 的日程。",
            data={"event_id": event_id},
            code="event_not_found",
        )
    if title:
        event.title = title
    if description is not None:
        event.description = str(description)
    if start_time_str is not None and str(start_time_str).strip():
        try:
            event.start_time = to_utc_naive(
                _resolve_stored_event_time(start_time_str, start_time_local)
            )
        except ValueError as e:
            db.close()
            return _tool_err(
                f"修改失败：{e}",
                data={"event_id": event_id, "start_time_str": start_time_str},
                code="time_parse_failed",
            )
    if end_time_str is not None and str(end_time_str).strip():
        try:
            event.end_time = to_utc_naive(_resolve_stored_event_time(str(end_time_str), end_time_local))
        except ValueError as e:
            db.close()
            return _tool_err(
                f"修改结束时间失败：{e}",
                data={"event_id": event_id, "end_time_str": end_time_str},
                code="end_time_parse_failed",
            )
    db.commit()
    reminder_id = f"event_{event_id}"
    now = utc_now_naive()
    if event.start_time and event.start_time >= now:
        reminder_manager.add_reminder(
            event.title,
            utc_naive_to_local_naive(event.start_time),
            event.description or "",
            reminder_id=reminder_id,
        )
    else:
        reminder_manager.cancel_reminder(reminder_id)
    db.close()
    return _tool_ok(
        f"已修改日程 {event_id}",
        data={
            "event_id": event_id,
            "title": event.title,
            "description": event.description or "",
            "start_time_utc_naive": event.start_time.strftime("%Y-%m-%d %H:%M:%S") if event.start_time else None,
            "end_time_utc_naive": event.end_time.strftime("%Y-%m-%d %H:%M:%S") if event.end_time else None,
            "reminder_id": reminder_id,
            "reminder_active": bool(event.start_time and event.start_time >= now),
        },
    )

def delete_event(event_id: int) -> str:
    db = SessionLocal()
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        db.close()
        return _tool_err(
            f"未找到ID为 {event_id} 的日程。",
            data={"event_id": event_id},
            code="event_not_found",
        )
    title = event.title
    db.delete(event)
    db.commit()
    db.close()
    reminder_id = f"event_{event_id}"
    reminder_manager.cancel_reminder(reminder_id)
    return _tool_ok(
        f"已删除日程: {title}",
        data={"event_id": event_id, "title": title, "reminder_id": reminder_id},
    )


def preview_meeting_reminders_purge(limit: int = 20) -> dict:
    """待确认文案用：预览将删除的日程与独立提醒（不写库）。"""
    db = SessionLocal()
    events = db.query(Event).order_by(Event.start_time).all()
    db.close()
    event_items = []
    for e in events[: max(1, int(limit or 20))]:
        local_time = utc_naive_to_local_naive(e.start_time) if e.start_time else None
        event_items.append(
            {
                "id": e.id,
                "title": e.title or "日程",
                "start_time_local": local_time.strftime("%Y-%m-%d %H:%M") if local_time else None,
            }
        )
    reminder_items = []
    try:
        for item in reminder_manager.list_reminders()[: max(1, int(limit or 20))]:
            title = item["args"][0] if item.get("args") else "提醒"
            reminder_items.append(
                {
                    "id": item.get("id"),
                    "title": title,
                    "next_run_time": item.get("next_run_time"),
                }
            )
    except Exception:
        reminder_items = []
    return {
        "events": event_items,
        "event_count": len(events),
        "reminders": reminder_items,
        "reminder_count": len(reminder_items),
        "total_count": len(events) + len(reminder_items),
    }


def delete_all_meeting_reminders() -> str:
    """删除全部日程并取消全部定时提醒（会议提醒批量清理）。"""
    db = SessionLocal()
    events = db.query(Event).order_by(Event.start_time).all()
    deleted_events = []
    for e in events:
        deleted_events.append({"id": e.id, "title": e.title or "日程"})
        reminder_manager.cancel_reminder(f"event_{e.id}")
        db.delete(e)
    db.commit()
    db.close()

    cancelled_reminders = []
    try:
        for item in list(reminder_manager.list_reminders()):
            rid = str(item.get("id") or "").strip()
            if not rid:
                continue
            if reminder_manager.cancel_reminder(rid):
                title = item["args"][0] if item.get("args") else rid
                cancelled_reminders.append({"id": rid, "title": title})
    except Exception:
        pass

    total = len(deleted_events) + len(cancelled_reminders)
    if total == 0:
        return _tool_ok(
            "当前没有可删除的会议提醒。",
            data={
                "deleted_events": [],
                "cancelled_reminders": [],
                "count": 0,
            },
            code="empty",
        )
    titles = [x["title"] for x in deleted_events[:8]]
    if cancelled_reminders:
        titles.extend(str(x.get("title") or x.get("id")) for x in cancelled_reminders[:4])
    summary = "、".join(titles[:8])
    more = total - min(len(titles), 8)
    human = f"已删除会议提醒共 {total} 项"
    if summary:
        human += f"：{summary}"
        if more > 0:
            human += f" 等"
    return _tool_ok(
        human,
        data={
            "deleted_events": deleted_events,
            "cancelled_reminders": cancelled_reminders,
            "count": total,
        },
        code="purged",
    )


def complete_event(event_id: int) -> str:
    db = SessionLocal()
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        db.close()
        return _tool_err(
            f"未找到ID为 {event_id} 的日程。",
            data={"event_id": event_id},
            code="event_not_found",
        )
    event.completed = True
    db.commit()
    db.close()
    reminder_manager.cancel_reminder(f"event_{event_id}")
    return _tool_ok(
        f"已将日程标记为完成: {event.title}",
        data={"event_id": event_id, "title": event.title},
    )


def import_calendar_ics(file_path: str, skip_duplicates: bool = True) -> dict:
    """从 workspace 内 .ics 文件导入日程。"""
    import os

    from app.core.calendar_ics import dedupe_key, parse_ics_events
    from app.core.config import settings

    rel = str(file_path or "").strip().replace("\\", "/").lstrip("/")
    if not rel:
        return _tool_err("请提供 ICS 文件路径（相对 workspace）", code="missing_file_path")
    if ".." in rel.split("/"):
        return _tool_err("文件路径不允许包含 ..", code="invalid_path")

    abs_path = os.path.join(settings.WORKSPACE_DIR, rel)
    if not os.path.isfile(abs_path):
        return _tool_err(f"文件不存在: {rel}", code="file_not_found")

    try:
        text = open(abs_path, encoding="utf-8", errors="replace").read()
        parsed = parse_ics_events(text)
    except Exception as exc:
        return _tool_err(f"解析 ICS 失败: {exc}", code="parse_failed")

    if not parsed:
        return _tool_ok("ICS 文件内没有可导入的日程。", data={"items": [], "count": 0}, code="empty")

    db = SessionLocal()
    existing_keys: set[str] = set()
    if skip_duplicates:
        for ev in db.query(Event).all():
            local = utc_naive_to_local_naive(ev.start_time)
            existing_keys.add(dedupe_key(ev.title, local))

    created = skipped = failed = 0
    items: list[dict] = []
    try:
        for row in parsed:
            title = str(row.get("title") or "").strip()
            start = row.get("start_time")
            if not title or not isinstance(start, datetime.datetime):
                failed += 1
                items.append({"title": title, "status": "failed", "reason": "invalid_event"})
                continue
            key = dedupe_key(title, start)
            if skip_duplicates and key in existing_keys:
                skipped += 1
                items.append({"title": title, "status": "skipped", "reason": "duplicate"})
                continue
            start_utc = to_utc_naive(start)
            event = Event(
                title=title,
                start_time=start_utc,
                description=str(row.get("description") or ""),
            )
            db.add(event)
            db.commit()
            db.refresh(event)
            existing_keys.add(key)
            created += 1
            items.append({"title": title, "status": "created", "event_id": event.id})
            if start_utc >= utc_now_naive():
                reminder_local = utc_naive_to_local_naive(start_utc)
                reminder_manager.add_reminder(
                    title,
                    reminder_local,
                    str(row.get("description") or ""),
                    reminder_id=f"event_{event.id}",
                )
    finally:
        db.close()

    human = f"ICS 导入完成：新增 {created}，跳过 {skipped}，失败 {failed}。"
    return _tool_ok(human, data={"items": items, "source": rel, "created": created}, code="imported")


def fetch_and_import_calendar(url: str, skip_duplicates: bool = True) -> dict:
    """从 webcal/http ICS 订阅地址拉取并导入日程。"""
    from app.core.calendar_ics import fetch_ics_from_url
    import os
    import tempfile

    from app.core.config import settings

    target = str(url or "").strip()
    if not target:
        return _tool_err("请提供 ICS 订阅 URL", code="missing_url")
    try:
        text = fetch_ics_from_url(target)
    except Exception as exc:
        return _tool_err(f"拉取 ICS 失败: {exc}", code="fetch_failed")

    tmp_dir = os.path.join(settings.WORKSPACE_DIR, ".imports")
    os.makedirs(tmp_dir, exist_ok=True)
    tmp_path = os.path.join(tmp_dir, f"calendar-{abs(hash(target)) % 10_000_000}.ics")
    with open(tmp_path, "w", encoding="utf-8") as fh:
        fh.write(text)
    rel = os.path.relpath(tmp_path, settings.WORKSPACE_DIR).replace("\\", "/")
    res = import_calendar_ics(rel, skip_duplicates=skip_duplicates)
    if isinstance(res, dict):
        res.setdefault("data", {})["source_url"] = target
    return res


def export_calendar_ics(file_path: str = "exports/calendar.ics") -> dict:
    """导出本地日程为 ICS 文件（写入 workspace）。"""
    import os

    from app.core.calendar_ics import render_ics_events
    from app.core.config import settings

    rel = str(file_path or "exports/calendar.ics").strip().replace("\\", "/").lstrip("/")
    if ".." in rel.split("/"):
        return _tool_err("文件路径不允许包含 ..", code="invalid_path")

    abs_path = os.path.join(settings.WORKSPACE_DIR, rel)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)

    db = SessionLocal()
    events = db.query(Event).order_by(Event.start_time).all()
    db.close()
    payload = [
        {
            "id": ev.id,
            "title": ev.title,
            "start_time": ev.start_time,
            "description": ev.description or "",
            "uid": f"admin-event-{ev.id}@local",
        }
        for ev in events
    ]
    body = render_ics_events(payload)
    with open(abs_path, "w", encoding="utf-8") as fh:
        fh.write(body)
    return _tool_ok(
        f"已导出 {len(payload)} 条日程到 {rel}",
        data={"path": rel, "count": len(payload)},
        code="exported",
    )

