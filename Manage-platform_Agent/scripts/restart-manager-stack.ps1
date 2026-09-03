# 重启 Manager_Agent 及其协作依赖的全部子 Agent（含 Multimodal / Music / Video）
# 用法：
#   .\scripts\restart-manager-stack.ps1           # force-recreate（重载 env，保留卷）
#   .\scripts\restart-manager-stack.ps1 -Build  # 重新构建镜像后启动
#   .\scripts\restart-manager-stack.ps1 -Enterprise  # 叠加 .env.agents-enterprise
#
# 禁止 down -v：见 doc/docker-persist-no-volume-wipe.md
# 企业档：docs/企业档配置指南.md

param(
    [switch]$Build,
    [switch]$Enterprise
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $root "docker-compose.agents-lan.yml"
$envFile = Join-Path $root ".env.agents-lan"
$enterpriseEnvFile = Join-Path $root ".env.agents-enterprise"

$composeEnvArgs = @("--env-file", $envFile)
if ($Enterprise) {
    if (-not (Test-Path $enterpriseEnvFile)) {
        throw @"
-Enterprise requires $enterpriseEnvFile
Copy-Item .env.agents-enterprise.example .env.agents-enterprise
See docs/企业档配置指南.md
"@
    }
    $composeEnvArgs += @("--env-file", $enterpriseEnvFile)
    Write-Host "Enterprise overlay: $enterpriseEnvFile" -ForegroundColor Yellow
}

# Manager 编排会用到的子 Agent（顺序：先依赖后总管）
$managerStack = @(
    "playwright_mcp",
    "db_agent",
    "rag_agent",
    "code_assistent_agent",
    "extractor_agent",
    "ai_admin_agent",
    "music_agent",
    "video_agent",
    "multimodal_agent",
    "lobster_agent",
    "manager_agent"
)

Write-Host "Manager stack services (volumes preserved; no -v):" -ForegroundColor Cyan
Write-Host ($managerStack -join ", ")

# 释放 13107：旧 older_agent 若仍占用端口会导致 multimodal_agent 无法启动
$legacy = docker ps -a --filter "name=older_agent" --format "{{.Names}}" 2>$null
if ($legacy) {
    Write-Host "Stopping legacy older_agent (port 13107)..." -ForegroundColor Yellow
    docker stop older_agent 2>$null | Out-Null
    docker rm older_agent 2>$null | Out-Null
}

if ($Build) {
    Write-Host "Building and force-recreating manager stack (keep volumes)..." -ForegroundColor Yellow
    docker compose @composeEnvArgs -f "$composeFile" up -d --build --force-recreate @managerStack
} else {
    # restart 不重载 env_file；改 STORAGE_BACKEND 等必须 force-recreate
    Write-Host "Force-recreating manager stack (keep volumes)..." -ForegroundColor Yellow
    docker compose @composeEnvArgs -f "$composeFile" up -d --force-recreate @managerStack
}

if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed (exit $LASTEXITCODE)"
}

Write-Host ""
Write-Host "Done. Endpoints:" -ForegroundColor Green
$lan = "localhost"
if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match "^LAN_HOST=" } | Select-Object -First 1
    if ($line) { $lan = $line.Split("=", 2)[1].Trim() }
}
Write-Host "  Manager      http://${lan}:13106"
Write-Host "  Lobster GUI  http://${lan}:13108"
Write-Host "  Multimodal   http://${lan}:13107"
Write-Host "  Music        http://${lan}:13110"
Write-Host "  Video        http://${lan}:13111"
