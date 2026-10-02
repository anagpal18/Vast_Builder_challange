# AGENTS.md: ALMOST on the VAST Builders VM

Instructions for a coding agent (Cursor) working in this repo **on the team-28 workshop VM**.
Read this first, then `README.md`. Plans: `docs/MASTER.md` (team contract), `docs/SHRESTH.md` (backend scope),
`frontend/TEAM_NOTES.md` (frontend ↔ backend contract notes).

## What this is

ALMOST finds near-miss traffic conflicts in street-camera footage, measures how close they were (PET / TTC),
verifies them with NVIDIA Cosmos3-Reason, finds recurring patterns, and recommends FHWA Proven Safety
Countermeasures (catalog only) for engineer review. One FastAPI backend serves the API, the React frontend
(`frontend/dist`, prebuilt), media, and a WebSocket that streams the investigation.

Data sources:
- **Real (default on the VM):** the team's VSS archive. `backend/perception/ingest_vss.py` pulls fixed-camera
  footage (`sf_streets_cam-1..4`, `neighborhood_cam-1`) as 30 s chunks / 5 s segments + per-frame YOLO11
  sidecars, tracks them (`tracker.py`), auto-calibrates the ground plane (`autocal.py`), then the normal pipeline
  runs. Dashcam `pie_cam-3` is not usable for measurement (moving camera).
- **Simulated:** `backend/synth/` renders 4 sites with ground truth. Used only for the Weave eval
  (`backend/evals/run_eval.py`) and hidden from the UI when `DATA_MODE=real`.

## Ground rules

- **Never commit secrets.** Credentials live in `/config/team-28.config` (+ `/config/team-28-k8s.yaml`,
  `team-28-backend-secret.yaml`). Code reads them at runtime (`backend/config.py` loads the single
  `/config/*.config`). Never copy them into the repo, never print `PASSWORD`, `SECRET_KEY`, `ACCESS_KEY`,
  `GPU_BEARER_TOKEN`, `WANDB_API_KEY`. The GitHub repo is **public**.
- Stay in **team-28**'s namespace, buckets and VSS instance. Do not redeploy the VSS stack or DataEngine.
- The app must run with **one worker** (run state is in-process). Do not add `--workers`.
- Keep the API contract in `docs/MASTER.md` §4–5 and `frontend/src/types.ts`. Extra fields are fine; renaming
  or removing fields breaks the frontend.
- FHWA recommendations come **only** from `data/config/fhwa_countermeasures.json`; three entries are
  `"active": false` because FHWA retired them (Sep 2026). Don't re-enable without checking the live index.

## Do this, in order

### 1. End-to-end test on the VM (no sudo, ~5–10 min)

```bash
cd ~/almost && git pull && scripts/vm_e2e.sh
```

Installs uv + Python 3.11 + deps, ingests 1 min of real footage per camera, starts the app on `127.0.0.1:8765`
with `DATA_MODE=real`, runs a full investigation (Cosmos3-Reason verifies real clips), checks every endpoint and
the frontend, writes `e2e.json`. Success = `"summary": {"fail": []}`. Knobs: `CAMS=sf_streets_cam-4 CHUNKS=4`.

Short summary of the result:
```bash
python3 -c "import json;r=json.load(open('e2e.json'));print(json.dumps({k:r[k] for k in ('summary','checks','server_errors')},indent=1))"
```

### 2. Deploy to Kubernetes → public URL

```bash
scripts/deploy-k8s.sh            # installs kubectl to ~/.local/bin if missing, deploys, waits, prints URLs
scripts/deploy-k8s.sh status     # pods/ingress + /health (shows real-camera ingest progress)
scripts/deploy-k8s.sh logs       # follow pod logs
```

Public URLs: `http://video-lab-team-28.cosmos.vastdata.com/app/` (app) and `/app/console` (test console).
Then verify the public deployment with the same checker:
```bash
.venv/bin/python scripts/e2e_check.py --base http://video-lab-team-28.cosmos.vastdata.com/app > e2e_k8s.json
```

How the deploy works (no docker build/push; VMs can't): public `python:3.11-slim` image downloads **this
GitHub repo's `main`** at start (`REPO`/`REF` env), `pip install -r requirements.txt` (ffmpeg comes from the
`imageio-ffmpeg` wheel), mounts `/config/team-28.config` from a Secret, generates the simulated eval data, starts
real-camera ingest in the background, serves on :8080; Ingress path `/app(/|$)(.*)` on the team host with
rewrite + 1 h proxy timeouts (WebSocket). First start takes ~3–6 min. Storage is `emptyDir`: a pod restart
re-ingests.

**Code changes reach the pod only through GitHub.** Commit + push to `main` (or a branch and `REF=<branch>
scripts/deploy-k8s.sh`), then re-run `scripts/deploy-k8s.sh` (it does `rollout restart`).

### 3. Optional
- Weave eval (simulated ground truth): `.venv/bin/python -m backend.evals.run_eval --label "<what changed>"`
  → `/eval/latest`, traces in W&B (`WANDB_TEAM`/`WANDB_PROJECT` from the team config, or `.env`).
