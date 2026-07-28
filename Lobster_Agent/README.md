# Lobster Agent

> **学习文档**：[入门](../docs/Agent学习指南-入门版.md) · [进阶](../docs/Agent学习指南-进阶版.md) · [Lobster 专篇](学习指南.md)  
> **协议 SSOT**：[Lobster升级SSOT](doc/Lobster升级SSOT.md) · [Docker 与宿主机动手](doc/Docker与宿主机动手部署.md)

基于 **Nuxt 4 + Playwright + LangGraph** 的网页 **GUI / RPA** Agent。平台能力 id 为 **`gui`**，服务名 `lobster_agent`，默认端口 **13108**（noVNC 常见 **6080**）。

## 项目简介

不是写死脚本，而是 **规划 → 执行 → verify → recover** 闭环：在动态页面上选元素、点选输入、校验是否真的进入下一步，失败则恢复。与 **Extractor（crawler）** 分工：采集列表字段用 Extractor；需要点击、登录流、遮罩处理用 Lobster。

## 核心能力

| 能力 | 说明 |
|------|------|
| 浏览器运行时 | Playwright 生命周期、截图、状态 API |
| 候选元素 | locator / bbox / 文本等多级兜底 |
| verify / recover | 动作后校验；失败进入恢复分支 |
| 风控 gate | 高风险动作限制或人工确认 |
| 执行模式 | `classic` / `mcp` / `auto`（默认 MCP 优先回退 classic） |
| Workflow Macro | `workflows/*.json` + 总管 `workflow_id` |
| MCP 导出 | 默认可暴露 `/api/mcp`（见环境变量） |

### 执行模式（`LOBSTER_EXECUTION_MODE`）

| 模式 | 说明 |
|------|------|
| `classic` | 内置 LangGraph + Playwright 候选/恢复流水线 |
| `mcp` | `@playwright/mcp` 无障碍树工具链 |
| `auto`（默认） | MCP 优先；失败回退 classic |

```bash
LOBSTER_EXECUTION_MODE=auto
LOBSTER_MCP_ENABLED=1
# Docker / 无显示：独立 MCP HTTP
# npx -y @playwright/mcp@latest --port 8931 --headless
# LOBSTER_MCP_URL=http://127.0.0.1:8931/mcp
```

探针：`GET /api/ready`（`executionMode`、`engines`、`mcp.ok`）。本地：`npm run smoke:mcp`、`npm run smoke:workflow`。

## 技术栈

- Nuxt 4、Vue 3、Nitro、LangGraph、Zod、Playwright
- 回归：`scripts/regression-smoke.mjs`

## 架构与关键路径

```text
WS/API task → plan → act（classic | mcp）
                    → verify → recover?
                    → screenshot / result → Manager
```

## 目录结构速览

- `server/services/lobsterAgent.ts` — 主编排
- `server/services/lobsterRuntime.ts` — 浏览器生命周期
- `server/services/lobsterAgent/` — 候选、执行、验证、恢复、合规
- `server/routes/_ws.ts` — WebSocket
- `server/api/lobster/*` — 启停、状态、截图
- `workflows/*.json` — 宏工作流

## 快速开始

```bash
cd Lobster_Agent
npm install
cp .env.example .env
npm run dev
```

## 环境变量

常见项：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`LOBSTER_PLANNER_MODEL`、`LOBSTER_DECISION_MODEL`、`LOBSTER_VISION_MODEL`、`LOBSTER_HEADLESS`、`LOBSTER_ADMIN_TOKEN`、`LOBSTER_EXECUTION_MODE`。完整见 `.env.example`。

## 与 Manager 协作

- 总管 cap：`gui`
- 主通道：WebSocket（`LOBSTER_AGENT_WS_URL`）
- 协议字段见 [Lobster升级SSOT](doc/Lobster升级SSOT.md) §4
- 高风险步骤受总管协作姿态与 HITL 约束

## 推荐测试站点

默认起始页 [菜鸟教程](https://www.runoob.com/)。示例：

```
打开 https://www.runoob.com/ ，提取页面标题和第一个教程链接，输出 JSON 并结束。
```

也可：`https://www.baidu.com/`、`https://www.gov.cn/`。

## 能力边界

- **适合**：结构清晰的国内资讯/教程站、搜索点击抽取、需恢复的 GUI 任务
- **不适合**：复杂 SPA 音视频站、大规模静态采集（用 Extractor）、纯 API 拉数

## Docker / 平台编排

默认 **`13108:13108`**，noVNC **`6080:6080`**。宿主桌面 / 登录态 Chrome / Win UIA 见 [Docker 与宿主机动手部署](doc/Docker与宿主机动手部署.md)。

## 安全提示

- 启用 `LOBSTER_ADMIN_TOKEN` 后 API/WS 须带鉴权
- 浏览器会执行页面脚本，仅对可信目标使用
- 勿提交真实 `.env`

## 常见问题

- **无窗口**：检查 `LOBSTER_HEADLESS`
- **任务卡住**：查候选元素与 recover 日志
- **鉴权失败**：token 与请求头是否一致

## 相关文档

- [Lobster升级SSOT](doc/Lobster升级SSOT.md)
- 矩阵总表：[docs/Agent矩阵升级总路线图.md](../docs/Agent矩阵升级总路线图.md)
