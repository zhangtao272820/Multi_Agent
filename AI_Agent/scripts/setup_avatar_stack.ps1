# 克隆 FeatherTalk + LiveTalking 到 AI_Agent/.external（不提交 git）
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Ext = Join-Path $Root ".external"
New-Item -ItemType Directory -Force -Path $Ext | Out-Null

$env:GIT_SSL_NO_VERIFY = "true"

function Ensure-Repo([string]$Name, [string]$Url) {
    $dest = Join-Path $Ext $Name
    if (Test-Path (Join-Path $dest ".git")) {
        Write-Host "[ok] $Name already present: $dest"
        return
    }
    if (Test-Path $dest) {
        Write-Host "[warn] $dest exists but is not a git repo; skip clone"
        return
    }
    Write-Host "[clone] $Url -> $dest"
    git -c http.sslVerify=false clone --depth 1 $Url $dest
}

Ensure-Repo "FeatherTalk" "https://github.com/anliyuan/FeatherTalk.git"
Ensure-Repo "LiveTalking" "https://github.com/lipku/LiveTalking.git"

$AvatarData = Join-Path $Root "assets\avatar_runtime"
New-Item -ItemType Directory -Force -Path $AvatarData | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $AvatarData "feathertalk") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $AvatarData "actions") | Out-Null

Write-Host ""
Write-Host "Next:"
Write-Host "  1. Train FeatherTalk model (see .external/FeatherTalk README)"
Write-Host "  2. Place checkpoint under assets/avatar_runtime/feathertalk/"
Write-Host "  3. .\scripts\start_livetalking.ps1"
Write-Host "  4. Set LIP_SYNC_MODE=livetalking in AI_Agent/.env"
