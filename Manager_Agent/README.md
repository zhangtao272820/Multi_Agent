# Manager Agent

> **面试讲义**：[备战入口](../docs/面试备战/00-使用说明与防穿帮.md) · [01 总管](../docs/面试备战/01-总管-Manager.md) · [06 协同](../docs/面试备战/06-多Agent协同.md) · [Star ⭐](https://gitee.com/assssshuhuhuh/agent/stargazers)

多 Agent 矩阵的**编排总管**：统一 WebSocket 会话入口，用 LangGraph 做意图拆解、路由、规划与执行，调度下游专家服务，并支持人工确认、取消与反馈采集。默认端口 **13106**（平台服务名 `manager_agent`）。

## 项目简介

Manager 不替代 DB、RAG、Code、Extractor 等专业能力，只负责：

- 维护会话与流式事件（chat / resume / cancel / confirm）
- 将用户诉求落到能力 cap（`db` / `rag` / `code` / `crawler` / `gui` / `admin` / `multimodal` / `music` / `video` 等）
- 在高风险步骤前暂停等待确认（HITL）
- 聚合下游结果并做合成 / 批评闭环

**媒体拓扑**：`multimodal`（识图/ASR/视频理解，**标准核心子 Agent**）、`music`、`video`（extended）由总管 **直接** HTTP/WS 调用。有附件且还需业务 Agent 时，Planner 先 multimodal 再下游 `dependsOn`。任务分配默认 **`decompose`（子句拆解）→ `route` → `planner`**；关闭拆解：`MANAGER_CLAUSE_DECOMPOSE=0`。聊天输入支持粘贴 / 拖拽 / 附件上传图片。

## 核心能力

| 能力 | 说明 |
|------|------|
| 编排状态机 | `probe → route → plan → execute → synthesize → critic` |
| 协作姿态 | Ask / Plan / Agent / Debug（输入区下拉，约束读写与确认） |
| 工作台模式 | 对话 / 专业（顶栏，控制编排深度） |
| Agent 注册表 | `GET /api/agents/registry`：能力、端点、健康快照（调度权威；与 ClawHive 技能表边界见 [`docs/registry-boundary.md`](../docs/registry-boundary.md)） |
| 工具健康 | `tool_health` 覆盖 db～video；`down` 不进入 `allowedAgents` |
| 自我进化 | 向量记忆、Prompt 补丁、Planner 规则、策略金丝雀、进化看板 |
| 媒体代理 | 音乐/视频产物同源播放（Docker 下可配 `MUSIC_AGENT_HTTP_URL` / `VIDEO_AGENT_HTTP_URL`） |
| 内置步骤 | `clean` / `visualize` / `report`（以 `smoke:p0`～`smoke:p3` 为准） |

## 协作姿态 vs 工作台模式

两套开关正交，不要混用：

| 开关 | 值 | 位置 | 作用 |
|------|-----|------|------|
| **协作姿态** `collaborationPosture` | Ask / Plan / Agent / Debug | 对话输入区下拉 | Ask/Debug 只读；Plan 强制蓝图确认；Agent 按风险推进；Debug 需步证据才重验 |
| **工作台模式** `workbenchMode` | 对话 / 专业 | 顶栏 | 对话可寒暄直连；专业走完整编排 |

契约 SSOT：`server/utils/platform/collaborationPosture.ts`。纯 RAG/DB 只读时 Ask 与 Agent 差异较小；写操作（admin / gui / code 落盘）与 Plan 停点差异明显。

## 技术栈

- **框架**：Nuxt 4、Nitro
- **通信**：WebSocket（`server/api/manager-ws.ts`）
- **编排**：LangGraph、`@langchain/openai`
- **校验**：Zod
- **可观测**：LangSmith、`GET /api/metrics`、Prometheus 导出
- **脚本**：`scripts/start-agents.js`、`scripts/nlu-metrics-report.mjs`、`scripts/vector-reindex.mjs`

## 架构与关键路径

```text
Browser ──WS──► manager-ws
                    │
         decompose → route → plan → execute → synthesize → critic
                    │              │
                    │              ├── HTTP/WS → 子 Agent
                    │              └── 内置 clean / visualize / report
                    ▼
            registry / tool_health / evolution
```

代码入口优先看：

- `server/api/manager-ws.ts` — 协议入口
- `server/utils/managerGraph.ts` — 图构建
- `server/graph/` — 节点与执行器
- `server/graph/core/agent/agentRegistry.ts` — 能力注册表

## 目录结构速览

- `server/api/` — WebSocket、metrics、registry、媒体代理等
- `server/graph/` — LangGraph 节点、执行器、状态
- `server/utils/` — 路由、计划、文本、平台契约
- `skills/` — router / planner / 各 cap 的 skill 说明
- `scripts/smoke/` — 门禁与协议 smoke
- `server/plugins/managerEvolutionCurator.ts` — 可选后台进化 Curator

## 快速开始

```bash
cd Manager_Agent
npm install
cp .env.example .env   # 填 OPENAI_API_KEY 与各子 Agent 地址
npm run dev
```

本地联调至少再起一个下游（例如 RAG），并在 `.env` / `nuxt.config` runtimeConfig 中指向其 URL。

**测前预检**：

```bash
npm run smoke:preflight          # 鉴权与配置脚枪
npm run smoke:preflight -- --live  # 再确认 Manager/DB/RAG 已 ready
```

## 自我进化

- **向量召回**（默认开）：experience / plan_outcome → `.data/manager-memory-embeddings.jsonl`
- **用户画像**：跨会话以 PG `mgr_user_profiles`（`user_key`）为权威；会话侧仍可写 `.data/manager-user-profiles.json`（`MANAGER_STORAGE_BACKEND` 默认 dual）
- **Prompt 补丁**：shadow → 晋级后注入 router/planner
- **策略金丝雀**：`MANAGER_POLICY_CANARY_PERCENT=5` 时约 5% 会话用 shadow policy
- **Planner 硬规则**：`.data/manager-planner-rules.json`，经 `plan_lint` 强制执行
- **后台 Curator**：`MANAGER_EVOLUTION_CURATOR=1`
- **运维**（`MANAGER_OPS_TOKEN` + 头 `x-manager-ops-token`）：`vector_reindex`、`prompt_shadow_diff` / `prompt_promote` / `prompt_evolve_force`；脚本 `npm run vector:reindex`

经验回放、向量记忆、规则进化、工具健康等**默认开启**（关：设 `0`）。

## 环境变量

复制 `.env.example`。必改：`OPENAI_API_KEY`、各 `*_AGENT_*_URL`。

常用可选项：`MANAGER_MODEL_*`、`MANAGER_AUTH_MODE` / `MANAGER_WS_TOKEN` / `MANAGER_OPS_TOKEN`、`MANAGER_EXECUTION_MODE_OVERRIDE` / `MANAGER_VOTE_TARGETS`、`MANAGER_POLICY_CANARY_PERCENT`、`MANAGER_EVOLUTION_CURATOR=1`、`MANAGER_CLAUSE_DECOMPOSE=0`。

## 下游协作一览

| cap | 目录 | 默认端口 |
|-----|------|----------|
| db | `DB_Agent` | 13101 |
| rag | `RAG_Agent` | 13102 |
| code | `CodePy_Agent`（服务 `code_assistent_agent`） | 13103 |
| crawler | `Extractor_Agent` | 13104 |
| admin | `AI_admin_Agent` | 13105 |
| multimodal | `Multimodal_Agent` | 13107 |
| gui | `Lobster_Agent`（Stagehand / MCP / classic） | 13108 |
| music | `Music_Agent` | 13110 |
| video | `Video_Agent` | 13111 |

爬虫路径：总管先 `web_search` 再带 `seed_urls` 调 Extractor；**禁止**不经 SERP 单独深抓。Admin 经总管只编排天气 / 地图 / 日程 / 邮件四类（见 `skills/admin_capabilities/skill.md`）。

## 能力边界

- **适合**：统一聊天入口、多 Agent 路由、HITL、任务编排与观测
- **不适合**：在总管进程内做重型爬取、重型文件处理或复杂 GUI 自动化

## Docker / 平台编排

`Manage-platform_Agent` 默认映射 **`13106:13106`**。LAN 部署见 [Manage-platform_Agent/README.md](../Manage-platform_Agent/README.md)。

## 安全提示

Docker/LAN/公网 checklist（与 `.env.example` / `agents-lan.example` 对齐）：

| 项 | 说明 |
|----|------|
| `MANAGER_AUTH_MODE` | `token`（推荐集群）或裸机本地 `open`；未设则默认不鉴权 |
| `MANAGER_WS_TOKEN` | `token` 模式必填；与 `NUXT_PUBLIC_MANAGER_WS_TOKEN` 成对，供同源 UI 连 WS |
| `MANAGER_OPS_TOKEN` | 运维 `POST /api/manager/ops`（头 `x-manager-ops-token`）；未设则一律 403 |
| TLS | 公网须 `wss` / HTTPS 反代；勿裸奔明文 |
| 密钥边界 | 勿把子 Agent 内网 URL、SMTP/API Key 暴露到前端；`NUXT_PUBLIC_*` 仅同源 WS token |

配置脚枪：`AUTH_MODE=token` 却未配 WS token 时，`/api/ready` 为 not-ready，启动日志 ERROR。守门：`npm run smoke:ws-auth`。

高风险写操作保留 HITL / writeGate；勿对公网关闭鉴权。

## 相关文档

- 矩阵总路线图（能力主轴已收口）：[docs/Agent矩阵升级总路线图.md](../docs/Agent矩阵升级总路线图.md)
- 生产硬度与下一波守门：[docs/Agent集群升级与面试对照.md](../docs/Agent集群升级与面试对照.md)
- 协作架构：[doc/借鉴Cursor-Agent模式升级.md](doc/借鉴Cursor-Agent模式升级.md)
- 域路由用例：[doc/真实域路由测试用例.md](doc/真实域路由测试用例.md)
- Smoke / 门禁：[scripts/smoke/README.md](scripts/smoke/README.md)

## 常见问题

- **连不上子 Agent**：检查 `nuxt.config.ts` / `.env` 中 `runtimeConfig.agents.*Url`
- **LangSmith 无数据**：确认追踪开关与 API Key
- **路由异常**：查 `server/graph/` 与 `skills/router_playbook`；看 `/api/metrics` 与进化看板
