# 智慧养老实训本地库（MySQL `p2026`，与 DB_Agent 当前库一致）

默认只读：`person_*`、`remote_*`、`elderly_*`、`bed_*`、`floor_*`、`org_*`、`monitor_*`、`teaching_*`、`cultivate_*`、`device_*`、`iot_*`；系统表仅 `sys_user` / `sys_role` / `sys_dept` / `sys_department` / `sys_menu`。
禁止查密码列、代码生成表、工作流表、未授权日志表。
人员主表是 `person_info`（有效行通常 `deleted = 0`）。健康指标走 `person_health_records`（按 `person_id` JOIN）。
足底压力主表 `remote_activity_foot_log`；仅当问区域/分区/重心时才 JOIN `remote_activity_foot_measure_log`。
情绪识别仪 → `remote_psychology_mood`；慢性病护理实训 → `remote_nursing_chronic`；骨密度 → `remote_health_bone_log`。
问数量且问「分别是什么」时，选出名称列，不要只 COUNT。性别枚举：`is_gender` 1=男 2=女。
