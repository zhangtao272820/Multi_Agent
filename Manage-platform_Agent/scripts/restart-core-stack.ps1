# 仅重启核心业务栈（省磁盘 / 适合笔记本 LAN 部署）
# 不含：Lobster、Music、Video、Tavern、AI_Agent、Prometheus/Grafana/Langfuse 等扩展栈
#
# 用法：
#   .\scripts\restart-core-stack.ps1                    # force-recreate（重载 env，保留卷）
#   .\scripts\restart-core-stack.ps1 -Enterprise          # 叠加 .env.agents-enterprise + overlay
#   .\scripts\restart-core-stack.ps1 -Build               # 有变更层时才重建镜像（不用 --no-cache）
#   .\scripts\restart-core-stack.ps1 -BuildManagerOnly    # 仅重建总管（shared 鉴权修复等）
#   .\scripts\restart-core-stack.ps1 -PruneBuildCache     # 完成后清理 BuildKit 缓存（省硬盘）
#   .\scripts\restart-core-stack.ps1 -NoMonitor           # 不启 monitoring（本栈本就不含监控服务）
#
# 禁止 down -v：见 doc/docker-persist-no-volume-wipe.md
# manager_agent 仍依赖 lobster_agent（compose depends_on）；本脚本不重建 Lobster，但需其保持运行。

param(
    [switch]$Build,
    [switch]$BuildManagerOnly,
    [switch]$Enterprise,
    [switch]$PruneBuildCache,
    [switch]$NoMonitor
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_agents-lan-common.ps1"

Stop-LegacyOlderAgent

$lobsterUp = docker ps --filter "name=^lobster_agent$" --filter "status=running" --format "{{.Names}}" 2>$null
if (-not $lobsterUp) {
    Write-Host "WARN: lobster_agent not running; manager_agent depends_on requires Lobster healthy." -ForegroundColor Yellow
    Write-Host "      Run: docker compose ... up -d lobster_agent" -ForegroundColor DarkYellow
}

Write-Host "Core stack (force-recreate, volumes kept):" -ForegroundColor Cyan
Write-Host ($Script:CoreStack -join ", ")

if ($BuildManagerOnly) {
    Write-Host "Building manager_agent only (cached layers OK)..." -ForegroundColor Yellow
    $base = Get-ComposeBaseArgs -Enterprise:$Enterprise
    docker compose @base @("build", "manager_agent")
    if ($LASTEXITCODE -ne 0) { throw "docker compose build manager_agent failed (exit $LASTEXITCODE)" }
}

$useBuildOnUp = $Build -and -not $BuildManagerOnly
$monitoring = -not $NoMonitor
Invoke-AgentsLanCompose -Action up -ForceRecreate -Build:$useBuildOnUp -Enterprise:$Enterprise -Monitoring:$monitoring -Services $Script:CoreStack

if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed (exit $LASTEXITCODE)"
}

if ($PruneBuildCache) {
    Write-Host "Pruning BuildKit cache (reclaim disk)..." -ForegroundColor Cyan
    docker builder prune -f | Out-Host
}

Write-Host ""
Write-Host "Done. Core endpoints:" -ForegroundColor Green
$lan = Get-AgentsLanLanHost
Write-Host "  ClawHive UI   http://${lan}:18073"
Write-Host "  ClawHive API  http://${lan}:18000"
Write-Host "  Manager       http://${lan}:13106"
Write-Host "  DB (Vanna)    http://${lan}:13121"
Write-Host "  RAG           http://${lan}:13102"
Write-Host "  Code          http://${lan}:13103"
Write-Host "  Crawler       http://${lan}:13104"
Write-Host "  Admin         http://${lan}:13105"
Write-Host "  Multimodal    http://${lan}:13107"
