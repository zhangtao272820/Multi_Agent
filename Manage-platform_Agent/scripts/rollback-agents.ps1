# 按镜像 tag 回滚标准协作链，并跑健康门禁
# 用法:
#   .\scripts\rollback-agents.ps1 -Tag 0.1.0-abc1234
#   .\scripts\rollback-agents.ps1 -Tag 0.1.0-abc1234 -Extended
param(
    [Parameter(Mandatory = $true)]
    [string]$Tag,
    [switch]$Extended
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env.agents-lan"
$composeFile = Join-Path $root "docker-compose.agents-lan.yml"
$healthTimeoutSec = 180

if (-not (Test-Path $envFile)) { throw "缺少 $envFile" }

. (Join-Path $PSScriptRoot "_agents-lan-common.ps1")
$content = Read-EnvFileUtf8Text $envFile
if ($content -match "(?m)^CLAWHIVE_IMAGE_TAG=") {
    $content = $content -replace "(?m)^CLAWHIVE_IMAGE_TAG=.*", "CLAWHIVE_IMAGE_TAG=$Tag"
} else {
    $content = $content.TrimEnd() + "`nCLAWHIVE_IMAGE_TAG=$Tag`n"
}
Write-EnvFileUtf8Text -Path $envFile -Text $content
$env:CLAWHIVE_IMAGE_TAG = $Tag
Write-Host "回滚到 CLAWHIVE_IMAGE_TAG=$Tag"

# 读取端口
$backendPort = "18000"
$m = Select-String -Path $envFile -Pattern "^CLAWHIVE_BACKEND_PORT=(.+)$" | Select-Object -First 1
if ($m) { $backendPort = $m.Matches.Groups[1].Value.Trim() }

$composeArgs = @("--env-file", $envFile, "-f", $composeFile, "up", "-d", "--no-build", "--force-recreate")
if ($Extended) { $composeArgs = @("--env-file", $envFile, "-f", $composeFile, "--profile", "extended", "up", "-d", "--no-build", "--force-recreate") }

Write-Host "force-recreate（--no-build）..."
docker compose @composeArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$deadline = (Get-Date).AddSeconds($healthTimeoutSec)
$url = "http://127.0.0.1:${backendPort}/health/ready"
Write-Host "健康门禁: 轮询 $url （最多 ${healthTimeoutSec}s）"
while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
        if ($resp.StatusCode -eq 200) {
            Write-Host "健康门禁通过: /health/ready"
            Write-Host "回滚完成: tag=$Tag"
            exit 0
        }
    } catch {
        Start-Sleep -Seconds 5
    }
}
throw "健康门禁超时"
