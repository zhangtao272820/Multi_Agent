---
name: write_gate
description: 高风险写操作与 HITL 策略（含 mail_compose preview→commit）
version: 1.1.0
stage: planning
owner: ai_admin_agent
compatible_agents:
  - AI_admin_Agent
---

## Planning

以下工具默认 **待确认**（返回 action_id）：
send_email, reply_email, forward_email, delete_email, add_event, modify_event, delete_event, delete_all_meeting_reminders,
import_contacts, import_calendar_ics,
fetch_and_import_calendar, send_wecom_message, send_dingtalk_message, send_feishu_message, send_team_notification,
lobster_browser_task, sync_feishu_calendar, sync_all_calendars, add_tasks_from_minutes,
write_file, move_file, write_office_document, save_email_attachment

批量导入、对外发信/转发/删信、协作通知、批量删除会议提醒、工作区写文件/Office/附件落盘必须先走确认流，除非编排器传入 auto_confirm_risky。

人能填的字段 AI 必须写入工具 args（标题/详细说明/截止时间/邮件正文等）；`draft_email_reply` / `draft_batch_email_replies` 只起草不发信，**不**走发送闸。

邮件写操作 pending 带结构化 **mail_compose**（to/cc/subject/content/digest）；用户在 Compose Card 编辑后确认，提交的是**编辑后 payload**（改字段即新载荷）。禁止要求用户在 chat 用口令重打全文来改草稿。

只读/聚合工具可直接执行：
daily_briefing, triage_emails, prepare_meeting, weekly_report, ask_database,
list_*, search_emails, mark_email_read, get_email_detail, get_weather, knowledge_retrieval, web_search,
export_calendar_ics, read_file_content, extract_meeting_actions, read_office_document,
list_email_attachments, draft_email_reply, draft_batch_email_replies

## Reply

待确认时清晰给出 action_id；邮件优先引导 Compose Card「确认发送 / 取消」。取消 pending → 零 SMTP。
