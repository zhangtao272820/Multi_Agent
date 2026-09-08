# 仅重启核心业务栈（省磁盘 / 适合笔记本与 4C8G 公网弱机）
# 不含：Lobster、Music、Video、Tavern、AI_Agent、Prometheus/Grafana/Langfuse 等扩展栈
#
# 用法：
#   .\scripts\restart-core-stack.ps1                    # force-recreate（重载 env，保留卷）
#   .\scripts\restart-core-stack.ps1 -Enterprise          # 叠加 .env.agents-enterprise + overlay
#   .\scripts\restart-core-stack.ps1 -Enterprise -Public -NoMonitor  # 公网弱机推荐
#   .\scripts\restart-core-stack.ps1 -Build               # 有变更层时才重建镜像（不用 --no-cache）
#   .\scripts\restart-core-stack.ps1 -BuildManagerOnly    # 仅重建总管（shared 鉴权修复等）
#   .\scripts\restart-core-stack.ps1 -PruneBuildCache     # 完成后清理 BuildKit 缓存（省硬盘）
#   .\scripts\restart-core-stack.ps1 -NoMonitor           # 不启 monitoring（本栈本就不含监控服务）
#
# 禁止 down -v：见 doc/docker-persist-no-volume-wipe.md
# Lobster 仅 --profile extended；核心栈不再 hard-depend GUI。

param(
    [switch]$Build,
    [switch]$BuildManagerOnly,
    [switch]$Enterprise,
    [switch]$Public,
    [switch]$PruneBuildCache,
    [switch]$NoMonitor
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_agents-lan-common.ps1"

Stop-LegacyOlderAgent

Write-Host "Core stack (force-recreate, volumes kept):" -ForegroundColor Cyan
Write-Host ($Script:CoreStack -join ", ")
if ($Public) {
    Write-Host "Public: bind 127.0.0.1 + 4C8G memory limits" -ForegroundColor Yellow
}

if ($BuildManagerOnly) {
    Write-Host "Building manager_agent only (cached layers OK)..." -ForegroundColor Yellow
    $base = Get-ComposeBaseArgs -Enterprise:$Enterprise -Public:$Public
    docker compose @base @("build", "manager_agent")
    if ($LASTEXITCODE -ne 0) { throw "docker compose build manager_agent failed (exit $LASTEXITCODE)" }
}

$useBuildOnUp = $Build -and -not $BuildManagerOnly
$monitoring = -not $NoMonitor
Invoke-AgentsLanCompose -Action up -ForceRecreate -Build:$useBuildOnUp -Enterprise:$Enterprise -Public:$Public -Monitoring:$monitoring -Services $Script:CoreStack

if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed (exit $LASTEXITCODE)"
}

if ($PruneBuildCache) {
    Write-Host "Pruning BuildKit cache (reclaim disk)..." -ForegroundColor Cyan
    docker builder prune -f | Out-Host
}

Write-Host ""
Write-Host "Done. Core endpoints:" -ForegroundColor Green
$lan = if ($Public) { "127.0.0.1" } else { Get-AgentsLanLanHost }
Write-Host "  ClawHive UI   http://${lan}:18073"
Write-Host "  ClawHive API  http://${lan}:18000"
Write-Host "  Manager       http://${lan}:13106"
Write-Host "  DB (Vanna)    http://${lan}:13121"
Write-Host "  RAG           http://${lan}:13102"
Write-Host "  Code          http://${lan}:13103"
Write-Host "  Crawler       http://${lan}:13104"
Write-Host "  Admin         http://${lan}:13105"
Write-Host "  Multimodal    http://${lan}:13107"
if ($Public) {
    Write-Host "  (Public overlay: only localhost; put Caddy/Nginx in front for HTTPS)" -ForegroundColor DarkYellow
}
