# 库级域补丁（`data/domains/<DB_AGENT_DOMAIN>/`）

换真实业务库时**只改本目录 JSON + `.env` 连接**，不要重写 NL2SQL 主链。

## 约定

- **一库一实例**：`MYSQL_DATABASE` 指向该库；`DB_AGENT_DOMAIN` 与目录名一致（或 `generic`）
- `p2026`：养老/实训范例补丁，可作复制模板，**不是**执行器硬编码
- `generic`：无业务表假设；靠 Schema COMMENT 接地；新库先用它试跑

## 新库 checklist

1. `.env`：`MYSQL_*`；`DB_AGENT_DOMAIN=generic` 试跑  
2. 业务表/列写清**中文 COMMENT**（选表与 WHERE 靠注释，不是靠重写 Agent）  
3. 手工 10–20 条真实典型问句，确认选表与 `sql_direct`  
4. 需要领域 hint 时：`cp -r p2026 <新域>`（或从 `generic` 起步），**只改 JSON** 中的表名/hint/relations/metrics  
5. 设 `DB_AGENT_DOMAIN=<新域>`；`GET /api/config` 看 `patch.id`  
6. Docker 镜像须包含 `data/domains/`

## 文件说明

| 文件 | 作用 |
|------|------|
| `blueprint.json` | 选表/JOIN/统计 hint（`scope` + `text`） |
| `schema_overrides.json` | `data_domain`→候选表等覆盖 |
| `relations.json` | 表间 JOIN / 专项表对 |
| `value_maps.json` | 枚举值中文映射 |
| `default_time_range.json` | 相对时间默认 |
| `metrics.json` | 可直接 SQL 的指标模板 |
| `fast_paths.json` / `display_rules.json` / `domain_tools.json` | 统计快路径、展示、工具表 |

缺文件时加载器按空对象处理；`generic` 层会与具体域 **merge**（见 `utils/domain_patch.ts`）。

## 与总管的边界

- 总管只发 `cap=db` 与自然语言/`managerTask`；**不**嵌入客户表结构  
- 换库总管侧无需改代码；演示题与 golden 与生产 prompt 分离见 Manager `doc/真实用户域解耦.md`
