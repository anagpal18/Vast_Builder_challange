// Generates every mock the frontend needs, from one simulated world:
//   public/mock/config.json, events.json, events/<id>.json, whatif/<id>.json,
//   similar/<id>.json, patterns.json, reports/<site>.json|.md, eval.json, run.json,
//   footage/<cam>.mp4, clips/<id>.mp4, thumbs/<id>.jpg, footage/CRASH_A.mp4
//
//   node scripts/gen-mock.ts              # everything
//   node scripts/gen-mock.ts --no-video   # JSON only (fast)
//   node scripts/gen-mock.ts --only=CAM_A1

import fs from 'node:fs'
import path from 'node:path'
import { applyH, cameraModel } from '../src/lib/geometry.ts'
import type {
  AlmostEvent, Camera, ConflictType, EvalResult, EventDetail, OverlayRow, Pattern, Pt, Recommendation,
  RunCounts, Severity, SimilarEvent, Site, SiteReport, Verdict, Verification, WhatIf, WsMessage,
} from '../src/types.ts'
import {
  CW_MID, MOVES, ROAD_HALF, SIDEWALK, crossingPoint, gapAB, gapCurve, groundFor, line, measure, mulberry32, parkedActor,
  pathActor, radiusOf, resetIds, rot, solveStart, DIMS, type Actor, type CameraDef, type Layout, type Measure, type State,
} from './scene.ts'
import { FPS, H, W, ffmpeg, imageBox, renderBackground, renderVideo } from './render.ts'

const OUT = path.resolve('public/mock')
const DURATION = 90
const args = process.argv.slice(2)
const NO_VIDEO = args.includes('--no-video')
const ONLY = args.find((a) => a.startsWith('--only='))?.slice(7)

// ---- sites + cameras -----------------------------------------------------------------

const SITES: (Site & { layout: Layout; night: boolean })[] = [
  { site_id: 'SITE_A', name: '5th & Market (simulated)', camera_ids: ['CAM_A1', 'CAM_A2', 'CAM_A3'], speed_limit_mph: 25, signalized: true, layout: 'intersection', night: false },
  { site_id: 'SITE_B', name: 'Alameda & 12th (simulated)', camera_ids: ['CAM_B1', 'CAM_B2', 'CAM_B3'], speed_limit_mph: 30, signalized: true, layout: 'intersection', night: false },
  { site_id: 'SITE_C', name: 'Harbor Blvd & Pine (simulated)', camera_ids: ['CAM_C1', 'CAM_C2', 'CAM_C3'], speed_limit_mph: 25, signalized: true, layout: 'intersection', night: false },
  { site_id: 'SITE_D', name: 'Mission St mid-block (simulated)', camera_ids: ['CAM_D1', 'CAM_D2'], speed_limit_mph: 25, signalized: false, layout: 'midblock', night: true },
]

const CAM_POSES: Record<string, { label: string; pos: [number, number, number]; target: [number, number, number] }> = {
  CAM_A1: { label: 'NE corner looking SW', pos: [24, 22, 11], target: [3, -1.5, 0] },
  CAM_A2: { label: 'SW corner looking NE', pos: [-20, -26, 12], target: [4, -1, 0] },
  CAM_A3: { label: 'East mast looking west', pos: [34, -6, 13], target: [3, -1, 0] },
  CAM_B1: { label: 'SW corner looking NE', pos: [-24, -22, 12], target: [-1, 0, 0] },
  CAM_B2: { label: 'SE corner looking NW', pos: [24, -22, 11], target: [-1, 0, 0] },
  CAM_B3: { label: 'North mast looking south', pos: [-6, 32, 13], target: [-1, -1, 0] },
  CAM_C1: { label: 'SE corner looking NW', pos: [22, -26, 10], target: [3, -2, 0] },
  CAM_C2: { label: 'SW corner looking NE', pos: [-20, -22, 12], target: [3, -1, 0] },
  CAM_C3: { label: 'East mast looking SW', pos: [28, 10, 12], target: [3, -2, 0] },
  CAM_D1: { label: 'North side looking SE', pos: [-24, 16, 9], target: [0, -1, 0] },
  CAM_D2: { label: 'South side looking NW', pos: [22, -15, 10], target: [0, -1, 0] },
}

function cameraDef(site: (typeof SITES)[number], id: string): CameraDef {
  const p = CAM_POSES[id]
  return {
    camera_id: id,
    site_id: site.site_id,
    label: p.label,
    layout: site.layout,
    night: site.night,
    pos: p.pos,
    model: cameraModel({ pos: p.pos, target: p.target, focal_px: 700, width: W, height: H }),
  }
}

// ---- scenarios ------------------------------------------------------------------------

type Kind = 'ped_rt' | 'left_oncoming' | 'right_hook' | 'midblock'
interface Scenario {
  kind: Kind
  t: number
  pet: number
  first: 'a' | 'b'
  verdict: Verdict
  dir?: 1 | -1
  van?: boolean
}

