# 构建标准版首方生产镜像，并写入 CLAWHIVE_IMAGE_TAG
# 用法:
#   .\scripts\build-agents-prod.ps1
#   .\scripts\build-agents-prod.ps1 -Extended
#   .\scripts\build-agents-prod.ps1 -NoUp
param(
    [switch]$Extended,
    [switch]$NoUp
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

& (Join-Path $PSScriptRoot "tag-images.ps1")
$envFile = Join-Path $root ".env.agents-lan"
$compose = @("-f", "docker-compose.agents-lan.yml")
if (Test-Path $envFile) { $compose = @("--env-file", $envFile) + $compose }

# 标准版首方服务（与 package-offline 对齐）
$standard = @(
    "clawhive_backend",
    "clawhive_frontend",
    "db_agent",
    "rag_agent",
    "code_assistent_agent",
    "extractor_agent",
    "ai_admin_agent",
    "multimodal_agent",
    "manager_agent"
)

$services = @($standard)
if ($Extended) {
    $services += @(
        "lobster_agent",
        "tavern_agent",
        "music_agent",
        "video_agent",
        "ai_agent"
    )
    $compose = $compose + @("--profile", "extended")
}

Write-Host "Building: $($services -join ', ')"
docker compose @compose build @services
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $NoUp) {
    docker compose @compose up -d --force-recreate --no-build @services
    exit $LASTEXITCODE
}
exit 0
