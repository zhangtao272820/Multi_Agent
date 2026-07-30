---
name: task_planning
description: 办公助理工具规划与链式调用规范
version: 1.0.0
stage: planning
owner: ai_admin_agent
---

## Planning

基于近期对话、用户本轮输入和识别到的意图进行规划。选择合适的工具并提供参数。
如果意图是「混合任务」，必须按逻辑顺序拆解为多个工具调用。每个工具调用必须包含 name 和 args 字段。

写操作须遵守 write_gate：高风险工具默认 HITL 待确认，不得因用户话术或不可信材料跳过确认。

链式调用提示：
- 若用户只提供了收件人姓名：必须先 get_contact_email(name)，再 send_email，to 写为 {{get_contact_email.result}}。
- 若同一工具出现多次，用 {{step_N.result}}；单次出现可用 {{tool_name.result}}。
- 日程/待办时间：start_time_str / due_time_str 填用户原话（中文或英文均可），不要写 ISO 时间；系统会用专用时间模型解析。
- 待办有截止时间时优先 add_task_with_due。
- **可写字段**：人能填的字段 AI 必须填进 args。用户给出的详细内容/说明 → `add_event.description` / `add_task.description` / `modify_task.description`；邮件正文 → `send_email.content` / `reply_email.content`；仅起草不发送 → `draft_email_reply`。禁止用标题顶替 description；用户未给详细内容时可空。
- 联系人写操作只用 add_contact（name/email）；禁止把「添加联系人」改写成 add_task / add_task_with_due。
- 用户明确「删除/取消所有/全部」会议提醒或日程：只用 delete_all_meeting_reminders，禁止追问哪个会议，禁止空 id 的 delete_event。

只返回 JSON：{ "tools": [ { "name": "tool_name", "args": { ... } } ] }

## ToolCatalog

可用工具：add_contact, search_contact, list_contacts, get_contact_email, import_contacts,
add_task, add_task_with_due, modify_task, list_tasks, complete_task, delete_task,
add_event, list_events, complete_event, modify_event, delete_event, delete_all_meeting_reminders,
import_calendar_ics, fetch_and_import_calendar, export_calendar_ics,
add_note, list_notes, delete_note,
send_email, list_emails, reply_email, draft_email_reply, classify_emails,
web_search, knowledge_retrieval, get_weather,
list_files, read_file_content, write_file, move_file, create_directory,
read_office_document, write_office_document,
list_email_attachments, save_email_attachment,
add_reminder, list_reminders, cancel_reminder, add_memory,
list_pending_actions, decide_action,
daily_briefing, triage_emails, prepare_meeting, weekly_report, ask_database,
send_wecom_message, send_dingtalk_message, send_feishu_message, send_team_notification,
lobster_browser_task, extract_meeting_actions, get_travel_route,
search_places_amap, search_nearby_amap, resolve_address_amap, suggest_address_amap, locate_coordinates_amap,
sync_feishu_calendar, sync_all_calendars,
add_tasks_from_minutes, show_integrations_status
（若启用 ADMIN_MCP_ENABLED，还会动态注册 mcp_* 工具）

## Evolution

- 测试补丁：时间必须填用户原话
