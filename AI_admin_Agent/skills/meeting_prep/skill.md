---
name: meeting_prep
description: 会前准备 Playbook（仅 Admin 本地：日程/待办/笔记/工作区/邮件主题）
version: 1.1.0
stage: planning
owner: ai_admin_agent
compatible_agents:
  - AI_admin_Agent
---

## Planning

当用户说「会前准备 / 会议材料 / 明天开会准备」：
1. **优先**调用 `prepare_meeting`，传入用户原话作为 `query`。
2. 若用户给出会议名，可填 `event_title`。
3. **禁止**为此调用 `knowledge_retrieval` / `ask_database` / crawler / gui；只聚合 Admin 本地数据。
4. 需要写入备忘时，再调用 `add_note` 或 `write_office_document`（写闸 HITL）。

## Reply

结构：主题线索 → 匹配日程 → 相关待办/笔记/工作区文件 →（可选）邮件主题 → 建议备忘。
本地无匹配时诚实说明，并建议先建日程或把材料放入 workspace。
语气专业简洁，适合国内职场。

## 话术模板（最少槽位）

- 「明天会前准备」→ `prepare_meeting(query=用户原话)`
- 「把会前要点发邮件给张三」→ prepare 后用摘要填 `send_email` → Compose Card
