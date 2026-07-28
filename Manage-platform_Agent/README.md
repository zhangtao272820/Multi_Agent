# Manage-platform Agent（紫微 · LAN 部署版）

> **学习文档**：[入门](../docs/Agent学习指南-入门版.md) · [进阶](../docs/Agent学习指南-进阶版.md) · [平台专篇](学习指南.md)  
> **升级方案**：[企业级控制面升级方案](doc/企业级控制面升级方案.md)（P0 · P0.5 · P1 · P2a · **P2b HPA/LiteLLM** · **Langfuse** 已落地；**P3-CP 可选加深默认不开**，见方案 §5.4）  
> **对外展示名**：本控制面称 **紫微**；子 Agent 星曜别名见 [`frontend/src/agentDisplayNames.js`](frontend/src/agentDisplayNames.js)（仅 UI/文档，不改 docker / API 名）。

本目录用于 **一键启动整套 Agent 运行环境**：Docker Compose 编排 **紫微（ClawHive）管理平台**（前端 + 后端 + PostgreSQL + Redis）以及 **禄存 DB / 文曲 RAG / 武曲 Code / 巨门 Extractor / 天梁 Admin / 天机 Manager / 廉贞 Multimodal / 七杀 Lobster / 天府 Tavern** 等子 Agent 容器；**标准版默认**挂载 **Prometheus + Grafana + Alertmanager + Tempo + Loki + Langfuse**（可用 `--no-monitor` / `-NoMonitor` 关闭）。可选 **LiteLLM** 出口网关（`--profile litellm` + `LITELLM_ENABLED=1`）。

