# CodePy_Agent

轻量代码助手 Agent（Manager cap **`code`**，端口 **13103**）。

用 **Python FastAPI + React** 重写，替代厚重的 Nuxt `code_assistent_Agent`（旧目录保留作对照/回滚）。

## 能力

| 路径 | 行为 |
|------|------|
| **compute** | 总管主路径：基于上游 facts/上下文做精准计算与整理；可产出改库 SQL/脚本**建议**（不直连生产库） |
| **inspect / edit** | 读仓、意见、SEARCH/REPLACE Diff；写盘默认 **pending → HITL confirm_token 再 apply** |
| **run_terminal** | 沙箱白名单命令（pytest/npm/ls/`git status|diff|log|show` 等），超时截断 |

**不做**：Repo Map / 向量经验 / learning / 厚 ReAct。生产写盘仍须 `WRITE_TOOL_ENABLED=1`。

## 对总管契约

- `GET /api/health` → `{ ok, agent: "code" }`
- `POST /api/compute` → `{ answer, meta, agentResult }`（HTTP 快路径）
- `WS /_ws`：`agent-chat` ↔ `delta` / `meta` / `done` / `error` / `agent_edit_preview`
- `POST /api/pending/decide`：确认/取消 pending patch（须 `confirm_token`）
- `POST /api/git-restore`：取消/失败兜底（`git checkout -- paths`）
- `POST /api/mcp`：精简 `run_code_task` / `read_file` / `apply_patch`
- Manager env **不变**：`CODE_AGENT_WS_URL` / `CODE_AGENT_HTTP_URL`；Compose 服务名仍为 **`code_assistent_agent`**

## Smoke

```bash
cd CodePy_Agent
python scripts/smoke_protocol.py
python scripts/smoke_fs.py
python scripts/smoke_compute.py
python scripts/smoke_shell_sandbox.py
python scripts/smoke_edit_pending.py
python scripts/smoke_hands_safety.py
```

写库侧（Vanna）：`python scripts/smoke_write_impact.py`、`python scripts/smoke_write_guard.py`

## 目录

```text
app/           FastAPI + compute/edit runner + FS / shell sandbox
frontend/      Vite + React 轻量 IDE
docker/        Dockerfile
scripts/       smoke_*.py
skills/        compute_assistant / code_edit_loop
```
