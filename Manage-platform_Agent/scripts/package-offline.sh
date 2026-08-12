#!/usr/bin/env bash
# 在有网构建机打包离线镜像：offline/images.tar + SHA256SUMS
# 用法:
#   bash scripts/package-offline.sh
#   bash scripts/package-offline.sh --extended
#   bash scripts/package-offline.sh --no-build   # 跳过 build，仅 docker save 已有镜像
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OFFLINE_DIR="$ROOT/offline"
ENV_FILE="$ROOT/.env.agents-lan"
COMPOSE_FILE="$ROOT/docker-compose.agents-lan.yml"
EXTENDED=0
NO_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --extended) EXTENDED=1 ;;
    --no-build) NO_BUILD=1 ;;
    -h|--help)
      echo "用法: bash scripts/package-offline.sh [--extended] [--no-build]"
      exit 0
      ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE" 2>/dev/null || true; set +a
fi

bash "$ROOT/scripts/tag-images.sh"
# shellcheck disable=SC1090
source "$ENV_FILE" 2>/dev/null || true
TAG="${CLAWHIVE_IMAGE_TAG:-prod}"

STANDARD_FIRST=(
  "clawhive/clawhive_backend:${TAG}"
  "clawhive/clawhive_frontend:${TAG}"
  "clawhive/db_agent:${TAG}"
  "clawhive/rag_agent:${TAG}"
  "clawhive/code_assistent_agent:${TAG}"
  "clawhive/extractor_agent:${TAG}"
  "clawhive/ai_admin_agent:${TAG}"
  "clawhive/multimodal_agent:${TAG}"
  "clawhive/manager_agent:${TAG}"
)

EXTENDED_FIRST=(
  "clawhive/lobster_agent:${TAG}"
  "clawhive/tavern_agent:${TAG}"
  "clawhive/music_agent:${TAG}"
  "clawhive/video_agent:${TAG}"
  "clawhive/ai_agent:${TAG}"
)

# 标准栈第三方基础镜像（与 compose 默认值对齐）
THIRD=(
  "docker.1ms.run/pgvector/pgvector:pg16"
  "docker.1ms.run/library/redis:7-alpine"
  "docker.1ms.run/grafana/tempo:2.6.1"
  "docker.1ms.run/grafana/loki:3.1.1"
  "docker.1ms.run/grafana/promtail:3.1.1"
  "docker.1ms.run/prom/prometheus:v2.55.1"
  "docker.1ms.run/prom/alertmanager:v0.27.0"
  "docker.1ms.run/grafana/grafana:11.2.2"
  "${SEARXNG_IMAGE:-docker.1ms.run/searxng/searxng:latest}"
)

IMAGES=("${STANDARD_FIRST[@]}" "${THIRD[@]}")
if (( EXTENDED )); then
  IMAGES+=("${EXTENDED_FIRST[@]}")
fi

BUILD_ARGS=(bash "$ROOT/scripts/build-agents-prod.sh" --no-up)
if (( EXTENDED )); then
  BUILD_ARGS+=(--extended)
fi

if (( ! NO_BUILD )); then
  echo "构建首方镜像 (tag=${TAG})..."
  "${BUILD_ARGS[@]}"
fi

missing=()
for img in "${IMAGES[@]}"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    # 第三方缺失则尝试 pull
    if [[ "$img" != clawhive/* ]]; then
      echo "拉取: $img"
      docker pull "$img" || missing+=("$img")
    else
      missing+=("$img")
    fi
  fi
done
if ((${#missing[@]})); then
  echo "错误: 以下镜像不存在，请先 build/pull: ${missing[*]}"
  exit 1
fi

mkdir -p "$OFFLINE_DIR"
OUT="$OFFLINE_DIR/images.tar"
echo "docker save → $OUT (${#IMAGES[@]} images)"
docker save "${IMAGES[@]}" -o "$OUT"

(
  cd "$OFFLINE_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum images.tar > SHA256SUMS
  else
    shasum -a 256 images.tar | sed 's/  /  /' > SHA256SUMS
  fi
)

echo "已写入:"
echo "  $OUT"
echo "  $OFFLINE_DIR/SHA256SUMS"
echo "客户机: bash scripts/install-linux.sh --offline"
