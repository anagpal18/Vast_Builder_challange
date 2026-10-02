# ALMOST: frontend

Aditya's part of ALMOST (see `MASTER.md` and `ADITYA.md`). The screen tells the investigation as five acts:
**sweep → collapse → event theater → WHAT-IF crash → "this wasn't isolated" → recommendation**, plus a site report and a calibration tool.

```bash
cd frontend
npm install
npm run gen:mock   # first run: renders the mock footage, clips and thumbs (~1 min, needs ffmpeg on PATH)
npm run dev        # http://localhost:5173
```

The JSON mocks are committed; the rendered video and images (~110 MB) are git-ignored and come from `gen:mock`. Without them the app loads but feeds and clips are blank.

With `VITE_API_BASE` unset, the app runs entirely on the mocks in `public/mock/`. Point it at the backend with:

```bash
VITE_API_BASE=http://localhost:8000 VITE_WS_URL=ws://localhost:8000/ws npm run dev
```

## Screens

| Route | What it is |
|---|---|
| `#/` | **Act 1–2.** Wall of 11 feeds, **FIND THE ALMOSTS**, stage ribbon, racing counters, conflict markers projected onto each feed, NVIDIA verdict ticker (REJECTs struck through). On verify-done the wall collapses into ranked close-call cards; #1 opens automatically. |
| `#/event/:id` | **Act 3–5.** Clip with a synced canvas overlay (trails, boxes, conflict point, live gap line, "0.7 seconds apart" freeze), bird's-eye reconstruction, margin timeline, NVIDIA verdict panel. **WHAT-IF** slider moves a ghost car along the real path; "Show the crash" plays the simulated collision. **Has this happened before?** recalls similar events, then pattern + FHWA recommendation cards. |
| `#/report/:siteId` | Site report: map of verified events by severity, patterns, recommendations, top events. Export Markdown, Print / PDF. |
| `/calibrate/:cameraId` | Calibration: click ≥4 road points, type ground meters, homography solved client-side (reprojection error + projected 5 m grid), draw legs / crosswalks / box, `PUT /cameras/{id}/calibration`. |

The eval panel (top right) reads `/eval/latest`.

## Code map

```
src/types.ts            team contract, field names exactly as MASTER §3–5
src/data/api.ts         REST client (mock or backend), ws.ts = WebSocket / mock replay
src/store.ts            run state from WS messages + hash router
src/lib/geometry.ts     homography (apply / invert / solve from points), camera model, gaps
src/lib/whatif.ts       ghost pose, live gap, occupancy intervals, contact time
src/acts/               Sweep, Theater, Cascade, Report, Calibrate
scripts/                mock world: scene simulation, PET solver, software renderer → ffmpeg
```

## About the mock data

`scripts/gen-mock.ts` simulates 4 sites / 11 cameras (90 s each, one at night), places scenario close calls with exact target PETs plus decoys, renders the footage, and derives **every** number (overlays, PET, TTC, WHAT-IF gap curves, impact) from the same paths that are drawn, so the overlay sits on the pixels and the slider's contact point matches what you see. Camera time = `clip.t0 + video time` (clips are cut on frame boundaries without B-frames).

Contract questions and deviations for the backend are in **`TEAM_NOTES.md`** (eval shape, WHAT-IF `b` extension, impact definition, shift sign, three FHWA countermeasures missing from the live catalog).

The previous prototype (FireSight, firefighter feeds) is archived in `archive/firesight/`.
