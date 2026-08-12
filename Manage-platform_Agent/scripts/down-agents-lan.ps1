$ErrorActionPreference = "Stop"

# 禁止：docker compose down -v（会删除 clawhive_pg_data / *_agent_data 等命名卷，对话与记忆丢失）
# 文档：doc/docker-persist-no-volume-wipe.md

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

if ($Rest | Where-Object { $_ -eq '-v' -or $_ -eq '--volumes' -or $_ -like '*-v*' }) {
    Write-Error @"
REFUSED: down with -v/--volumes is forbidden.

This would delete named volumes (clawhive_pg_data, rag_agent_data, manager_agent_data, db_agent_data, …)
and wipe chat history / memory / vectors.

Use: docker compose … down
See: Manage-platform_Agent/doc/docker-persist-no-volume-wipe.md
"@
    exit 2
}

$root = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $root "docker-compose.agents-lan.yml"
$envFile = Join-Path $root ".env.agents-lan"

Write-Host "Stopping agent stack (volumes preserved; never uses -v)..." -ForegroundColor Cyan
docker compose --env-file "$envFile" -f "$composeFile" down
Write-Host "Done. Named volumes kept." -ForegroundColor Green
