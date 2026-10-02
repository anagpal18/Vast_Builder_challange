# Aditya — Frontend: the Investigation, the Proof, the Simulation

Read `MASTER.md` sections 1–5 and 12 first. You own **what makes judges lean in**. The screen is not a dashboard; it's a story the agent tells in 5 acts: **sweep → collapse → event theater → what-if crash → "this wasn't isolated" → recommendation**. Every number on screen links to video.

**You connect with:** Shresth (all data via REST + WebSocket; calibration saves to his API) · Kenil (clip / thumb URLs).

## Stack

React + Vite + TypeScript · Tailwind · Framer Motion · HTML `<video>` + `<canvas>` overlays · SVG for the bird's-eye view · Zustand store.

---

## Act 1: The Sweep (home screen)

- **Wall of 10–12 feeds** (all cameras; loop videos muted). Site labels on each tile.
- Giant button **FIND THE ALMOSTS** → `POST /investigate`.
- **Stage ribbon** across the top from WebSocket `run.stage`: Scan → Measure → Verify → Remember → Recall → Pattern → Recommend → Report, the current stage glowing.
- **Racing counters** (`counts`): minutes of video scanned, road users tracked, interactions measured, candidates, verified, rejected.
- During _measure_: tiles get faint trajectory scribbles (draw a few `run.candidate` overlays), then dim.
- During _verify_: a **verdict ticker** (NVIDIA): `EV_A1_0041 ACCEPT — driver didn't yield`, `EV_B1_0090 REJECT — pedestrian waiting at curb`. REJECTs shown in gray, struck through. This is our "we don't trust geometry alone" moment.

## Act 2: The Collapse

- When verify finishes, all tiles shrink away and **verified close calls fly in as ranked cards** (thumbnail, site, conflict type in plain words like "Turning car vs pedestrian", **margin bar** showing PET from 0 to 3 s, severity color).
- #1 card auto-expands into the Event Theater after 1.5 s (demo flow), or click any card.

## Act 3: Event Theater (fullscreen)

Left (big): **real video** (`clip.url`) with a `<canvas>` overlay synced via `requestVideoFrameCallback`:

- Trails of A (vehicle) and B (person/bike) from `overlay` points, drawn progressively up to current time; boxes on current positions.
- Conflict point marker; a **live gap line** between A and B with the distance label.
- At `t_conflict`, freeze 1 s with a pulse and the label **"0.7 seconds apart"**.

Right: **bird's-eye reconstruction** (SVG, ground meters from `/whatif` paths + camera `ground` polygons): crosswalks, legs, A as a rectangle rotated by heading, B as a circle, both animated in sync with the video. Same conflict point.

Bottom: **margin timeline**: A's occupancy interval and B's occupancy interval at the conflict point as two bars on a time axis; the gap between them is the PET, labeled.

Side panel: **NVIDIA verdict** (ACCEPT badge, reason, description, contributing factors, conditions), measured facts (speeds in mph, PET, min TTC), "Verified by NVIDIA Cosmos · Tracked by YOLO · Stored in VAST".

## Act 4: WHAT-IF crash simulation (from `GET /events/{id}/whatif`)

- Slider **−3 s … +3 s**, label: "What if the driver had arrived \_\_ s later?". Snap marker at `first_contact_shift_s`.
- On change, look up `gap_curve` (instant, no backend call) and re-render:
  - Bird's-eye: **ghost car** (translucent) moving along A's path shifted in time; real car faint.
  - Video overlay: ghost box/trajectory projected with `homography_inv` (ground → image) over the real clip.
  - Gap readout updates live; color goes green → amber → red as gap shrinks.
- When gap ≤ 0 (inside `contact_ranges`): **crash simulation**: playback slows, the ghost car meets B at `impact.point`, red impact burst, screen shake (subtle), banner **"Collision at +0.55 s · 14 mph"**. Then a calm line: "They made it home with 0.7 seconds to spare."
- Always show the disclaimer from the payload in small text under the slider.
- Optional toggle: "Show the simulated crash clip" plays the one real simulated crash for comparison.

