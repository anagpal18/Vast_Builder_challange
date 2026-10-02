#!/usr/bin/env bash
set -euo pipefail
python -m backend.precompute
exec uvicorn backend.main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8000}" --workers 1 --proxy-headers --forwarded-allow-ips='*'