- Run the app on the VM without k8s: `DATA_MODE=real scripts/run.sh` (port from `.env`, default 8000).
- More / other footage: `.venv/bin/python -m backend.perception.ingest_vss --cameras sf_streets_cam-2 --chunks 8`.

## Facts already verified on this VM (2026-10-02, `scripts/vm_smoke.py`)

- VSS: `INGRESS_URL=http://video-lab-team-28.cosmos.vastdata.com`, login with `USERNAME`/`PASSWORD` works.
  Cameras: `i24_cam-1, neighborhood_cam-1, pie_cam-3, sdg_warehouse_cam-2, sf_streets_cam-1..4, smartspace_cam-1`.
- `GET /api/v1/videos/explore` → `{"chunks": [{original_video, chunk_duration_sec: 30, total_segments: 6,
  timeline: [...]}, ...]}`.
- `GET /api/v1/tools/segments?original_video=` → `{"segments": [{source, segment_number, segment_start_sec,
  segment_end_sec, camera_id, location, object_classes, detection_sidecar_uri, ...}]}`.
- `GET /api/v1/videos/detections?source=` → `{video_shape: [1080, 1920], fps: 30, frames: [{frame_index,
  time_sec, detections: [{label, confidence, bbox: [x1, y1, x2, y2]}]}]}`: every frame, **no track ids**.
- `POST /api/v1/search` rejects `llm_top_n: 0` (must be ≥ 1).
- GPU (`GPU_HOST=166.19.38.112`, bearer `GPU_BEARER_TOKEN`), tested through `backend/vss/gpu.py`:
  - Cosmos3-Reason :8001: model id is `nvidia/cosmos3-nano-reasoner` (discovered via `/v1/models`; don't
    hardcode). Video verify with `video_url` base64 ≈ 4 s per 12 s clip; returns parseable JSON. It reports
    UNSURE on the simulated cartoon clips (correct), so meaningful verdicts need real VSS footage.
  - Embed1 :8003: 256-d; `request_type: "query"` accepts **one input per request** (a list → 422).
  - YOLO :8002: `/healthz`; `/v1/infer` ≈ 2 s per 12 s clip, frames shaped like the VSS sidecars.
- `kubectl` is **not** preinstalled; kubeconfig is `/config/team-28-k8s.yaml` (`deploy-k8s.sh` handles both).

## Where things are

| Path | What |
|---|---|
| `backend/main.py` | API (MASTER §5), WebSocket hub, serves `frontend/dist` at `/`, console at `/console` |
| `backend/agents/orchestrator.py` | scan → measure → verify → remember → recall → pattern → recommend → report |
| `backend/agents/patterns.py`, `recommend.py`, `llm.py` | W&B Inference agents + validators (template fallback) |
| `backend/perception/conflicts.py`, `whatif.py` | PET / TTC / conflict type; WHAT-IF gap curves |
| `backend/perception/ingest_vss.py`, `tracker.py`, `autocal.py` | real VSS footage → tracks |
| `backend/memory_vss.py` | Cosmos3-Reason verify, Embed1 similarity, VSS search recall |
| `backend/memory_adapter.py` | picks `memory/` (Kenil) → `memory_vss` (team stack configured) → `memory_mock` |
| `backend/vss/client.py`, `gpu.py` | VSS REST client (JWT, re-login on 401); GPU model clients |
| `backend/config.py` | all knobs; reads `.env` then `/config/*.config`; `DATA_MODE` |
| `frontend/` | React app (Aditya). Rebuild after edits: `cd frontend && npm ci && VITE_API_BASE=same-origin npm run build`, commit `frontend/dist` |
| `scripts/` | `setup.sh`, `run.sh`, `vm_smoke.py`, `vm_e2e.sh`, `e2e_check.py`, `deploy-k8s.sh`, `k8s-entrypoint.sh` |
| `tests/` | `.venv/bin/pytest -q`: math, validators, API e2e, fake-VSS ingest deep test |

## Troubleshooting

| Symptom | Check |
|---|---|
| `ingest failed` | `tail -50 data/cache/ingest.log`; `/health` → `ingest`. 401 = credentials; empty chunks = camera id typo |
| No real cameras in the UI | footage appears in `data/footage/CAM_*.mp4` only after ingest finishes; `DATA_MODE` must be `real`/`auto` |
| Verdicts all `UNSURE` | Cosmos call failing: `GPU_BEARER_TOKEN` set? `curl -H "Authorization: Bearer $GPU_BEARER_TOKEN" http://166.19.38.112:8001/v1/models` |
| Patterns say `template` | W&B Inference failed or no key; the run still completes (validators + fallback) |
| Pod not Ready | `scripts/deploy-k8s.sh logs`; first start is slow (pip + data); `ImagePullBackOff` = cluster can't reach Docker Hub |
| `/app` loads blank | must end in `/app/` (index.html redirects); check Ingress rewrite annotation |
| No conflict types / FHWA recs on real cams | uncalibrated cams use heading-based movements; draw legs/crosswalks in the Calibrate screen (`PUT /cameras/{id}/calibration`) |

## When reporting back

Paste `e2e.json` summary (`summary`, `checks`, `server_errors`, `facts.events`, `facts.sample_verdicts`,
`facts.patterns`) and, after deploy, the printed URLs + `e2e_k8s.json` summary.
