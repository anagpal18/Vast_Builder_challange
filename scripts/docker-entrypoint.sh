#!/usr/bin/env bash
set -euo pipefail
# a fresh/empty data volume: restore shipped config files that are missing
mkdir -p data/config
for f in /app/defaults/config/*; do [ -e "data/config/$(basename "$f")" ] || cp "$f" data/config/; done
python -m backend.precompute
exec uvicorn backend.main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8000}" --workers 1 --proxy-headers --forwarded-allow-ips='*'
