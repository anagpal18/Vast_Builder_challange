#!/usr/bin/env bash
# Start the API (+ mock console at /). Single worker on purpose: run state lives in-process.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a
exec .venv/bin/uvicorn backend.main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8000}" \
  --workers 1 --proxy-headers --forwarded-allow-ips='*' "$@"
