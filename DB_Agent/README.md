# DB Agent

> **学习文档**：[入门](../docs/Agent学习指南-入门版.md) · [进阶](../docs/Agent学习指南-进阶版.md) · [DB 专篇](学习指南.md)

单库 **自然语言查数（NL2SQL）** Agent：Schema 接地 → 路径选择 → 只读 SQL 执行。对应平台 `db_agent`，默认端口 **13101**；总管能力 cap 为 `db`。

## 项目简介

面向「连上一套 MySQL、用中文问业务指标」的场景。主链强调 **只读查询、Schema 注释接地、结构化槽位**，避免在总管侧用关键词硬路由。范例域 `p2026`（养老）可作补丁模板；生产可用 `generic` + 本库 `data/domains/<库名>/` 补丁。

## 核心能力

| 能力 | 说明 |
|------|------|
| 查询编排 | `repeat → condense → plan → schema_ground → route → …` |
| 统计路径 | generic_stats / 领域模板 + LLM 路由 |
| SQL 路径 | 默认 `sql_plan_direct`（preflight+SQL）；失败可回落 `sql_agent` |
| 域补丁 | `data/domains/<DB_AGENT_DOMAIN>/`（blueprint / relations / metrics） |
| 运行档位 | `DB_AGENT_PROFILE=low_token \| balanced \| full`（生产推荐 `balanced`） |
| 观测 | `GET /api/metrics`、`/api/learning`、`/api/metrics-catalog` |
| 反馈 | `POST /api/feedback` `{ question, score: 1\|-1 }` |
| 进化数据 | `.data/`（学习信号、经验回放、影子 prompt、路径 Bandit） |

## 技术栈

- Nuxt 4、LangGraph、Zod、OpenAI 兼容 LLM
- MySQL（业务库）；主链见 `utils/graph/`、`conversational_retrieval_chain.ts`

## 架构与关键路径

```text
repeat → condense → plan → schema_ground → route
  → statistics（generic_stats / 领域模板）
  → sql_plan_direct → sql_direct → sql_agent（fallback）
```

前端：`pages/index.vue` + `components/db-chat/`。

## 目录结构速览

- `utils/graph/` — LangGraph 节点
- `utils/db_agent_env.ts` — 默认开关与档位 SSOT
- `data/domains/` — 库级补丁
- `server/api/` — ask / plan / probe / metrics / schema
- `scripts/` — smoke 与灌数

## 快速开始

```bash
cd DB_Agent
npm install
cp .env.example .env
npm run dev
```

### Smoke

```bash
npm run smoke:all              # 无 MySQL：含 nlu-mode / sql-path / domain-modules 等
npm run smoke:structural-link  # 需 MySQL
npm run smoke:decompose        # 需本服务 HTTP（默认 :13101）
```

Manager `ci:gate` 会跑：`npm run smoke:db-all`。

可选灌数：`npm run seed:p2026-person`。Schema 缓存：`POST /api/schema/refresh`。

## 环境变量

`.env` 仅保留必改项示例：

```bash
OPENAI_API_KEY=sk-...
MYSQL_PASSWORD=...
MYSQL_DATABASE=p2026

# 能力层模型名（SSOT 也可来自 Manage-platform capability_models）
OPENAI_ORCHESTRATION_MODEL=qwen3-14b
OPENAI_NLU_MODEL=qwen3-14b
OPENAI_AGENT_MODEL=qwen3-coder-flash
EMBEDDING_MODEL=text-embedding-v1
```

其余开关与 token 预算 → `utils/db_agent_env.ts` 的 `DB_AGENT_DEFAULTS`。  
库级补丁 → `DB_AGENT_DOMAIN=p2026` 或 `generic`。

## 与 Manager 协作

- 总管 cap：`db`
- `POST /api/ask`、`/api/plan`、`/api/probe` 与 `managerTask` 载荷协议稳定
- `dbId` 忽略，始终连 `MYSQL_DATABASE`；换库只改域补丁，总管侧无需改代码

## 新库接入 checklist

权威细则：[data/domains/README.md](data/domains/README.md)。摘要：

1. `.env` 设 `MYSQL_*`；`DB_AGENT_DOMAIN=generic` 试跑  
2. 为业务表/列写清中文 `COMMENT`  
3. 手工提 10–20 条**真实客户**典型问句，确认 `sql_direct` 与选表  
4. 需要领域 hint：复制 `data/domains/generic/`（或 `p2026/`）→ `data/domains/<新库>/`，**只改 JSON**  
5. Docker 镜像需含 `data/domains/`；**一库一实例**  
6. `GET /api/config` 看 `patch.id`；`GET /api/metrics` 看 path / `llm_calls`  

总管侧提示词/演示题与库解耦：见 Manager `doc/真实用户域解耦.md`。不重写 NL2SQL 主链。

## 能力边界

- **适合**：单库只读问数、指标统计、带 Schema 接地的 SQL
- **不适合**：跨库联邦、写库/DDL、无注释的「盲猜列名」生产库

## Docker / 平台编排

默认 **`13101:13101`**。镜像须带上 `data/domains/`（见 Manage-platform Nuxt Dockerfile）。

## 安全提示

- 生产保持只读账号与最小权限
- 勿把生产库密码提交进仓库

## 常见问题

- **选表错误**：补 COMMENT 与域补丁 relations  
- **路径总走 agent**：看 `DB_AGENT_PROFILE` 与 metrics 中 path 分布  
- **总管 500**：先对本机 `/api/ask` 做协议 smoke，再查 Manager 透传字段

## 相关文档

- Skills：`skills/*/skill.md`
- LLM-First 约束：`doc/db-agent-llm-first-constraints.md`（若本地保留）
- 矩阵总表：[docs/Agent矩阵升级总路线图.md](../docs/Agent矩阵升级总路线图.md)
