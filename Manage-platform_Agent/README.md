# Manage-platform Agent（紫微 · Docker 部署）

用 **Docker Compose** 一键拉起整套 Agent 集群：紫微控制台（前端 + 后端 + Postgres + Redis）+ Manager 与协作子 Agent（DB / RAG / Code / Extractor / Admin / Multimodal 等）。日常只改 **一个配置文件 + 控制台**，不必手改十几份 `.env`。

- **面试讲义**：[07 控制面](../docs/面试备战/07-控制面-ClawHive.md) · [备战入口](../docs/面试备战/00-使用说明与防穿帮.md) · [06 协同](../docs/面试备战/06-多Agent协同.md)
- 公网 / 云主机清单：[docs/公网演示部署.md](../docs/公网演示部署.md) · 反代模板 [`docker/public/`](docker/public/)
- 离线镜像包：[offline/README.md](offline/README.md)
- K8s（可选）：[helm/clawhive/README.md](helm/clawhive/README.md)

---

## 你要关心的文件

| 文件 | 作用 |
|------|------|
| `docker-compose.agents-lan.yml` | 编排（模型名不要写进 `services.environment`） |
| `.env.agents-lan` | **基础设施**：`LAN_HOST`、端口、Token、API Key、密码 |
| `.env.capability-models` | 模型名 `CAP_*` |
| `.env.convergence-modes` | 行为 MODE |

控制台可改上述内容；落盘仍以这三层文件为准。密钥优先走控制台 Vault。

---

## 一、部署到客户服务器（Linux）

### 前提

- Docker Engine 24+、Compose v2  
- 整仓在 `/opt/agent`（或离线交付包）  
- Ubuntu 装 Docker：`sudo bash scripts/bootstrap-docker-ubuntu.sh`

### 档位

| 档位 | 命令 | 内容 |
|------|------|------|
| **标准版** | `bash scripts/install-linux.sh` | 平台 + 协作链 + 监控 |
| **弱机 / 面试** | `… --no-monitor` | 同上，不开 Prom/Grafana 等 |
| **完整版** | `… --extended` | + 音乐 / 视频 / Lobster 等 |
| **离线** | `… --offline` | 先有 `offline/images.tar` + `SHA256SUMS` |

### 3 步安装

```bash
cd /opt/agent/Manage-platform_Agent
cp .env.agents-lan.example .env.agents-lan
# 必改：LAN_HOST、CLAWHIVE_INTERNAL_TOKEN、OPENAI_API_KEY（或 QWEN/DASHSCOPE）、
#       CLAWHIVE_ADMIN_PASSWORD、CLAWHIVE_JWT_SECRET、CLAWHIVE_PG_PASSWORD、
#       MANAGER_WS_TOKEN / NUXT_PUBLIC_MANAGER_WS_TOKEN / MANAGER_OPS_TOKEN
test -f .env.capability-models || cp .env.capability-models.example .env.capability-models
test -f .env.convergence-modes || cp .env.convergence-modes.example .env.convergence-modes

bash scripts/install-linux.sh --no-monitor   # 或去掉 --no-monitor / 加 --extended / --offline
```

### 验收

| 地址 | 用途 |
|------|------|
| `http://<LAN_HOST>:18073` | 紫微控制台（默认 `admin` / 见 `.env.agents-lan`） |
| `http://<LAN_HOST>:18000/health` | 后端健康 |
| `http://<LAN_HOST>:13106` | Manager 对话 |

登录 → **总览** 尽量全绿 → Manager 发一条对话。脚本会轮询 `/health/ready`。

### 离线交付（构建机 → 客户机）

```text
构建机: bash scripts/package-offline.sh
    ↓ 拷贝仓库 + offline/images.tar + SHA256SUMS
客户机: 填 .env.agents-lan → bash scripts/install-linux.sh --offline
```

公网只开 **80/443** 反代 UI，勿把 PG / Redis / 子 Agent 端口写进安全组。详见 [公网演示部署](../docs/公网演示部署.md)（含 **§2b 专家失败决策 / 会话退出** 与生产封顶 env）。

---

## 二、Windows / 内网开发机

```powershell
cd e:\Agent\Manage-platform_Agent
cp .env.agents-lan.example .env.agents-lan   # 若尚无，并编辑 LAN_HOST、Token、Key
powershell -ExecutionPolicy Bypass -File .\scripts\up-agents-lan.ps1
# 弱机：… -NoMonitor
# 完整：… -Extended
```

---

## 三、日常维护：启动 / 停止 / 重启

以下均在 `Manage-platform_Agent` 目录；**必须**带 `.env.agents-lan`（脚本已内置）。

> **禁止 `down -v`**：命名卷（`clawhive_pg_data`、各 `*_agent_data`、`rag_pgvector_data`）存对话/记忆/向量。  
> `docker compose … down -v` 会清空数据。重启只用 `up -d --force-recreate`（可选 `--build`）。  
> 详见 [doc/docker-persist-no-volume-wipe.md](./doc/docker-persist-no-volume-wipe.md)。

