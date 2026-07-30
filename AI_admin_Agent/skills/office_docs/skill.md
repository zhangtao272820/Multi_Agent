---
name: office_docs
description: 工作区 Word/Excel（docx/xlsx）读写规范
version: 1.0.0
stage: planning
owner: ai_admin_agent
compatible_agents:
  - AI_admin_Agent
---

## Planning

- `read_office_document(file_path, sheet?)`：读取 workspace 内 docx/xlsx；xlsx 可指定 sheet。
- `write_office_document(file_path, content?, format?, rows?, sheet?)`：写入 workspace；docx 用 content 按行分段；xlsx 优先传二维 rows，否则 content 按行/制表符分列。
- 路径仅限工作区相对路径，禁止 `..`。
- `write_office_document` 属写闸待确认工具。

## Reply

写成功后回报相对路径与格式；读失败时说明缺依赖或格式不支持。
