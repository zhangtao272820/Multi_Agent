# 重启 Manager_Agent 及其协作依赖的全部子 Agent（含 Multimodal / Music / Video）
# 用法：
#   .\scripts\restart-manager-stack.ps1           # force-recreate（重载 env，保留卷）
#   .\scripts\restart-manager-stack.ps1 -Build  # 重新构建镜像后启动
#   .\scripts\restart-manager-stack.ps1 -Enterprise  # 叠加 .env.agents-enterprise + overlay
#
# 禁止 down -v：见 doc/docker-persist-no-volume-wipe.md
# 企业档：doc/enterprise-docker.md

param(
    [switch]$Build,
    [switch]$Enterprise,
    [switch]$NoMonitor
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_agents-lan-common.ps1"

Write-Host "Manager stack services (volumes preserved; no -v):" -ForegroundColor Cyan
Write-Host ($Script:ManagerStack -join ", ")

Stop-LegacyOlderAgent

$monitoring = -not $NoMonitor
# Manager 栈含 music/video → 自动带 extended；默认带 monitoring
Invoke-AgentsLanCompose -Action up -ForceRecreate -Build:$Build -Enterprise:$Enterprise -Monitoring:$monitoring -Services $Script:ManagerStack

if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed (exit $LASTEXITCODE)"
}

Write-Host ""
Write-Host "Done. Endpoints:" -ForegroundColor Green
$lan = Get-AgentsLanLanHost
Write-Host "  Manager      http://${lan}:13106"
Write-Host "  Lobster GUI  http://${lan}:13108"
Write-Host "  Multimodal   http://${lan}:13107"
Write-Host "  Music        http://${lan}:13110"
Write-Host "  Video        http://${lan}:13111"
