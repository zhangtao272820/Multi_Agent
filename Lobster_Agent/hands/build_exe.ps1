# Build Hands onedir POC for local Windows
# Usage: powershell -ExecutionPolicy Bypass -File hands/build_exe.ps1
# Set LOBSTER_HANDS_FORCE_BUILD=1 to force npm run build

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Out = Join-Path $Root "hands_dist\LobsterHands"
if (Test-Path $Out) {
  Remove-Item -Recurse -Force $Out
}
New-Item -ItemType Directory -Force $Out | Out-Null

if (-not (Test-Path "node_modules")) {
  Write-Host "==> npm install" -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

$built = Test-Path (Join-Path $Root ".output\server\index.mjs")
$force = [string]$env:LOBSTER_HANDS_FORCE_BUILD -eq '1'
if ($force -or -not $built) {
  Write-Host "==> Nuxt build" -ForegroundColor Cyan
  npm run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host "WARN: nuxt build failed; launcher will use nuxt dev fallback" -ForegroundColor Yellow
  }
} else {
  Write-Host "==> Reuse existing .output (set LOBSTER_HANDS_FORCE_BUILD=1 to rebuild)" -ForegroundColor Cyan
}

Write-Host "==> Assemble onedir" -ForegroundColor Cyan
Copy-Item (Join-Path $Root "hands\launcher.mjs") (Join-Path $Out "launcher.mjs")
Copy-Item (Join-Path $Root "hands\README.md") (Join-Path $Out "README.md")
Copy-Item (Join-Path $Root "hands\start-hands.ps1") (Join-Path $Out "start-hands.ps1")

$Cmd = @"
@echo off
setlocal
set ROOT=%~dp0..\..
cd /d "%ROOT%"
set LOBSTER_HANDS_ONLY=1
set LOBSTER_DESKTOP_MCP_ENABLED=1
set HOST=127.0.0.1
if "%LOBSTER_HANDS_PORT%"=="" set LOBSTER_HANDS_PORT=13109
set PORT=%LOBSTER_HANDS_PORT%
set NITRO_PORT=%PORT%
set NUXT_PORT=%PORT%
echo LobsterHands starting on http://127.0.0.1:%PORT%
echo ready: http://127.0.0.1:%PORT%/api/ready
node hands\launcher.mjs
endlocal
"@
Set-Content -Path (Join-Path $Out "LobsterHands.cmd") -Value $Cmd -Encoding ASCII

$Vbs = @"
Set oWS = WScript.CreateObject("WScript.Shell")
sLink = oWS.ExpandEnvironmentStrings("%USERPROFILE%\Desktop\LobsterHands.lnk")
Set oLink = oWS.CreateShortcut(sLink)
oLink.TargetPath = "$Out\LobsterHands.cmd"
oLink.WorkingDirectory = "$Root"
oLink.WindowStyle = 1
oLink.Description = "Lobster Hands desktop sidecar :13109"
oLink.Save
WScript.Echo "Shortcut: " & sLink
"@
Set-Content -Path (Join-Path $Out "create-desktop-shortcut.vbs") -Value $Vbs -Encoding ASCII

$EnvExample = @"
# %LOCALAPPDATA%\LobsterHands\.env
LOBSTER_ADMIN_TOKEN=
OPENAI_API_KEY=
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LOBSTER_DESKTOP_MCP_ENABLED=1
LOBSTER_HANDS_ONLY=1
LOBSTER_HANDS_PORT=13109
"@
Set-Content -Path (Join-Path $Out "env.example") -Value $EnvExample -Encoding UTF8

$LocalDir = Join-Path $env:LOCALAPPDATA "LobsterHands"
if (-not (Test-Path $LocalDir)) {
  New-Item -ItemType Directory -Force $LocalDir | Out-Null
}
$LocalEnv = Join-Path $LocalDir ".env"
if (-not (Test-Path $LocalEnv)) {
  Copy-Item (Join-Path $Out "env.example") $LocalEnv
  Write-Host "Seeded $LocalEnv" -ForegroundColor Cyan
}

try {
  cscript //nologo (Join-Path $Out "create-desktop-shortcut.vbs")
} catch {
  Write-Host "WARN: desktop shortcut skipped" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Double-click:" -ForegroundColor Green
Write-Host "  $Out\LobsterHands.cmd"
Write-Host "  or Desktop\LobsterHands.lnk"
Write-Host "Docker Manager already uses host.docker.internal:13109 when Hands is up"