## Act 5: "This wasn't isolated" → Pattern → Recommendation

- Button / auto after WHAT-IF: **"Has this happened before?"** → `GET /events/{id}/similar` (VAST recall) → similar events **cascade in** from the edges as mini video cards with times and cameras, drawing lines to the current one.
- They stack into a **Pattern card** (`/patterns/{id}`): signature in plain words, count, worst / median margin, day vs night, summary text with event chips (click → theater).
- Below: **Recommendation cards**, one per FHWA countermeasure:
  - Title (e.g. Leading Pedestrian Interval), badge **"FHWA Proven Safety Countermeasure"**, link (opens FHWA page)
  - "Why here": the `why` text with clickable event chips
  - Footer: `review_note` ("Suggested for traffic engineer review")
- Never render a recommendation without its FHWA link.

## Site Report

- Per site (`/report/{site_id}`): map-like header (bird's-eye of the intersection with all verified events as dots colored by severity), patterns, recommendations, top events with thumbnails, disclaimer. **Export** button → downloads `/report/{site_id}.md`, and a print stylesheet so "Print to PDF" looks clean.

## Eval panel (small, corner)

`GET /eval/latest`: detection recall / precision, PET error (s), verification accuracy, pattern purity, recommendation validity, link "Open in Weave". Style it like an instrument cluster, not debug text.

## Calibration tool (needed early, small)

Route `/calibrate/:cameraId`: shows a video frame; you click ≥4 points on the road and type their ground coordinates (meters) → compute homography client-side (or send point pairs) → draw leg and crosswalk polygons on the ground view → `PUT /cameras/{id}/calibration`. Shresth needs this in Block 1 unless footage comes with simulator camera parameters.

---

## Data wiring

```ts
const API = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
const WS = import.meta.env.VITE_WS_URL ?? "ws://localhost:8000/ws";
// Load: GET /config, GET /eval/latest
// WS: run.stage | run.candidate | run.verified | run.similar | run.pattern | run.recommendation | run.done
// Theater: GET /events/{id} (with overlay) + GET /events/{id}/whatif
```

Types exactly as MASTER section 4. **Start with `mock/` JSON** for 3 events, 1 pattern, 2 recommendations, 1 WHAT-IF payload, and a fake WebSocket that replays a run, so you never wait on the backend.

### Ground ↔ image math (for the ghost overlay)

```ts
// p = H_inv · [gx, gy, 1];  u = p0/p2, v = p1/p2   (H_inv from whatif payload)
```

Scale canvas to the video's displayed size (`video.clientWidth / video.videoWidth`).

## Visual rules

- Dark UI, one accent per severity (severe red, moderate amber, low blue); verified = solid, rejected = gray.
- Motion only with meaning: trails draw, cards fly, margin shrinks, impact bursts.
- Big readable numbers from the back of the room (PET, mph, counts).
- Plain words everywhere: "Turning car vs pedestrian", "0.7 seconds apart", never raw type ids.
- Test at 1920×1080 on the projector.

## Checklist

- [ ] Mock data + fake WebSocket replay
- [ ] Calibration tool
- [ ] Sweep: wall, button, stage ribbon, counters, verdict ticker
- [ ] Collapse → ranked cards with margin bars
- [ ] Theater: synced overlay, bird's-eye, margin timeline, verdict panel
- [ ] WHAT-IF slider, ghost car (both views), crash simulation
- [ ] Similar cascade → pattern card → FHWA recommendation cards
- [ ] Site report + export + print style
- [ ] Eval panel
- [ ] Two full runs on real data at projector resolution

## Sync points

| When    | With    | What                                                     |
| ------- | ------- | -------------------------------------------------------- |
| Start   | Shresth | Types, WebSocket messages, calibration format            |
| Block 1 | Shresth | Calibration tool working for his first camera            |
| Block 3 | Shresth | Real overlays + WHAT-IF payloads                         |
| Block 3 | Kenil   | Similar-events cascade                                   |
| Block 4 | All     | Full runs; tune animation timing to real stage durations |
