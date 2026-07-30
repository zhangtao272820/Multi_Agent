"""晨间简报、邮件分拣、会前准备、周报（国内办公场景复合工具）。"""
from __future__ import annotations

import datetime
import re

from app.core.config import settings
from app.core.time_utils import local_now_aware
from app.core.user_preferences import get_user_preferences
from app.tools.common import _tool_err, _tool_ok
from app.tools import calendar, email, tasks, weather, notes, files, reminders


def _pref_city(session_id: str = "default") -> str:
    prefs = get_user_preferences(session_id)
    return str(prefs.get("default_weather_city") or "").strip()


def _tool_items(result) -> list[dict]:
    if isinstance(result, dict):
        data = result.get("data") or {}
        items = data.get("items") or data.get("files") or []
        return [x for x in items if isinstance(x, dict)]
    return []


def _tool_human(result) -> str:
    if isinstance(result, dict):
        return str(result.get("human_message") or result.get("message") or "")
    return str(result or "")


def _query_tokens(q: str) -> list[str]:
    """从用户原话抽匹配用短词（非意图路由；仅本地过滤）。"""
    raw = str(q or "").strip()
    if not raw:
        return []
    for noise in (
        "帮我",
        "请",
        "准备",
        "会前",
        "材料",
        "一下",
        "明天",
        "后天",
        "今天",
        "下午",
        "上午",
        "晚上",
        "的",
        "会议",
        "开会",
    ):
        raw = raw.replace(noise, " ")
    parts = [p for p in re.split(r"[\s,，。；;、/\\|]+", raw) if len(p) >= 2]
    if not parts and len(str(q or "").strip()) >= 2:
        parts = [str(q).strip()[:32]]
    return parts[:8]


def _text_matches(text: str, tokens: list[str]) -> bool:
    t = str(text or "")
    if not tokens:
        return True
    return any(tok and tok in t for tok in tokens)


def daily_briefing(city: str = "", session_id: str = "default", include_emails: bool = True) -> dict:
    """聚合天气 + 今日日程 + 待办 +（可选）未读邮件摘要。"""
    now = local_now_aware()
    lines = [f"📋 **{now.strftime('%Y年%m月%d日')} 晨间简报**", ""]

    c = (city or _pref_city(session_id) or "").strip()
    if c:
        w = weather.get_weather(c, "today", session_id)
        wtext = w.get("human_message", str(w)) if isinstance(w, dict) else str(w)
        lines.extend(["**天气**", wtext, ""])
    else:
        lines.extend(["**天气**", "（未设置默认城市，可说「北京天气」或告诉我常住城市）", ""])

    ev = calendar.list_events()
    etext = ev.get("human_message", str(ev)) if isinstance(ev, dict) else str(ev)
    lines.extend(["**日程**", etext, ""])

    tk = tasks.list_tasks()
    ttext = tk.get("human_message", str(tk)) if isinstance(tk, dict) else str(tk)
    lines.extend(["**待办**", ttext, ""])

    email_summary = ""
    if include_emails and (settings.IMAP_USER or settings.SMTP_USER):
        em = email.list_emails(limit=5)
        et = em.get("human_message", str(em)) if isinstance(em, dict) else str(em)
        email_summary = et
        lines.extend(["**最近邮件**", et, ""])
    elif include_emails:
        lines.extend(["**邮件**", "（IMAP 未配置，跳过邮件摘要）", ""])

    body = "\n".join(lines).strip()
    return _tool_ok(
        body,
        data={"city": c or None, "has_email": bool(email_summary), "date": now.strftime("%Y-%m-%d")},
        code="briefing_ok",
    )


def triage_emails(limit: int = 20, session_id: str = "default") -> dict:
    """列出并分类邮件，给出优先级建议。"""
    if not (settings.IMAP_USER or settings.SMTP_USER):
        return _tool_err(
            "邮件分拣需要配置 IMAP/SMTP（.env 中 IMAP_USER / SMTP_USER）。",
            code="imap_not_configured",
        )
    listed = email.list_emails(limit=max(5, min(int(limit or 20), 50)))
    if isinstance(listed, dict) and not listed.get("ok", True):
        return listed
    classified = email.classify_emails(session_id=session_id)
    ltext = listed.get("human_message", "") if isinstance(listed, dict) else str(listed)
    ctext = classified.get("human_message", str(classified)) if isinstance(classified, dict) else str(classified)
    body = f"**收件箱概览**\n{ltext}\n\n**分类与优先级**\n{ctext}"
    return _tool_ok(body, data={"limit": limit}, code="triage_ok")


