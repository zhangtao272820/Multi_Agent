param(
    [string]$Service = "",
    [switch]$Build,
    # 叠加 .env.agents-enterprise（须已从 example 复制）；默认不加，LAN 行为不变
    [switch]$Enterprise
)

# 禁止 down -v：本脚本只用 up --force-recreate，保留命名卷
# 文档：doc/docker-persist-no-volume-wipe.md
# 企业档：docs/企业档配置指南.md

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $root "docker-compose.agents-lan.yml"
$envFile = Join-Path $root ".env.agents-lan"
$enterpriseEnvFile = Join-Path $root ".env.agents-enterprise"

$composeEnvArgs = @("--env-file", $envFile)
if ($Enterprise) {
    if (-not (Test-Path $enterpriseEnvFile)) {
        Write-Error @"
-Enterprise requires $enterpriseEnvFile
Copy-Item .env.agents-enterprise.example .env.agents-enterprise
See docs/企业档配置指南.md
"@
        exit 1
    }
    $composeEnvArgs += @("--env-file", $enterpriseEnvFile)
    Write-Host "Enterprise overlay: $enterpriseEnvFile" -ForegroundColor Yellow
}

$validServices = @(
    "clawhive_postgres",
    "clawhive_redis",
    "clawhive_backend",
    "clawhive_frontend",
    "prometheus",
    "grafana",
    "alertmanager",
    "tempo",
    "loki",
    "promtail",
    "langfuse",
    "litellm",
    "db_agent",
    "vanna_db_agent",
    "vanna_db_web",
    "rag_agent",
    "code_assistent_agent",
    "extractor_agent",
    "ai_admin_agent",
    "manager_agent",
    "multimodal_agent",
    "lobster_agent",
    "tavern_agent",
    "music_agent",
    "video_agent"
)

# compose restart 不重载 env_file；改 .env 后必须 force-recreate
if ([string]::IsNullOrWhiteSpace($Service)) {
    Write-Host "Force-recreating all agent services (reloads env_file; volumes preserved)..." -ForegroundColor Cyan
    if ($Build) {
        docker compose @composeEnvArgs -f "$composeFile" up -d --build --force-recreate
    } else {
        docker compose @composeEnvArgs -f "$composeFile" up -d --force-recreate
    }
    Write-Host "Done." -ForegroundColor Green
    exit 0
}

if ($validServices -notcontains $Service) {
    Write-Error "Unknown service: $Service. Valid: $($validServices -join ', ')"
    exit 1
}

Write-Host "Force-recreating $Service (volumes preserved)..." -ForegroundColor Cyan
if ($Build) {
    docker compose @composeEnvArgs -f "$composeFile" up -d --build --force-recreate $Service
} else {
    docker compose @composeEnvArgs -f "$composeFile" up -d --force-recreate $Service
}
Write-Host "Done." -ForegroundColor Green
