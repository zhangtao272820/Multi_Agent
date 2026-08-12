# Lobster Agent

> **面试讲义**：[备战入口](../docs/面试备战/00-使用说明与防穿帮.md) · [05 GUI](../docs/面试备战/05-GUI-Lobster.md)  
> **协议 SSOT**：[Lobster升级SSOT](doc/Lobster升级SSOT.md) · [Docker 与宿主机动手](doc/Docker与宿主机动手部署.md)  
> **能力升级规划**（与 Admin 双动手）：[`docs/动手Agent升级-Admin与Lobster.md`](../docs/动手Agent升级-Admin与Lobster.md)

基于 **Nuxt 4 + Playwright + LangGraph** 的网页 **GUI / RPA** Agent。平台能力 id 为 **`gui`**，服务名 `lobster_agent`，默认端口 **13108**（noVNC 常见 **6080**）。compose 生产入口为本目录 Dockerfile。

## 项目简介

不是写死脚本，而是 **规划 → 执行 → verify → recover** 闭环：在动态页面上选元素、点选输入、校验是否真的进入下一步，失败则恢复。与 **Extractor（crawler）** 分工：采集列表字段用 Extractor；需要点击、登录流、遮罩处理用 Lobster。

## 核心能力

| 能力 | 说明 |
|------|------|
| 浏览器运行时 | Playwright 生命周期、截图、状态 API |
| 候选元素 | locator / bbox / 文本等多级兜底 |
| verify / recover | 动作后校验；失败进入恢复分支 |
| 风控 gate | 高风险动作限制或人工确认 |
| 执行模式 | `auto`=网页 **Stagehand only**；`stagehand` / `mcp` / `classic` 为单引擎锁 |
| Workflow Macro | `workflows/*.json` + 总管 `workflow_id`（国内首选 w3school-form-* / runoob；httpbin 仅海外兜底） |
| Hands 侧车 | `LOBSTER_HANDS_ONLY=1` · 默认 `:13109` · 见 [`hands/README.md`](hands/README.md) |
| MCP 导出 | 默认可暴露 `/api/mcp`（见环境变量） |

### 执行模式（`LOBSTER_EXECUTION_MODE`）

| 模式 | 说明 |
|------|------|
| `auto`（默认） | 网页 **Stagehand 单次**；desktop/mobile/video 硬守卫；无 mcp/classic 自动回退 |
| `stagehand` | 仅 Stagehand Plan Loop |
| `mcp` | 仅 Playwright MCP（显式旁路） |
| `classic` | 仅 LangGraph classic（HITL / 视频 / 显式旁路） |

```bash
LOBSTER_EXECUTION_MODE=auto
LOBSTER_STAGEHAND=1
# 旁路（非网页默认）：
# LOBSTER_EXECUTION_MODE=mcp
# LOBSTER_MCP_URL=http://127.0.0.1:8931/mcp
```

探针：`GET /api/ready`（`executionMode`、`engines`、`mcp.ok`）。本地：`npm run smoke:mcp`、`npm run smoke:workflow`。

## 技术栈

- Nuxt 4、Vue 3、Nitro、LangGraph、Zod、Playwright
- 回归：`scripts/regression-smoke.mjs`

## 架构与关键路径

```text
WS/API task → understand → Stagehand（网页主路径）
                         → MCP（显式旁路）
                         → classic（仅视频 / HITL）
              → verify（拒绝 chrome-error / 网络失败假成功）
              → gui-plus 兜底？ → result → Manager
```

**能力矩阵**：网页 auto = Stagehand；MCP = 调试/旁路；classic = 视频与人工接管；desktop/android 默认关。

## 目录结构速览

- `server/services/lobsterStagehandAgent.ts` — 网页主引擎
- `server/services/lobsterMcpAgent.ts` — Playwright MCP 旁路
- `server/services/lobsterAgent.ts` — classic（视频/HITL）
- `server/services/lobsterAgentRouter.ts` — 引擎路由
- `server/routes/_ws.ts` — WebSocket
- `server/api/lobster/*` — 启停、状态、截图
- `scripts/sync-agent-shared.mjs` — 稀疏同步 shared（7 文件）
- `workflows/*.json` — 宏工作流

## 快速开始

```bash
cd Lobster_Agent
npm install
npm run sync:shared
cp .env.example .env
npm run dev
```

## 环境变量

模型真源：[Manage-platform_Agent/.env.capability-models](../Manage-platform_Agent/.env.capability-models)（`sync-capability-models.py`）。

| 变量 | 能力层 | 说明 |
|------|--------|------|
| `LOBSTER_PLANNER/DECISION/STAGEHAND_MODEL` | **CAP_ROUTE**（T0） | 文本规划与决策，省 token |
| `LOBSTER_VISION_MODEL` / `LOBSTER_GUI_MODEL` | **CAP_GUI**（gui-plus） | 界面专用；默认 `LOBSTER_USE_VISION=false` 不每步截图 |
| `LOBSTER_GUI_PLUS_FALLBACK` / `_MAX_STEPS` | — | DOM(Stagehand/MCP) verify 失败后有限步 computer_use 兜底（默认开，≤3 步） |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | — | Docker 内浏览器出网；宿主机能开网页 ≠ 容器能开 |
| 其它 | — | `LOBSTER_HEADLESS`、`LOBSTER_ADMIN_TOKEN`、`LOBSTER_EXECUTION_MODE` 等见 `.env.example` |

网页主路径：**Stagehand + Playwright bridge**（DOM）。MCP 为旁路。失败且非验证码时，自动走 **gui-plus computer_use**（截图→坐标，硬帽省 token）。

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
- **chrome-error / 无法访问此网站**：容器出网失败；配置 `HTTP_PROXY` 后可用 `npm run diag:egress` 或 `docker exec lobster_agent node /app/scripts/diag-egress.mjs` 诊断
- **任务卡住**：查候选元素与 recover 日志
- **鉴权失败**：token 与请求头是否一致
- **假成功 score=1**：已由 verify 拒绝错误页；若仍出现请确认 shared/lobsterRunVerifyLite 已同步

## 相关文档

- [Lobster升级SSOT](doc/Lobster升级SSOT.md)
- 矩阵总表：[docs/Agent矩阵升级总路线图.md](../docs/Agent矩阵升级总路线图.md)
