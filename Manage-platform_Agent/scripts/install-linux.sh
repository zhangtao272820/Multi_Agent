#!/usr/bin/env bash
# ClawHive 客户服务器一键部署（Linux）
# 用法：
#   cd /path/to/agent/Manage-platform_Agent
#   bash scripts/install-linux.sh                 # 标准版（含多模态理解 + 监控）
#   bash scripts/install-linux.sh --extended      # + 音乐/视频 / Lobster
#   bash scripts/install-linux.sh --no-monitor    # 弱机跳过 Prom/Grafana/AM/Tempo/Loki
#   bash scripts/install-linux.sh --core --enterprise --public --no-monitor
#       # 4C8G 公网推荐：核心栈 + 企业鉴权 + 本机绑端口
#   bash scripts/install-linux.sh --offline       # 从 offline/images.tar 加载
#   bash scripts/install-linux.sh --no-build

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.agents-lan.yml"
ENTERPRISE_OVERLAY="$ROOT/docker-compose.agents-enterprise.overlay.yml"
PUBLIC_OVERLAY="$ROOT/docker-compose.agents-public.overlay.yml"
ENV_FILE="$ROOT/.env.agents-lan"
ENTERPRISE_ENV="$ROOT/.env.agents-enterprise"
EXAMPLE="$ROOT/.env.agents-lan.example"
ENTERPRISE_EXAMPLE="$ROOT/.env.agents-enterprise.example"
OFFLINE_DIR="$ROOT/offline"
EXTENDED=0
NO_BUILD=0
NO_MONITOR=0
OFFLINE=0
ENTERPRISE=0
PUBLIC=0
CORE=0
HEALTH_TIMEOUT_SEC=180

CORE_SERVICES=(
  clawhive_postgres
  clawhive_redis
  searxng
  crw
  rag_pgvector
  vanna_db_agent
  vanna_db_web
  clawhive_backend
  clawhive_frontend
  rag_agent
  code_assistent_agent
  extractor_agent
  ai_admin_agent
  multimodal_agent
  manager_agent
)

for arg in "$@"; do
  case "$arg" in
    --extended) EXTENDED=1 ;;
    --no-build) NO_BUILD=1 ;;
    --no-monitor) NO_MONITOR=1 ;;
    --offline) OFFLINE=1; NO_BUILD=1 ;;
    --enterprise) ENTERPRISE=1 ;;
    --public) PUBLIC=1 ;;
    --core) CORE=1 ;;
    -h|--help)
      echo "用法: bash scripts/install-linux.sh [--core] [--enterprise] [--public] [--extended] [--no-build] [--no-monitor] [--offline]"
      echo "  4C8G 公网推荐: --core --enterprise --public --no-monitor"
      exit 0
      ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "错误: 未找到 docker，请先安装 Docker Engine + Compose 插件"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "错误: 需要 docker compose v2（docker compose version）"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ ! -f "$EXAMPLE" ]]; then
    echo "错误: 缺少 $EXAMPLE"
    exit 1
  fi
  cp "$EXAMPLE" "$ENV_FILE"
  echo "已创建 $ENV_FILE，请编辑必填项后重新运行本脚本"
  echo "  必填: LAN_HOST, CLAWHIVE_INTERNAL_TOKEN, OPENAI_API_KEY, CLAWHIVE_ADMIN_PASSWORD"
  exit 1
fi

if (( ENTERPRISE )); then
  if [[ ! -f "$ENTERPRISE_ENV" ]]; then
    if [[ -f "$ENTERPRISE_EXAMPLE" ]]; then
      cp "$ENTERPRISE_EXAMPLE" "$ENTERPRISE_ENV"
      echo "已创建 $ENTERPRISE_ENV，请对齐 CLAWHIVE_INTERNAL_TOKEN / JWT / MANAGER_WS_TOKEN 后重跑"
      exit 1
    fi
    echo "错误: 缺少 $ENTERPRISE_ENV（见 .env.agents-enterprise.example）"
    exit 1
  fi
  if [[ ! -f "$ENTERPRISE_OVERLAY" ]]; then
    echo "错误: 缺少 $ENTERPRISE_OVERLAY"
    exit 1
  fi
fi

if (( PUBLIC )); then
  if [[ ! -f "$PUBLIC_OVERLAY" ]]; then
    echo "错误: 缺少 $PUBLIC_OVERLAY"
    exit 1
  fi
