# Shared compose paths for restart-*.ps1 / apply-capability-models.ps1

$Script:AgentsLanRoot = Split-Path -Parent $PSScriptRoot
$Script:ComposeFile = Join-Path $AgentsLanRoot "docker-compose.agents-lan.yml"
$Script:EnvFile = Join-Path $AgentsLanRoot ".env.agents-lan"
$Script:SyncModelsScript = Join-Path $PSScriptRoot "sync-capability-models.ps1"
$Script:SyncConvergenceModesScript = Join-Path $PSScriptRoot "sync-convergence-modes.ps1"

$Script:ManagerStack = @(
    "db_agent",
    "rag_agent",
    "code_assistent_agent",
    "extractor_agent",
    "ai_admin_agent",
    "music_agent",
    "video_agent",
    "multimodal_agent",
    "playwright_mcp",
    "lobster_agent",
    "manager_agent"
)

$Script:ExtendedOnlyServices = @(
    "music_agent",
    "video_agent",
    "tavern_agent",
    "ai_agent",
    "browserless",
    "prometheus",
    "grafana",
    "alertmanager",
    "tempo",
    "loki",
    "promtail"
)

# Agent name -> docker-compose service (matches backend/app/managed_agents.py)
$Script:AgentDockerServiceMap = @{
    "DB_Agent"             = "db_agent"
    "RAG_Agent"            = "rag_agent"
    "code_assistent_Agent" = "code_assistent_agent"
    "CodePy_Agent"         = "code_assistent_agent"
    "Extractor_Agent"      = "extractor_agent"
    "AI_admin_Agent"       = "ai_admin_agent"
    "Manager_Agent"        = "manager_agent"
    "Multimodal_Agent"     = "multimodal_agent"
    "Lobster_Agent"        = "lobster_agent"
    "Tavern_Agent"         = "tavern_agent"
    "Music_Agent"          = "music_agent"
    "Video_Agent"          = "video_agent"
    "AI_Agent"             = "ai_agent"
}

$Script:AllCapabilityServices = @(
    "db_agent",
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
    "ai_agent"
)

# UTF-8 helpers: Windows PowerShell 5.1 Set-Content -Encoding utf8 writes BOM and
# Get-Content default uses system ANSI (GBK), which mojibakes Chinese comments in .env.
function Read-EnvFileUtf8 {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path $Path)) { return @() }
    # detectEncodingFromByteOrderMarks=true so existing UTF-8 BOM files don't poison line 1
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $reader = New-Object System.IO.StreamReader((Resolve-Path $Path).Path, $utf8, $true)
    try {
        $list = New-Object System.Collections.Generic.List[string]
        while ($null -ne ($line = $reader.ReadLine())) { [void]$list.Add($line) }
        return ,$list.ToArray()
    } finally {
        $reader.Dispose()
    }
}

function Read-EnvFileUtf8Text {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path $Path)) { return "" }
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $reader = New-Object System.IO.StreamReader((Resolve-Path $Path).Path, $utf8, $true)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Write-EnvFileUtf8 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Lines
    )
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $text = if ($null -eq $Lines -or $Lines.Count -eq 0) { "" } else { ($Lines -join "`n") + "`n" }
    [System.IO.File]::WriteAllText($Path, $text, $utf8)
}

