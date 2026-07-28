# Extractor Agent

> **学习文档**：[入门](../docs/Agent学习指南-入门版.md) · [进阶](../docs/Agent学习指南-进阶版.md) · [Extractor 专篇](学习指南.md)

网页 **抓取与结构化抽取** Agent：自然语言任务 → 计划 → 多通道执行 → 质量评分与重试。对应平台 `extractor_agent`，默认端口 **13104**；总管能力 cap 为 **`crawler`**（与 Extractor 为同一专家）。

## 项目简介

偏静态 / 半静态页面与列表型字段抽取；与 **Lobster（gui）** 分工：Lobster 做浏览器 GUI 点击与交互，Extractor 做采集与结构化输出。

经总管调用时：**必须先**由 Manager `web_search` 产出种子，再带 `seed_urls` 精抓；禁止不经 SERP 单独深抓。

## 核心能力

| 能力 | 说明 |
|------|------|
| HTTP 通道 | fetch + cheerio，默认首选 |
| Playwright | 动态页 / 反爬 / 总管种子精抓 |
| 云抓取 | Firecrawl 兼容（`MCP_*`）；可自托管 CRW |
| 异步队列 | `EXTRACTOR_ASYNC_QUEUE=1`：`POST /api/extract/async` → `GET /api/jobs/{id}` |
| MCP Server | `EXTRACTOR_MCP_SERVER=1`：`scrape_url` / `extract_task` |
| Seed-first | `manager_task_json.seed_urls` |
| 站点补丁 | `patches/sites/*.json`（换站加 JSON） |
| 抽取路径 | patch → template → rule → llm → heuristic（`meta.extract_path`） |
| 质量门禁 | 覆盖率、重复率、条数；低质可重试 |
| 合规 | `robotsPolicy`、限速、并发上限 |

## 技术栈

- Nuxt 4、Nitro、LangGraph、Zod
- cheerio、turndown、Playwright
- 冒烟：`scripts/extractor-smoke.mjs`

## 架构与关键路径

```text
taskPlan → channel select（HTTP / browser / cloud）
        → extract（patch/template/rule/llm/heuristic）
        → quality score → retry?
        → crawler_results.json / API 响应
```

## 目录结构速览

- `server/services/` — 编排、执行器、规划、质量控制
- `server/routes/` — WebSocket 等
- `server/api/` — HTTP 任务入口
- `patches/sites/` — 站点补丁
- `scripts/extractor-smoke.mjs`
- `crawler_results.json` — 默认产物

## 快速开始

```bash
cd Extractor_Agent
npm install
cp .env.example .env
npm run dev
```

生产构建：`npm run build`。

## 常用运行参数

```json
{
  "maxPages": 3,
  "maxItems": 30,
  "maxConcurrency": 3,
  "useBrowser": false,
  "outputJsonPath": "crawler_results.json",
  "robotsPolicy": "strict"
}
```

`robotsPolicy`：`strict`（默认）/ `warn` / `off`（仅受控环境）。

## 环境变量

见 `.env.example`。云抓取：`MCP_BASE_URL` 等；异步 / MCP 开关见上表。

## 与 Manager 协作

- 总管 cap：`crawler`
- 主通道：WebSocket（`CRAWLER_AGENT_WS_URL`）；HTTP health `/api/health`
- 种子：`manager_task` / `seed_urls`；总管侧 skill：`crawler_web`
- 可选 MCP 导出供注册表发现

## 能力边界

- **适合**：列表/详情字段采集、分页、质量门禁与重试
- **不适合**：强 GUI 交互（用 Lobster）、无视 robots 的大规模爬取

## Docker / 平台编排

默认 **`13104:13104`**。

## 安全提示

- 浏览器通道会执行页面脚本，慎用
- 生产勿关闭合规检查；勿提交真实密钥

## 常见问题

- **Playwright 未就绪**：确认 Chromium 安装
- **结果过少**：调大 `maxPages` 或放宽质量阈值
- **通道选错**：检查 taskPlan 与站点补丁

## 相关文档

- Skills：`skills/*/skill.md`
- 矩阵总表：[docs/Agent矩阵升级总路线图.md](../docs/Agent矩阵升级总路线图.md)
