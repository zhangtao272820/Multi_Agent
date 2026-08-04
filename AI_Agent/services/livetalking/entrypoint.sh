#!/usr/bin/env bash
set -euo pipefail
cd /opt/LiveTalking

if [[ -f requirements.txt ]]; then
  pip install -q -r requirements.txt || true
fi

PORT="${LIVETALKING_PORT:-8010}"
MODEL="${LIVETALKING_MODEL:-ultralight}"
TRANSPORT="${LIVETALKING_TRANSPORT:-webrtc}"

echo "[livetalking] port=$PORT model=$MODEL transport=$TRANSPORT"
echo "[livetalking] FeatherTalk checkpoint: ${FEATHERTALK_CHECKPOINT:-/data/feathertalk}"
echo "[livetalking] See AI_Agent/doc/feathertalk-livetalking-bridge.md"

exec python app.py --listenport "$PORT" --model "$MODEL" --transport "$TRANSPORT" "$@"