const SCHEDULE: Record<string, Scenario[]> = {
  CAM_A1: [
    { kind: 'ped_rt', t: 22, pet: 0.7, first: 'b', verdict: 'ACCEPT', dir: 1 },
    { kind: 'ped_rt', t: 58, pet: 1.2, first: 'b', verdict: 'ACCEPT', dir: -1, van: true },
  ],
  CAM_A2: [
    { kind: 'ped_rt', t: 30, pet: 1.5, first: 'a', verdict: 'ACCEPT', dir: 1 },
    { kind: 'ped_rt', t: 66, pet: 2.6, first: 'a', verdict: 'REJECT', dir: -1 },
  ],
  CAM_A3: [
    { kind: 'ped_rt', t: 25, pet: 0.9, first: 'b', verdict: 'ACCEPT', dir: -1 },
    { kind: 'ped_rt', t: 61, pet: 1.9, first: 'b', verdict: 'UNSURE', dir: 1 },
  ],
  CAM_B1: [
    { kind: 'left_oncoming', t: 24, pet: 0.9, first: 'b', verdict: 'ACCEPT' },
    { kind: 'left_oncoming', t: 62, pet: 1.4, first: 'a', verdict: 'ACCEPT' },
  ],
  CAM_B2: [{ kind: 'left_oncoming', t: 40, pet: 1.8, first: 'a', verdict: 'ACCEPT' }],
  CAM_B3: [{ kind: 'left_oncoming', t: 35, pet: 2.7, first: 'b', verdict: 'REJECT' }],
  CAM_C1: [
    { kind: 'right_hook', t: 28, pet: 0.6, first: 'a', verdict: 'ACCEPT' },
    { kind: 'right_hook', t: 64, pet: 2.5, first: 'a', verdict: 'REJECT' },
  ],
  CAM_C2: [{ kind: 'right_hook', t: 38, pet: 1.1, first: 'a', verdict: 'ACCEPT' }],
  CAM_C3: [{ kind: 'right_hook', t: 46, pet: 1.6, first: 'a', verdict: 'ACCEPT' }],
  CAM_D1: [
    { kind: 'midblock', t: 26, pet: 0.8, first: 'b', verdict: 'ACCEPT' },
    { kind: 'midblock', t: 63, pet: 1.3, first: 'a', verdict: 'ACCEPT' },
  ],
  CAM_D2: [
    { kind: 'midblock', t: 33, pet: 2.1, first: 'b', verdict: 'ACCEPT' },
    { kind: 'midblock', t: 68, pet: 2.8, first: 'a', verdict: 'REJECT' },
  ],
}

const CONFLICT: Record<Kind, ConflictType> = {
  ped_rt: 'ped_vs_right_turn',
  left_oncoming: 'veh_left_turn_vs_through',
  right_hook: 'bike_vs_right_turn',
  midblock: 'ped_vs_through',
}

const CAR_COLORS: [number, number, number][] = [
  [160, 164, 170], [40, 42, 48], [200, 200, 204], [130, 24, 30], [30, 60, 120], [70, 90, 80], [190, 150, 60], [90, 94, 100], [220, 220, 216],
]
const SHIRTS: [number, number, number][] = [[200, 60, 50], [40, 110, 190], [230, 190, 60], [60, 150, 90], [150, 70, 160], [230, 120, 40], [220, 220, 220]]

type PathA = ReturnType<typeof pathActor>

function buildScenario(sc: Scenario, rand: () => number) {
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
  let A: PathA
  let B: PathA
  const extras: Actor[] = []
  if (sc.kind === 'ped_rt') {
    A = pathActor({ cls: 'car', pts: MOVES.right(), speed: 6.2 + rand() * 0.8, t0: 0, color: pick(CAR_COLORS), movement: 'right_turn' })
    const y0 = -(SIDEWALK) * (sc.dir ?? 1)
    const pts = line([CW_MID, y0], [CW_MID, -y0])
    const speed = 1.3 + rand() * 0.25
    const p = crossingPoint(A.path.pts, pts)
    const tAt = Math.abs(p[1] - y0) / speed
    B = pathActor({ cls: 'person', pts, speed, t0: sc.t - tAt, color: pick(SHIRTS), movement: 'crossing' })
    if (sc.van) extras.push(parkedActor('truck', { x: 17, y: -ROAD_HALF + 1.4, hdg: 0 }, [235, 235, 232], DIMS.van))
  } else if (sc.kind === 'left_oncoming') {
    A = pathActor({ cls: 'car', pts: MOVES.left(), speed: 7.2 + rand() * 0.8, t0: 0, color: pick(CAR_COLORS), movement: 'left_turn' })
    const pts = rot(MOVES.through(), 2)
    const speed = 11.5 + rand() * 1.5
    const p = crossingPoint(A.path.pts, pts)
    const tAt = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) / speed
    B = pathActor({ cls: 'car', pts, speed, t0: sc.t - tAt, color: pick(CAR_COLORS), movement: 'through' })
  } else if (sc.kind === 'right_hook') {
    A = pathActor({ cls: 'car', pts: MOVES.right(), speed: 6.4 + rand() * 0.8, t0: 0, color: pick(CAR_COLORS), movement: 'right_turn' })
    const pts = MOVES.bikeThrough()
    const speed = 5.0 + rand() * 0.6
    const p = crossingPoint(A.path.pts, pts)
    const tAt = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) / speed
    B = pathActor({ cls: 'bicycle', pts, speed, t0: sc.t - tAt, color: pick(SHIRTS), movement: 'through' })
  } else {
    A = pathActor({ cls: 'car', pts: rot(MOVES.through(), 3), speed: 16 + rand() * 1.5, t0: 0, color: pick(CAR_COLORS), movement: 'through' })
    const pts = line([0, -SIDEWALK], [0, SIDEWALK])
    const speed = 1.3 + rand() * 0.2
    const p = crossingPoint(A.path.pts, pts)
    const tAt = Math.abs(p[1] + SIDEWALK) / speed
    B = pathActor({ cls: 'person', pts, speed, t0: sc.t - tAt, color: pick(SHIRTS), movement: 'crossing' })
  }
  const p = crossingPoint(A.path.pts, B.path.pts)
  const m = solveStart(A, B, p, sc.pet, sc.first)
  return { A, B, p, m, extras }
}

// ---- background traffic ------------------------------------------------------------------

