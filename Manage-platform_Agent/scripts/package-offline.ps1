# 在有网构建机打包离线镜像：offline/images.tar + SHA256SUMS
# 用法:
#   .\scripts\package-offline.ps1
#   .\scripts\package-offline.ps1 -Extended
#   .\scripts\package-offline.ps1 -NoBuild
param(
    [switch]$Extended,
    [switch]$NoBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$offlineDir = Join-Path $root "offline"
$envFile = Join-Path $root ".env.agents-lan"

& (Join-Path $PSScriptRoot "tag-images.ps1")

$tag = "prod"
if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern "^CLAWHIVE_IMAGE_TAG=(.+)$" | Select-Object -First 1
    if ($m) { $tag = $m.Matches.Groups[1].Value.Trim() }
}

$standardFirst = @(
    "clawhive/clawhive_backend:$tag",
    "clawhive/clawhive_frontend:$tag",
    "clawhive/db_agent:$tag",
    "clawhive/rag_agent:$tag",
    "clawhive/code_assistent_agent:$tag",
    "clawhive/extractor_agent:$tag",
    "clawhive/ai_admin_agent:$tag",
    "clawhive/multimodal_agent:$tag",
    "clawhive/manager_agent:$tag"
)
$extendedFirst = @(
    "clawhive/lobster_agent:$tag",
    "clawhive/tavern_agent:$tag",
    "clawhive/companion_agent:$tag",
    "clawhive/music_agent:$tag",
    "clawhive/video_agent:$tag",
    "clawhive/ai_agent:$tag"
)
$third = @(
    "docker.1ms.run/pgvector/pgvector:pg16",
    "docker.1ms.run/library/redis:7-alpine",
    "docker.1ms.run/grafana/tempo:2.6.1",
    "docker.1ms.run/grafana/loki:3.1.1",
    "docker.1ms.run/grafana/promtail:3.1.1",
    "docker.1ms.run/prom/prometheus:v2.55.1",
    "docker.1ms.run/prom/alertmanager:v0.27.0",
    "docker.1ms.run/grafana/grafana:11.2.2",
    "docker.1ms.run/searxng/searxng:latest"
)

$images = @($standardFirst) + @($third)
if ($Extended) { $images += $extendedFirst }

if (-not $NoBuild) {
    Write-Host "构建首方镜像 (tag=$tag)..."
    $buildArgs = @("-NoUp")
    if ($Extended) { $buildArgs += "-Extended" }
    & (Join-Path $PSScriptRoot "build-agents-prod.ps1") @buildArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$missing = @()
foreach ($img in $images) {
    docker image inspect $img 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        if ($img -like "clawhive/*") {
            $missing += $img
        } else {
            Write-Host "拉取: $img"
            docker pull $img
            if ($LASTEXITCODE -ne 0) { $missing += $img }
        }
    }
}
if ($missing.Count -gt 0) {
    throw "以下镜像不存在，请先 build/pull: $($missing -join ', ')"
}

New-Item -ItemType Directory -Force -Path $offlineDir | Out-Null
$out = Join-Path $offlineDir "images.tar"
Write-Host "docker save → $out ($($images.Count) images)"
docker save @images -o $out
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$hash = (Get-FileHash -Algorithm SHA256 -Path $out).Hash.ToLowerInvariant()
$sums = Join-Path $offlineDir "SHA256SUMS"
Set-Content -Path $sums -Value "$hash  images.tar" -Encoding ascii

Write-Host "已写入: $out"
Write-Host "已写入: $sums"
Write-Host "客户机: bash scripts/install-linux.sh --offline"
