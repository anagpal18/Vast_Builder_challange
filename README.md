# ALMOST: backend, perception, agents (Shresth)

Implements `SHRESTH.md` against the contracts in `MASTER.md`. Runs end to end today on a simulated dataset,
with Kenil's `memory/` package mocked until it lands.

## Run

```bash
uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python -m backend.synth.make_all          # footage + tracks + ground truth (≈30 s)
.venv/bin/uvicorn backend.main:app --port 8000      # API + mock test console at http://localhost:8000/
.venv/bin/python -m backend.evals.run_eval --label "baseline"   # Weave eval → /eval/latest
.venv/bin/pytest -q
```

Secrets live in `.env` (gitignored): `WANDB_API_KEY`, `WANDB_ENTITY`, `WANDB_PROJECT=almost`, `LLM_MODEL`.
Without a key the agents fall back to deterministic templates, so the API works with zero env vars.

## Layout

| Path | What |
|---|---|
| `backend/perception/track.py` | YOLO + ByteTrack → raw image tracks (real footage) |
| `backend/perception/calibrate.py` | homography → ground meters, Savitzky–Golay, footprint compensation, speed/heading |
| `backend/perception/summarize.py` | entry/exit leg, movement, 10 Hz paths, in-process track cache |
| `backend/perception/conflicts.py` | crossing point, PET, min TTC, conflict type, score, candidates |
| `backend/perception/whatif.py` | gap curve over ±3 s shifts, contact ranges, impact |
| `backend/perception/clips.py` | ffmpeg clip + thumb, image-space overlays |
| `backend/agents/orchestrator.py` | 8 streamed stages, one Weave trace tree per run |
| `backend/agents/patterns.py`, `recommend.py` | W&B agents + validators (template fallback) |
| `backend/memory_mock.py`, `memory_adapter.py` | mock of Kenil's API; real `memory/` is used automatically when importable |
| `backend/synth/` | simulated cameras: rendered mp4, detections, ground truth with controlled PET |
| `backend/evals/run_eval.py` | detection, PET error, verification, pattern purity, recommendation validity |
| `backend/static/mock.html` | mock frontend served at `/` (for testing; Aditya's app replaces it) |

## Decisions the team should know

- **FHWA catalog:** Bicycle Lanes, Appropriate Speed Limits and Speed Safety Cameras are no longer on FHWA's
  Proven Safety Countermeasures index (Sep 2026); their pages return 404. They are kept in
  `fhwa_countermeasures.json` with `"active": false` and never recommended. Consequence: **Site C (right hook)
  gets no recommendation** and Site D gets no speed countermeasure. Flip `active` if the team decides otherwise.
- **Footprint compensation** (calibrate.py): the box bottom-center is the footprint edge nearest the camera, not
  the vehicle center. Without the correction measured PET was ~0 for every event; with it PET MAE is ~0.12 s.
- **Verify cutoff:** top 15 by score *plus* the top 4 per site (`MIN_VERIFY_PER_SITE`), otherwise bike events
  (low TTC term) never get verified.
- **LLM:** `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B` on W&B Inference (text only; W&B rejects image input
  for it; Nemotron Ultra returns 401 for our key). Reasoning is off by default (`LLM_THINKING=1` to enable;
  it can overrun the token budget, then retries without). Every LLM output is validated: cited ids must be in
  the group, numbers must appear in the data, no collision language for near misses, catalog-only ids with name
  and URL copied from the catalog. One retry with the validator's complaint, then template.
- **WHAT-IF sign:** positive shift = the vehicle arrives *later* (`A'(t) = A(t − s)`). When the pedestrian/cyclist
  went through first, contact happens at a *negative* shift (e.g. EV_A1_0231: −0.45 s); when the car went first,
  at a positive one. Label the slider both ways; don't hard-code "drag right".
- **event_id** = `EV_{camera_id without CAM_}_{int(t_conflict*10):04d}` (MASTER's example doesn't match its formula).
- **Extra fields** beyond the contracts (safe to ignore): event `a/b.entry_leg/exit_leg/crosswalk`, `similar`,
  `found_by`; pattern `facts`, `generated_by`, `validator_note`, `recommendation_note`; camera `lighting`, `sim`.
- **Calibration PUT** accepts `{"points":[{"u","v","gx","gy"}…]}` (≥4, fitted with OpenCV) or `{"homography":…}`,
  plus optional `ground` and `camera_ground_xy`; tracks are re-projected immediately.

## For Kenil

`memory/` must expose `verify_event, store_event, store_track_summaries, similar_events, similar_chunks,
get_event, list_events` (MASTER 5). Drop the package at repo root; `MEMORY_BACKEND=mock` forces the mock.
Verify results are cached per backend in `data/cache/verify/<backend>/`; the #1 event is always verified live.
