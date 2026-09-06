"""批次 5～6：Lobster 填表、会议纪要、出行路线、短信、飞书日历、多日历同步。"""
from __future__ import annotations

import json
import re

from app.core.config import settings
from app.core.integrations_registry import parse_calendar_subscriptions
from app.core.llm import qwen_llm
from app.core.lobster_client import (
    format_lobster_result,
    lobster_agent_configured,
    poll_lobster_run,
    start_lobster_run,
)
from app.tools.calendar import fetch_and_import_calendar
from app.tools.common import _tool_err, _tool_ok
from app.tools.tasks import add_task, add_task_with_due


def lobster_browser_task(
    task: str,
    start_url: str = "",
    wait_seconds: int = 90,
    session_id: str = "",
    storage_profile: str = "",
    engine_hint: str = "",
) -> dict:
    """委托 Lobster_Agent 执行浏览器任务（OA 填表/网页操作，高风险）。"""
    t = str(task or "").strip()
    if not t:
        return _tool_err("请描述要在浏览器中完成的任务。", code="missing_task")
    if not lobster_agent_configured():
        return _tool_err(
            "Lobster 未配置：设置 LOBSTER_AGENT_HTTP_URL（如 http://lobster_agent:13108）。",
            code="lobster_not_configured",
        )
    started = start_lobster_run(
        t,
        start_url,
        session_id=session_id,
        storage_profile=storage_profile,
        engine_hint=engine_hint,
    )
    if not started or started.get("ok") is False:
        err = str((started or {}).get("error") or "start_failed")
        return _tool_err(f"Lobster 启动失败：{err}", code="lobster_start_failed")
    run_id = str(started.get("runId") or "").strip()
    if not run_id:
        return _tool_err("Lobster 未返回 runId。", code="lobster_no_run_id")
    result = poll_lobster_run(run_id, max_wait_sec=float(wait_seconds or 90))
    human, meta = format_lobster_result(result, t)
    if meta.get("ok") is False:
        return _tool_err(human, data=meta, code="lobster_failed")
    meta["runId"] = run_id
    return _tool_ok(human, data=meta, code="lobster_ok")


def extract_meeting_actions(minutes_text: str) -> dict:
    """从会议纪要文本提取待办清单（不自动写入，供用户确认）。"""
    text = str(minutes_text or "").strip()
    if len(text) < 10:
        return _tool_err("请提供足够的会议纪要正文（至少 10 字）。", code="text_too_short")

    prompt = f"""从以下会议纪要中提取行动项（待办）。只返回 JSON：
{{"actions": [{{"title": "...", "assignee": "...", "due_expression": "..."}}]}}

会议纪要：
{text[:6000]}
"""
    try:
        raw = qwen_llm.chat_text([{"role": "user", "content": prompt}])
        m = re.search(r"\{[\s\S]*\}", raw)
        parsed = json.loads(m.group(0) if m else raw)
        actions = parsed.get("actions") if isinstance(parsed, dict) else []
        if not isinstance(actions, list):
            actions = []
    except Exception as exc:
        return _tool_err(f"纪要解析失败：{exc}", code="parse_failed")

    if not actions:
        return _tool_ok("未从纪要中识别到明确待办，请检查原文或手动添加。", data={"actions": []}, code="empty")

    lines = ["**会议待办提取**", ""]
    for i, act in enumerate(actions[:15], start=1):
        if not isinstance(act, dict):
            continue
        title = str(act.get("title") or "").strip()
        if not title:
            continue
        assignee = str(act.get("assignee") or "").strip()
        due = str(act.get("due_expression") or "").strip()
        extra = []
        if assignee:
            extra.append(f"负责人：{assignee}")
        if due:
            extra.append(f"时间：{due}")
        suffix = f"（{'；'.join(extra)}）" if extra else ""
        lines.append(f"{i}. {title}{suffix}")

    lines.append("")
    lines.append("如需写入待办，请说「把以上待办加进任务列表」。")
    lines.append("如需邮件发出摘要，可在 Compose 中确认草稿（收件人可后填）。")
    from app.core.mail_compose import compose_prefills_from_minutes_actions

    mail_compose = compose_prefills_from_minutes_actions(actions[:15])
    return _tool_ok(
        "\n".join(lines),
        data={
            "actions": actions[:15],
            "count": len(actions),
            "mail_compose": mail_compose,
            "mail_compose_prefill": mail_compose,
        },
        code="extracted",
    )


