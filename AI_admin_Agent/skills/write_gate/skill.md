---
name: write_gate
description: 高风险写操作与 HITL 策略
version: 1.0.0
stage: planning
owner: ai_admin_agent
compatible_agents:
  - AI_admin_Agent
---

## Planning

以下工具默认 **待确认**（返回 action_id）：
send_email, reply_email, add_event, modify_event, delete_event, delete_all_meeting_reminders,
import_contacts, import_calendar_ics,
fetch_and_import_calendar, send_wecom_message, send_dingtalk_message, send_feishu_message, send_team_notification,
lobster_browser_task, sync_feishu_calendar, sync_all_calendars, add_tasks_from_minutes

批量导入、对外发信、协作通知、批量删除会议提醒必须先走确认流，除非编排器传入 auto_confirm_risky。

只读/聚合工具可直接执行：
daily_briefing, triage_emails, prepare_meeting, weekly_report, ask_database,
list_*, get_weather, knowledge_retrieval, web_search, export_calendar_ics

## Reply

待确认时清晰给出 action_id 与「确认 N / 取消 N」指令。