function Write-EnvFileUtf8Text {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text
    )
    $utf8 = New-Object System.Text.UTF8Encoding $false
    if ($Text.Length -gt 0 -and -not $Text.EndsWith("`n")) { $Text = $Text + "`n" }
    [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Get-AgentsLanLanHost {
    $lan = "localhost"
    if (Test-Path $Script:EnvFile) {
        $line = Read-EnvFileUtf8 $Script:EnvFile | Where-Object { $_ -match "^LAN_HOST=" } | Select-Object -First 1
        if ($line) {
            # 防御：.env 若被错误拼成单行，只取 LAN_HOST 值的第一个 token
            $raw = $line.Split("=", 2)[1].Trim()
            $lan = ($raw -split "\s+")[0].Trim().Trim('"').Trim("'")
            if (-not $lan) { $lan = "localhost" }
        }
    }
    return $lan
}

function Get-ComposeBaseArgs {
    return @("--env-file", $Script:EnvFile, "-f", $Script:ComposeFile)
}

function Get-ProfileArgs {
    param([bool]$Extended)
    if ($Extended) { return @("--profile", "extended") }
    return @()
}

function Test-RequiresExtendedProfile {
    param([string[]]$Services)
    foreach ($name in $Services) {
        if ($Script:ExtendedOnlyServices -contains $name) { return $true }
    }
    return $false
}

function Invoke-SyncCapabilityModels {
    param(
        [switch]$DryRun,
        [switch]$Check,
        [string[]]$LayerSet = @(),
        [string[]]$Agents = @()
    )
    if (-not (Test-Path $Script:SyncModelsScript)) {
        throw "sync script not found: $Script:SyncModelsScript"
    }
    if ($Check) {
        Write-Host "Checking capability model drift..." -ForegroundColor Cyan
    } else {
        Write-Host "Syncing capability models (SSOT -> Agent .env + .env.agents-lan)..." -ForegroundColor Cyan
    }
    $syncArgs = @{}
    if ($DryRun) { $syncArgs.DryRun = $true }
    if ($Check) { $syncArgs.Check = $true }
    if ($LayerSet.Count -gt 0) { $syncArgs["Set"] = $LayerSet }
    if ($Agents.Count -gt 0) { $syncArgs.Agents = $Agents }
    & $Script:SyncModelsScript @syncArgs
    if ($LASTEXITCODE -ne 0) {
        throw "sync-capability-models.ps1 failed (exit $LASTEXITCODE)"
    }
}

function Invoke-SyncConvergenceModes {
    param(
        [switch]$DryRun,
        [switch]$Check,
        [string[]]$Agents = @()
    )
    if (-not (Test-Path $Script:SyncConvergenceModesScript)) {
        Write-Host "Skip convergence modes sync (script missing)" -ForegroundColor DarkYellow
        return
    }
    if ($Check) {
        Write-Host "Checking convergence MODE drift..." -ForegroundColor Cyan
    } else {
        Write-Host "Syncing convergence MODE (SSOT -> Agent .env + .env.agents-lan)..." -ForegroundColor Cyan
    }
    $syncArgs = @{}
    if ($DryRun) { $syncArgs.DryRun = $true }
    if ($Check) { $syncArgs.Check = $true }
    if ($Agents.Count -gt 0) { $syncArgs.Agents = $Agents }
    & $Script:SyncConvergenceModesScript @syncArgs
    if ($LASTEXITCODE -ne 0) {
        throw "sync-convergence-modes.ps1 failed (exit $LASTEXITCODE)"
    }
}

function Resolve-CapabilityDockerServices {
    param(
        [switch]$All,
        [switch]$Extended,
        [string[]]$Agents = @()
    )

    if ($Agents.Count -gt 0) {
        $services = @()
        foreach ($agent in $Agents) {
            $name = $agent.Trim()
            if (-not $name) { continue }
            $svc = $Script:AgentDockerServiceMap[$name]
            if (-not $svc) {
                throw "Unknown agent: $name (valid: $($Script:AgentDockerServiceMap.Keys -join ', '))"
            }
            if ($services -notcontains $svc) { $services += $svc }
        }
        if ($services.Count -eq 0) {
            throw "No docker services resolved from -Agents"
        }
        return ,$services
    }

    if ($All) {
        return ,$Script:AllCapabilityServices
    }

    if ($Extended) {
        $extendedAgents = @("tavern_agent", "ai_agent")
        $services = [System.Collections.Generic.List[string]]::new()
        foreach ($svc in $Script:ManagerStack + $extendedAgents) {
            if (-not $services.Contains($svc)) { $services.Add($svc) | Out-Null }
        }
        return ,$services.ToArray()
    }

    return ,$Script:ManagerStack
}

function Stop-LegacyOlderAgent {
    $legacy = docker ps -a --filter "name=older_agent" --format "{{.Names}}" 2>$null
    if ($legacy) {
        Write-Host "Stopping legacy older_agent (port 13107)..." -ForegroundColor Yellow
        docker stop older_agent 2>$null | Out-Null
        docker rm older_agent 2>$null | Out-Null
    }
}

function Get-DockerBaseImagesForPull {
    param([bool]$Extended = $false)
    $images = @(
        "docker.m.daocloud.io/library/node:20-bullseye",
        "docker.m.daocloud.io/library/python:3.11-slim-bookworm"
    )
    if ($Extended) {
        $images += @(
            "docker.m.daocloud.io/library/python:3.10-slim-bookworm",
            "docker.m.daocloud.io/library/python:3.12-slim-bookworm"
        )
    }
    return $images
}

function Invoke-DockerBaseImagePull {
    param(
        [bool]$Extended = $false,
        [int]$MaxAttempts = 3
    )
    $images = Get-DockerBaseImagesForPull -Extended $Extended
    Write-Host "Pre-pulling Docker base images (retry on TLS timeout)..." -ForegroundColor Cyan
    foreach ($image in $images) {
        $ok = $false
        for ($i = 1; $i -le $MaxAttempts; $i++) {
            Write-Host ("  pull {0} (attempt {1}/{2})" -f $image, $i, $MaxAttempts) -ForegroundColor DarkGray
            docker pull $image 2>&1 | Out-Host
            if ($LASTEXITCODE -eq 0) {
                $ok = $true
                break
            }
            if ($i -lt $MaxAttempts) {
                Write-Host "  retry in 5s..." -ForegroundColor DarkYellow
                Start-Sleep -Seconds 5
            }
        }
        if (-not $ok) {
            throw "Failed to pull base image after $MaxAttempts attempts: $image (check network / mirror)"
        }
    }
}

function Invoke-AgentsLanCompose {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("restart", "up")]
        [string]$Action,
        [bool]$Extended = $false,
        [switch]$Build,
        [switch]$ForceRecreate,
        [string[]]$Services = @()
    )

    if ($Build -and $Action -eq "up") {
        $useExtendedForPull = $Extended -or (Test-RequiresExtendedProfile -Services $Services)
        Invoke-DockerBaseImagePull -Extended $useExtendedForPull
    }

    $base = Get-ComposeBaseArgs
    $useExtended = $Extended -or (Test-RequiresExtendedProfile -Services $Services)
    $profile = Get-ProfileArgs -Extended $useExtended

    if ($Action -eq "restart") {
        if ($Build -or $ForceRecreate) {
            Write-Host "Note: restart does not reload env; using up -d instead." -ForegroundColor DarkYellow
            $Action = "up"
        } else {
            $cmd = @("compose") + $base + $profile + @("restart")
            if ($Services.Count -gt 0) { $cmd += $Services }
            Write-Host ("docker " + ($cmd -join " ")) -ForegroundColor DarkGray
            & docker @cmd
            return
        }
    }

    $cmd = @("compose") + $base + $profile + @("up", "-d")
    if ($Build) { $cmd += "--build" }
    if ($ForceRecreate) { $cmd += "--force-recreate" }
    if ($Services.Count -gt 0) { $cmd += $Services }

    if ($useExtended -and -not $Extended) {
        Write-Host "Auto-enabled --profile extended (extended-only service in list)." -ForegroundColor DarkYellow
    }

    Write-Host ("docker " + ($cmd -join " ")) -ForegroundColor DarkGray
    & docker @cmd
}
