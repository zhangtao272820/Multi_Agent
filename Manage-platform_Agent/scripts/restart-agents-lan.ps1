param(
    [string]$Service = "",
    [switch]$Build,
    # 叠加 .env.agents-enterprise + enterprise overlay；默认不加，LAN 行为不变
    [switch]$Enterprise,
    # 公网弱机：127.0.0.1 绑端口 + 4C8G 内存顶
    [switch]$Public,
    # 不启 monitoring profile（默认启，与标准版一致）
    [switch]$NoMonitor
)

# 禁止 down -v：本脚本只用 up --force-recreate，保留命名卷
# 企业档：doc/enterprise-docker.md
# 公网：docker-compose.agents-public.overlay.yml

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_agents-lan-common.ps1"

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
    "video_agent",
    "ai_agent",
    "db_agent"
)

$monitoring = -not $NoMonitor
$services = @()
if (-not [string]::IsNullOrWhiteSpace($Service)) {
    if ($validServices -notcontains $Service) {
        Write-Error "Unknown service: $Service. Valid: $($validServices -join ', ')"
        exit 1
    }
    $services = @($Service)
    Write-Host "Force-recreating $Service (volumes preserved)..." -ForegroundColor Cyan
} else {
    Write-Host "Force-recreating all agent services (reloads env_file; volumes preserved)..." -ForegroundColor Cyan
}

Invoke-AgentsLanCompose -Action up -ForceRecreate -Build:$Build -Enterprise:$Enterprise -Public:$Public -Monitoring:$monitoring -Services $services
if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed (exit $LASTEXITCODE)"
}
Write-Host "Done." -ForegroundColor Green
