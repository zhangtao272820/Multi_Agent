# 企业档 Docker 双轨

LAN 日常默认 **不变**。企业 fail-closed / 资源限额仅在显式 `-Enterprise` 时生效。公网弱机再加 `-Public`。

## 双轨

| 档 | 命令 | 效果 |
|----|------|------|
| **lan（默认）** | `.\scripts\restart-agents-lan.ps1` / `up-agents-lan.ps1` | 无 enterprise env、无 overlay；鉴权保持 lan |
| **enterprise** | 同上加 `-Enterprise` | 叠加 `.env.agents-enterprise` + `docker-compose.agents-enterprise.overlay.yml` |
| **public（弱机公网）** | 再加 `-Public`（建议同时 `-Enterprise -NoMonitor`） | 再叠 `docker-compose.agents-public.overlay.yml`：端口 `127.0.0.1` + 4C8G 内存顶 |

监控：主 compose 使用 `profiles: [monitoring]`。脚本默认传 `--profile monitoring`；`-NoMonitor` / `--no-monitor` **不启**该 profile（不再先起再 stop）。

Lobster/GUI：仅 `--profile extended`；核心栈默认 `MANAGER_DISABLED_AGENTS` 含 `gui`，Manager **不再** hard-depend Lobster。

改 env 后必须 `up -d --force-recreate`。**禁止** `docker compose down -v`。

多租户并发 / 排队（准入、RAG 异步入库、Admin/GUI 槽）：见 [`docs/多租户并发排队.md`](../../docs/多租户并发排队.md)。企业档默认打开 `MANAGER_*_INFLIGHT` / `RAG_*` / `ADMIN_*` / `GUI_*`；LAN 默认 0=不限。

## 启用

```powershell
cd Manage-platform_Agent
Copy-Item .env.agents-enterprise.example .env.agents-enterprise
# 对齐 .env.agents-lan：CLAWHIVE_INTERNAL_TOKEN / JWT / MANAGER_WS_TOKEN
.\scripts\restart-agents-lan.ps1 -Enterprise
# 4C8G 公网弱机：
.\scripts\restart-core-stack.ps1 -Enterprise -NoMonitor -Public
# 或一键验收（契约 smoke，不调 LLM）
.\scripts\verify-enterprise-docker.ps1 -Public -NoMonitor
```

等价手动：

```powershell
docker compose `
  --env-file .env.agents-lan `
  --env-file .env.agents-enterprise `
  -f docker-compose.agents-lan.yml `
  -f docker-compose.agents-enterprise.overlay.yml `
  -f docker-compose.agents-public.overlay.yml `
  up -d --force-recreate
```

## 回退 LAN

1. 去掉 `-Enterprise` / `-Public`（可删/改名 `.env.agents-enterprise`）
2. `.\scripts\restart-agents-lan.ps1`（不要加企业/公网开关）
3. 确认对话 / WS 恢复

## 验收

| 步骤 | 命令 |
|------|------|
| Docker + 契约 | `.\scripts\verify-enterprise-docker.ps1 [-Public] [-NoMonitor]` |
| 仅 smoke | `cd ../Manager_Agent && npm run smoke:security-profile` 等 |
| npm 包装 | `cd Manager_Agent && npm run verify:enterprise-docker` |

## 相关文件

- `.env.agents-enterprise.example` — 企业覆盖键（可入库；勿提交真实 `.env.agents-enterprise`）
- `docker-compose.agents-enterprise.overlay.yml` — limits + 监控 healthcheck
- `docker-compose.agents-public.overlay.yml` — 127.0.0.1 绑定 + 4C8G 限额
- `scripts/_agents-lan-common.ps1` — `Get-ComposeBaseArgs -Enterprise -Public` 统一拼装
- 本地详版：`docs/企业化.md` · 公网：`docs/公网演示部署.md`
