# Build Hands onedir POC (not full Manager/Lobster mega-exe)
# Usage: powershell -ExecutionPolicy Bypass -File hands/build_exe.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Out = Join-Path $Root "hands_dist\LobsterHands"
if (Test-Path $Out) {
  Remove-Item -Recurse -Force $Out
}
New-Item -ItemType Directory -Force $Out | Out-Null

Write-Host "==> Optional Nuxt build (for production server entry)" -ForegroundColor Cyan
if (-not (Test-Path "node_modules")) {
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}
# Best-effort build; launcher falls back to nuxt dev if .output missing
npm run build
if ($LASTEXITCODE -ne 0) {
  Write-Host "WARN: nuxt build failed; onedir will use nuxt dev fallback" -ForegroundColor Yellow
}

Write-Host "==> Assemble onedir" -ForegroundColor Cyan
Copy-Item (Join-Path $Root "hands\launcher.mjs") (Join-Path $Out "launcher.mjs")
Copy-Item (Join-Path $Root "hands\README.md") (Join-Path $Out "README.md")
Copy-Item (Join-Path $Root "hands\start-hands.ps1") (Join-Path $Out "start-hands.ps1")

# Pointer files: run from repo root (hands_dist is sibling of hands/)
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
node hands\launcher.mjs
endlocal
"@
Set-Content -Path (Join-Path $Out "LobsterHands.cmd") -Value $Cmd -Encoding ASCII

$EnvExample = @"
# %LOCALAPPDATA%\LobsterHands\.env
LOBSTER_ADMIN_TOKEN=
OPENAI_API_KEY=
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LOBSTER_DESKTOP_MCP_ENABLED=1
LOBSTER_HANDS_ONLY=1
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

Write-Host ""
Write-Host "Done. Double-click:" -ForegroundColor Green
Write-Host "  $Out\LobsterHands.cmd"
Write-Host "Then point Manager LOBSTER_HANDS_WS_URL=ws://127.0.0.1:13109/_ws"