本仓库在 Gitee 上为单体仓库 [`assssshuhuhuh/agent`](https://gitee.com/assssshuhuhuh/agent) 中的 `Manage-platform_Agent/`。本地 LAN 采用 **三层 SSOT**（勿压成单一巨型 `.env`）；**日常可在 ClawHive 控制台改**，文件仍是落盘权威：

| 层 | 文件 | 写什么 | 控制台入口 |
|----|------|--------|------------|
| 模型 | `.env.capability-models` | `CAP_*` 模型名（唯一可写源） | Agent 配置 → 能力层 |
| 行为 MODE | `.env.convergence-modes` | `MANAGER_WEB_SEARCH_MODE` 等 | Agent 配置 → 收敛 MODE |
| 基础设施 | `.env.agents-lan` | 端口、Token、API Key、SearXNG | Agent 配置 → 集群基建；密钥 → 系统设置 Vault |

### ClawHive 七域控制面

| 域 | 控制台路由 | 能力 |
|----|------------|------|
| 运维 | 总览 / 总管 / 任务 | 健康、Token 流水、编排转发 |
| 配置 | Agent 配置 | 模型 · MODE · agents-lan · 本地白名单 `.env` |
| 管控 | Agent 管控 | 启停 · Drain · 滚动重启 |
| 可观测 | 监控与日志 | Prom 大屏 · 告警 · run_id/trace_id → Loki/Tempo/Langfuse |
| 部署 | 部署中心 | 镜像 tag · 回滚（封装 `rollback-agents`）· 离线包状态 |
| 维护 | 备份恢复 | PG 备份/恢复（封装 scripts） |
| 治理 | 系统设置 | 租户配额 · Vault · 审计 |

API 速查：`/api/agents/config/convergence-modes`、`/api/agents/config/agents-lan`、`/api/agents/config/{name}/local-env`、`/api/ops/deploy/*`、`/api/ops/backup/*`。

## 项目简介

Manage-platform 是整套矩阵的 **运维与治理入口**：用 Compose 固化端口、服务发现与依赖顺序，用脚本封装 `up/down/restart`，让演示与内网部署可重复；ClawHive 提供 Agent 启停、技能市场、任务编排与健康总览。

## 核心文件

- `docker-compose.agents-lan.yml`（编排；模型键勿写进 `services.environment`）
- `.env.agents-lan` / `.env.agents-lan.example`（基础设施）
- `.env.capability-models` / `.env.capability-models.example`（能力层模型 SSOT）
- `.env.convergence-modes` / `.env.convergence-modes.example`（行为 MODE SSOT）
- 能力层说明：[../docs/企业级能力层模型方案.md](../docs/企业级能力层模型方案.md)
- **控制面升级**：[doc/企业级控制面升级方案.md](doc/企业级控制面升级方案.md)（与真·企业控制面差距、开源对标、P0–P2）
- `scripts/apply-capability-models.ps1`（换模型/MODE 后一键 sync + force-recreate）
- `scripts/install-linux.sh`（**客户 Linux 一键部署**；`--offline` / `--no-monitor` / 健康门禁）
- `scripts/up-agents-lan.ps1`（Windows / 开发机；`-Extended` / `-NoMonitor`）
- `scripts/tag-images.sh` / `tag-images.ps1`（写入 `CLAWHIVE_IMAGE_TAG=semver-sha`）
- `scripts/package-offline.sh` / `package-offline.ps1`（构建机打 `offline/images.tar`）
- `scripts/rollback-agents.sh` / `rollback-agents.ps1`（按旧 tag 回滚 + 健康门禁）
- `scripts/backup-postgres.sh` / `backup-postgres.ps1`（PG 备份）
- `scripts/restore-postgres.sh` / `restore-postgres.ps1`（PG 恢复）
- `scripts/build-agents-prod.ps1` / `build-agents-prod.sh`（标准版全量首方镜像）
- `scripts/down-agents-lan.ps1`
- `scripts/restart-agents-lan.ps1`
- `scripts/restart-manager-stack.ps1`（仅总管协作链：Manager + 子 Agent）
- `helm/clawhive/`（**P2a** K8s 标准协作链 chart；详见 [helm/clawhive/README.md](helm/clawhive/README.md)）
- `backend/app/runners/`（Local / Compose / Kubernetes 启停实现）

## 客户服务器部署（推荐流程）

看起来容器很多，但运维只需关心 **一个配置文件 + 一个控制台**；子 Agent 的模型/端口在 ClawHive 里改，不必 SSH 进每台机器改 `.env`。

### 新环境交付（构建机 → 客户机）

```text
构建机: package-offline → offline/images.tar + SHA256SUMS
    ↓ 拷贝仓库（或制品包）
客户机: 填 .env.agents-lan → install-linux.sh --offline → /health/ready
    ↓
日常: 只开控制台（启停 / 改模型 / 看告警）；不必改各 Agent .env
```

| 步骤 | 命令 |
|------|------|
| 构建机打离线包 | `bash scripts/package-offline.sh`（Windows：`.\scripts\package-offline.ps1`） |
| 客户机安装 | `bash scripts/install-linux.sh --offline` |
| 验收 | 打开 `:18073` 总览全绿；Grafana/Prom/Tempo/Loki；Manager 发一条对话 |
| 备份 | `bash scripts/backup-postgres.sh` |
| 恢复演练 | `bash scripts/restore-postgres.sh backups/<file>.sql.gz --yes` → 再查 `/health/ready` |
| 回滚镜像 | `bash scripts/rollback-agents.sh <旧CLAWHIVE_IMAGE_TAG>` |

详见 [`offline/README.md`](offline/README.md)。

### K8s / Helm（P2a，可选；Compose 仍为默认）

有集群时用同一套 `clawhive/*:<tag>` 镜像：

```bash
kubectl create namespace clawhive
helm upgrade --install clawhive ./helm/clawhive -n clawhive \
  --set image.tag=<CLAWHIVE_IMAGE_TAG> \
  --set secrets.clawhiveInternalToken=<token> \
  --set secrets.openaiApiKey=<key>
# 弱机：--set monitoring.enabled=false
```

- backend 默认 `AGENT_CONTROL_MODE=kubernetes`，**不挂 docker.sock**；控制台启停 = scale Deployment（名与 `docker_service` / `k8s_deployment` 一致）。
- 验收：`helm lint ./helm/clawhive` → 安装后 `:18000/health/ready` → 管控页 stop/start 某一 Agent。
- **Compose 回归**：LAN 继续 `up-agents-lan.ps1` / `install-linux.sh`，`AGENT_CONTROL_MODE=docker` 行为不变。

### 两档部署

| 档位 | 命令 | 包含 |
|------|------|------|
| **标准版**（企业默认） | `install-linux.sh` 或 `up-agents-lan.ps1` | 平台 + DB/RAG/Code/Extractor/Admin/Multimodal/Manager + **Prom/Grafana/Alertmanager/Tempo/Loki** |
| **完整版** | 加 `--extended` / `-Extended` | 标准版 + 音乐/视频/Lobster |
| **弱机** | 加 `--no-monitor` / `-NoMonitor` | 标准协作链，不启监控（含 Tempo / Loki） |

标准版已覆盖 **对话编排 + 查数 + RAG + 代码 + 爬虫 + 办公 + 多模态理解 + 基础监控**；音乐/视频生成与 Lobster 按需再开 extended。

镜像版本：环境变量 `CLAWHIVE_IMAGE_TAG`（默认 `prod`；构建/安装脚本可写成 `0.1.0-<gitsha>`）。离线交付：构建机 `package-offline` 产出 `offline/images.tar` + `SHA256SUMS` 后，客户机执行 `bash scripts/install-linux.sh --offline`。

### Linux 客户机（3 步）

**前提**：Docker Engine 24+、Compose v2、Git 克隆整仓到 `/opt/agent`（或交付离线包）。

```bash
cd /opt/agent/Manage-platform_Agent
cp .env.agents-lan.example .env.agents-lan
# 编辑：LAN_HOST、CLAWHIVE_INTERNAL_TOKEN、OPENAI_API_KEY、CLAWHIVE_ADMIN_PASSWORD
bash scripts/install-linux.sh
# 弱机：bash scripts/install-linux.sh --no-monitor
# 离线：准备 offline/images.tar + SHA256SUMS 后 bash scripts/install-linux.sh --offline
```

完整版：

```bash
bash scripts/install-linux.sh --extended
```

验收：浏览器打开 `http://<LAN_HOST>:18073` 登录 → **总览** 全绿 → **Agent 管控** 见期望/实际态 → **Manager** `:13106` 发一条对话；Grafana `:13000` / Prometheus `:19090` / Tempo `:3200` / Loki `:3100` 可打开；总览「追踪」条或运行详情可深链到 Grafana Explore。

PG 备份 / 恢复：

```bash
bash scripts/backup-postgres.sh
bash scripts/restore-postgres.sh backups/clawhive-pg-XXXX.sql.gz --yes
```

镜像回滚（需本地已有旧 tag 镜像，或先 load 旧离线包）：

```bash
bash scripts/rollback-agents.sh 0.1.0-<oldsha>
```
### 客户日常只碰这些

| 做什么 | 在哪做 |
|--------|--------|
| 改模型 / Profile | 控制台 → Agent 配置 |
| 重启某个 Agent | 控制台 → Agent 配置 → 重启此 Agent |
| 改 API Key | `.env.agents-lan` → `force-recreate` 平台栈，或在控制台密钥托管 |
| 改 MySQL 连接 | `.env.agents-lan` 的 `DB_AGENT_MYSQL_*` |
| 看健康 / Token / Trace | 控制台 → 总览 / 监控大屏；Trace 深链打开 Grafana Explore |
| 设租户配额 / 看密钥状态 | 控制台 → 系统设置 |
| Prometheus 告警 | 标准监控栈 → `:19090/alerts` 或系统设置 / 监控大屏告警中心（含 `notify_detail`） |
| 外发告警 webhook | `.env.agents-lan` 的 `CLAWHIVE_ALERT_WEBHOOK_URL`（可选；企微/钉钉/自定义） |

**不必**让客户手改 12 份 Agent `.env`：Docker 内各 Agent 通过 `CLAWHIVE_BACKEND_URL` 拉平台配置，~60s 生效。

**配额**：`.env.agents-lan` 可设 `CLAWHIVE_DEFAULT_TENANT_QUOTA_TOKENS`；或在控制台 **系统设置** 按租户设置，超配额任务返回 HTTP 429。

### Windows 开发机 / 内网演示

```powershell
cd e:\Agent\Manage-platform_Agent
cp .env.agents-lan.example .env.agents-lan   # 若尚无
powershell -ExecutionPolicy Bypass -File .\scripts\up-agents-lan.ps1
# 完整栈：
powershell -ExecutionPolicy Bypass -File .\scripts\up-agents-lan.ps1 -Extended
# 弱机不开监控：
powershell -ExecutionPolicy Bypass -File .\scripts\up-agents-lan.ps1 -NoMonitor
```

## 使用方法（PowerShell）

> **以后以 Docker 为主**：日常只操作下面「Docker 运维」命令；本机 `npm run dev` 仅用于单独调试某个 Agent。

先进入目录：

```powershell
cd e:\Agent\Manage-platform_Agent
```

### 启动全部（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\up-agents-lan.ps1
```

启动后可访问（默认读取 `.env.agents-lan`）：

- 管理平台前端：`http://<LAN_HOST>:${CLAWHIVE_FRONTEND_PORT:-18073}`
- 管理平台后端健康：`http://<LAN_HOST>:${CLAWHIVE_BACKEND_PORT:-18000}/health`
- Grafana：`http://<LAN_HOST>:${CLAWHIVE_GRAFANA_PORT:-13000}`（默认 `admin/admin123`；Tempo uid=`tempo`；Loki uid=`loki`）
- Prometheus：`http://<LAN_HOST>:${CLAWHIVE_PROMETHEUS_PORT:-19090}`
- Alertmanager：`http://<LAN_HOST>:${CLAWHIVE_ALERTMANAGER_PORT:-19093}`
- Tempo：`http://<LAN_HOST>:${CLAWHIVE_TEMPO_PORT:-3200}`（OTLP HTTP `:4318`；Manager `MANAGER_OTLP_ENDPOINT`）
- Langfuse：`http://<LAN_HOST>:${CLAWHIVE_LANGFUSE_PORT:-13001}`（OTLP → `/api/public/otel/v1/traces`；Manager 双写 `MANAGER_LANGFUSE_OTLP_ENDPOINT`；默认账号 `admin@clawhive.local` / `admin123`）
- LiteLLM（可选）：`LITELLM_ENABLED=1` + `docker compose --profile litellm up` → `:14000`；配置见 `monitoring/litellm/config.yaml`
- Loki：`http://<LAN_HOST>:${CLAWHIVE_LOKI_PORT:-3100}`（Promtail 刮容器日志；Manager `MANAGER_STRUCTURED_LOG`）
- （可选）Dex OIDC：`docker compose --profile oidc up -d dex`，并设置 `OIDC_ENABLED=1`、`OIDC_ISSUER=http://127.0.0.1:5556/dex`、`OIDC_CLIENT_ID=clawhive`、`OIDC_CLIENT_SECRET=clawhive-oidc-secret`、`OIDC_REDIRECT_URI=http://127.0.0.1:18000/api/auth/oidc/callback`

### 最短上手（首次建议按这个顺序）

1) 启动全部：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\up-agents-lan.ps1
```

2) 打开管理平台：

```text
http://<LAN_HOST>:18073
```

3) 登录默认账号：

```text
admin / admin123
```

4) 登录后建议验证（侧栏管理系统）：

- **总览**：运维 KPI、企业监控（Prometheus Token/Runs）、快捷入口
- **总管 & 子 Agent**：阶段耗时、Token 按 phase、子 Agent 探活 + `/api/metrics` 快照、调用流水（每 5s 刷新）
- **Agent 配置**：统一编辑各 Agent 模型 / 端口 / 端点（写入 DB + 审计，Manager/子 Agent 自动拉取）
- **监控大屏**：平台 API/技能图表 + **Manager Token / Runs**（Prometheus）
- **Agent 管控**：docker compose 启停 + 手动注册
- **任务编排**：目标留空或 `manager` → **Manager WebSocket 编排**
- **系统设置**：环境登记只读快照、用户管理

5) 进阶功能（可选）：

- 「技能中心」：市场、安装/Rollout、沙箱执行引擎（平台内已有能力；旧「公共技能市场方案」长文已废弃）
- **记忆 / 反馈进化**：历史 Phase 已落地；旧「Agent 记忆与存储数据库化」长文已废弃，不再单列升级（见矩阵总表「已完成 / 已取消」）
- Grafana / Prometheus / Tempo / Loki：`:13000` / `:19090` / `:3200` / `:3100`（控制台 Trace/Log 深链 → Explore）

### 仅重建 ClawHive 平台（改过 `frontend/` 或 `backend/app/` 后）

勿只 `docker cp` 单个文件到 `clawhive_backend`（曾导致崩溃循环）。应完整构建：

```powershell
cd e:\Agent\Manage-platform_Agent
docker compose --env-file .env.agents-lan -f docker-compose.agents-lan.yml build clawhive_frontend clawhive_backend
docker compose --env-file .env.agents-lan -f docker-compose.agents-lan.yml up -d clawhive_frontend clawhive_backend
```

浏览器 **Ctrl+F5** 强刷。若 Manager 不可达：`docker compose ... up -d manager_agent`。

### 环境变量（三层 SSOT）

| 文件 | 用途 |
|------|------|
| **`.env.capability-models`** | 模型名 `CAP_*` **唯一可写源** → apply 脚本同步到各 Agent `.env` |
| **`.env.convergence-modes`** | 行为 MODE（含 `MANAGER_WEB_SEARCH_MODE`） |
| **`.env.agents-lan`** | 端口、PG、**CLAWHIVE_INTERNAL_TOKEN**、API Key、**SearXNG / WEB_SEARCH_*** |
| `backend/.env` | 仅本机 `up-local.ps1` 起后端时用 |
| 项目根 `.env` | **勿放** `CAP_*` / `SEARXNG_*`（compose 插值会污染）；仅可作非 SSOT 回退 |

`CLAWHIVE_INTERNAL_TOKEN` 必须与 `Manager_Agent/.env` 中相同，否则 Manager 无法从平台同步端点。

日常换模型并生效（sync + recreate，**restart 不会重载 env_file**）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\apply-capability-models.ps1
# 仅检查漂移：
powershell -ExecutionPolicy Bypass -File .\scripts\apply-capability-models.ps1 -Check
# 只写文件不重启：
powershell -ExecutionPolicy Bypass -File .\scripts\apply-capability-models.ps1 -SyncOnly
```

