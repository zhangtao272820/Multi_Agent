# CodePy_Agent

轻量代码助手 Agent（Manager cap **`code`**，端口 **13103**）。

用 **Python FastAPI + React** 重写，替代厚重的 Nuxt `code_assistent_Agent`（旧目录保留作对照/回滚）。

## 能力

| 路径 | 行为 |
|------|------|
| **compute** | 总管主路径：基于上游 facts/上下文做精准计算与整理；可产出改库 SQL/脚本**建议**（不直连生产库） |
| **inspect / edit** | 独立端：读仓、意见、SEARCH/REPLACE Diff；写盘需 `WRITE_TOOL_ENABLED` + UI 确认 |

**不做**：Repo Map / 向量经验 / learning / 厚 ReAct / 命令沙箱（首版）。

## 对总管契约

- `GET /api/health` → `{ ok, agent: "code" }`
- `POST /api/compute` → `{ answer, meta, agentResult }`（HTTP 快路径）
- `WS /_ws`：`agent-chat` ↔ `delta` / `meta` / `done` / `error` / `agent_edit_preview`
- `POST /api/mcp`：精简 `run_code_task` / `read_file` / `apply_patch`
- Manager env **不变**：`CODE_AGENT_WS_URL` / `CODE_AGENT_HTTP_URL`；Compose 服务名仍为 **`code_assistent_agent`**

## 本地开发

```bash
cd CodePy_Agent
python -m venv .venv
# Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # 填 OPENAI_API_KEY

python -m uvicorn app.main:app --host 0.0.0.0 --port 13103

# 前端
cd frontend && npm install && npm run build
# 或 npm run dev（代理到 13103）
```

## Smoke

```bash
cd CodePy_Agent
pip install -r requirements.txt
python scripts/smoke_protocol.py
python scripts/smoke_fs.py
python scripts/smoke_compute.py
```

## Docker / Compose

`Manage-platform_Agent/docker-compose.agents-lan.yml` 中服务名仍为 **`code_assistent_agent`**，构建改为：

```yaml
dockerfile: CodePy_Agent/docker/Dockerfile
```

挂载宿主 monorepo → `/workspace`（`PROJECT_DIR=/workspace`）。

### 回滚到旧 Nuxt Code

1. 将 compose 中 `code_assistent_agent.build` 改回 `Manage-platform_Agent/docker/nuxt-agent/Dockerfile` + `AGENT_DIR: code_assistent_Agent`
2. `env_file` 改回 `../code_assistent_Agent/.env`
3. `docker compose build code_assistent_agent && docker compose up -d code_assistent_agent`

## 目录

```text
app/           FastAPI + compute/edit runner + FS sandbox
frontend/      Vite + React 轻量 IDE（秋意武曲风格）
docker/        Dockerfile
scripts/       smoke_*.py
skills/        compute_assistant / code_edit_loop
```
