# AI Admin Agent

> **面试讲义**：[备战入口](../docs/面试备战/README.md) · [04 Admin](../docs/面试备战/技术/04-Admin-Agent.md)  
> **能力升级规划**（Admin Compose / MCP）：[`docs/Admin办公助手对标与Compose升级.md`](../docs/Admin办公助手对标与Compose升级.md)

基于 **FastAPI + React (Vite) + LangGraph** 的个人办公助理。对应平台 `ai_admin_agent`，默认端口 **13105**；总管能力 cap 为 `admin`。

## 项目简介

把天气、地图、日程/待办/联系人、邮件等能力封装为 **tools**，由图状态机驱动调用；支持 HTTP 与 WebSocket 流式交互。可独立使用玩法台，也可由 Manager 经 `manager_task` 侧车下发已确认任务。

**总管可编排范围**（办公六包，与 `shared/adminCapabilities.ts` / `admin_capabilities` skill 对齐）：天气、地图（高德）、日程（含待办/联系人/提醒）、邮件动手、简报/会前、工作区文件。热榜 / 百科盲盒 / 飞书玩法等可在本服务玩法台直连，**Manager 不路由到 admin**。

## 核心能力

| 能力 | 说明 |
|------|------|
| 邮箱绑定（A0） | 按登录用户绑定国内 IMAP/SMTP（QQ/163/126/企业邮）；授权码 Fernet 密文；未绑定 → `email_not_bound` |
| 邮件动手（AM） | 列表/搜索/已读/分拣/草稿/批量草稿/回复/发送/转发/删除/附件；发信·转发·删信 RISKY HITL + **Compose Card** |
| 办公主链 | 日历、待办、提醒、通讯录 |
| 天气 / 地图 | 工具调用（总管亦走此 cap） |
| 简报 / 会前 | `daily_briefing` / `prepare_meeting` / `weekly_report`（含 mail_compose 预填） |
| HITL | 高风险操作确认；邮件提交编辑后 `mail_compose` payload |
| manager_task | 结构化侧车，与总管协议对齐；Python `MANAGER_ADMIN_TOOLS` ↔ shared 白名单 |
| content_trust | 内容可信度相关约束与 smoke |
| 玩法台 / MCP | 本仓额外趣味能力；对外 MCP 见 `mcp-servers/admin-office`（只读+draft，禁直发） |

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

- `backend/app/main.py` — 路由、WS、聊天入口、邮箱绑定 API
- `backend/app/graph/state.py` — 图定义
- `backend/app/tools/` — 工具与 skills
- `backend/app/core/` — 配置、LLM、mailbox_binding、content_trust 等
- `backend/app/db/` — 会话与模型
- `backend/app/api/metrics.py` — 指标
- `frontend/` — 管理台与聊天 UI（含「连接邮箱」）
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
python scripts/smoke_admin_mailbox_binding.py
python scripts/smoke_admin_mail_hands.py
python scripts/smoke_admin_mail_compose.py
python scripts/smoke_admin_dual_path_prompt.py
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
公网默认关闭 `ADMIN_MAIL_ALLOW_GLOBAL_FALLBACK`（勿用运维全局邮箱冒充用户箱）。

## 与 Manager 协作

- 总管 cap：`admin`（办公六包；玩法/问数/联网搜不经此 cap）
- 主通道：WebSocket（`AI_ADMIN_AGENT_WS_URL`）
- 载荷：`client_context.manager_task`（与 `normalize_manager_task` / passthrough 对齐）；须带 `user_id` 以解析邮箱绑定
- 问数 / 知识库 / 联网搜索 → 总管走 `db` / `rag` / `crawler`，勿判给 admin
- 合成层：无 `agentResult` 证据不得声称「已发送」

## 能力边界

- **适合**：按用户绑定邮箱动手、日程邮件、天气地图、经总管的 HITL 办公步骤
- **不适合**：Gmail/M365 OAuth（以后再说）、无人值守群发、把玩法类能力伪装成总管 cap

## Docker / 平台编排

默认 **`13105:13105`**。

## 安全提示

- `auto_confirm_risky` 仅可信编排层可用
- 邮件授权码密文存储；发信必 HITL；勿提交真实 `.env`

## 常见问题

- **WS 403**：CORS / 反向代理
- **前端 404**：确认静态资源已构建挂载
- **email_not_bound**：先在 Mail 页「连接邮箱」绑定国内箱
- **工具失败**：查 DB、模型 Key、外部 API 配额

## 相关文档

- 矩阵总表：[docs/Agent矩阵升级总路线图.md](../docs/Agent矩阵升级总路线图.md)（P2-D 国内 Skill/MCP 加强已取消；趣味能力以本仓为准）
- 动手升级：[docs/动手Agent升级-Admin与Lobster.md](../docs/动手Agent升级-Admin与Lobster.md)
- 总管 admin 范围：`Manager_Agent/skills/admin_capabilities/skill.md`