fi

# 核心/公网：强制踢出 gui（Lobster 仅 --extended）；写入 lan env 以免插值盖掉 overlay
if (( CORE || PUBLIC )); then
  if grep -q '^MANAGER_DISABLED_AGENTS=' "$ENV_FILE"; then
    sed -i.bak 's/^MANAGER_DISABLED_AGENTS=.*/MANAGER_DISABLED_AGENTS=music,video,gui/' "$ENV_FILE"
  else
    echo 'MANAGER_DISABLED_AGENTS=music,video,gui' >> "$ENV_FILE"
  fi
fi

# shellcheck disable=SC1090
source "$ENV_FILE" 2>/dev/null || true

missing=()
[[ -z "${LAN_HOST:-}" || "$LAN_HOST" == *"请"* ]] && missing+=("LAN_HOST")
[[ -z "${CLAWHIVE_INTERNAL_TOKEN:-}" || "$CLAWHIVE_INTERNAL_TOKEN" == *"请"* ]] && missing+=("CLAWHIVE_INTERNAL_TOKEN")
[[ -z "${OPENAI_API_KEY:-}${QWEN_API_KEY:-}${DASHSCOPE_API_KEY:-}" ]] && missing+=("OPENAI_API_KEY 或 QWEN_API_KEY")
if (( PUBLIC || ENTERPRISE )); then
  [[ -z "${MANAGER_WS_TOKEN:-}" || "$MANAGER_WS_TOKEN" == *"请"* || "$MANAGER_WS_TOKEN" == change-* ]] && missing+=("MANAGER_WS_TOKEN")
  [[ -z "${CLAWHIVE_JWT_SECRET:-}" || "$CLAWHIVE_JWT_SECRET" == *"请"* || "$CLAWHIVE_JWT_SECRET" == change-* ]] && missing+=("CLAWHIVE_JWT_SECRET")