换联网基础设施（SearXNG URL / provider）→ 只改 `.env.agents-lan` → `up -d --force-recreate manager_agent searxng`。  
换云抓取底座（CRW，Firecrawl 兼容）→ `up -d --force-recreate crw extractor_agent`；容器内 `MCP_BASE_URL=http://crw:3000/v1/scrape`。  
**apply 脚本不会修 SearXNG**；见下文「总管联网搜索排查」。

### 停止全部

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\down-agents-lan.ps1
```

---

## 总管联网搜索排查

总管 `web_search` 节点依赖：**MODE**（是否开搜）+ **SearXNG 容器**（真正出网）+ **模型**（规划 query；须关 thinking / 有超时）。

| 现象 | 检查 |
|------|------|
| UI 停在 `web_search` / 「规划检索 query」很久 | Manager 搜索 LLM 是否经 `createManagerChatOpenAI(skipThinking)`；容器模型是否为 qwen3.5 且默认开思考 |
| SearXNG 失败 / 空结果 | `docker exec manager_agent wget -qO- 'http://searxng:8080/search?q=test&format=json'`；`SEARXNG_BASE_URL` 须为 `http://searxng:8080`（容器内禁止 `localhost:8088`） |
| 有 Tavily/Serper 却一直挂起 | 付费 API 需带 AbortSignal；检查出网/代理 |
| Admin 能搜、Manager 不能 | Manager 默认 `WEB_SEARCH_ALLOW_DDG_FALLBACK=0`；对比 Admin |