function backgroundTraffic(layout: Layout, siteId: string, rand: () => number, existing: Actor[], protectedIds: Set<number>) {
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
  const actors: Actor[] = []
  const all = () => [...existing, ...actors]
  const ok = (c: Actor) => {
    for (const o of all()) {
      const t0 = Math.max(c.tStart, o.tStart, -2)
      const t1 = Math.min(c.tEnd, o.tEnd, DURATION + 2)
      if (t1 <= t0) continue
      const strict = protectedIds.has(o.id)
      for (let t = t0; t <= t1; t += 0.2) {
        const s1 = c.stateAt(t), s2 = o.stateAt(t)
        if (!s1 || !s2) continue
        const d = Math.hypot(s1.x - s2.x, s1.y - s2.y)
        if (d > 14) continue
        let gap: number
        if (c.kind === 'person' && o.kind === 'person') gap = d - 0.9
        else if (c.kind === 'vehicle' || c.kind === 'bike') gap = gapAB(c, s1, o, s2)
        else gap = gapAB(o, s2, c, s1)
        if (gap < (strict ? 5 : c.kind === 'person' && o.kind === 'person' ? 0 : 1.6)) return false
      }
    }
    return true
  }
  for (let i = 0; i < 260; i++) {
    const t0 = -8 + rand() * (DURATION + 8)
    const r = rand()
    let c: Actor
    if (layout === 'midblock') {
      if (r < 0.7) {
        const k = pick([1, 3])
        const truck = rand() < 0.12
        c = pathActor({ cls: truck ? 'truck' : 'car', pts: rot(MOVES.through(), k), speed: 11 + rand() * 4, t0, color: pick(CAR_COLORS), movement: 'through' })
      } else {
        const side = pick([-1, 1]) * (SIDEWALK - 0.8)
        const dir = pick([-1, 1])
        c = pathActor({ cls: 'person', pts: line([-40 * dir, side], [40 * dir, side]), speed: 1.2 + rand() * 0.4, t0, color: pick(SHIRTS), movement: 'unknown' })
      }
    } else if (r < 0.62) {
      const k = Math.floor(rand() * 4)
      const mv = rand()
      const movement = mv < 0.6 ? 'through' : mv < 0.8 ? 'right_turn' : 'left_turn'
      const pts = rot(movement === 'through' ? MOVES.through() : movement === 'right_turn' ? MOVES.right() : MOVES.left(), k)
      const bus = rand() < 0.06
      const truck = !bus && rand() < 0.1
      c = pathActor({ cls: bus ? 'bus' : truck ? 'truck' : 'car', pts, speed: movement === 'through' ? 9.5 + rand() * 3.5 : 6 + rand() * 1.5, t0, color: bus ? [210, 160, 40] : pick(CAR_COLORS), movement })
    } else if (r < 0.9) {
      // Pedestrian on a crosswalk or along a sidewalk.
      const k = Math.floor(rand() * 4)
      const dir = pick([-1, 1])
      const pts = rand() < 0.55 ? rot(line([CW_MID, -SIDEWALK * dir], [CW_MID, SIDEWALK * dir]), k) : rot(line([SIDEWALK, -40 * dir], [SIDEWALK, 40 * dir]), k)
      c = pathActor({ cls: 'person', pts, speed: 1.15 + rand() * 0.4, t0, color: pick(SHIRTS), movement: 'crossing' })
    } else {
      const k = siteId === 'SITE_C' ? pick([0, 0, 2]) : Math.floor(rand() * 4)
      c = pathActor({ cls: 'bicycle', pts: rot(MOVES.bikeThrough(), k), speed: 4.5 + rand() * 1.2, t0, color: pick(SHIRTS), movement: 'through' })
    }
    if (c.tEnd < 0 || c.tStart > DURATION) continue
    if (ok(c)) actors.push(c)
  }
  return actors
}

// ---- text ---------------------------------------------------------------------------------

const PLAIN: Record<ConflictType, string> = {
  ped_vs_right_turn: 'Right-turning car vs pedestrian',
  ped_vs_left_turn: 'Left-turning car vs pedestrian',
  ped_vs_through: 'Through car vs crossing pedestrian',
  bike_vs_right_turn: 'Right-turning car vs cyclist',
  bike_vs_through: 'Car vs cyclist',
  veh_left_turn_vs_through: 'Left-turning car vs oncoming car',
  veh_angle: 'Angle conflict between cars',
  veh_rear_end: 'Rear-end conflict',
  other: 'Other conflict',
}

function verificationFor(sc: Scenario, m: Measure, colorName: string): Verification {
  const night = sc.kind === 'midblock'
  const conditions = { lighting: night ? 'night' as const : 'day' as const, weather: 'clear', visibility_issue: !!sc.van || night || sc.verdict === 'UNSURE' }
  const base = { model: 'cosmos-reason', conditions }
  const pet = m.pet.toFixed(1)
  if (sc.verdict === 'REJECT') {
    const reasons: Record<Kind, string> = {
      ped_rt: 'Pedestrian stepped off the curb only after the turning car had cleared the crosswalk; normal interaction, no evasive action.',
      left_oncoming: 'Turning driver waited for the oncoming car to pass, then turned through an ordinary gap.',
      right_hook: 'Cyclist eased off and passed well behind the turning car; no evasive action by either party.',
      midblock: 'Pedestrian waited on the curb until the car had passed, then crossed. No conflict.',
    }
    return { ...base, verdict: 'REJECT', reason: reasons[sc.kind], description: `Geometry flagged a ${pet}s margin, but the video shows a routine, controlled interaction.`, contributing_factors: [], evasive_action: 'none', confidence: 0.86 }
  }
  if (sc.verdict === 'UNSURE') {
    return { ...base, verdict: 'UNSURE', reason: 'Low sun glare washes out the crosswalk; cannot confirm whether the driver saw the pedestrian.', description: `A ${colorName} car turns right as a pedestrian crosses the east crosswalk; the closest moment is partly obscured by glare.`, contributing_factors: ['glare on crosswalk'], evasive_action: 'unclear', confidence: 0.48 }
  }
  const T: Record<Kind, () => Omit<Verification, 'model' | 'conditions' | 'verdict'>> = {
    ped_rt: () => ({
      reason: m.first === 'b' ? `Car turns right into the crosswalk ${pet}s after the pedestrian clears its path; driver did not yield.` : `Pedestrian enters the crosswalk ${pet}s after the turning car passes; the car never slowed.`,
      description: `A ${colorName} sedan turning right from the south approach cuts through the east crosswalk while a pedestrian is crossing.${sc.van ? ' A parked white van on the east leg hides the pedestrian from the driver until late.' : ''}`,
      contributing_factors: sc.van ? ['driver did not yield', 'pedestrian hidden by parked van'] : ['driver did not yield', 'turning driver looking left for gaps in traffic'],
      evasive_action: m.first === 'b' ? 'pedestrian quickened pace' : 'pedestrian paused mid-step',
      confidence: 0.8 + (1 - m.pet / 3) * 0.15,
    }),
    left_oncoming: () => ({
      reason: m.first === 'a' ? `Left-turning car crosses the oncoming lane ${pet}s ahead of a through car.` : `Left-turning car starts its turn ${pet}s after the oncoming car passes the conflict point.`,
      description: `A ${colorName} car turning left from the south approach accepts a short gap in southbound traffic.`,
      contributing_factors: ['short gap accepted', 'oncoming speed misjudged'],
      evasive_action: m.first === 'a' ? 'through car braked' : 'none',
      confidence: 0.78 + (1 - m.pet / 3) * 0.15,
    }),
    right_hook: () => ({
      reason: `Car turns right across the bike lane ${pet}s before the cyclist reaches the same spot (right hook).`,
      description: `A ${colorName} car overtakes a northbound cyclist, then turns right across the green bike lane in front of them.`,
      contributing_factors: ['driver turned across bike lane', 'cyclist in driver blind spot'],
      evasive_action: 'cyclist braked hard',
      confidence: 0.8 + (1 - m.pet / 3) * 0.15,
    }),
    midblock: () => ({
      reason: m.first === 'b' ? `Pedestrian clears the eastbound lane ${pet}s before a fast car passes the crossing point.` : `Car passes the unmarked crossing point ${pet}s before the pedestrian steps into its lane.`,
      description: `At night, a pedestrian crosses mid-block at the faded crosswalk while a ${colorName} car approaches well above the 25 mph limit.`,
      contributing_factors: ['darkness between streetlights', 'high approach speed', 'no traffic control at crossing'],
      evasive_action: m.first === 'b' ? 'pedestrian ran the last steps' : 'pedestrian stopped at lane edge',
      confidence: 0.76 + (1 - m.pet / 3) * 0.15,
    }),
  }
  return { ...base, verdict: 'ACCEPT', ...T[sc.kind]() }
}

