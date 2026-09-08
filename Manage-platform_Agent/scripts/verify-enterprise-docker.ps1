# 企业档 Docker 本地验收（不调 LLM、不发副作用）
# 用法（在 Manage-platform_Agent/）:
#   .\scripts\verify-enterprise-docker.ps1
#   .\scripts\verify-enterprise-docker.ps1 -Public -NoMonitor   # 公网弱机叠加
#   .\scripts\verify-enterprise-docker.ps1 -SkipRecreate   # 仅断言已跑中的企业档容器 + smoke
#   .\scripts\verify-enterprise-docker.ps1 -SkipSmoke      # 仅 Docker env / health
#
# 禁止 down -v。日常 LAN 勿加 -Enterprise。

param(
    [switch]$SkipRecreate,
    [switch]$SkipSmoke,
    [switch]$NoMonitor,
    [switch]$Public
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
if ($Public -and -not (Test-Path $Script:PublicOverlayFile)) {
    throw "Missing public overlay: $Script:PublicOverlayFile"
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
    Write-Host "Force-recreate core subset with -Enterprise$(if ($Public) { ' -Public' }) (volumes kept)..." -ForegroundColor Yellow
    Invoke-AgentsLanCompose -Action up -ForceRecreate -Enterprise -Public:$Public -Monitoring:$monitoring -Services $verifyServices
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
    $disabled = (docker exec $mgrCid printenv MANAGER_DISABLED_AGENTS 2>$null)
    Assert-Ok "AGENT_SECURITY_PROFILE=enterprise" ($profile -eq "enterprise") "got='$profile'"
    Assert-Ok "AGENT_SERVICE_AUTH=require" ($auth -eq "require") "got='$auth'"
    Assert-Ok "MANAGER_DISABLED_AGENTS includes gui" ($disabled -match '(^|,)gui(,|$)') "got='$disabled'"
    $runTok = (docker exec $mgrCid printenv MANAGER_RUN_MAX_TOKENS 2>$null)
    $runTokOk = $false
    if ($runTok -match '^\d+$') {
        $runTokOk = ([int]$runTok -gt 0)
    }
    Assert-Ok "MANAGER_RUN_MAX_TOKENS>0" $runTokOk "got='$runTok'"
    $maxRetry = (docker exec $mgrCid printenv MANAGER_MAX_RETRY 2>$null)
    Assert-Ok "MANAGER_MAX_RETRY set" ($maxRetry -match '^\d+$') "got='$maxRetry'"
}

if ($Public -and $mgrCid) {
    $ports = (docker port $mgrCid 2>$null)
    Assert-Ok "manager port bound to 127.0.0.1" ($ports -match '127\.0\.0\.1:') "ports='$ports'"
}

$backendPort = "18000"
if (Test-Path $Script:EnvFile) {
    foreach ($line in @(Read-EnvFileUtf8 $Script:EnvFile)) {
        $m = [regex]::Match([string]$line, '^\s*CLAWHIVE_BACKEND_PORT\s*=\s*(\d+)\s*$')
        if ($m.Success) {
            $backendPort = [string]$m.Groups[1].Value
            break
        }
    }
}
if ([string]::IsNullOrWhiteSpace($backendPort)) { $backendPort = "18000" }

Write-Host "Health poll backend /health/ready (port $backendPort) ..." -ForegroundColor Cyan
# Wait for docker health first (avoids racing HTTP while container still starting)
$healthDeadline = (Get-Date).AddSeconds(180)
$backendHealthy = $false
while ((Get-Date) -lt $healthDeadline) {
    $cid = docker ps --filter "name=^clawhive_backend$" --filter "status=running" --format "{{.ID}}" 2>$null
    if ($cid) {
        $h = (docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" $cid 2>$null)
        if ($h -eq "healthy" -or $h -eq "none") { $backendHealthy = $true; break }
    }
    Start-Sleep -Seconds 3
}
$ready = $false
if ($backendHealthy) {
    $httpDeadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $httpDeadline) {
        try {
            $resp = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/health/ready" -f $backendPort) -UseBasicParsing -TimeoutSec 5
            if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
                $ready = $true
                break
            }
        } catch {
            Start-Sleep -Seconds 2
        }
    }
}
Assert-Ok "backend /health/ready" $ready

foreach ($svc in @("clawhive_postgres", "clawhive_redis", "clawhive_backend", "manager_agent")) {
    $cid = docker ps --filter "name=^${svc}$" --filter "status=running" --format "{{.ID}}" 2>$null
    if (-not $cid) {
        Assert-Ok "$svc healthy" $false "not running"
        continue
    }
    $waitUntil = (Get-Date).AddSeconds(120)
    $h = ""
    while ((Get-Date) -lt $waitUntil) {
        $h = (docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" $cid 2>$null)
        if ($h -eq "healthy" -or $h -eq "none") { break }
        Start-Sleep -Seconds 3
    }
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
            "smoke:pii-policy",
            "smoke:budget",
            "smoke:blast-radius",
            "smoke:expert-failover",
            "smoke:disabled-agents"
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