def prepare_meeting(
    query: str = "",
    event_title: str = "",
    session_id: str = "default",
) -> dict:
    """会前准备：仅用 Admin 本地数据（日程/待办/笔记/提醒/工作区/可选邮件），不调 RAG/DB。"""
    q = str(query or event_title or "").strip()
    tokens = _query_tokens(q)
    lines = ["**会前准备**（仅本地办公数据，未检索知识库）", ""]
    if q:
        lines.extend([f"**主题线索**：{q}", ""])

    ev = calendar.list_events()
    ev_items = _tool_items(ev)
    matched_events = [it for it in ev_items if _text_matches(f"{it.get('title') or ''}", tokens)]
    if tokens and matched_events:
        lines.append("**匹配日程**")
        for it in matched_events[:8]:
            lines.append(
                f"- [{it.get('id')}] {it.get('title')}（{it.get('start_time_local') or '时间未知'}）"
            )
        lines.append("")
    else:
        lines.extend(["**日程**", _tool_human(ev) or "（无日程）", ""])
        if tokens and ev_items:
            lines.append("（未找到与主题关键词匹配的日程；已列出全部日程供核对。）")
            lines.append("")

    tk = tasks.list_tasks()
    tk_items = _tool_items(tk)
    matched_tasks = [
        it
        for it in tk_items
        if _text_matches(f"{it.get('title') or ''} {it.get('description') or ''}", tokens)
    ]
    lines.append("**相关待办**")
    if matched_tasks:
        for it in matched_tasks[:10]:
            lines.append(f"- [{it.get('id')}] {it.get('title')}")
    elif tokens:
        lines.append("（无与主题匹配的待办）")
    else:
        lines.append(_tool_human(tk) or "（无待办）")
    lines.append("")

    nt = notes.list_notes()
    nt_items = _tool_items(nt)
    matched_notes = [
        it
        for it in nt_items
        if _text_matches(f"{it.get('title') or ''} {it.get('content') or ''}", tokens)
    ]
    lines.append("**相关笔记**")
    if matched_notes:
        for it in matched_notes[:10]:
            title = it.get("title") or "(无标题)"
            lines.append(f"- [{it.get('id')}] {title}")
    elif tokens:
        lines.append("（无与主题匹配的笔记）")
    else:
        lines.append(_tool_human(nt) or "（无笔记）")
    lines.append("")

    try:
        rm = reminders.list_reminders()
        rm_items = _tool_items(rm)
        matched_rm = [
            it
            for it in rm_items
            if _text_matches(f"{it.get('content') or it.get('title') or ''}", tokens)
        ]
        lines.append("**相关提醒**")
        if matched_rm:
            for it in matched_rm[:8]:
                lines.append(f"- {it.get('content') or it.get('title') or it}")
        else:
            lines.append("（无匹配提醒）" if tokens else (_tool_human(rm) or "（无提醒）"))
        lines.append("")
    except Exception:
        pass

    listed = files.list_files("")
    file_items = _tool_items(listed)
    matched_files = [
        it
        for it in file_items
        if (not it.get("is_dir"))
        and _text_matches(str(it.get("name") or it.get("path") or ""), tokens)
    ]
    lines.append("**工作区相关文件**")
    if matched_files:
        for it in matched_files[:12]:
            lines.append(f"- {it.get('path') or it.get('name')}")
    elif tokens:
        lines.append("（工作区无文件名匹配的材料；可把议程/纪要放到 workspace 后再问）")
    else:
        lines.append(f"（工作区共 {len(file_items)} 项；给出会议主题关键词可筛选）")
    lines.append("")

    if settings.IMAP_USER or settings.SMTP_USER:
        try:
            em = email.list_emails(session_id=session_id or "default", limit=10, unread_only=False)
            em_items = _tool_items(em)
            matched_mail = [
                it
                for it in em_items
                if _text_matches(f"{it.get('subject') or ''} {it.get('sender') or ''}", tokens)
            ]
            lines.append("**相关邮件（主题）**")
            if matched_mail:
                for it in matched_mail[:8]:
                    lines.append(f"- #{it.get('id')} {it.get('subject')} | {it.get('sender')}")
            else:
                lines.append("（最近邮件中无主题匹配）")
            lines.append("")
        except Exception:
            pass

    hint = (
        f"**建议备忘**（{local_now_aware().strftime('%Y-%m-%d %H:%M')}）\n"
        "- 核对上方匹配日程的时间与参会人\n"
        "- 打开工作区相关文件 / 笔记核对材料是否齐全\n"
        "- 把仍缺的材料补进 workspace，或用 write_office_document 生成议程草稿\n"
    )
    if q:
        hint += f"- 主题：{q}\n"
    if tokens and not matched_events and not matched_files and not matched_notes and not matched_tasks:
        hint += "- 本地暂无匹配材料：可先 add_event 建会，或把文件放入工作区后再准备\n"
    lines.append(hint.strip())

    body = "\n".join(lines).strip()
    return _tool_ok(
        body,
        data={
            "query": q,
            "tokens": tokens,
            "matched": {
                "events": len(matched_events),
                "tasks": len(matched_tasks),
                "notes": len(matched_notes),
                "files": len(matched_files),
            },
            "sources": ["calendar", "tasks", "notes", "reminders", "workspace", "email_subjects"],
        },
        code="meeting_prep_ok",
    )


def weekly_report(session_id: str = "default") -> dict:
    """生成本周工作周报草稿（待办 + 日程 + 笔记摘要）。"""
    now = local_now_aware()
    week_start = (now - datetime.timedelta(days=now.weekday())).strftime("%Y-%m-%d")
    lines = [f"**本周工作周报（{week_start} ~ {now.strftime('%Y-%m-%d')}）**", ""]

    tk = tasks.list_tasks()
    lines.extend(["**待办进展**", tk.get("human_message", str(tk)) if isinstance(tk, dict) else str(tk), ""])

    ev = calendar.list_events()
    lines.extend(["**本周日程**", ev.get("human_message", str(ev)) if isinstance(ev, dict) else str(ev), ""])

    nt = notes.list_notes()
    lines.extend(["**笔记摘录**", nt.get("human_message", str(nt)) if isinstance(nt, dict) else str(nt), ""])

    lines.append("**下周计划**（请补充）\n- ")
    body = "\n".join(lines).strip()
    return _tool_ok(body, data={"week_start": week_start}, code="weekly_ok")
