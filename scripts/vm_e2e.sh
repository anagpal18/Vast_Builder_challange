#!/usr/bin/env bash
# Full end-to-end test ON THE WORKSHOP VM against the team's real VSS archive + GPU models.
#   scripts/vm_e2e.sh                       # 4 SF street cams + neighborhood cam, 2 chunks (1 min) each
#   CAMS=sf_streets_cam-4 CHUNKS=4 scripts/vm_e2e.sh
# Installs (no sudo needed), ingests real footage, starts the app on :8765, runs an investigation with
# Cosmos3-Reason verifying the real clips, checks every endpoint + the frontend, prints e2e.json.
set -euo pipefail
cd "$(dirname "$0")/.."
CAMS="${CAMS:-sf_streets_cam-1,sf_streets_cam-2,sf_streets_cam-3,sf_streets_cam-4,neighborhood_cam-1}"
CHUNKS="${CHUNKS:-2}"
PORT_E2E="${PORT_E2E:-8765}"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }

say "1/4 install (uv + Python 3.11 + deps, simulated eval data)"
SKIP_TESTS=1 scripts/setup.sh >&2

say "2/4 ingest real footage from VSS: $CAMS ($CHUNKS x 30 s each)"
.venv/bin/python -m backend.perception.ingest_vss --cameras "$CAMS" --chunks "$CHUNKS" 2> data/cache/ingest.log \
  || { tail -30 data/cache/ingest.log >&2; echo "ingest failed (see data/cache/ingest.log)" >&2; }
tail -5 data/cache/ingest.log >&2

say "3/4 start the app on :$PORT_E2E (DATA_MODE=real)"
DATA_MODE=real .venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port "$PORT_E2E" > data/cache/e2e_server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT_E2E/health" >/dev/null && break; sleep 1; done

say "4/4 end-to-end checks (investigation with Cosmos3-Reason on real clips)"
set +e
.venv/bin/python scripts/e2e_check.py --base "http://127.0.0.1:$PORT_E2E" > e2e.json
rc=$?
set -e
python3 - <<'PY'
import json, re
r = json.load(open("e2e.json"))
log = open("data/cache/e2e_server.log").read()
r["server_errors"] = [l[:240] for l in log.splitlines() if re.search(r"ERROR|Traceback|Exception", l)][-12:]
json.dump(r, open("e2e.json", "w"), indent=1)
print(json.dumps(r, indent=1))
PY
say "done: paste e2e.json back (exit $rc). App still runnable with: DATA_MODE=real scripts/run.sh"
exit $rc