冒烟（可选）：

```powershell
docker cp .\scripts\_verify-web-search-e2e.mjs manager_agent:/tmp/v.mjs
docker exec manager_agent node /tmp/v.mjs
```

---

## Docker 运维速查（主路径）

以下命令均在 `e:\Agent\Manage-platform_Agent` 执行；**必须**带 `.env.agents-lan`。

### 场景对照

| 你改了什么 | 推荐命令 |
|-----------|----------|
| 平台前端/后端（侧栏、API、Agent 配置页） | `restart-clawhive-platform.ps1`（需 **build** 时见下文） |
| Manager + 协作子 Agent 代码/配置 | `restart-manager-stack.ps1` 或 `-Build` |
| 单个 Agent（如只改了 DB） | 控制台 **Agent 配置 → 重启此 Agent**，或 compose 单服务 |
| 全栈（平台 + 全部 Agent + 监控） | `up-agents-lan.ps1` / `restart-agents-lan.ps1` |
| 只改了 `.env.agents-lan` 里的端口/Key | 对应服务 **`up -d --force-recreate <service>`** |

### 1) 首次 / 全量启动

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\up-agents-lan.ps1
```

### 2) 只重建 ClawHive 平台（改过 backend/frontend 后）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-clawhive-platform.ps1
```

