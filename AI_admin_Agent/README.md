# AI Admin Agent

> **学习文档**：[入门](../docs/Agent学习指南-入门版.md) · [进阶](../docs/Agent学习指南-进阶版.md) · [Admin 专篇](学习指南.md)  
> **能力升级规划**（Admin + Lobster，能力优先）：[`docs/动手Agent升级-Admin与Lobster.md`](../docs/动手Agent升级-Admin与Lobster.md)

基于 **FastAPI + React (Vite) + LangGraph** 的个人办公助理。对应平台 `ai_admin_agent`，默认端口 **13105**；总管能力 cap 为 `admin`。

## 项目简介

把天气、地图、日程/待办/联系人、邮件等能力封装为 **tools**，由图状态机驱动调用；支持 HTTP 与 WebSocket 流式交互。可独立使用玩法台，也可由 Manager 经 `manager_task` 侧车下发已确认任务。

**总管可编排范围**（仅四类）：天气、地图、日程（含待办/联系人）、邮件。热榜 / 百科盲盒 / 飞书玩法等可在本服务玩法台直连，**Manager 不路由到 admin**。详见仓库 `Manager_Agent/skills/admin_capabilities/skill.md`。

## 核心能力

| 能力 | 说明 |
|------|------|
| 办公主链 | 日历、待办、提醒、通讯录、邮件分拣与回复 |
| 天气 / 地图 | 工具调用（总管亦走此 cap） |
| HITL | 高风险操作确认；总管可传可信侧自动确认参数 |
| manager_task | 结构化侧车，与总管协议对齐 |
| content_trust | 内容可信度相关约束与 smoke |
| 玩法台 / MCP | 本仓额外趣味能力；不经总管编排 |

## 技术栈

- 后端：FastAPI、SQLAlchemy、LangGraph、LangChain（OpenAI 兼容）
- 前端：React 19、Vite、Tailwind
- 通信：HTTP API、WebSocket

## 架构与关键路径

```text
HTTP/WS chat ──► LangGraph
                   ├─ tool call（日历/邮件/地图/天气…）
                   ├─ HITL gate
                   └─ 流式事件回前端 / 总管
```

## 目录结构速览

- `backend/app/main.py` — 路由、WS、聊天入口
- `backend/app/graph/state.py` — 图定义
- `backend/app/tools/` — 工具与 skills
- `backend/app/core/` — 配置、LLM、content_trust 等
- `backend/app/db/` — 会话与模型
- `backend/app/api/metrics.py` — 指标
- `frontend/` — 管理台与聊天 UI
- `backend/scripts/smoke_*.py` — 批次 smoke

## 快速开始

### Smoke

```bash
cd AI_admin_Agent/backend
python scripts/smoke_batch0.py
python scripts/smoke_batch1.py
python scripts/smoke_batch2.py
python scripts/smoke_batch3.py
python scripts/smoke_batch4.py
python scripts/smoke_batch5.py
python scripts/smoke_content_trust.py
python scripts/smoke_admin_write_clarify.py
python scripts/smoke_admin_risky_hitl.py
```

### 后端

```bash
cd AI_admin_Agent/backend
python -m venv venv
# Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 13105
```

### 前端

```bash
cd AI_admin_Agent/frontend
npm install
npm run dev
```

## 环境变量

见 `.env.example`：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`、数据库与邮件相关配置。

## 与 Manager 协作

- 总管 cap：`admin`（仅四类诉求）
- 主通道：WebSocket（`AI_ADMIN_AGENT_WS_URL`）
- 载荷：`client_context.manager_task`（与 `normalize_manager_task` / passthrough 对齐）
- 问数 / 知识库 / 联网搜索 → 总管走 `db` / `rag` / `crawler`，勿判给 admin

## 能力边界

- **适合**：办公协助、日程邮件、天气地图、经总管的 HITL 办公步骤
- **不适合**：无约束公网助理、把玩法类能力伪装成总管 cap、未经授权的敏感操作

## Docker / 平台编排

默认 **`13105:13105`**。

## 安全提示

- `auto_confirm_risky` 仅可信编排层可用
- 邮件与通讯录最小权限；勿提交真实 `.env`

## 常见问题

- **WS 403**：CORS / 反向代理
- **前端 404**：确认静态资源已构建挂载
- **工具失败**：查 DB、模型 Key、外部 API 配额

## 相关文档

- 矩阵总表：[docs/Agent矩阵升级总路线图.md](../docs/Agent矩阵升级总路线图.md)（P2-D 国内 Skill/MCP 加强已取消；趣味能力以本仓为准）
- 总管 admin 范围：`Manager_Agent/skills/admin_capabilities/skill.md`
