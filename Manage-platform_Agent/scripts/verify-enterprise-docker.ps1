# 企业档 Docker 本地验收（不调 LLM、不发副作用）
# 用法（在 Manage-platform_Agent/）:
#   .\scripts\verify-enterprise-docker.ps1
#   .\scripts\verify-enterprise-docker.ps1 -SkipRecreate   # 仅断言已跑中的企业档容器 + smoke
#   .\scripts\verify-enterprise-docker.ps1 -SkipSmoke      # 仅 Docker env / health
#
# 禁止 down -v。日常 LAN 勿加 -Enterprise。

param(
    [switch]$SkipRecreate,
    [switch]$SkipSmoke,
    [switch]$NoMonitor
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_agents-lan-common.ps1"

$failed = 0
function Assert-Ok([string]$Label, [bool]$Ok, [string]$Detail = "") {
    if ($Ok) {
        Write-Host "  OK  $Label" -ForegroundColor Green
    } else {
        Write-Host "  FAIL $Label $(if ($Detail) { "- $Detail" })" -ForegroundColor Red
        $script:failed++
    }
}

Write-Host "=== verify-enterprise-docker ===" -ForegroundColor Cyan

if (-not (Test-Path $Script:EnterpriseEnvFile)) {
    throw @"
Missing $Script:EnterpriseEnvFile
Copy first:
  Copy-Item .env.agents-enterprise.example .env.agents-enterprise
Align CLAWHIVE_INTERNAL_TOKEN / JWT_SECRET / MANAGER_WS_TOKEN with .env.agents-lan
"@
}
if (-not (Test-Path $Script:EnterpriseOverlayFile)) {
    throw "Missing overlay: $Script:EnterpriseOverlayFile"
}

$verifyServices = @(
    "clawhive_postgres",
    "clawhive_redis",
    "clawhive_backend",
    "manager_agent",
    "rag_agent",
    "vanna_db_agent"
)

$monitoring = -not $NoMonitor
if (-not $SkipRecreate) {
    Write-Host "Force-recreate core subset with -Enterprise (volumes kept)..." -ForegroundColor Yellow
    Invoke-AgentsLanCompose -Action up -ForceRecreate -Enterprise -Monitoring:$monitoring -Services $verifyServices
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose recreate failed (exit $LASTEXITCODE)"
    }
} else {
    Write-Host "Skip recreate (-SkipRecreate)" -ForegroundColor DarkYellow
}

Write-Host "Assert container env..." -ForegroundColor Cyan
$mgrCid = docker ps --filter "name=^manager_agent$" --filter "status=running" --format "{{.ID}}" 2>$null
Assert-Ok "manager_agent running" ([bool]$mgrCid)
if ($mgrCid) {
    $profile = (docker exec $mgrCid printenv AGENT_SECURITY_PROFILE 2>$null)
    $auth = (docker exec $mgrCid printenv AGENT_SERVICE_AUTH 2>$null)
    Assert-Ok "AGENT_SECURITY_PROFILE=enterprise" ($profile -eq "enterprise") "got='$profile'"
    Assert-Ok "AGENT_SERVICE_AUTH=require" ($auth -eq "require") "got='$auth'"
}

$backendPort = "18000"
if (Test-Path $Script:EnvFile) {
    $bp = (Read-EnvFileUtf8 $Script:EnvFile | Where-Object { $_ -match '^\s*CLAWHIVE_BACKEND_PORT\s*=' -and $_ -notmatch '^\s*#' } | Select-Object -First 1)
    if ($bp) { $backendPort = ($bp -replace '^\s*CLAWHIVE_BACKEND_PORT\s*=\s*', '').Trim().Split(" ")[0] }
}

Write-Host "Health poll backend /health/ready ..." -ForegroundColor Cyan
$deadline = (Get-Date).AddSeconds(120)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:${backendPort}/health/ready" -UseBasicParsing -TimeoutSec 5
        if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
            $ready = $true
            break
        }
    } catch {
        Start-Sleep -Seconds 3
    }
}
Assert-Ok "backend /health/ready" $ready

foreach ($svc in @("clawhive_postgres", "clawhive_redis", "clawhive_backend", "manager_agent")) {
    $cid = docker ps --filter "name=^${svc}$" --filter "status=running" --format "{{.ID}}" 2>$null
    if (-not $cid) {
        Assert-Ok "$svc healthy" $false "not running"
        continue
    }
    $h = (docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" $cid 2>$null)
    if ($h -eq "none" -or [string]::IsNullOrWhiteSpace($h)) {
        Assert-Ok "$svc running (no healthcheck)" $true
    } else {
        Assert-Ok "$svc health=$h" ($h -eq "healthy") 
    }
}

if (-not $SkipSmoke) {
    $managerRoot = Join-Path (Split-Path $Script:AgentsLanRoot -Parent) "Manager_Agent"
    if (-not (Test-Path (Join-Path $managerRoot "package.json"))) {
        Assert-Ok "Manager_Agent package.json" $false "not found at $managerRoot"
    } else {
        Write-Host "Contract smokes (no LLM) in Manager_Agent..." -ForegroundColor Cyan
        $smokes = @(
            "smoke:security-profile",
            "smoke:envelope-auth",
            "smoke:ws-auth",
            "smoke:content-trust-strict",
            "smoke:pii-policy"
        )
        Push-Location $managerRoot
        try {
            foreach ($s in $smokes) {
                Write-Host "  npm run $s" -ForegroundColor DarkGray
                npm run $s --silent 2>&1 | Out-Host
                Assert-Ok "npm run $s" ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
            }
        } finally {
            Pop-Location
        }
    }
} else {
    Write-Host "Skip smoke (-SkipSmoke)" -ForegroundColor DarkYellow
}

Write-Host ""
if ($failed -gt 0) {
    Write-Host "FAILED: $failed check(s)" -ForegroundColor Red
    exit 1
}
Write-Host "All checks passed." -ForegroundColor Green
Write-Host "Rollback to LAN: restart without -Enterprise (optional: rename .env.agents-enterprise). Never down -v." -ForegroundColor DarkGray
