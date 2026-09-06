# Docker 持久化：禁止 `down -v` 清卷

## 结论

重启 / 重建 Agent 与总管栈时，**永远不要**带 `-v` / `--volumes`。对话、记忆、向量数据在命名卷里；`down -v` 会直接删掉。

## 数据落在哪

| 卷（compose 项目前缀 `manage-platform_agent_`） | 内容 |
|---|---|
| `clawhive_pg_data` | 各 Agent 会话/记忆权威库（Postgres） |
| `rag_agent_data` | RAG `.data` 文件镜像（dual） |
| `db_agent_data` | DB Agent `.data` 文件镜像（dual） |
| `manager_agent_data` | Manager `.data` 文件镜像（dual） |
| `rag_pgvector_data` | RAG 向量库 |

存储后端：`RAG_AGENT_STORAGE_BACKEND` / `DB_AGENT_STORAGE_BACKEND` / `MANAGER_STORAGE_BACKEND` 应为 **`dual`**（PG + 文件）。compose 默认与 `.env.agents-lan` 需一致；仅改 compose 默认会被 env 覆盖。

## 允许的操作

```bash
cd Manage-platform_Agent

# 启动 / 重建容器（保留卷）
docker compose --env-file .env.agents-lan -f docker-compose.agents-lan.yml up -d --force-recreate

# 改代码后重建镜像再启动（仍保留卷）
docker compose --env-file .env.agents-lan -f docker-compose.agents-lan.yml up -d --build --force-recreate manager_agent db_agent rag_agent

# 停止（保留卷）
docker compose --env-file .env.agents-lan -f docker-compose.agents-lan.yml down
```

Windows：

```powershell
.\scripts\restart-agents-lan.ps1
.\scripts\restart-agents-lan.ps1 -Build
.\scripts\restart-manager-stack.ps1 -Build
.\scripts\down-agents-lan.ps1   # 内部禁止 -v
```

## 禁止的操作

```bash
docker compose … down -v
docker compose … down --volumes
docker volume rm manage-platform_agent_clawhive_pg_data
docker volume prune
```

仅当用户**明确要求清空库 / 重置全部数据**时才可删卷，且应先备份（如 `scripts/backup-postgres.sh`）。

## Agent / 自动化约束

Cursor 规则：[`.cursor/rules/docker-no-volume-wipe.mdc`](../../.cursor/rules/docker-no-volume-wipe.mdc)（alwaysApply）。  
脚本：`down-agents-lan.ps1` 拒绝任何 `-v` 参数。
