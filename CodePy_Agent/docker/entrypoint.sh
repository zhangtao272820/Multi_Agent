#!/bin/sh
set -e
cd /app
if [ -f frontend/package.json ] && [ ! -d frontend/dist ]; then
  (cd frontend && npm install && npm run build) || true
fi
exec python -m uvicorn app.main:app --host 0.0.0.0 --port "${CODE_PORT:-13103}" --reload
