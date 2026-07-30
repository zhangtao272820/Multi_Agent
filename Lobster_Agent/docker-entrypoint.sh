#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export VNC_PORT="${VNC_PORT:-5900}"
export NOVNC_PORT="${NOVNC_PORT:-6080}"
export APP_PORT="${APP_PORT:-13108}"
export PORT="${APP_PORT}"
export NITRO_PORT="${APP_PORT}"
export HOST="${HOST:-0.0.0.0}"

if [ ! -f /app/agent-repo-shared/qwenModelKwargs.ts ]; then
  echo "[lobster] FATAL: missing /app/agent-repo-shared — rebuild with compose context .." >&2
  exit 1
fi

if [ ! -f /app/.output/server/index.mjs ]; then
  echo "[lobster] FATAL: missing .output/server/index.mjs — image build failed" >&2
  exit 1
fi

# Named volume at /app/.data/sessions leaves parent /app/.data root-owned; ensure writable subdirs.
mkdir -p /app/.data/lobster /app/.data/runs /app/.data/traces /app/.data/videos /app/.data/sessions
mkdir -p /app/.data/pw-home/.config /app/.data/pw-home/.cache
chown -R pwuser:pwuser /app/.data

# 虚拟桌面：供 headed Chromium + noVNC
if ! xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
  echo "[lobster] starting Xvfb on ${DISPLAY}..."
  Xvfb "${DISPLAY}" -screen 0 1920x1080x24 -ac +extension RANDR +extension GLX &
  for _ in $(seq 1 40); do
    if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
      echo "[lobster] X display ${DISPLAY} ready"
      break
    fi
    sleep 0.25
  done
fi

mkdir -p /app/.data/pw-home/.fluxbox
cat > /app/.data/pw-home/.fluxbox/init <<'FBINIT'
session.screen0.rootCommand:
session.screen0.toolbar.visible: false
FBINIT
chown -R pwuser:pwuser /app/.data/pw-home/.fluxbox

HOME=/app/.data/pw-home fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display "${DISPLAY}" -forever -shared -nopw -rfbport "${VNC_PORT}" >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc "${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" >/tmp/novnc.log 2>&1 &

echo "[lobster] production server ${HOST}:${APP_PORT} DISPLAY=${DISPLAY}"

# Stagehand/chrome-launcher：指向 Playwright 镜像内置 Chromium（若未显式设置）
if [ -z "${CHROME_PATH:-}" ]; then
  CHROME_CANDIDATE="$(find /ms-playwright -path '*/chrome-linux64/chrome' -type f 2>/dev/null | head -1 || true)"
  if [ -z "${CHROME_CANDIDATE}" ]; then
    CHROME_CANDIDATE="$(find /ms-playwright -path '*/chrome-linux/chrome' -type f 2>/dev/null | head -1 || true)"
  fi
  if [ -n "${CHROME_CANDIDATE}" ]; then
    export CHROME_PATH="${CHROME_CANDIDATE}"
    echo "[lobster] CHROME_PATH=${CHROME_PATH}"
  else
    echo "[lobster] WARN: no Chromium under /ms-playwright; Stagehand may fail without CHROME_PATH" >&2
  fi
fi

# pwuser 的 HOME 必须可写，否则 headed Chromium crashpad 会立刻退出
exec runuser -p -u pwuser -- env \
  HOME=/app/.data/pw-home \
  XDG_CONFIG_HOME=/app/.data/pw-home/.config \
  XDG_CACHE_HOME=/app/.data/pw-home/.cache \
  CHROME_PATH="${CHROME_PATH:-}" \
  node .output/server/index.mjs
