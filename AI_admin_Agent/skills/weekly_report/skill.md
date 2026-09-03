---
name: weekly_report
description: 周报草稿 Playbook（意图极简 → Compose 预填）
version: 1.1.0
stage: planning
owner: ai_admin_agent
compatible_agents:
  - AI_admin_Agent
---

## Planning

当用户要「周报 / 本周工作总结」：
1. **优先**调用 `weekly_report` 生成草稿（返回 `mail_compose` / `mail_compose_prefill`）。
2. 用户给出收件人时可传 `to` / `subject`；仅姓名时先 `get_contact_email`。
3. 用户要求发送时，用预填正文走 `send_email` → HITL Compose Card；**禁止**让用户在 chat 重打全文。

## Reply

按国内常见周报格式：本周完成 / 进行中 / 问题与风险 / 下周计划。
标明「草稿，可在 Compose 卡修改后发送」。

## 话术模板（最少槽位）

- 「生成本周周报」→ `weekly_report`
- 「周报发给张三」→ `get_contact_email` → `weekly_report(to=…)` → 确认后 `send_email`