改过 **backend Dockerfile**（如本次新增 docker CLI）需 build：

```powershell
docker compose --env-file .env.agents-lan -f docker-compose.agents-lan.yml build clawhive_backend clawhive_frontend
docker compose --env-file .env.agents-lan -f docker-compose.agents-lan.yml up -d clawhive_backend clawhive_frontend
```

### 3) Manager 全家桶（最常用）

仅重启进程（镜像不变）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-manager-stack.ps1
```

代码或依赖变更后重建镜像：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-manager-stack.ps1 -Build
```

等价一条命令：

```powershell
docker compose --env-file .env.agents-lan -f docker-compose.agents-lan.yml up -d --build --force-recreate db_agent rag_agent code_assistent_agent extractor_agent ai_admin_agent music_agent video_agent multimodal_agent manager_agent
```

### 4) 控制台内重启（无需 SSH）

登录 ClawHive → **Agent 配置**：

- **重启此 Agent**：`docker compose up -d <service>`
- **强制重建此 Agent**：加 `--force-recreate`
- **重启 Manager 全家桶**：一次 restart 9 个协作服务

（需 `clawhive_backend` 挂载 `/var/run/docker.sock`，已在 compose 中配置。）

### 5) 重启单个服务（示例：DB）

```powershell
docker compose --env-file .env.agents-lan -f docker-compose.agents-lan.yml up -d --force-recreate db_agent
```

### 6) 重启全部（不重建镜像）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-agents-lan.ps1
```

### 7) 停止

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\down-agents-lan.ps1
```

### 8) 必配项（Docker 集群）

在 `.env.agents-lan` 中设置（与 `Manager_Agent/.env` 一致）：

```text
CLAWHIVE_INTERNAL_TOKEN=随机长字符串
```

未设置时：子 Agent 内部鉴权不生效；设置后 Manager 会自动在调用头里带上该 token。

---

### 重启（全部或单个）— 脚本别名

仅重建 **ClawHive 管理平台**（前端侧栏 UI / 后端 API 变更后）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-clawhive-platform.ps1
```

重启全部：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-agents-lan.ps1
```

仅重启 **Manager 全家桶**（总管 + 协作子 Agent）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-manager-stack.ps1
```

重建 Manager 全家桶镜像：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-manager-stack.ps1 -Build
```

