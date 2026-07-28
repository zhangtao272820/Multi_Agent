# 写入 CLAWHIVE_IMAGE_TAG=0.1.0-<gitsha>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env.agents-lan"
$repo = Split-Path $root -Parent
$semver = if ($env:CLAWHIVE_IMAGE_SEMVER) { $env:CLAWHIVE_IMAGE_SEMVER } else { "0.1.0" }
$sha = "local"
try { $sha = (git -C $repo rev-parse --short HEAD).Trim() } catch {}
$tag = "$semver-$sha"
if (-not (Test-Path $envFile)) { New-Item -ItemType File -Path $envFile | Out-Null }

# Must use UTF-8 (no BOM): default Get-Content/Set-Content on Chinese Windows rewrites UTF-8 as GBK mojibake.
. (Join-Path $PSScriptRoot "_agents-lan-common.ps1")
$content = @(Read-EnvFileUtf8 $envFile)
if ($content -match "^CLAWHIVE_IMAGE_TAG=") {
    $content = $content | ForEach-Object { if ($_ -match "^CLAWHIVE_IMAGE_TAG=") { "CLAWHIVE_IMAGE_TAG=$tag" } else { $_ } }
    Write-EnvFileUtf8 -Path $envFile -Lines $content
} else {
    $content = @($content) + @("CLAWHIVE_IMAGE_TAG=$tag")
    Write-EnvFileUtf8 -Path $envFile -Lines $content
}
Write-Output $tag