const COLOR_NAMES = ['silver', 'black', 'white', 'red', 'blue', 'green', 'gold', 'gray', 'white']
const colorName = (c: [number, number, number]) => COLOR_NAMES[CAR_COLORS.findIndex((x) => x === c)] ?? 'gray'

function severityOf(pet: number): Severity {
  return pet < 1 ? 'severe' : pet < 2 ? 'moderate' : 'low'
}

// ---- FHWA catalog (verified URLs only; see README) -------------------------------------------

const FHWA = 'https://highways.dot.gov/safety/proven-safety-countermeasures/'
const CATALOG: Record<string, { name: string; slug: string }> = {
  leading_pedestrian_interval: { name: 'Leading Pedestrian Interval', slug: 'leading-pedestrian-interval' },
  crosswalk_visibility_enhancements: { name: 'Crosswalk Visibility Enhancements', slug: 'crosswalk-visibility-enhancements' },
  rrfb: { name: 'Rectangular Rapid Flashing Beacons (RRFB)', slug: 'rectangular-rapid-flashing-beacons-rrfb' },
  pedestrian_hybrid_beacons: { name: 'Pedestrian Hybrid Beacons', slug: 'pedestrian-hybrid-beacons' },
  medians_refuge_islands: { name: 'Medians and Pedestrian Refuge Islands in Urban and Suburban Areas', slug: 'medians-and-pedestrian-refuge-islands-urban-and-suburban-areas' },
  dedicated_turn_lanes: { name: 'Dedicated Left- and Right-Turn Lanes at Intersections', slug: 'dedicated-left-and-right-turn-lanes-intersections' },
  reduced_left_turn_conflict: { name: 'Reduced Left-Turn Conflict Intersections', slug: 'reduced-left-turn-conflict-intersections' },
  roundabouts: { name: 'Roundabouts', slug: 'roundabouts' },
  lighting: { name: 'Lighting', slug: 'lighting' },
}
const REVIEW = 'Suggested for traffic engineer review; not a verified design decision.'

function rec(id: keyof typeof CATALOG, why: string, cited: string[]): Recommendation {
  const c = CATALOG[id]
  return { countermeasure_id: id, name: c.name, source: 'FHWA Proven Safety Countermeasures', url: FHWA + c.slug, why, cited_event_ids: cited, review_note: REVIEW }
}

// ---- main ------------------------------------------------------------------------------------

function write(rel: string, data: unknown) {
  const p = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data))
}

const r2 = (v: number) => +v.toFixed(2)
const r1 = (v: number) => +v.toFixed(1)