重启单个（示例）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-agents-lan.ps1 -Service code_assistent_agent
```

可选服务名：

- `clawhive_postgres`
- `clawhive_redis`
- `clawhive_backend`
- `clawhive_frontend`
- `prometheus`
- `grafana`
- `db_agent`
- `rag_agent`
- `code_assistent_agent`
- `extractor_agent`
- `ai_admin_agent`
- `manager_agent`
- `multimodal_agent`
- `lobster_agent`
- `playwright_mcp`（Lobster GUI 的 Playwright MCP sidecar，端口默认 `8931`）
- `tavern_agent`
- `music_agent`
- `video_agent`
- `ai_agent`

## 注意

- **局域网打不开控制台 / 登录后接口失败**：Docker 内后端默认需匹配浏览器 **Origin**。Compose 已为 `clawhive_backend` 注入 `CLAWHIVE_FRONTEND_PORT` / `CLAWHIVE_BACKEND_PORT`，并在 **`DEPLOY_MODE=docker`** 时用正则放行任意 IP 的 `:18073`、`:18000`。若仍失败，在 `.env.agents-lan` 中为 **`CLAWHIVE_ALLOW_ORIGINS`** 追加你的访问地址，例如 `http://192.168.1.100:18073`（见仓库内 `.env.agents-lan.example`）。
- 所有 Docker 命令都必须带 compose 文件与 env 文件（脚本已内置）。
- 首次执行 `up` 会触发镜像构建，耗时较长属于正常；后续重启会明显加快。
- 如果出现旧代码未生效，优先使用 `restart-agents-lan.ps1` 或 `down` + `up`。
- 管理平台默认管理员：`admin / admin123`（建议在 `.env.agents-lan` 中立刻修改）。
- Lobster noVNC（默认映射宿主端口 `${LOBSTER_VNC_PORT:-6080}`）：`http://<LAN_HOST>:6080/vnc.html`（若在 `.env.agents-lan` 改了 `LOBSTER_VNC_PORT`，请替换端口）。
- Lobster **Playwright MCP**：extended 配置下自动起 `playwright_mcp` sidecar；`lobster_agent` 默认 `LOBSTER_EXECUTION_MODE=auto` 且 `LOBSTER_MCP_URL=http://playwright_mcp:8931/mcp`。探针：`GET http://<LAN_HOST>:13108/api/ready` 查看 `mcp.ok`。
- Docker/LAN 环境统一使用 `.env.agents-lan`（以及 backend 镜像内环境变量）。

## 常用接口（登录后）

- 健康总览：`GET /api/health/overview`
- Agent 运行态：`GET /api/agents/runtime`
- 技能执行：`POST /api/skills/invoke`
- 技能运行记录：`GET /api/skills/runs`、`GET /api/skills/runs/{run_id}`
- 技能生命周期：`POST /api/skills/{skill_id}/publish`、`POST /api/skills/{skill_id}/deprecate`、`GET /api/skills/{skill_id}/versions`
- 公共市场：`GET /api/skills/registry/search`、`POST /api/skills/catalog/install`、`GET /api/skills/market/stats`
- 远程导入：`POST /api/skills/import/url`、`POST /api/skills/import/registry`
- 安装回滚与日志：`POST /api/agents/{agent_id}/skills/rollback`、`GET /api/skills/runs/{run_id}/logs`
- 远程演示包构建：`python scripts/build-registry-packages.py`
- **内部免费市场同步**：`python scripts/sync-internal-market.py`（扫描全集群 Playbook → `skills-catalog/internal-market/`）（生成 `skills-catalog/remote-demo/`）
## Docker 运维速查（启动 / 重启 / Python 镜像）

以下命令都在 `e:\Agent\Manage-platform_Agent` 目录执行。

### 1) 启动全部服务

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" up -d
```

首次部署（或你改过 Dockerfile）建议加 `--build`：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" up -d --build
```

### 2) 重启全部服务（不重建镜像）

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" restart
```

### 3) Manager 全家桶（总管 + 全部协作子 Agent，推荐）

包含：`db_agent`、`rag_agent`、`code_assistent_agent`、`extractor_agent`、`ai_admin_agent`、`music_agent`、`video_agent`、`multimodal_agent`、`manager_agent`（**不含** ClawHive 管理平台与 Lobster/Tavern）。

**总管 UI 音乐/视频「加载超时」或无法播放下载**：浏览器请求的是总管同源 `/api/files/…`、`/api/video/…`，由 `manager_agent` 容器再 HTTP 转发到 `music_agent` / `video_agent`。若未配置 **`MUSIC_AGENT_HTTP_URL`** / **`VIDEO_AGENT_HTTP_URL`**，代理会误连容器内的 `127.0.0.1` 导致超时。`docker-compose.agents-lan.yml` 已默认注入 `http://music_agent:13110` 与 `http://video_agent:13111`；修改后请 **`up -d --force-recreate manager_agent`**。

**只重建容器进程**（镜像不变，配置/挂载更新会生效）：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" up -d --force-recreate db_agent rag_agent code_assistent_agent extractor_agent ai_admin_agent music_agent video_agent multimodal_agent manager_agent
```

**重建镜像并重启**（改过各 Agent 代码、`Dockerfile`、Python/Node 依赖后执行，与下文 `ai_admin_agent` 单条命令同风格）：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" up -d --build --force-recreate db_agent rag_agent code_assistent_agent extractor_agent ai_admin_agent music_agent video_agent multimodal_agent manager_agent
```

等价脚本（会先停止占用 13107 的旧 `older_agent` 容器）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-manager-stack.ps1
```

需重建镜像时：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-manager-stack.ps1 -Build
```

### 4) 完整 LAN 全家桶（管理平台 + 全部 Agent + 监控）

