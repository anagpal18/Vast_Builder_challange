# Team notes from the frontend (Aditya)

Things the frontend assumes or found that differ from `MASTER.md`. Bring these to the next sync.

## For Shresth (API / WHAT-IF / catalog)

1. **`/eval/latest` shape is not in MASTER.** The frontend reads `EvalResult` in `src/types.ts`:
   `{detection:{recall,precision}, measurement:{pet_mae_s}, verification:{accuracy,decoys_rejected}, patterns:{purity}, recommendations:{from_catalog,urls_valid,claims_cited}, weave_url, run_at}`. Change either side, but agree on it.
2. **WHAT-IF `b` extension (backwards compatible).** `b.path` rows may carry heading as a 4th value `[t, gx, gy, heading_deg]`, and `b.dims_m` is present when B is a vehicle (left-turn vs oncoming). Without it a car is drawn as a circle.
3. **`impact` definition.** Mock uses the contact just past `first_contact_shift_s` (0.15 s deeper, inside the contact range), not the deepest overlap. Deepest overlap sits 1–1.5 s away from first contact, which made the slider snap point and the crash banner disagree.
4. **Sign of the shift.** `shift_s` = how much *later* actor A arrives (negative = earlier). For events where the pedestrian went first, contact is at a negative shift, so the UI says "earlier". The MASTER 4.4 example (first_through `b`, contact at +0.55) can't happen with that convention; check yours.
5. **PET uses a conflict zone, not a bare point.** Mock occupancy = body within the other road user's half-width of the crossing point. With a bare point, PET 0.7 s still had bodies overlapping (car is 1.8 m wide).
6. **FHWA catalog: three MASTER §7 entries are not on the live FHWA list** (checked 2026-10-02, every slug variant returned 404): *Bicycle Lanes*, *Appropriate Speed Limits for All Road Users*, *Speed Safety Cameras*. Verified slugs (HTTP 200): `leading-pedestrian-interval`, `crosswalk-visibility-enhancements`, `rectangular-rapid-flashing-beacons-rrfb`, `pedestrian-hybrid-beacons`, `medians-and-pedestrian-refuge-islands-urban-and-suburban-areas`, `dedicated-left-and-right-turn-lanes-intersections`, `reduced-left-turn-conflict-intersections`, `roundabouts`, `lighting`, `backplates-retroreflective-borders`, `yellow-change-intervals`. The right-hook pattern (Site C) currently has **no** catalog match; the UI shows "no FHWA catalog match, flagged for engineer review" instead of inventing a link.
7. **Crash comparison clip.** Frontend loads `/media/footage/CRASH_A.mp4` from the backend (mock: `/mock/footage/CRASH_A.mp4`).
8. **Clip timing.** The overlay maps camera time = `clip.t0 + mediaTime` (decoder pts via requestVideoFrameCallback). A constant start offset in the clip is fine; what breaks sync is cutting off a frame boundary, so cut clips on frame boundaries.
9. **Markdown export download.** `<a download>` is ignored cross-origin, so against a backend on another port "Export Markdown" opens the raw `.md`. Send `Content-Disposition: attachment` from `/report/{site_id}.md` and it downloads.

## For Kenil

- `clip.url` / `clip.thumb` are used as-is when absolute, else prefixed with `VITE_API_BASE`.

## Mock data

`npm run gen:mock` regenerates `public/mock/` (footage, clips, thumbs and all JSON) from one simulated world, so overlays, WHAT-IF curves and PET agree with the pixels. See `scripts/`.
