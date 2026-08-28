# 启动整套 Agent LAN 栈
param(
    [switch]$NoBuild,
    [switch]$Extended,
    [switch]$NoMonitor,
    [switch]$SkipHealthGate
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $root "docker-compose.agents-lan.yml"
$envFile = Join-Path $root ".env.agents-lan"
. (Join-Path $PSScriptRoot "_agents-lan-common.ps1")
$lanHost = "192.168.88.51"
$backendPort = "18000"
if (Test-Path $envFile) {
    $line = (Read-EnvFileUtf8 $envFile | Where-Object { $_ -match "^LAN_HOST=" } | Select-Object -First 1)
    if ($line) { $lanHost = ($line.Split("=", 2)[1].Trim() -split "\s+")[0].Trim() }
    $bp = (Read-EnvFileUtf8 $envFile | Where-Object { $_ -match "^CLAWHIVE_BACKEND_PORT=" } | Select-Object -First 1)
    if ($bp) { $backendPort = $bp.Split("=", 2)[1].Trim() }
}

# 确保 CLAWHIVE_IMAGE_TAG
$tagScript = Join-Path $PSScriptRoot "tag-images.ps1"
if (Test-Path $tagScript) {
    & $tagScript
} else {
    $sha = "local"
    try { $sha = (git -C (Split-Path $root -Parent) rev-parse --short HEAD).Trim() } catch {}
    $tag = "0.1.0-$sha"
    if (Test-Path $envFile) {
        $content = @(Read-EnvFileUtf8 $envFile)
        if ($content -match "^CLAWHIVE_IMAGE_TAG=") {
            $content = $content | ForEach-Object { if ($_ -match "^CLAWHIVE_IMAGE_TAG=") { "CLAWHIVE_IMAGE_TAG=$tag" } else { $_ } }
            Write-EnvFileUtf8 -Path $envFile -Lines $content
        } else {
            Write-EnvFileUtf8 -Path $envFile -Lines (@($content) + @("CLAWHIVE_IMAGE_TAG=$tag"))
        }
    }
}

$profileArgs = @()
if ($Extended) {
    $profileArgs = @("--profile", "extended")
    Write-Host "Deploy mode: extended (music/video + lobster)" -ForegroundColor Cyan
} else {
    Write-Host "Deploy mode: standard (platform + manager stack + multimodal + monitoring)" -ForegroundColor Cyan
}
if ($NoMonitor) {
    Write-Host "Monitoring: skipped (-NoMonitor)" -ForegroundColor Yellow
}

Write-Host "Starting agent stack for LAN access..." -ForegroundColor Cyan
if ($NoBuild) {
    docker compose --env-file "$envFile" -f "$composeFile" @profileArgs up -d
} else {
    docker compose --env-file "$envFile" -f "$composeFile" @profileArgs up -d --build
}
if ($LASTEXITCODE -ne 0) {
    throw "docker compose up failed. Please check output above."
}

if ($NoMonitor) {
    docker compose --env-file "$envFile" -f "$composeFile" stop prometheus grafana alertmanager tempo loki promtail
}

if (-not $SkipHealthGate) {
    $deadline = (Get-Date).AddSeconds(180)
    $ok = $false
    Write-Host "Health gate: polling http://127.0.0.1:${backendPort}/health/ready" -ForegroundColor Cyan
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:${backendPort}/health/ready" -UseBasicParsing -TimeoutSec 5
            if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
                Write-Host "Health gate passed." -ForegroundColor Green
                $ok = $true
                break
            }
        } catch {
            Start-Sleep -Seconds 5
        }
    }
    if (-not $ok) { throw "Health gate timeout (180s)" }
}

Write-Host ""
Write-Host "Done. Access from other LAN devices via:" -ForegroundColor Green
Write-Host "http://${lanHost}:13120  Vanna_DbAgent UI"
Write-Host "http://${lanHost}:13121  Vanna_DbAgent API"
Write-Host "http://${lanHost}:13101  DB_Agent (legacy rollback)"
Write-Host "http://${lanHost}:13102  RAG_Agent"
Write-Host "http://${lanHost}:13103  CodePy_Agent (service code_assistent_agent)"
Write-Host "http://${lanHost}:13104  Extractor_Agent"
Write-Host "http://${lanHost}:13105  AI_admin_Agent"
Write-Host "http://${lanHost}:13106  Manager_Agent"
Write-Host "http://${lanHost}:18073  ClawHive_Management_Frontend"
Write-Host "http://${lanHost}:18000/health  ClawHive_Management_Backend_Health"
if (-not $NoMonitor) {
    Write-Host "http://${lanHost}:13000  Grafana"
    Write-Host "http://${lanHost}:19090  Prometheus"
    Write-Host "http://${lanHost}:19093  Alertmanager"
    Write-Host "http://${lanHost}:3200   Tempo"
    Write-Host "http://${lanHost}:3100   Loki"
}
if ($Extended) {
    Write-Host "http://${lanHost}:13108  Lobster_Agent"
    Write-Host "http://${lanHost}:18088/vnc.html  Lobster_Agent_Viewer(noVNC)"
    Write-Host "http://${lanHost}:13110  Music_Agent"
    Write-Host "http://${lanHost}:13111  Video_Agent"
    Write-Host "http://${lanHost}:13112  AI_Agent"
} else {
    Write-Host "http://${lanHost}:13107  Multimodal_Agent"
    Write-Host "(extended) Music/Video/Lobster: up-agents-lan.ps1 -Extended" -ForegroundColor DarkGray
}
Write-Host "Backup: .\scripts\backup-postgres.ps1" -ForegroundColor DarkGray