含 ClawHive（Postgres/Redis/前后端）、全部子 Agent、`prometheus`、`grafana`、`rag_pgvector` 等。

**只强制重建容器**：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" up -d --force-recreate
```

**重建全部镜像并重启**：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" up -d --build --force-recreate
```

### 5) `AI_admin_Agent`（Python）更新与重启

只重启容器（代码/镜像未变）：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" restart ai_admin_agent
```

重建镜像并重启（Python 依赖、Dockerfile、后端代码有变更时）：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" up -d --build --force-recreate ai_admin_agent
```

若构建报错 `docker.1ms.run/... not found` 或 `failed to resolve source metadata`，说明镜像加速源不可用。`ai_admin_agent` 已默认改用 DaoCloud 基础镜像；也可在 `.env.agents-lan` 中设置：

```text
AI_ADMIN_PYTHON_IMAGE=docker.m.daocloud.io/library/python:3.11-slim-bookworm
```

### 6) `Tavern_Agent`（Agent 酒馆）：重启 Docker「后台 + 前台」

说明：**只有一个容器 `tavern_agent`**——FastAPI 既提供 `/api`，又用构建好的前端静态页托管页面（无单独前端容器）。下面两条分别对应「只重启进程」与「改代码后重建镜像再启动」。

仅重启（镜像与代码未变，加载 `.env.agents-lan` 中的环境变量）：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" restart tavern_agent
```

重建镜像并重启（改过 `Tavern_Agent/backend`、`Tavern_Agent/frontend`、`Tavern_Agent/Dockerfile` 或依赖后执行）：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" up -d --build --force-recreate tavern_agent
```

默认映射：`${TAVERN_PORT:-13109}:13109`，浏览器访问：`http://<LAN_HOST>:13109/`（页面与接口同源）。

若密钥与 Tavern 相关变量写在仓库内 **`.env`**（而非 `.env.agents-lan`），将上述命令里的 `--env-file ".\.env.agents-lan"` 换成 **`--env-file ".\.env"`** 即可。

也可用脚本（读取 `.env.agents-lan`）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-agents-lan.ps1 -Service tavern_agent
```

改过 Dockerfile / 前后端代码需重建镜像时加 `-Build`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-agents-lan.ps1 -Service tavern_agent -Build
```

### 7) `Music_Agent`（作曲 / MIDI / 前端静态页）：重启 Docker 服务

说明：**单个容器 `music_agent`**——FastAPI 提供 API，并托管构建好的前端 `dist`（与 Tavern 类似，无单独前端容器）。默认映射：`${MUSIC_AGENT_PORT:-13110}:13110`，浏览器访问：`http://<LAN_HOST>:13110/`。

仅重启（镜像与代码未变）：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" restart music_agent
```

重建镜像并重启（改过 `Music_Agent/backend`、`Music_Agent/frontend`、`Music_Agent/Dockerfile` 或 Python/Node 依赖后执行）：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" up -d --build --force-recreate music_agent
```

也可用脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-agents-lan.ps1 -Service music_agent
```

改过 Dockerfile / 前后端代码需重建镜像时加 `-Build`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart-agents-lan.ps1 -Service music_agent -Build
```

构建阶段若出现 **`Unable to connect to deb.debian.org`**、`apt-get install` **exit code 100**：多为拉 Debian 官方包时网络中断（国内常见）。`Music_Agent/Dockerfile` 已默认把 apt 换为 **清华 Debian / debian-security** 镜像，并增加 apt 重试；`docker-compose.agents-lan.yml` 的 `music_agent` 构建参数可通过 `.env.agents-lan` 覆盖：`MUSIC_AGENT_APT_DEBIAN_MIRROR`、`MUSIC_AGENT_APT_SECURITY_MIRROR`（海外若需官方源可设为 `https://deb.debian.org/debian` 与 `https://security.debian.org/debian-security`）。

**`No matching distribution found for spleeter`**：`music_agent` 镜像须 **Python 3.10**（重演绎依赖 spleeter）。勿将 `MUSIC_AGENT_PYTHON_IMAGE` 设为 `3.12`；compose 默认已为 `python:3.10-slim-bookworm`。

**仅执行 `docker compose ... build` 时，正在跑的容器仍用旧镜像**，页面会像「没更新」。构建成功后请 **`up -d --force-recreate music_agent`**（或一条命令 `up -d --build --force-recreate music_agent`），再在浏览器对 `http://<主机>:13110` **强制刷新**（Ctrl+F5 / 清空缓存后硬刷新）。

