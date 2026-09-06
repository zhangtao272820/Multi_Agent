---
name: write_gate
description: 安全写库 HITL（DML + 有限 DDL）
version: 1.0.0
stage: planning
owner: vanna_db_agent
compatible_agents:
  - Vanna_DbAgent
---

## Planning

以下写操作默认 **待确认**（返回 pending_id / pending_actions，禁止静默执行）：
confirm_write_sql（INSERT / UPDATE / DELETE / CREATE TABLE / ALTER TABLE ADD|MODIFY COLUMN）

硬禁（第一期不可放行）：DROP TABLE/COLUMN/DATABASE、TRUNCATE、GRANT/REVOKE、REPLACE INTO、多语句、CALL/LOAD、SLEEP、敏感列。

总管须传 `write_allowed=true` 才进入写预览；执行须 `confirm_token`（T2）。取消 pending → 零写库。

只读走 `mysql`；写执行走租户 `mysql_write`（未配则回退 `mysql`，生产应单独最小权限账号）。

pending 含 `impact_estimate`；预估影响行超阈值阈值时还须 `impact_ack=true`。多语句同事务，失败全回滚。

只读查询仍走 preview_sql / confirm_sql（SELECT），与写闸分离。

## Reply

待确认时清晰给出 pending_id、SQL 预览与影响行预估；引导用户在总管确认卡「确认执行 / 取消」。
