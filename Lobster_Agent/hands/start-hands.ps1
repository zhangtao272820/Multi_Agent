# Start Lobster Hands sidecar (desktop only) on :13109
# Usage: powershell -ExecutionPolicy Bypass -File hands/start-hands.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root "package.json"))) {
  throw "Run from Lobster_Agent: package.json not found at $Root"
}

Set-Location $Root
$env:LOBSTER_HANDS_ONLY = "1"
$env:LOBSTER_DESKTOP_MCP_ENABLED = "1"
$env:HOST = "127.0.0.1"
$env:PORT = $(if ($env:LOBSTER_HANDS_PORT) { $env:LOBSTER_HANDS_PORT } else { "13109" })
$env:NITRO_PORT = $env:PORT
$env:NUXT_PORT = $env:PORT

Write-Host "==> Lobster Hands sidecar on http://127.0.0.1:$($env:PORT)" -ForegroundColor Cyan
Write-Host "    Manager: LOBSTER_HANDS_WS_URL=ws://127.0.0.1:$($env:PORT)/_ws" -ForegroundColor DarkGray

if (-not (Test-Path "node_modules")) {
  Write-Host "==> npm install" -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

node hands/launcher.mjs