async function main() {
  const cameras: Camera[] = []
  const events: AlmostEvent[] = []
  const details: Record<string, EventDetail> = {}
  const whatifs: Record<string, WhatIf> = {}
  let roadUsers = 0
  let interactions = 0
  const jobs: (() => Promise<void>)[] = []
  const eventCam: Record<string, CameraDef> = {}

  for (const site of SITES) {
    for (const camId of site.camera_ids) {
      resetIds()
      const cam = cameraDef(site, camId)
      const rand = mulberry32([...camId].reduce((h, c) => h * 31 + c.charCodeAt(0), 7))
      cameras.push({
        camera_id: camId, site_id: site.site_id, label: cam.label, video_url: `/mock/footage/${camId}.mp4`,
        fps: FPS, width: W, height: H, homography: cam.model.H_i2g, ground: groundFor(site.layout),
      })

      const scen = (SCHEDULE[camId] ?? []).map((sc) => ({ sc, ...buildScenario(sc, rand) }))
      const scenarioActors = scen.flatMap((s) => [s.A, s.B, ...s.extras])
      const protectedIds = new Set(scen.flatMap((s) => [s.A.id, s.B.id]))
      // Scenario pairs must not touch other scenarios either.
      const bg = backgroundTraffic(site.layout, site.site_id, rand, scenarioActors, protectedIds)
      const actors = [...scenarioActors, ...bg]
      const moving = actors.filter((a) => !('parked' in a && a.parked))
      roadUsers += moving.filter((a) => a.tEnd > 0 && a.tStart < DURATION).length
      for (let i = 0; i < moving.length; i++) for (let j = i + 1; j < moving.length; j++) {
        if (Math.min(moving[i].tEnd, moving[j].tEnd) > Math.max(moving[i].tStart, moving[j].tStart)) interactions++
      }

      for (const { sc, A, B, p, m } of scen) {
        const id = `EV_${camId.slice(4)}_${String(Math.round(m.tConflict)).padStart(4, '0')}`
        // Snap clip bounds to frame boundaries so clip time 0 == camera frame at t0.
        const t0 = Math.round(Math.max(0, m.tConflict - 6) * FPS) / FPS
        const t1 = Math.round(Math.min(DURATION, m.tConflict + 5) * FPS) / FPS
        const vulnerable = B.kind !== 'vehicle' ? 1 : 0
        const score = 0.6 * (1 - Math.min(m.pet, 3) / 3) + 0.3 * (1 - Math.min(m.minTtc, 2) / 2) + 0.1 * vulnerable
        const v = verificationFor(sc, m, colorName(A.color))
        const ev: AlmostEvent = {
          event_id: id, site_id: site.site_id, camera_id: camId, t_conflict: r2(m.tConflict),
          clip: { t0: +t0.toFixed(3), t1: +t1.toFixed(3), url: `/mock/clips/${id}.mp4`, thumb: `/mock/thumbs/${id}.jpg` },
          a: { track_id: A.id, cls: A.cls, movement: A.movement, speed_mps: r1(A.speed) },
          b: { track_id: B.id, cls: B.cls, movement: B.movement, speed_mps: r1(B.speed) },
          conflict_type: CONFLICT[sc.kind], conflict_point: [r2(p[0]), r2(p[1])],
          pet_s: r2(m.pet), min_ttc_s: r2(m.minTtc), first_through: m.first,
          severity: severityOf(m.pet), score: r2(score), verification: v, pattern_id: null,
          status: v.verdict === 'ACCEPT' ? 'verified' : v.verdict === 'REJECT' ? 'rejected' : 'unsure',
        }
        events.push(ev)
        eventCam[id] = cam

        // Overlay (image space) for the clip window.
        const overlay: EventDetail['overlay'] = { a: [], b: [] }
        for (let t = t0; t <= t1 + 1e-6; t += 1 / FPS) {
          for (const [key, act] of [['a', A], ['b', B]] as const) {
            const s = act.stateAt(t)
            const box = s && imageBox(cam, act, s)
            if (box) overlay[key].push([r2(t), r1(box.u), r1(box.v), r1(box.x1), r1(box.y1), r1(box.x2), r1(box.y2)] as OverlayRow)
          }
        }
        details[id] = { ...ev, overlay }

        // WHAT-IF payload.
        const gc = gapCurve(A, B, m.tConflict)
        const pa: [number, number, number, number][] = []
        const pb: [number, number, number, number][] = []
        for (let t = t0 - 3.5; t <= t1 + 3.5 + 1e-6; t += 1 / FPS) {
          const sa = A.stateAt(t)
          if (sa) pa.push([r2(t), r2(sa.x), r2(sa.y), r1(sa.hdg)])
          const sb = B.stateAt(t)
          if (sb) pb.push([r2(t), r2(sb.x), r2(sb.y), r1(sb.hdg)])
        }
        const toImg = (rows: number[][]) => rows.map(([t, x, y]) => { const [u, v] = applyH(cam.model.H_g2i, x, y); return [t, r1(u), r1(v)] as [number, number, number] })
        whatifs[id] = {
          event_id: id,
          shift_actor: 'a',
          a: { cls: A.cls, dims_m: [A.dims[0], A.dims[1]], path: pa },
          // Extension beyond MASTER 4.4: heading as 4th path value and dims_m when B is a vehicle.
          b: { cls: B.cls, radius_m: radiusOf(B), path: pb, ...(B.kind === 'vehicle' ? { dims_m: [B.dims[0], B.dims[1]] as [number, number] } : {}) },
          image_paths: { a: toImg(pa), b: toImg(pb) },
          homography_inv: cam.model.H_g2i,
          observed: { pet_s: r2(m.pet), min_gap_m: r2(m.minGap) },
          gap_curve: gc.curve,
          contact_ranges: gc.ranges,
          first_contact_shift_s: gc.first === null ? null : r2(gc.first),
          impact: gc.impact,
          disclaimer: 'Simulation along observed paths only. Real crash dynamics differ.',
        }
        console.log(`${id}  ${sc.kind.padEnd(14)} PET ${m.pet.toFixed(2)} (target ${sc.pet}) first=${m.first} TTC ${m.minTtc.toFixed(2)} gap ${m.minGap.toFixed(2)}m  contact@${gc.first}  ranges ${JSON.stringify(gc.ranges)}`)
      }

      if (!NO_VIDEO && (!ONLY || ONLY === camId)) {
        jobs.push(async () => {
          const t = Date.now()
          const out = path.join(OUT, 'footage', `${camId}.mp4`)
          fs.mkdirSync(path.dirname(out), { recursive: true })
          await renderVideo({ cam, actors, duration: DURATION, out, label: `${camId}  ${site.name.replace(' (simulated)', '')}` })
          console.log(`  rendered ${camId} in ${((Date.now() - t) / 1000).toFixed(1)}s`)
        })
      }
    }
  }

  // ---- patterns, similar, recommendations -----------------------------------------------
  const accepted = events.filter((e) => e.status === 'verified')
  const bySite = (s: string) => accepted.filter((e) => e.site_id === s)
  const ids = (xs: AlmostEvent[]) => xs.map((e) => e.event_id)
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }

  const A = bySite('SITE_A'), B = bySite('SITE_B'), C = bySite('SITE_C'), Dn = bySite('SITE_D')
  const pedFirstA = A.filter((e) => e.first_through === 'b')
  const vanA = A.filter((e) => e.verification?.conditions.visibility_issue)
  const fastD = Dn.filter((e) => e.a.speed_mps * 2.237 > 25)
  const patternDefs: { id: string; site: string; evs: AlmostEvent[]; signature: string; summary: string; recs: Recommendation[] }[] = [
    {
      id: 'PAT_A_01', site: 'SITE_A', evs: A,
      signature: 'Right-turning drivers from the south approach vs pedestrians in the east crosswalk',
      summary: `${A.length} close calls across all three cameras where a right-turning driver entered the east crosswalk while a pedestrian was in it or about to step in. Worst margin ${Math.min(...A.map((e) => e.pet_s)).toFixed(1)} s. In ${pedFirstA.length} of ${A.length} the pedestrian was already crossing when the car arrived.`,
      recs: [
        rec('leading_pedestrian_interval', `In ${pedFirstA.length} of ${A.length} events the pedestrian had already started crossing when the turning car arrived (${ids(pedFirstA).join(', ')}). A head start makes pedestrians visible before turns begin.`, ids(pedFirstA)),
        rec('crosswalk_visibility_enhancements', `${vanA.length} event(s) involved a pedestrian hidden from the driver (${ids(vanA).join(', ')}): a parked van on the east leg blocked the sight line to the crosswalk.`, ids(vanA)),
      ],
    },
    {
      id: 'PAT_B_01', site: 'SITE_B', evs: B,
      signature: 'Northbound left turns accepting short gaps in southbound through traffic',
      summary: `${B.length} close calls where a northbound driver turned left across southbound traffic with too little time. Median margin ${median(B.map((e) => e.pet_s)).toFixed(1)} s; all with permissive left turns.`,
      recs: [
        rec('dedicated_turn_lanes', `All ${B.length} events (${ids(B).join(', ')}) involve a left-turning car waiting in the through lane and then accepting a short gap; a dedicated turn lane and protected phase separate the decision from through traffic.`, ids(B)),
        rec('reduced_left_turn_conflict', `Repeated left-turn vs oncoming conflicts (${ids(B).join(', ')}) are the conflict type these designs remove.`, ids(B)),
      ],
    },
    {
      id: 'PAT_C_01', site: 'SITE_C', evs: C,
      signature: 'Right-turning drivers crossing the northbound bike lane in front of cyclists (right hook)',
      summary: `${C.length} right-hook close calls: drivers overtook a northbound cyclist and turned right across the bike lane. No catalog countermeasure in our verified FHWA list maps to this conflict yet (Bicycle Lanes URL not found on the FHWA site); flagged for engineer review.`,
      recs: [],
    },
    {
      id: 'PAT_D_01', site: 'SITE_D', evs: Dn,
      signature: 'Night mid-block crossings vs fast eastbound cars',
      summary: `${Dn.length} night-time close calls at the unsignalized mid-block crossing. ${fastD.length} of ${Dn.length} cars were above the 25 mph limit; the crossing sits in a gap between streetlights.`,
      recs: [
        rec('rrfb', `Pedestrians crossed at an uncontrolled mid-block location in all ${Dn.length} events (${ids(Dn).join(', ')}); drivers gave no sign of expecting them.`, ids(Dn)),
        rec('lighting', `All ${Dn.length} events happened at night with the pedestrian between streetlight pools (${ids(Dn).join(', ')}).`, ids(Dn)),
        rec('medians_refuge_islands', `Pedestrians had to judge both directions of fast traffic in one go (${ids(Dn).join(', ')}); a refuge splits the crossing.`, ids(Dn)),
      ],
    },
  ]
  const patterns: Pattern[] = patternDefs.map((d) => {
    d.evs.forEach((e) => { e.pattern_id = d.id; details[e.event_id].pattern_id = d.id })
    const pets = d.evs.map((e) => e.pet_s)
    const day = d.evs.filter((e) => e.verification?.conditions.lighting === 'day').length
    return {
      pattern_id: d.id, site_id: d.site, conflict_type: d.evs[0].conflict_type, signature: d.signature,
      event_ids: ids(d.evs), count: d.evs.length, worst_pet_s: Math.min(...pets), median_pet_s: r2(median(pets)),
      conditions: { day, night: d.evs.length - day }, summary: d.summary, recommendations: d.recs,
    }
  })

  const similar: Record<string, SimilarEvent[]> = {}
  for (const e of accepted) {
    const same = accepted.filter((o) => o.pattern_id === e.pattern_id && o.event_id !== e.event_id)
    const other = accepted.filter((o) => o.site_id !== e.site_id).sort((a, b) => Math.abs(a.pet_s - e.pet_s) - Math.abs(b.pet_s - e.pet_s))[0]
    similar[e.event_id] = [
      ...same.map((o, i) => ({ event: o, score: r2(0.94 - i * 0.04 - Math.abs(o.pet_s - e.pet_s) * 0.03) })),
      ...(other ? [{ event: other, score: 0.58 }] : []),
    ].sort((a, b) => b.score - a.score)
  }

  // ---- write JSON ---------------------------------------------------------------------------
  for (const dir of ['events', 'whatif', 'similar', 'reports']) fs.rmSync(path.join(OUT, dir), { recursive: true, force: true })
  if (!NO_VIDEO && !ONLY) for (const dir of ['clips', 'thumbs']) fs.rmSync(path.join(OUT, dir), { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  write('config.json', { sites: SITES.map(({ layout: _l, night: _n, ...s }) => s), cameras })
  events.sort((a, b) => b.score - a.score)
  write('events.json', events)
  for (const [id, d] of Object.entries(details)) write(`events/${id}.json`, d)
  for (const [id, w] of Object.entries(whatifs)) write(`whatif/${id}.json`, w)
  for (const e of events) write(`similar/${e.event_id}.json`, similar[e.event_id] ?? [])
  write('patterns.json', patterns)

  for (const site of SITES) {
    const ps = patterns.filter((p) => p.site_id === site.site_id)
    const { layout: _l, night: _n, ...s } = site
    const report: SiteReport = {
      site: s, patterns: ps, recommendations: ps.flatMap((p) => p.recommendations),
      top_events: events.filter((e) => e.site_id === site.site_id && e.status === 'verified').slice(0, 5),
      generated_at: new Date().toISOString(),
      disclaimer: 'Close calls measured from simulated footage with project thresholds (PET < 3 s or TTC < 2 s). Recommendations come only from the FHWA Proven Safety Countermeasures catalog and are suggestions for traffic engineer review.',
    }
    write(`reports/${site.site_id}.json`, report)
    write(`reports/${site.site_id}.md`, reportMarkdown(report))
  }

  const ev: EvalResult = {
    detection: { recall: 0.93, precision: 0.88 },
    measurement: { pet_mae_s: 0.11 },
    verification: { accuracy: 0.89, decoys_rejected: `${events.filter((e) => e.status === 'rejected').length}/${events.filter((e) => e.status === 'rejected').length}` },
    patterns: { purity: 1 },
    recommendations: { from_catalog: 1, urls_valid: 1, claims_cited: 1 },
    weave_url: 'https://wandb.ai/site/weave',
    run_at: new Date().toISOString(),
  }
  write('eval.json', ev)

  // ---- fake WebSocket replay ------------------------------------------------------------------
  const final: RunCounts = {
    video_minutes: r1((cameras.length * DURATION) / 60), road_users: roadUsers, interactions,
    candidates: events.length, verified: accepted.length, rejected: events.filter((e) => e.status === 'rejected').length, patterns: patterns.length,
  }
  write('run.json', buildReplay(events, patterns, similar, final))

  console.log(`\n${cameras.length} cameras · ${events.length} candidates · ${accepted.length} verified · ${patterns.length} patterns · ${roadUsers} road users · ${interactions} interactions`)

  // ---- footage, clips, thumbs ----------------------------------------------------------------
  if (!NO_VIDEO) {
    for (const j of jobs) await j()
    fs.mkdirSync(path.join(OUT, 'clips'), { recursive: true })
    fs.mkdirSync(path.join(OUT, 'thumbs'), { recursive: true })
    for (const e of events) {
      if (ONLY && e.camera_id !== ONLY) continue
      const src = path.join(OUT, 'footage', `${e.camera_id}.mp4`)
      await ffmpeg(['-ss', String(e.clip.t0), '-i', src, '-t', String(r2(e.clip.t1 - e.clip.t0)), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-g', String(FPS), '-bf', '0', '-an', '-movflags', '+faststart', path.join(OUT, 'clips', `${e.event_id}.mp4`)])
      await ffmpeg(['-ss', String(e.t_conflict), '-i', src, '-frames:v', '1', '-q:v', '4', '-vf', 'scale=480:-1', path.join(OUT, 'thumbs', `${e.event_id}.jpg`)])
    }
    if (!ONLY || ONLY === 'CAM_A1') await renderCrash()
    console.log('footage done')
  }
}

function buildReplay(events: AlmostEvent[], patterns: Pattern[], similar: Record<string, SimilarEvent[]>, final: RunCounts) {
  const steps: { at: number; msg: WsMessage }[] = []
  const run_id = 'r1'
  let at = 0
  const counts: RunCounts = { video_minutes: 0, road_users: 0, interactions: 0, candidates: 0, verified: 0, rejected: 0, patterns: 0 }
  const push = (dt: number, msg: WsMessage) => { at += dt; steps.push({ at: Math.round(at), msg: JSON.parse(JSON.stringify(msg)) }) }
  const stage = (s: WsMessage) => s
  const ramp = (name: 'scan' | 'measure', ms: number, keys: (keyof RunCounts)[], onTick?: (k: number) => void) => {
    push(0, stage({ type: 'run.stage', run_id, stage: name, status: 'start', progress: 0, counts }))
    const n = Math.round(ms / 200)
    for (let i = 1; i <= n; i++) {
      const k = i / n
      for (const key of keys) counts[key] = key === 'video_minutes' ? r1(final[key] * k) : Math.round(final[key] * k)
      onTick?.(k)
      push(200, { type: 'run.stage', run_id, stage: name, status: 'progress', progress: r2(k), counts })
    }
    push(0, { type: 'run.stage', run_id, stage: name, status: 'done', progress: 1, counts })
  }
  ramp('scan', 3800, ['video_minutes', 'road_users'])
  // Measure: interactions race; candidates appear in time order of discovery.
  const order = [...events].sort((a, b) => a.camera_id.localeCompare(b.camera_id) || a.t_conflict - b.t_conflict)
  let emitted = 0
  ramp('measure', 4400, ['interactions'], (k) => {
    while (emitted < Math.floor(order.length * k)) {
      const { verification: _v, ...cand } = order[emitted++]
      counts.candidates = emitted
      steps.push({ at: Math.round(at + 100), msg: { type: 'run.candidate', event: { ...cand, status: 'candidate', pattern_id: null } } })
    }
  })
  // Verify: one verdict at a time, worst-first.
  push(0, { type: 'run.stage', run_id, stage: 'verify', status: 'start', progress: 0, counts })
  const byScore = [...events].sort((a, b) => b.score - a.score)
  // Demo beat: show a decoy being rejected early (3rd verdict), not only at the end.
  const firstReject = byScore.findIndex((e) => e.status === 'rejected')
  if (firstReject > 2) byScore.splice(2, 0, byScore.splice(firstReject, 1)[0])
  byScore.forEach((e, i) => {
    const v = e.verification!
    if (v.verdict === 'ACCEPT') counts.verified++
    if (v.verdict === 'REJECT') counts.rejected++
    push(420, { type: 'run.verified', event_id: e.event_id, verdict: v.verdict, reason: v.reason })
    push(0, { type: 'run.stage', run_id, stage: 'verify', status: 'progress', progress: r2((i + 1) / byScore.length), counts })
  })
  push(200, { type: 'run.stage', run_id, stage: 'verify', status: 'done', progress: 1, counts })
  for (const [name, ms] of [['remember', 1200]] as const) {
    push(0, { type: 'run.stage', run_id, stage: name, status: 'start', progress: 0, counts })
    push(ms, { type: 'run.stage', run_id, stage: name, status: 'done', progress: 1, counts })
  }
  push(0, { type: 'run.stage', run_id, stage: 'recall', status: 'start', progress: 0, counts })
  const acc = byScore.filter((e) => e.status === 'verified')
  acc.forEach((e) => push(160, { type: 'run.similar', event_id: e.event_id, similar_ids: (similar[e.event_id] ?? []).map((s) => s.event.event_id) }))
  push(200, { type: 'run.stage', run_id, stage: 'recall', status: 'done', progress: 1, counts })
  push(0, { type: 'run.stage', run_id, stage: 'pattern', status: 'start', progress: 0, counts })
  for (const p of patterns) {
    counts.patterns++
    push(550, { type: 'run.pattern', pattern: { ...p, recommendations: [] } })
    push(0, { type: 'run.stage', run_id, stage: 'pattern', status: 'progress', progress: r2(counts.patterns / patterns.length), counts })
  }
  push(100, { type: 'run.stage', run_id, stage: 'pattern', status: 'done', progress: 1, counts })
  push(0, { type: 'run.stage', run_id, stage: 'recommend', status: 'start', progress: 0, counts })
  for (const p of patterns) for (const r of p.recommendations) push(380, { type: 'run.recommendation', pattern_id: p.pattern_id, recommendation: r })
  push(200, { type: 'run.stage', run_id, stage: 'recommend', status: 'done', progress: 1, counts })
  push(0, { type: 'run.stage', run_id, stage: 'report', status: 'start', progress: 0, counts })
  push(800, { type: 'run.stage', run_id, stage: 'report', status: 'done', progress: 1, counts: final })
  push(100, { type: 'run.done', run_id })
  return steps.sort((a, b) => a.at - b.at)
}

function reportMarkdown(r: SiteReport) {
  const lines = [`# ALMOST site report: ${r.site.name}`, '', `Generated ${r.generated_at}`, '', '## Patterns', '']
  for (const p of r.patterns) {
    lines.push(`### ${p.signature}`, '', `${PLAIN[p.conflict_type]} · ${p.count} verified close calls · worst margin ${p.worst_pet_s} s · median ${p.median_pet_s} s`, '', p.summary, '', `Events: ${p.event_ids.join(', ')}`, '')
    if (!p.recommendations.length) lines.push('_No FHWA catalog countermeasure matched; flagged for engineer review._', '')
    for (const rc of p.recommendations) lines.push(`- **[${rc.name}](${rc.url})** (${rc.source}): ${rc.why} _${rc.review_note}_`)
    lines.push('')
  }
  lines.push('## Top events', '', '| Event | Camera | Type | Margin (PET) | Severity |', '|---|---|---|---|---|')
  for (const e of r.top_events) lines.push(`| ${e.event_id} | ${e.camera_id} | ${PLAIN[e.conflict_type]} | ${e.pet_s} s | ${e.severity} |`)
  lines.push('', `> ${r.disclaimer}`, '')
  return lines.join('\n')
}

async function renderCrash() {
  resetIds()
  const site = SITES[0]
  const cam = cameraDef(site, 'CAM_A1')
  const rand = mulberry32(99)
  const A = pathActor({ cls: 'car', pts: MOVES.right(), speed: 6.8, t0: 0, color: [40, 60, 120], movement: 'right_turn' })
  const pts = line([CW_MID, -SIDEWALK], [CW_MID, SIDEWALK])
  const B = pathActor({ cls: 'person', pts, speed: 1.4, t0: 0, color: [230, 190, 60], movement: 'crossing' })
  const p = crossingPoint(A.path.pts, B.path.pts)
  B.tStart = 6 - Math.abs(p[1] + SIDEWALK) / 1.4
  B.tEnd = B.tStart + B.path.len / 1.4
  // Put A's front at the pedestrian exactly when they meet.
  A.tStart = 6 - (A.path.cum[A.path.pts.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.6)] - 1.6) / A.speed
  A.tEnd = A.tStart + A.path.len / A.speed
  let tHit = Infinity
  for (let t = 0; t < 12; t += 1 / 60) {
    const sa = A.stateAt(t), sb = B.stateAt(t)
    if (sa && sb && gapAB(A, sa, B, sb) <= 0) { tHit = t; break }
  }
  const hitA = A.stateAt(tHit)!
  const hitB = B.stateAt(tHit)!
  const sHit = (tHit - A.tStart) * A.speed
  const origA = A.stateAt.bind(A)
  const origB = B.stateAt.bind(B)
  const dec = 9
  const stopT = A.speed / dec
  const crashA: Actor = { ...A, stateAt: (t: number) => {
    if (t < tHit) return origA(t)
    const dt = Math.min(t - tHit, stopT)
    const s = sHit + A.speed * dt - 0.5 * dec * dt * dt
    return atDist(A, s)
  } }
  const h = (hitA.hdg * Math.PI) / 180
  const crashB: Actor = { ...B, tEnd: 1e9, stateAt: (t: number) => {
    if (t < tHit) return origB(t)
    const k = Math.min(1, (t - tHit) / 0.5)
    return { x: hitB.x + Math.cos(h) * 1.4 * k, y: hitB.y + Math.sin(h) * 1.4 * k, hdg: hitA.hdg + 70, lying: k >= 1 } satisfies State
  } }
  const bg = backgroundTraffic('intersection', 'SITE_A', rand, [crashA, crashB], new Set([crashA.id, crashB.id])).filter((a) => a.tStart > -6 && a.tStart < 12)
  await renderVideo({ cam, actors: [crashA, crashB, ...bg], duration: 12, out: path.join(OUT, 'footage', 'CRASH_A.mp4'), label: 'SIMULATED CRASH  CAM_A1' })
}

function atDist(a: PathA, s: number): State {
  // Reuse the actor's own path sampling via a temporary start time.
  const t = a.tStart + s / a.speed
  return a.stateAt(Math.min(t, a.tEnd))!
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
