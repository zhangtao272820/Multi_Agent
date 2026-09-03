# Vanna_DbAgent 后续能力清单

独立栈。本文记 **已交付 / 还没做完**，便于下一轮实现。

## 本波已交付（契约对齐，未切总管）

引擎是 **Retrieve → Understand（Router）→ 可选 SQL LLM** + schema 卡片（失败才修；成功可另 1 次口吻）。独立 UI 仍 **SQL 预览 → 确认**。问句理解能力评估见 [docs/nlu-capability-assessment.md](docs/nlu-capability-assessment.md)。

- 列值样例进入 schema 卡片与打分（`samples=`）。
- 场景/领域 Skill + `tenants/<id>/metrics.json` 注入 prompt / ingest；指标名精确命中走黄金 SQL。
- `POST /api/golden` 人审收入黄金（写 `special_golden.json` + 合并 `golden.json` + 一次 Chroma upsert）。禁止 `AUTO_PROMOTE`。
- 无表可链：0-LLM 澄清（`needs_clarify`）。sqlglot AST 闸叠在原 regex 上。
- `POST /api/mcp` 四工具：`schema_search` / `preview_sql` / `confirm_sql` / `promote_golden`（无裸 `run_sql`）。
- 缺 `joins.json` 时从 FK snapshot 种子；不覆盖手工 joins。`tenants/_template.yml` 不加载为租户。
- 分析师图：时间轴折线、≤6 类饼图，其余柱图。
- Envelope v2 / `agentResult.agent=db` / `GET /api/health` / `POST /api/probe|plan` / `WS /api/chat.ws`。
- 总管路径（`source=manager`、内部令牌、`x-agent-protocol`、或 dbClient `messages`）跳过预览，guard 通过后只读执行。
- `turn_scope` 抑制会话/经验；`db_query_experience` 无 PG 时空召回不抛。独立面只在黄金收录时写经验。
- `GET /api/learning` + `curate` / `promote` / `reset` 对齐 Evolution Hub 形状；curate 默认不晋级。
- **NLU 短板升级**：SQL `filter_gate` 约束硬闸；Router `confidence` 降级；golden `special`/`template` 分计量；`tenants/p2026/nl_eval.json` 离线契约评测。

**本波已切总管 DB 腿**：Manager / Admin 的 `DB_AGENT_HTTP_URL` → `http://vanna_db_agent:13121`，`MANAGER_DB_ID` / `DB_AGENT_DB_ID` 默认 **p2026**。旧 `db_agent:13101` 仍可在 compose 中保留回滚。

## 现在就能用（对照验收）

- 打开 http://127.0.0.1:13120 ，租户 `p2026`（或已 ingest 的租户），场景「后台助手」。
- 总管 http://127.0.0.1:13106 ：`cap=db` 打 Vanna；联机用例脚本：`python scripts/live_p2026_manager_cases.py`
- 黄金问句：白名单表计数/名单 + 手工 JOIN。执行成功后可点「收入黄金」（不自动晋级）。
- **LLM 次数**：ask 主路径 **始终 1 次 Understand**；`path=golden` 时省第二次 SQL LLM；`path=llm_sql` 再加 1 次写 SQL（失败可修）。精确黄金/指标别名经归一化后仍走 Understand，由 Router 确认 `path=golden`。
- Docker：`vanna_db_web:13120`、`vanna_db_agent:13121`（总管 DB）；旧 `db_agent:13101` 仅回滚用。

真实问句清单：[docs/p2604-real-questions.md](docs/p2604-real-questions.md)（内容为 **p2026**）。  
NLU / 快路径 / 约束评估：[docs/nlu-capability-assessment.md](docs/nlu-capability-assessment.md)。

换库：复制 `tenants/_template.yml` 为 `tenants/<id>.yml`（文件名不要 `_` 开头）+ 目录文件夹，然后  
`python scripts/bootstrap_tenant.py --tenant <id> --live`（或已有 snapshot 时 `--from-snapshot`），再 `POST /api/ingest?tenant=<id>`。

## 总管切流（已做）

- `DB_AGENT_HTTP_URL` / `DB_AGENT_WS_URL` → `vanna_db_agent:13121`；`MANAGER_DB_ID=p2026`
- Evolution Hub db 腿打 Vanna `/api/learning`（随 URL 切换）
- 验收：probe/plan/ask（manager 路径跳过 checkpoint）、真实域 A1–A5 / D1 / D3 联机脚本
- **禁止** `docker compose down -v`
- 回滚：compose 两行 URL 改回 `db_agent:13101`，`--force-recreate manager_agent`

## 场景：入口已通，深度未填

| 场景 | 现状 | 缺什么 |
|---|---|---|
| 后台助手 | 名单/计数、checkpoint、收入黄金 | 写库 HITL 已通（须 write_allowed + confirm_token） |
| 分析师自助 | 聚合 SQL + 柱/折/饼 | 自动看板、下钻、导出 Excel |
| 决策分析 | GROUP BY / 指标口径 | 漏斗模板包 |
| DBA 助手 | 允许 `information_schema` 只读 | 慢日志、锁等待 |
| 合规审计 | 强制 SQL 留痕、敏感列更严 | 审计导出 |
| 嵌入 SaaS | 路由 stub | 按商户注入行级 WHERE |
| ETL / 质检 | 路由 stub | 空值/重复/枚举越界模板 |

## 产品缺口

- 用户登录与 ERP JWT 打通（P2604 后台 9990 浮窗仍未做）。
- 只读 MySQL 账号（当前可用 root，生产应换成 SELECT-only；**写库账号应单独最小权限**，勿用无边界 root 当唯一防线）。
- 场景自动识别（开关默认关，避免再变成多次 LLM）。

## 写库 HITL（已交付 · p2026）

- 安全 DML（INSERT/UPDATE/DELETE）+ 有限 DDL（CREATE TABLE、ALTER ADD/MODIFY COLUMN）。
- 硬禁 DROP/TRUNCATE/DROP COLUMN/GRANT 等；AST + `guard_write_sql`。
- 写路径始终 pending → `POST /api/pending/decide` + `confirm_token`（T2）；总管 `MANAGER_DB_WRITE_ALLOWED=1` 或 meta.`dbWriteAllowed` 才进写预览。
- Skill：`skills/write_gate.md`。

## 明确不做（除非另开需求）

- 不把旧 LangGraph 十三段 LLM 搬过来。
- 第一期不对 DROP/TRUNCATE 做「二次确认放行」。
- 不 `docker compose down -v`。
