#!/usr/bin/env bash
# 构建标准版首方生产镜像，并写入 CLAWHIVE_IMAGE_TAG
# 用法:
#   bash scripts/build-agents-prod.sh
#   bash scripts/build-agents-prod.sh --extended
#   bash scripts/build-agents-prod.sh --no-up
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EXTENDED=0
NO_UP=0
for arg in "$@"; do
  case "$arg" in
    --extended) EXTENDED=1 ;;
    --no-up) NO_UP=1 ;;
    -h|--help)
      echo "用法: bash scripts/build-agents-prod.sh [--extended] [--no-up]"
      exit 0
      ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

bash "$ROOT/scripts/tag-images.sh"

ENV_FILE="$ROOT/.env.agents-lan"
COMPOSE=(docker compose)
if [[ -f "$ENV_FILE" ]]; then
  COMPOSE+=(--env-file "$ENV_FILE")
fi
COMPOSE+=(-f "$ROOT/docker-compose.agents-lan.yml")

STANDARD=(
  clawhive_backend
  clawhive_frontend
  db_agent
  rag_agent
  code_assistent_agent
  extractor_agent
  ai_admin_agent
  multimodal_agent
  manager_agent
)

SERVICES=("${STANDARD[@]}")
if (( EXTENDED )); then
  SERVICES+=(
    lobster_agent
    tavern_agent
    companion_agent
    music_agent
    video_agent
    ai_agent
  )
  COMPOSE+=(--profile extended)
fi

echo "Building: ${SERVICES[*]}"
"${COMPOSE[@]}" build "${SERVICES[@]}"

if (( ! NO_UP )); then
  "${COMPOSE[@]}" up -d --force-recreate --no-build "${SERVICES[@]}"
fi