### Linux 客户机（推荐脚本）

| 动作 | 命令 |
|------|------|
| 首次 / 全量启动 | `bash scripts/install-linux.sh`（或 `--no-monitor`） |
| 等价 compose 启动 | `docker compose --env-file .env.agents-lan -f docker-compose.agents-lan.yml up -d` |
| 停止（**保留卷**） | `docker compose --env-file .env.agents-lan -f docker-compose.agents-lan.yml down` |
| 停止并删卷 | **禁止**（除非明确要求清库）；勿加 `-v` |
| 看状态 | `docker compose --env-file .env.agents-lan -f docker-compose.agents-lan.yml ps` |
| 看日志 | `… logs --tail=200 <service>`（如 `manager_agent`） |
| PG 备份 | `bash scripts/backup-postgres.sh` |
| PG 恢复 | `bash scripts/restore-postgres.sh backups/<file>.sql.gz --yes` |
| 镜像回滚 | `bash scripts/rollback-agents.sh <旧CLAWHIVE_IMAGE_TAG>` |

改 Key / 端口后要对对应服务 **`up -d --force-recreate <service>`**（仅 `restart` 不会重载 `env_file`）。

### Windows 开发机脚本

| 动作 | 命令 |
|------|------|
| 启动全部 | `.\scripts\up-agents-lan.ps1` |
| 停止全部（保留卷） | `.\scripts\down-agents-lan.ps1` |
| 重启全部（不重建镜像） | `.\scripts\restart-agents-lan.ps1` |
| 重启 Manager + 协作链 | `.\scripts\restart-manager-stack.ps1`（改代码加 `-Build`） |
| 仅重建紫微前后端 | `.\scripts\restart-clawhive-platform.ps1` |
| 重启单个服务 | `.\scripts\restart-agents-lan.ps1 -Service db_agent` |
| 换模型 / MODE 并生效 | `.\scripts\apply-capability-models.ps1` |

常用服务名：`clawhive_backend`、`clawhive_frontend`、`manager_agent`、`db_agent`、`rag_agent`、`code_assistent_agent`、`extractor_agent`、`ai_admin_agent`、`multimodal_agent`；完整版另有 `music_agent`、`video_agent`、`lobster_agent` 等。

### 控制台内运维（不必 SSH）

登录 `:18073`：

| 做什么 | 入口 |
|--------|------|
| 看健康 / Token | 总览 |
| 启停 / Drain / 滚动重启 | Agent 管控 |
| 改模型、MODE、集群基建 | Agent 配置 |
| 镜像 tag / 回滚 | 部署中心 |
| PG 备份策略 | 维护 → 备份恢复 |
| API Key | 密钥 Vault / 系统设置 |

**不必**让客户手改各 Agent `.env`：容器经平台拉配置，约 60s 生效。

---

## 四、访问端口速查

| 端口（默认） | 服务 |
|--------------|------|
| 18073 | 紫微前端 |
| 18000 | 紫微后端 |
| 13106 | Manager |
| 13101–13105 / 13107 | DB / RAG / Code / Extractor / Admin / Multimodal |
| 13000 / 19090 | Grafana / Prometheus（未 `--no-monitor` 时） |
| 15432 / 16379 | Postgres / Redis（**勿对公网开放**） |

监控账号默认见安装输出；生产务必改掉 `admin123` 等默认密码。

---

## 五、故障速查

| 现象 | 处理 |
|------|------|
| 安装报缺 `LAN_HOST` / Key | 检查 `.env.agents-lan` 是否仍含「请填写」或空 Key |
| `/health/ready` 超时 | `docker compose … ps` / `logs clawhive_backend` |
| 局域网打不开 / CORS | `.env.agents-lan` 的 `CLAWHIVE_ALLOW_ORIGINS` 加上访问源 |
| 旧代码未生效 | `--build --force-recreate`（**勿** `down -v`） |
| 总管搜不到网 | 容器内 `SEARXNG_BASE_URL=http://searxng:8080`；勿用宿主机 `localhost` |
| 公网 WS 失败 | 反代需支持 Upgrade；用 `wss`（见公网文档） |

`CLAWHIVE_INTERNAL_TOKEN` 须与 `Manager_Agent/.env`（若存在）一致。

---

## 相关链接

| 文档 | 说明 |
|------|------|
| [docs/公网演示部署.md](../docs/公网演示部署.md) | 云规格、安全组、Caddy/Nginx |
| [offline/README.md](offline/README.md) | 离线 `images.tar` |
| [helm/clawhive/README.md](helm/clawhive/README.md) | K8s Chart |
| [docs/unified-login.md](../docs/unified-login.md) | 统一登录 |
| [doc/企业级控制面升级方案.md](doc/企业级控制面升级方案.md) | 控制面能力演进（非运维必读） |
| 各 `*_Agent/README.md` | 单 Agent 开发与排障 |
