# 企业档 Docker 双轨

LAN 日常默认 **不变**。企业 fail-closed / 资源限额仅在显式 `-Enterprise` 时生效。

## 双轨

| 档 | 命令 | 效果 |
|----|------|------|
| **lan（默认）** | `.\scripts\restart-agents-lan.ps1` / `up-agents-lan.ps1` | 无 enterprise env、无 overlay；鉴权保持 lan |
| **enterprise** | 同上加 `-Enterprise` | 叠加 `.env.agents-enterprise` + `docker-compose.agents-enterprise.overlay.yml` |

监控：主 compose 使用 `profiles: [monitoring]`。脚本默认传 `--profile monitoring`；`-NoMonitor` / `--no-monitor` **不启**该 profile（不再先起再 stop）。

改 env 后必须 `up -d --force-recreate`。**禁止** `docker compose down -v`。

## 启用

```powershell
cd Manage-platform_Agent
Copy-Item .env.agents-enterprise.example .env.agents-enterprise
# 对齐 .env.agents-lan：CLAWHIVE_INTERNAL_TOKEN / JWT / MANAGER_WS_TOKEN
.\scripts\restart-agents-lan.ps1 -Enterprise
# 或一键验收（契约 smoke，不调 LLM）
.\scripts\verify-enterprise-docker.ps1
```

等价手动：

```powershell
docker compose `
  --env-file .env.agents-lan `
  --env-file .env.agents-enterprise `
  -f docker-compose.agents-lan.yml `
  -f docker-compose.agents-enterprise.overlay.yml `
  --profile monitoring `
  up -d --force-recreate
```

## 回退 LAN

1. 去掉 `-Enterprise`（可删/改名 `.env.agents-enterprise`）
2. `.\scripts\restart-agents-lan.ps1`（不要加 `-Enterprise`）
3. 确认对话 / WS 恢复

## 验收

| 步骤 | 命令 |
|------|------|
| Docker + 契约 | `.\scripts\verify-enterprise-docker.ps1` |
| 仅 smoke | `cd ../Manager_Agent && npm run smoke:security-profile` 等 |
| npm 包装 | `cd Manager_Agent && npm run verify:enterprise-docker` |

## 相关文件

- `.env.agents-enterprise.example` — 企业覆盖键（可入库；勿提交真实 `.env.agents-enterprise`）
- `docker-compose.agents-enterprise.overlay.yml` — limits + 监控 healthcheck
- `scripts/_agents-lan-common.ps1` — `Get-ComposeBaseArgs -Enterprise` 统一拼装
- 本地详版：`docs/企业化.md`