def sync_feishu_calendar(skip_duplicates: bool = True) -> dict:
    """从 ADMIN_FEISHU_ICS_URL 拉取飞书日历 ICS 并导入。"""
    url = str(settings.ADMIN_FEISHU_ICS_URL or settings.ADMIN_CALENDAR_ICS_URL or "").strip()
    if not url:
        return _tool_err(
            "飞书日历未配置：设置 ADMIN_FEISHU_ICS_URL（飞书日历订阅 ICS 链接）。",
            code="feishu_ics_not_configured",
        )
    return fetch_and_import_calendar(url, skip_duplicates=skip_duplicates)


def sync_all_calendars(skip_duplicates: bool = True) -> dict:
    """从 ADMIN_CALENDAR_SUBSCRIPTIONS（或飞书/默认 ICS）批量拉取并导入日程。"""
    subs = parse_calendar_subscriptions()
    if not subs:
        return _tool_err(
            "多日历未配置：设置 ADMIN_CALENDAR_SUBSCRIPTIONS JSON，或 ADMIN_FEISHU_ICS_URL。",
            code="calendar_subs_not_configured",
        )

    results: list[dict] = []
    total_imported = 0
    for name, url in subs.items():
        res = fetch_and_import_calendar(url, skip_duplicates=skip_duplicates)
        ok = bool(res.get("ok")) if isinstance(res, dict) else False
        imported = 0
        if isinstance(res, dict):
            data = res.get("data") or {}
            imported = int(data.get("imported") or data.get("imported_count") or 0)
        if ok:
            total_imported += imported
        results.append({"calendar": name, "ok": ok, "imported": imported, "detail": res})

    failed = [r for r in results if not r.get("ok")]
    if failed and len(failed) == len(results):
        return _tool_err(
            f"全部 {len(results)} 个日历同步失败。",
            data={"results": results},
            code="sync_all_failed",
        )

    lines = [f"**多日历同步完成**：{len(results)} 源，新增/更新约 {total_imported} 条"]
    for r in results:
        status = "✓" if r.get("ok") else "✗"
        lines.append(f"- {status} {r.get('calendar')}：{r.get('imported', 0)} 条")
    code = "sync_all_partial" if failed else "sync_all_ok"
    return _tool_ok("\n".join(lines), data={"results": results, "total_imported": total_imported}, code=code)


def add_tasks_from_minutes(actions_json: str = "", minutes_text: str = "") -> dict:
    """将会议纪要待办写入本地任务列表（高风险，需用户确认后调用）。"""
    actions: list = []
    raw_json = str(actions_json or "").strip()
    if raw_json:
        try:
            parsed = json.loads(raw_json)
            if isinstance(parsed, dict) and isinstance(parsed.get("actions"), list):
                actions = parsed["actions"]
            elif isinstance(parsed, list):
                actions = parsed
        except json.JSONDecodeError as exc:
            return _tool_err(f"actions_json 解析失败：{exc}", code="invalid_json")

    if not actions:
        text = str(minutes_text or "").strip()
        if len(text) < 10:
            return _tool_err("请提供 actions_json 或足够长的 minutes_text。", code="missing_input")
        extracted = extract_meeting_actions(text)
        if not extracted.get("ok"):
            return extracted
        data = extracted.get("data") or {}
        actions = data.get("actions") or []

    if not actions:
        return _tool_ok("没有可写入的待办。", data={"added": []}, code="empty")

    added: list[dict] = []
    for act in actions[:20]:
        if not isinstance(act, dict):
            continue
        title = str(act.get("title") or "").strip()
        if not title:
            continue
        assignee = str(act.get("assignee") or "").strip()
        due_expr = str(act.get("due_expression") or "").strip()
        desc_parts = []
        if assignee:
            desc_parts.append(f"负责人：{assignee}")
        if due_expr:
            desc_parts.append(f"截止：{due_expr}")
        description = "；".join(desc_parts)

        if due_expr:
            res = add_task_with_due(title, due_expr, description=description)
        else:
            res = add_task(title, description=description)

        if isinstance(res, dict) and res.get("ok"):
            task_data = res.get("data") or {}
            added.append({"title": title, "task_id": task_data.get("task_id")})

    if not added:
        return _tool_err("未能写入任何待办，请检查 actions 格式。", code="add_failed")

    lines = [f"**已写入 {len(added)} 条待办**", ""]
    for i, item in enumerate(added, start=1):
        lines.append(f"{i}. {item['title']}（ID {item.get('task_id')}）")
    return _tool_ok("\n".join(lines), data={"added": added, "count": len(added)}, code="tasks_added")
