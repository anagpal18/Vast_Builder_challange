# Shresth — Backend, Perception, Agents (W&B) + Integration

Read `MASTER.md` fully. You own the spine: **YOLO perception and closeness math**, the **investigation orchestrator**, the **W&B pattern and recommendation agents**, **Weave** tracing and evaluation, the **WHAT-IF** precomputation, and the API. You lead integration.

**You connect with:** Kenil (`memory/` package: verify, store, recall) · Aditya (REST + WebSocket; calibration tool writes your camera config).

---

## Stack
Python 3.11 · FastAPI + Uvicorn · `ultralytics` (YOLO + ByteTrack) · `opencv-python` · `numpy`, `pandas`, `pyarrow`, `scipy` · `shapely` (polygons, path intersection) · `weave`, `openai` (W&B Inference is OpenAI-compatible) · ffmpeg.

---

## 1. Perception (`backend/perception/`)

### 1.1 `track.py`: YOLO + tracking (precompute)
```python
from ultralytics import YOLO
model = YOLO(os.environ.get("YOLO_MODEL", "yolo11m.pt"))
for r in model.track(source=video, tracker="bytetrack.yaml", persist=True, stream=True,
                     classes=[0, 1, 2, 3, 5, 7], conf=0.3, iou=0.5):
    # per box: track id, class, xyxy, conf → row (MASTER 4.1)
```
- Foot point `(u, v)` = bottom center of the box.
- Write `data/tracks/<camera>.parquet`. Run all cameras before integration (GPU if available).
- Drop tracks shorter than 1 s.