fi
if ((${#missing[@]})); then
  echo "错误: .env.agents-lan 尚未配置: ${missing[*]}"
  exit 1
fi

# 同步 internal token 到 Manager（若存在 .env）
MANAGER_ENV="$ROOT/../Manager_Agent/.env"
if [[ -f "$MANAGER_ENV" ]]; then
  if grep -q '^CLAWHIVE_INTERNAL_TOKEN=' "$MANAGER_ENV"; then
    sed -i.bak "s|^CLAWHIVE_INTERNAL_TOKEN=.*|CLAWHIVE_INTERNAL_TOKEN=${CLAWHIVE_INTERNAL_TOKEN}|" "$MANAGER_ENV"
  else
    echo "CLAWHIVE_INTERNAL_TOKEN=${CLAWHIVE_INTERNAL_TOKEN}" >> "$MANAGER_ENV"
  fi
  if ! grep -q '^CLAWHIVE_BACKEND_URL=' "$MANAGER_ENV"; then
    echo "CLAWHIVE_BACKEND_URL=http://${LAN_HOST}:${CLAWHIVE_BACKEND_PORT:-18000}" >> "$MANAGER_ENV"
  fi
fi

# 可选：写入镜像 tag（未设置则保持 prod）
if [[ -z "${CLAWHIVE_IMAGE_TAG:-}" ]]; then
  if command -v git >/dev/null 2>&1 && git -C "$ROOT/.." rev-parse --short HEAD >/dev/null 2>&1; then
    SHA="$(git -C "$ROOT/.." rev-parse --short HEAD)"
    TAG="0.1.0-${SHA}"
  else
    TAG="prod"
  fi
  if grep -q '^CLAWHIVE_IMAGE_TAG=' "$ENV_FILE"; then
    sed -i.bak "s|^CLAWHIVE_IMAGE_TAG=.*|CLAWHIVE_IMAGE_TAG=${TAG}|" "$ENV_FILE"
  else
    echo "CLAWHIVE_IMAGE_TAG=${TAG}" >> "$ENV_FILE"
  fi
  export CLAWHIVE_IMAGE_TAG="$TAG"
  echo "CLAWHIVE_IMAGE_TAG=${CLAWHIVE_IMAGE_TAG}"
fi

if (( OFFLINE )); then
  echo "离线模式: 校验并加载 ${OFFLINE_DIR}"
  if [[ ! -f "$OFFLINE_DIR/SHA256SUMS" || ! -f "$OFFLINE_DIR/images.tar" ]]; then
    echo "错误: 需要 ${OFFLINE_DIR}/images.tar 与 SHA256SUMS"
    exit 1
  fi
  (
    cd "$OFFLINE_DIR"
    sha256sum -c SHA256SUMS
  )
  docker load -i "$OFFLINE_DIR/images.tar"
fi

COMPOSE_ARGS=(--env-file "$ENV_FILE")
if (( ENTERPRISE )); then
  COMPOSE_ARGS+=(--env-file "$ENTERPRISE_ENV")
fi
COMPOSE_ARGS+=(-f "$COMPOSE_FILE")
if (( ENTERPRISE )); then
  COMPOSE_ARGS+=(-f "$ENTERPRISE_OVERLAY")
  echo "企业档: $ENTERPRISE_ENV + overlay"
fi
if (( PUBLIC )); then
  COMPOSE_ARGS+=(-f "$PUBLIC_OVERLAY")
  echo "公网 overlay: 127.0.0.1 绑定 + 4C8G 内存顶"
fi

PROFILE_ARGS=()
if (( EXTENDED )); then
  PROFILE_ARGS+=(--profile extended)
  echo "部署模式: 完整版（extended，含 Lobster/music/video）"
elif (( CORE )); then
  echo "部署模式: 核心栈（无 Lobster / 无 extended）"
else
  echo "部署模式: 标准版（平台 + Manager 协作链；Lobster 须 --extended）"
fi
if (( NO_MONITOR )); then
  echo "监控: 跳过（--no-monitor；不启 monitoring profile）"
else
  PROFILE_ARGS+=(--profile monitoring)
  echo "监控: 启用（--profile monitoring）"
fi

UP_ARGS=(up -d "${PROFILE_ARGS[@]}")
if (( NO_BUILD )); then
  :
else
  UP_ARGS+=(--build)
fi

echo "启动 ClawHive 集群..."
if (( CORE )); then
  docker compose "${COMPOSE_ARGS[@]}" "${UP_ARGS[@]}" "${CORE_SERVICES[@]}"
else
  docker compose "${COMPOSE_ARGS[@]}" "${UP_ARGS[@]}"
fi

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
  echo "错误: 健康门禁超时（${HEALTH_TIMEOUT_SEC}s）"
  return 1
}

if ! wait_health; then
  exit 1
fi

HOST_SHOW="${LAN_HOST}"
if (( PUBLIC )); then
  HOST_SHOW="127.0.0.1"
fi

echo ""
echo "========== 部署完成 =========="
echo "管理平台:  http://${HOST_SHOW}:${CLAWHIVE_FRONTEND_PORT:-18073}  （admin / 见 .env.agents-lan）"
echo "Manager UI: http://${HOST_SHOW}:${MANAGER_PORT:-13106}"
echo "后端健康:  http://${HOST_SHOW}:${CLAWHIVE_BACKEND_PORT:-18000}/health"
if (( PUBLIC )); then
  echo "公网入口: 配置 docker/public/Caddyfile.example（安全组仅 80/443）"
fi
if (( ! NO_MONITOR )); then
  echo "Grafana:    http://${LAN_HOST}:${CLAWHIVE_GRAFANA_PORT:-13000}"
  echo "Prometheus: http://${LAN_HOST}:${CLAWHIVE_PROMETHEUS_PORT:-19090}"
  echo "Alertmanager: http://${LAN_HOST}:${CLAWHIVE_ALERTMANAGER_PORT:-19093}"
  echo "Tempo:      http://${LAN_HOST}:${CLAWHIVE_TEMPO_PORT:-3200}"
  echo "Loki:       http://${LAN_HOST}:${CLAWHIVE_LOKI_PORT:-3100}"
fi
echo ""
echo "日常运维: 登录控制台 → Agent 管控 / Agent 配置 → 总览"
echo "备份: bash scripts/backup-postgres.sh"
echo "恢复: bash scripts/restore-postgres.sh backups/<file>.sql.gz --yes"
echo "回滚: bash scripts/rollback-agents.sh <旧CLAWHIVE_IMAGE_TAG>"
if (( ! EXTENDED )); then
  echo "如需音乐/视频/Lobster: bash scripts/install-linux.sh --extended --no-build"
fi
