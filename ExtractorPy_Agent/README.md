# ExtractorPy_Agent

轻量网页爬虫 Agent（Manager cap **`crawler`**，端口 **13104**）。

用 **Python FastAPI + React** 重写，替代厚重的 Node/Nuxt `Extractor_Agent`（旧目录保留作对照/回滚）。

## 栈

| 阶段 | 实现 |
|------|------|
| 搜种子 | SearXNG（缺 `seed_urls` 且允许发现时） |
| 主抓取 | CRW（Firecrawl 兼容 `MCP_BASE_URL`） |
| 难页兜底 | 自有 Docker `playwright_mcp` |
| 抽取 | 启发式优先；必要时 T0 `CAP_ROUTE`（默认 `qwen-turbo`）短 JSON，思考关闭 |
| NLU | 与旧 Extractor 同 skill：`structured_task_plan` / `seed_crawl_plan` / `crawler_slot_clarify`；structural≥0.72 锁定；`EXTRACTOR_PLAN_MAX_TOKENS=384` |

**不做**：本地 Chromium、site patches、learning/bandit、BullMQ。

## 对总管契约

- `WS /_ws`：`start` / `cancel` / `ping` ↔ `status` / `log` / `result` / `error` / `pong`
- `POST /api/extract`、`POST /api/extract/async`、`GET /api/jobs/{id}`
- `GET /api/health`、`GET /api/ready`
- `agentResult.agent === "crawler"`，`structured.content_trust === "untrusted"`
- Manager env 不变：`CRAWLER_AGENT_WS_URL` / `CRAWLER_AGENT_HTTP_URL`

## 本地开发

```bash
cd ExtractorPy_Agent
python -m venv .venv
# Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # 填 QWEN_API_KEY；本机 CRW/SearX/MCP 端口见 .env.example

# 后端
python -m uvicorn app.main:app --host 0.0.0.0 --port 13104

# 前端（可选）
cd frontend && npm install && npm run build
# 或 npm run dev（代理到 13104）
```

## Smoke

```bash
cd ExtractorPy_Agent
pip install -r requirements.txt
python scripts/smoke_protocol.py
python scripts/smoke_channels.py
```

## Docker / Compose

`Manage-platform_Agent/docker-compose.agents-lan.yml` 中服务名仍为 **`extractor_agent`**，构建改为：

```yaml
dockerfile: ExtractorPy_Agent/docker/Dockerfile
```

并注入 `PLAYWRIGHT_MCP_URL=http://playwright_mcp:8931/mcp`，依赖 `crw` / `searxng` / `playwright_mcp`。

### 回滚到旧 Node Extractor

1. 将 compose 中 `extractor_agent.build.dockerfile` 改回 `Extractor_Agent/Dockerfile`
2. 恢复原 Node 相关 `args` / `environment`（见 git 历史）
3. `docker compose build extractor_agent && docker compose up -d extractor_agent`

## 目录

```text
app/           FastAPI + runner + tools
frontend/      Vite + React 工作台
docker/        Dockerfile / entrypoint
scripts/       smoke_*.py
```
