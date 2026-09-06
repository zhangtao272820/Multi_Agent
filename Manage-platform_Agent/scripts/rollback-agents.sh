#!/usr/bin/env bash
# 按镜像 tag 回滚标准协作链，并跑健康门禁
# 用法:
#   bash scripts/rollback-agents.sh 0.1.0-abc1234
#   bash scripts/rollback-agents.sh 0.1.0-abc1234 --extended
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env.agents-lan"
COMPOSE_FILE="$ROOT/docker-compose.agents-lan.yml"
HEALTH_TIMEOUT_SEC=180
EXTENDED=0

if [[ $# -lt 1 ]]; then
  echo "用法: bash scripts/rollback-agents.sh <CLAWHIVE_IMAGE_TAG> [--extended]"
  exit 1
fi

TAG="$1"
shift || true
for arg in "$@"; do
  case "$arg" in
    --extended) EXTENDED=1 ;;
    -h|--help)
      echo "用法: bash scripts/rollback-agents.sh <CLAWHIVE_IMAGE_TAG> [--extended]"
      exit 0
      ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "错误: 缺少 $ENV_FILE"
  exit 1
fi

if grep -q '^CLAWHIVE_IMAGE_TAG=' "$ENV_FILE"; then
  sed -i.bak "s|^CLAWHIVE_IMAGE_TAG=.*|CLAWHIVE_IMAGE_TAG=${TAG}|" "$ENV_FILE"
else
  echo "CLAWHIVE_IMAGE_TAG=${TAG}" >> "$ENV_FILE"
fi
export CLAWHIVE_IMAGE_TAG="$TAG"
echo "回滚到 CLAWHIVE_IMAGE_TAG=${TAG}"

# shellcheck disable=SC1090
source "$ENV_FILE" 2>/dev/null || true

PROFILE_ARGS=(--profile monitoring)
if (( EXTENDED )); then
  PROFILE_ARGS+=(--profile extended)
fi

echo "force-recreate（--no-build，使用已加载镜像）..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
  "${PROFILE_ARGS[@]}" up -d --no-build --force-recreate

wait_health() {
  local base="http://127.0.0.1:${CLAWHIVE_BACKEND_PORT:-18000}"
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SEC))
  echo "健康门禁: 轮询 ${base}/health/ready （最多 ${HEALTH_TIMEOUT_SEC}s）"
  while (( SECONDS < deadline )); do
    if curl -fsS "${base}/health/ready" >/dev/null 2>&1; then
      echo "健康门禁通过: /health/ready"
      return 0
    fi
    sleep 5
  done
  echo "错误: 健康门禁超时"
  return 1
}

wait_health
echo "回滚完成: tag=${TAG}"