### 1.2 `calibrate.py`: ground plane
- `homography` from `cameras.json` (Aditya's tool fills it): `cv2.perspectiveTransform` foot points → `(gx, gy)` meters.
- Smooth `gx, gy` per track (Savitzky–Golay, window 9, order 2), resample to **10 Hz**, compute `speed_mps`, `heading_deg`.
- If the footage comes from a simulator with known camera parameters, compute the homography from those instead (more accurate).

### 1.3 `summarize.py`: track summaries (MASTER 4.2)
- `entry_leg` / `exit_leg`: which leg polygon contains the first / last ground point.
- `movement`: vehicles → from (entry, exit) pair using a lookup table per site orientation (e.g. S→E = right_turn, S→W = left_turn, S→N = through). People/bikes inside a crosswalk polygon → `crossing`.
- Send all summaries to `memory.store_track_summaries`.

### 1.4 `conflicts.py`: closeness math
For each camera, for each pair (A, B) overlapping in time by ≥ 0.5 s where at least one is a vehicle:
1. **Crossing point P:** intersection of the two ground paths (shapely `LineString.intersection`). If none, use the closest-approach point if it's < 2.0 m.
2. **Occupancy radius:** person 0.35 m, bicycle/motorcycle 0.8 m, car 2.3 m, bus/truck 4.0 m.
3. For each road user: `t_enter`, `t_exit` = first/last time its center is within its radius + 0.5 m of P.
4. **PET** = `t_enter(second) − t_exit(first)` (clamp ≥ 0); `first_through` = who left first. If their occupancy intervals overlap → PET 0 (contact).
5. **Min TTC:** at each 0.1 s step, project both at constant velocity; time until distance ≤ sum of radii; take the minimum (ignore if diverging).
6. **conflict_type:** from classes + movements (MASTER 4.3 list). Angle/rear-end for vehicle pairs from heading difference (> 45° angle, < 20° same direction = rear-end).
7. Candidate if thresholds (MASTER 4.6). Score, severity, `t_conflict` = time the second user enters P.
8. Clip: `t0 = t_conflict − 6`, `t1 = t_conflict + 6`; cut with ffmpeg to `data/clips/<event_id>.mp4` + thumbnail.
9. `overlay` for the UI: image-space `[t, u, v, x1, y1, x2, y2]` of A and B for the clip window.
- `event_id = f"EV_{camera_short}_{int(t_conflict*10):04d}"`.

### 1.5 `whatif.py`: crash simulation curves (MASTER 4.4)
- Shift actor = the vehicle (A). For shift `s` in −3…+3 s (step 0.05): A'(t) = A(t − s). Over the overlap window, compute **minimum gap** = distance between B's circle and A's oriented rectangle (4.5×1.8 m car; use shapely polygons) minus B's radius.
- `gap_curve`, `contact_ranges` (where gap ≤ 0), `first_contact_shift_s` (smallest |s| with contact), `impact` (time, point, A speed at that shift).
- Include `image_paths` and `homography_inv` so the frontend can draw a ghost vehicle on the real video.
- Always include the disclaimer string.

---

## 2. Agents (`backend/agents/`, W&B Inference + Weave)

```python
import weave, openai, os
weave.init(f"{os.environ['WANDB_ENTITY']}/{os.environ['WANDB_PROJECT']}")
llm = openai.OpenAI(base_url="https://api.inference.wandb.ai/v1",
                    api_key=os.environ["WANDB_API_KEY"],
                    project=f"{os.environ['WANDB_ENTITY']}/{os.environ['WANDB_PROJECT']}")
```
Confirm base URL + model ids at the event. Every step below is `@weave.op`, so a run is one trace tree.

### 2.1 `orchestrator.py`: the investigation (stages stream over WebSocket, MASTER 5)
```
investigate(site_ids):
  scan       → load tracks + summaries, emit counts
  measure    → conflicts.py → candidates (emit run.candidate for top 30)
  verify     → memory.verify_event on top 15 by score (parallel) → status verified / rejected / unsure (emit run.verified)
  remember   → memory.store_event for all
  recall     → for each verified event: memory.similar_events → link; memory.similar_chunks(description) → if a chunk window has tracks not yet paired, re-run conflicts on that window (emit run.similar)
  pattern    → patterns.py
  recommend  → recommend.py
  report     → assemble per site
```
- Counters (`video_minutes`, `road_users`, `interactions`, …) update during each stage for the UI.
- Precomputed caches (tracks, verify results) make this run in < 60 s. Don't fake stage timing; it should be genuinely fast.

### 2.2 `patterns.py`
1. Deterministic grouping: verified events by `site_id + conflict_type + (a.movement, entry leg)`; merge in VAST-recalled similar events with score > 0.8 and same conflict type.
2. W&B model writes `signature` + `summary` from the group (events as a numbered list with PET, times, factors, conditions). Rules: cite event ids for every statement; numbers only from the data given; ≤ 60 words.
3. Validate cited ids ∈ group.

### 2.3 `recommend.py` (FHWA only)
1. Load `data/config/fhwa_countermeasures.json` (MASTER 7). Candidates = catalog entries whose `addresses` include the pattern's conflict type or conditions (night → Lighting; speeds above limit → speed countermeasures).
2. W&B model chooses 1–3 **from the candidate list only**, returning `countermeasure_id`, `why` (citing event ids and observed facts like "pedestrian already in crosswalk in 3 of 4"), `review_note`.
3. Validator: id must exist in catalog; copy `name` + `url` **from the catalog, never from the model**; cited events must belong to the pattern; drop anything failing.
4. Startup check: request each catalog URL, log any non-200 so we fix slugs before the demo.

### 2.4 `fhwa_countermeasures.json`
Build from the FHWA Proven Safety Countermeasures index (`https://highways.dot.gov/safety/proven-safety-countermeasures`). Known-good example: `https://highways.dot.gov/safety/proven-safety-countermeasures/leading-pedestrian-interval`. Copy the other URLs **from the index page**, don't guess slugs. `summary_in_our_words` = one sentence each, written by us.

---

## 3. API (`backend/main.py`)
Exactly MASTER section 5. Notes:
- `/investigate` starts the orchestrator as a background task, returns `run_id` immediately.
- `/events/{id}` adds `overlay`; `/events/{id}/whatif` from `whatif.py` (cache per event).
- `/report/{site_id}.md`: Markdown with patterns, recommendations (name, FHWA link, why, cited events with timestamps), disclaimer: "Generated from simulated footage for demonstration. Recommendations are for traffic engineer review."
- Mount `data/` at `/media`. CORS for the frontend. WebSocket broadcast manager.

## 4. Evaluation (`backend/evals/run_eval.py`, Weave)
Dataset = `data/ground_truth/events.json`. Scorers (each `@weave.op`):
- `detection` → recall / precision (match: same camera, ±1.5 s, same class pair)
- `pet_error` → |our PET − true PET| (simulator truth)
- `verification_accuracy` → verdict vs `is_conflict` (decoys must be REJECT)
- `pattern_purity` → share of events in each pattern with the true conflict type
- `recommendation_validity` → 100% catalog, URL 200, mapping matches MASTER 7
Write `data/ground_truth/eval_latest.json` → `/eval/latest` with Weave URL. Run, fix the worst issue, re-run; show before/after if you can.

## 5. Mocks
Until Kenil's package works: `memory_mock.py` (verify = ACCEPT for real scenarios, REJECT for decoys from ground truth; similar = same conflict type). Give Aditya mock API responses in Block 1.

---

## Checklist
- [ ] YOLO tracks for all cameras
- [ ] Calibration → ground paths, speeds, headings
- [ ] Summaries + movements
- [ ] PET / TTC / conflict types / candidates / clips / overlays
- [ ] WHAT-IF curves
- [ ] Orchestrator streaming all stages
- [ ] Pattern + FHWA recommendation agents with validators
- [ ] Catalog URLs verified
- [ ] API complete, Aditya connected
- [ ] Weave eval run, numbers in UI
- [ ] Two full demo runs

## Sync points
| When | With | What |
|---|---|---|
| Start | Kenil, Aditya | Contracts (MASTER 3–5); calibration format |
| Block 1 | Aditya | Mock API + WebSocket |
| Block 2 | Kenil | Candidate events → verification |
| Block 3 | Aditya | Real `/events`, `/whatif`, overlays |
| Block 4 | All | Integration + eval |
