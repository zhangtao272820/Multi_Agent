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
# 确保 Hands 子进程能找到 uvx（windows-mcp）；USERPROFILE 偶发为空时要兜底
$homeDir = @(
  $env:USERPROFILE,
  $env:HOME,
  $(if ($env:HOMEDRIVE -and $env:HOMEPATH) { Join-Path $env:HOMEDRIVE $env:HOMEPATH } else { $null }),
  [Environment]::GetFolderPath('UserProfile')
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1
if (-not [string]::IsNullOrWhiteSpace($homeDir)) {
  $uvBin = Join-Path $homeDir ".local\bin"
  if (-not [string]::IsNullOrWhiteSpace($uvBin) -and (Test-Path -LiteralPath $uvBin)) {
    $env:Path = "$uvBin;" + $env:Path
  }
}
# 若 Path 里仍无 uvx，尝试 which 后把其目录前置
$uvxCmd = Get-Command uvx -ErrorAction SilentlyContinue
if ($uvxCmd -and $uvxCmd.Source) {
  $uvxDir = Split-Path -Parent $uvxCmd.Source
  if ($uvxDir -and ($env:Path -notlike "*$uvxDir*")) {
    $env:Path = "$uvxDir;" + $env:Path
  }
}
# Docker Manager 经 host.docker.internal 访问时需绑定非仅-loopback；仍默认 127.0.0.1 更安全，
# 设 LOBSTER_HANDS_BIND=0.0.0.0 可对局域网暴露（配合 token）。
$bindHost = [string]$env:LOBSTER_HANDS_BIND
if ([string]::IsNullOrWhiteSpace($bindHost)) { $bindHost = "127.0.0.1" }
$env:HOST = $bindHost
$env:NUXT_DEV_HOST = $bindHost
$env:PORT = $(if ($env:LOBSTER_HANDS_PORT) { $env:LOBSTER_HANDS_PORT } else { "13109" })
$env:NITRO_PORT = $env:PORT
$env:NUXT_PORT = $env:PORT

Write-Host ("==> Lobster Hands sidecar on http://{0}:{1}" -f $bindHost, $env:PORT) -ForegroundColor Cyan
Write-Host ("    Manager Docker: LOBSTER_HANDS_WS_URL=ws://host.docker.internal:{0}/_ws" -f $env:PORT) -ForegroundColor DarkGray
Write-Host "    desktop MCP: uvx windows-mcp serve" -ForegroundColor DarkGray
Write-Host ("    ready: GET http://127.0.0.1:{0}/api/ready" -f $env:PORT) -ForegroundColor DarkGray
# 端口被占用时禁止静默改到 3000（总管只认 :13109）
$busy = Get-NetTCPConnection -LocalPort ([int]$env:PORT) -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  $pids = $busy | Select-Object -ExpandProperty OwningProcess -Unique
  throw "Port $($env:PORT) already in use by PID(s): $($pids -join ', '). Stop old Hands first, then retry."
}
$env:APP_PORT = $env:PORT
$env:NUXT_HOST = $bindHost

# 默认走 nuxt dev（立刻吃到源码修复）；设 LOBSTER_HANDS_USE_BUILT=1 才用 .output
if ($env:LOBSTER_HANDS_USE_BUILT -ne '1') {
  $env:LOBSTER_HANDS_PREFER_DEV = '1'
}

if (-not (Test-Path "node_modules")) {
  Write-Host "==> npm install" -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

node hands/launcher.mjs
