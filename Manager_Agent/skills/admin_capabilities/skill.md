---
name: admin_capabilities
description: 总管侧个人助理（admin）能力：天气、地图、日程（含待办/联系人）、邮件。搜索/玩法/问数等走总管其他 Agent。
version: 1.3.0
stage: route
owner: manager_agent
compatible_agents:
  - Manager_Agent
  - AI_admin_Agent
---

## Capabilities（总管路由范围 · 办公四类）

总管 `allowedAgents` 含 `admin` 时，**只**处理下列四类诉求。AI_admin_Agent 本体可有更多工具，但 **Manager 路由与 Planner 不得**将其他能力判给 admin。

| 类别 | 用户诉求示例 | 说明 |
|------|-------------|------|
| **天气** | 今天气温、预报、下雨、穿衣 | `get_weather`；**禁止** crawler 爬天气网页 |
| **地图** | 多久到、怎么走、周边 POI、地址解析 | `get_travel_route`、`search_*_amap` 等 |
| **日程** | 会议、日历、提醒、待办、联系人办公跟进 | `add_event`、`list_events`、`add_task`、`add_reminder`、`add_contact`…；会议须 `add_event`（落库） |
| **邮件** | 发信、收件箱、分拣、回信 | `send_email`、`list_emails`、`triage_emails`… |

> 飞书发消息等若 Admin 本体支持，用户可直连 Admin；**总管不扩玩法类 / IM 类 cap**。

## 总管禁止经 admin 路由的能力

以下能力在 AI_admin 玩法台/MCP 可用，但 **总管不加 cap、不写 admin 步骤**：

- 热榜 / B 站 / arxiv / 每日一句 / 百科盲盒 → **总管不编排**（用户直连 Admin 玩法台）
- 联网搜索 / 知识库检索 / 问数 → **总管** crawler / rag / db（勿进 admin）
- 简报 / 会前准备 / 文件 / 笔记 / 长期记忆 / 企微钉钉 / 浏览器自动化 → **总管不编排 admin**；跨轮 recall 沿用 Manager 现有 `vectorMemory` / 进化管线（**不**新建内置 memory Agent）

## RouteHints

- 纯天气 / 地图 / 日程（含待办·联系人）/ 邮件 → `allowedAgents: ["admin"]`，intent=admin。
- 复合任务：取数走 db/rag/crawler，办公子句走 admin；admin query **只写**对应子句。
- **不要**把纯路线/地图/天气判给 code、crawler、rag。
- **不要**把搜索、问数、arxiv、热榜、记忆、飞书玩法等判给 admin（总管侧）。

## PlannerHints

- admin 步骤 query 只写上述四类子任务，保留用户原话中的地点、时间、起终点、收件人。
- 会议/「创建日程」必须规划 `add_event`，禁止只用 `add_reminder`（日历页读不到）。
- 地图子任务默认**无需** dependsOn rag/db/crawler，除非用户明确「根据查询结果再出行」。
