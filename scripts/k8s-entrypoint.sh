#!/usr/bin/env bash
# Runs inside the k8s pod after the code is fetched (see scripts/deploy-k8s.sh).
set -euo pipefail
mkdir -p data/cache
python -m backend.precompute                                   # simulated sites (eval + demo)
if [ -n "${REAL_CAMERAS:-}" ] && ls /config/*.config >/dev/null 2>&1; then
  # real VSS cameras stream in while the server is already up; /health shows progress
  nohup python -m backend.perception.ingest_vss --cameras "$REAL_CAMERAS" --chunks "${REAL_CHUNKS:-4}" \
    > data/cache/ingest.log 2>&1 &
fi
exec uvicorn backend.main:app --host 0.0.0.0 --port "${PORT:-8080}" --workers 1 \
  --proxy-headers --forwarded-allow-ips='*'
