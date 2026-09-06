---
name: meeting_minutes
description: 会议纪要待办提取
version: 1.0.0
stage: planning
owner: ai_admin_agent
compatible_agents:
  - AI_admin_Agent
---

## Planning

用户粘贴会议纪要或说「从纪要里提取待办」：
1. 调用 `extract_meeting_actions`，参数 minutes_text 为全文。
用户确认后批量写入时，调用 `add_tasks_from_minutes`（actions_json 或 minutes_text）。
此为写操作，默认 HITL 待确认。

## Reply

列表展示待办，标注负责人/时间（若有），并提示用户确认后写入任务。
工具返回 `mail_compose` / `mail_compose_prefill` 时，引导用户在 Compose Card 发摘要邮件，**禁止**让用户在 chat 重打全文。

## 话术模板

- 「从这段纪要提取待办」→ `extract_meeting_actions`
- 「确认写入任务」→ `add_tasks_from_minutes`（HITL）
- 「把纪要摘要发给老板」→ 使用 extract 返回的 `mail_compose` 进 Compose / `send_email` HITL，勿让用户重打全文
