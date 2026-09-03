# P2026 领域蓝图（Understand / SQL 注入）

## 口语 → 表
- 老人/人员/学员 → `person_info`（有效行 `deleted = 0`）；姓名列 `name`，性别 `is_gender`（男=1 女=2），年龄 `age`，地区 `provinces_and_cities`（库内为「省+市+区」复合串，如「天津市河西区」；区县过滤必须 `LIKE '%河西区%'`，禁止 `= '河西区'`）。
- 健康指标/体检/生命体征 → 先 `person_info` 按姓名定位，再 JOIN `person_health_records` ON `person_id`。
- 足底压力/足压/平衡 → 主表 `remote_activity_foot_log`，按 `person_name` 过滤。
- **仅**当问区域/分区/重心/左右脚/足弓/前掌/后跟/热力时，才把 `remote_activity_foot_measure_log` 写入 tables 并 JOIN。
- 情绪识别仪/心理检测 → `remote_psychology_mood`；列名以 schema 注释为准，禁止臆造列。
- 慢性病护理/血压血糖实训 → `remote_nursing_chronic`；姓名用 `cus_name`；勿与 `person_health_records` 混用。
- 骨密度 → `remote_health_bone_log`。

## 路径与过滤
- 有额外姓名/地区/时间过滤时禁止 path=golden，改 llm_sql，并写入 `filters.slots` / `time_range`。
- 性别等枚举：`sql_match_value` 用库内编码（男→1、女→2），不要写「男」「女」进 WHERE 除非列是文本。
- 地区槽：`field_hint=地区`，`sql_match_value` 为短区县名；SQL 用 `provinces_and_cities LIKE '%短名%'`。
- 分布/占比/趋势：分组列与时间列须来自 schema 注释；注意 NULL。
- JOIN 关系以 joins.json 的 when 为准；人员主表⋈事实表时 `join_needed=true`。