**百炼 Key 在 `Manage-platform_Agent/.env` 里仍报未配置**：若命令行用了 `--env-file .env.agents-lan`，Compose **只会用该文件**做 YAML 里的 `${OPENAI_API_KEY}` 替换，**不会自动读** 同目录的 `.env`，原先 `music_agent` 的 `environment: OPENAI_API_KEY: ${OPENAI_API_KEY:-}` 会被展开成**空字符串**写进容器。已在 `docker-compose.agents-lan.yml` 为 `music_agent` 增加 **`env_file`**（`.env.agents-lan`、`.env`、`../Music_Agent/.env`，均可选），由容器启动时加载 Key；修改后请 **`up -d --force-recreate music_agent`**。

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" up -d --build --force-recreate music_agent
```
### 7b) `Video_Agent`（10 秒内短视频 / LangGraph / 通义万相）

**单容器 `video_agent`**：FastAPI + 托管前端 `dist`。端口接在 `music_agent` 之后，默认 **`${VIDEO_AGENT_PORT:-13111}:13111`**，浏览器：`http://<LAN_HOST>:13111/`。密钥与 `music_agent` 相同，通过 `env_file` 链加载 `../Video_Agent/.env` 等。

**BGM 无声 / 时间线显示「BGM 失败」**：`video_agent` 会 HTTP 调用 `music_agent` 的 `/api/music/generate-bgm`。若 `../Video_Agent/.env` 里仍是本机地址 `MUSIC_AGENT_HTTP_URL=http://127.0.0.1:37890`，在 Docker 内会连到 **video 容器自身** 而非 `music_agent`（`Connection refused`）。`docker-compose.agents-lan.yml` 已为 `video_agent` 默认注入 `MUSIC_AGENT_HTTP_URL=http://music_agent:13110`；改 compose 或 `.env` 后请 **`up -d --force-recreate video_agent`**。

**BGM 成功但仍无声**：万相返回的是 OSS 外链，BGM 在 `music_agent` 的 `/api/files/…`。`mux` 须下载两者并用 **ffmpeg** 混流；若合成失败会静默退回 OSS 原片（无音轨，播放器音量不可调）。时间线「合成」应显示 `合成模式：merged` 与 `/api/video/out/final_with_bgm_*.mp4`；若为 `passthrough` 请看「说明」。镜像需含 ffmpeg，改代码后请 **`up -d --build --force-recreate video_agent`**。

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" up -d --build --force-recreate video_agent
```

### 7c) `AI_Agent`（实时语音数字人）

**单容器 `ai_agent`**：FastAPI + WebSocket + 前端静态页。端口接在 `video_agent` 之后，默认 **`${AI_AGENT_PORT:-13112}:8080`**，浏览器访问：`http://<LAN_HOST>:13112/`。容器会同时提供 `/health`、`/ws` 和前端页面，同源启动更适合联调。

仅重启（代码未变）:

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" restart ai_agent
```

改过代码 / Dockerfile 需重建镜像：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" up -d --build --force-recreate ai_agent
```

### 7d) `AI_Agent`（废土数字人 / 实时语音对话）

**单容器 `ai_agent`**：FastAPI + 托管前端 `dist`。默认映射：`${AI_AGENT_PORT:-13112}:8080`，浏览器访问：`http://<LAN_HOST>:13112/`，WebSocket：`ws://<LAN_HOST>:13112/ws`。

构建时可通过 `.env.agents-lan` 覆盖基础镜像，避免 Docker Hub 拉取超时：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" up -d --build --force-recreate ai_agent
```

如果你的网络直连 Docker Hub 不稳定，可在 `.env.agents-lan` 里显式设置：

```text
AI_AGENT_NODE_IMAGE=docker.m.daocloud.io/library/node:20-bullseye
AI_AGENT_PYTHON_IMAGE=docker.m.daocloud.io/library/python:3.12-slim-bookworm
```

**配置优先级**：业务项（Key、模型、`LIP_SYNC_MODE`、路径等）一律编辑 **`AI_Agent/.env`**（从 `AI_Agent/.env.example` 复制）；Docker 仅通过 `env_file` 注入，不在 compose `environment` 里写默认值。编排端口、局域网 IP 写在 **`Manage-platform_Agent/.env.agents-lan`**（见 `.env.agents-lan.example` 的 `AI_AGENT_PORT`、`LAN_HOST`）。Docker 部署时在 `AI_Agent/.env` 中取消注释 `ASSETS_DIR=/app/assets` 等容器路径。

对口型缓存：在 `.env` 设 `LIP_SYNC_MODE=cached_s2v`，相同问题命中 `AI_Agent/assets/`，不再重复调万相。

### 8) 镜像/容器问题排查（特别是 Python 服务）

查看服务状态：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" ps
```

查看 `AI_admin_Agent` 日志：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" logs --tail=200 ai_admin_agent
```

镜像缓存疑似脏了（依赖冲突、旧层残留）时，强制重新构建：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" build --no-cache ai_admin_agent
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" up -d --force-recreate ai_admin_agent
```

### 8) 停止与清理

仅停止：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" down
```

停止并删除匿名卷（谨慎）：

```powershell
docker compose --env-file ".\.env.agents-lan" -f ".\docker-compose.agents-lan.yml" down -v
```
换模型 / MODE 后请用正式入口（见上文「环境变量（三层 SSOT）」）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\apply-capability-models.ps1

```
