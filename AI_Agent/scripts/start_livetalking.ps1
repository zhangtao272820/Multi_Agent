# 启动 LiveTalking（需已 clone + 配置形象/权重）
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Lt = Join-Path $Root ".external\LiveTalking"
if (-not (Test-Path $Lt)) {
    Write-Error "LiveTalking not found. Run .\scripts\setup_avatar_stack.ps1 first."
}

$Port = if ($env:LIVETALKING_PORT) { $env:LIVETALKING_PORT } else { "8010" }
$Model = if ($env:LIVETALKING_MODEL) { $env:LIVETALKING_MODEL } else { "ultralight" }
$Transport = if ($env:LIVETALKING_TRANSPORT) { $env:LIVETALKING_TRANSPORT } else { "webrtc" }

Write-Host "LiveTalking dir: $Lt"
Write-Host "Listen port: $Port model=$Model transport=$Transport"
Write-Host "FeatherTalk weights: set avatar/data paths per LiveTalking docs;"
Write-Host "  prefer FeatherTalk checkpoint over legacy Ultralight."

Set-Location $Lt
# LiveTalking 入口随版本略有差异；优先 app.py
$entry = $null
foreach ($c in @("app.py", "webui.py", "main.py")) {
    if (Test-Path (Join-Path $Lt $c)) { $entry = $c; break }
}
if (-not $entry) {
    Write-Error "Cannot find LiveTalking entry (app.py). Check .external/LiveTalking"
}

$py = if ($env:LIVETALKING_PYTHON) { $env:LIVETALKING_PYTHON } else { "python" }
& $py $entry --listenport $Port --model $Model --transport $Transport @args
