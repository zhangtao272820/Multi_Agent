# Code Assist Agent

> **学习文档**：[入门](../docs/Agent学习指南-入门版.md) · [进阶](../docs/Agent学习指南-进阶版.md) · [Code 专篇](学习指南.md)

面向真实仓库的 **工程化 Coding Agent**：浏览 / 语义搜索 / 静态分析 / Diff 预览 / 受控写盘。对应平台 `code_assistent_agent`，默认端口 **13103**；总管能力 cap 为 `code`。

## 项目简介

不是通用聊天框，而是把模型接到仓库工作流：先读后写、变更以 Diff 展示、写操作走鉴权与限流。可由 Manager 经 WebSocket 下发任务，也可独立打开本服务 UI。

## 核心能力

| 能力 | 说明 |
|------|------|
| 仓库浏览 | 文件树、Git 状态、内容读取 |
| 语义搜索 | 代码仓向量 / 符号检索 |
| 静态分析 | tree-sitter、code smell、Bug 扫描 |
| 重构与建议 | 局部修改建议、测试生成 |
| Diff 写盘 | 先预览再确认写入 |
| 安全中间件 | 鉴权（jose）、限流、审计 |
| MCP（可选） | `CODE_MCP_SERVER=1` 时暴露 `/api/mcp` |

## 技术栈

- Nuxt 4、Vue 3、Pinia、Monaco Editor
- LangGraph、`@langchain/openai`、WebSocket（`ws`）
- `web-tree-sitter`、Vitest

## 架构与关键路径

```text
WS / HTTP ──► agent 编排
               ├─ read / search / analyze
               ├─ propose Diff
               └─ gated write（auth + rate limit）
```

## 目录结构速览

- `server/routes/_ws.ts` — WebSocket 主通道
- `server/api/*.ts` — 文件树、Git、写文件、向量搜索等
- `server/services/agent.ts` — 对话与工具编排
- `server/services/codeAnalyzer.ts` / `analysis.ts` — 静态分析
- `server/services/bugDetector.ts`、`testGenerator.ts`
- `server/middleware/00-rate-limit.ts`、`01-auth.ts`
- `components/` — 文件树、Diff、编辑器 UI
- `skills/` — skill 与 MCP manifest

## 快速开始

```bash
cd code_assistent_Agent
npm install
cp .env.example .env
npm run dev
```

## 环境变量

模型与鉴权密钥见 `.env.example` / `nuxt.config.ts`。写盘相关白名单与 token 务必在受信环境配置。

## 与 Manager 协作

- 总管 cap：`code`
- 主通道：WebSocket（`CODE_AGENT_WS_URL`）
- 写文件类步骤通常受协作姿态与 HITL 约束（Ask 只读；Agent/Plan 才推进落盘）

## 能力边界

- **适合**：仓库理解、局部重构、语义找码、受控编辑、测试建议
- **不适合**：无上下文任意写盘、替代完整 CI/CD 与安全审计

## Docker / 平台编排

默认 **`13103:13103`**。

## 安全提示

- 写文件能力仅限受信环境
- 未授权请求应拒绝；勿提交生产密钥

## 常见问题

- **WS 连不上**：检查 Nitro websocket / 反向代理 Upgrade
- **向量搜不到**：确认索引已构建
- **写文件失败**：鉴权、路径白名单、磁盘权限

## 相关文档

- [doc/Code升级路线图.md](doc/Code升级路线图.md)
- Skills / MCP：`skills/*/skill.md`
- 矩阵总表：[docs/Agent矩阵升级总路线图.md](../docs/Agent矩阵升级总路线图.md)
