---
name: step_sanitize
description: Manager 规划步骤 query 净化：各 agent 应保留/剔除的语义、噪声词表、LLM 裁剪规则与媒体执行约束。
version: 1.0.0
stage: planner
owner: manager_agent
---

# 步骤 Query 净化

结构化净化逻辑在 `managerGraph.stepIsolation.ts`（`STEP_SANITIZE_STRATEGIES`）；本文为 SSOT 规范。

## 数据源 agent（rag / db / crawler）

**应剥离噪声**（DATA_PLANE_NOISE）：画图、图表、可视化、echarts、报告、分析报告、总结报告、写报告、日程、邮件、会议、待办、提醒、预约、安排会议、创建会议

- maxLen: 520；超长或噪声残留时可触发 LLM 裁剪（MANAGER_STEP_SANITIZE_LLM=1）

## code

**应剥离**：邮件、日程、会议、待办、提醒、预约、跟进（替换为「任务」）
- maxLen: 640

## visualize / report

**应剥离取数表述**：从知识库、从数据库、知识库检索、数据库查询、sql查询、抓取网页、爬虫

## clean

噪声：画图、图表、echarts、邮件、日程、会议；maxLen: 480

## multimodal / music / video

见 STEP_SANITIZE_STRATEGIES；媒体 agent 附加 MEDIA_EXEC_GUARDS 约束块。

## admin

保留日程/邮件/会议/待办，以及**高德路线、周边 POI、地址解析**相关子句（buildAdminStepQuery）。地图子句须完整保留起终点与出行方式原话，勿删减为「查路线」之类空泛描述。

**可写字段不得摘要丢弃**：标题、开始/截止时间、详细内容/详细说明、待办描述、邮件正文或回复内容——用户已给出的必须原样保留在 admin 步骤 query 中；禁止裁成「创建日程并设置提醒」而丢掉正文。

## 依赖隔离

- admin / music / video / multimodal **不应**继承数据检索步骤的 missing/澄清。
- admin 默认不 dependsOn rag/db/crawler，除非用户明确「根据检索/查询结果」安排事务。

## LlmSanitize

你是任务步骤 query 裁剪器。每个 step 的 query 只能描述该 agent 自己的职责。
规则：
- rag/db/crawler：只保留检索/取数实体、时间、指标、关键词；去掉画图、报告、日程、邮件等下游诉求。
- code：只保留计算/加工/汇总描述；去掉纯事务类表述；若计划含 visualize 步骤则去掉一切图表/ECharts/可视化表述。
- visualize/report/clean：只保留呈现/分析/清洗描述；去掉「从知识库/数据库查询」等取数动作。
- admin：保留天气、高德地图、日程/提醒/待办/联系人、邮件子句，以及用户给出的标题/时间/详细内容/待办说明/邮件正文；去掉 rag/db/搜索/玩法/飞书玩法/画图/报告等其它 agent 职责。
- 若原文已足够短且职责单一，可原样返回 query。
只输出 JSON：{"steps":[{"id":"...","query":"..."}]}，不要 markdown。
