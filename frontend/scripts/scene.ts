// Scene simulation for mock footage: site layouts, road-user motion along
// polylines, and the measurement math (PET, TTC, WHAT-IF gap curve) the backend
// will eventually compute from YOLO tracks. Everything is derived from the same
// paths that get rendered, so overlays and numbers agree with the pixels.

import { gapRectCircle, type CameraModel } from '../src/lib/geometry.ts'
import type { Ground, Pt, RoadUserClass } from '../src/types.ts'

export const ROAD_HALF = 6 // m, curb to centerline
export const LANE = 1.75 // centre of the travel lane
export const BIKE_LANE = 4.75
export const CW_IN = 7 // crosswalk band, distance from centre
export const CW_OUT = 10
export const CW_MID = 8.5
export const SIDEWALK = 9.5

export type Layout = 'intersection' | 'midblock'

export function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- polylines -------------------------------------------------------------

export function line(a: Pt, b: Pt, step = 0.5): Pt[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as Pt)
}

export function arc(cx: number, cy: number, r: number, a0: number, a1: number, step = 0.4): Pt[] {
  const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / step))
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt
  })
}

export function join(...parts: Pt[][]): Pt[] {
  const out: Pt[] = []
  for (const p of parts) for (const q of p) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(last[0] - q[0], last[1] - q[1]) > 1e-6) out.push(q)
  }
  return out
}

/** Rotate a polyline about the origin by k * 90 degrees CCW. */
export function rot(poly: Pt[], k: number): Pt[] {
  const c = Math.round(Math.cos((k * Math.PI) / 2))
  const s = Math.round(Math.sin((k * Math.PI) / 2))
  return poly.map(([x, y]) => [x * c - y * s, x * s + y * c] as Pt)
}

const D = 70 // approach length
// Northbound base movements (from the S leg). Other approaches = rot(k).
export const MOVES = {
  through: () => line([LANE, -D], [LANE, D]),
  right: () => join(line([LANE, -D], [LANE, -CW_IN]), arc(CW_IN, -CW_IN, CW_IN - LANE, Math.PI, Math.PI / 2), line([CW_IN, -LANE], [D, -LANE])),
  left: () => join(line([LANE, -D], [LANE, -CW_IN]), arc(-CW_IN, -CW_IN, CW_IN + LANE, 0, Math.PI / 2), line([-CW_IN, LANE], [-D, LANE])),
  bikeThrough: () => line([BIKE_LANE, -D], [BIKE_LANE, D]),
}

// ---- road users -------------------------------------------------------------

export type Kind = 'vehicle' | 'person' | 'bike'

export interface State {
  x: number
  y: number
  hdg: number // degrees, 0 = east, CCW
  lying?: boolean
}

export interface Actor {
  id: number
  cls: RoadUserClass
  kind: Kind
  dims: [number, number, number] // length, width, height
  color: [number, number, number]
  tStart: number
  tEnd: number
  speed: number
  stateAt: (t: number) => State | null
  movement: 'through' | 'left_turn' | 'right_turn' | 'crossing' | 'unknown'
  parked?: boolean
}

interface PathInfo {
  pts: Pt[]
  cum: number[]
  len: number
}

function pathInfo(pts: Pt[]): PathInfo {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  return { pts, cum, len: cum[cum.length - 1] }
}

export function atDistance(p: PathInfo, s: number): State {
  s = Math.max(0, Math.min(p.len, s))
  let lo = 0
  let hi = p.cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (p.cum[mid] <= s) lo = mid
    else hi = mid
  }
  const a = p.pts[lo]
  const b = p.pts[hi]
  const seg = p.cum[hi] - p.cum[lo] || 1
  const k = (s - p.cum[lo]) / seg
  return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, hdg: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI }
}

let nextId = 1
export function resetIds() {
  nextId = 1
}

export const DIMS: Record<string, [number, number, number]> = {
  car: [4.5, 1.8, 1.5],
  van: [5.6, 2.1, 2.4],
  truck: [7.5, 2.4, 3.0],
  bus: [11, 2.5, 3.1],
  person: [0.45, 0.45, 1.75],
  bicycle: [1.75, 0.5, 1.7],
}

export function pathActor(opts: {
  cls: RoadUserClass
  pts: Pt[]
  speed: number
  t0: number
  color: [number, number, number]
  movement: Actor['movement']
  dims?: [number, number, number]
}): Actor & { path: PathInfo } {
  const path = pathInfo(opts.pts)
  const kind: Kind = opts.cls === 'person' ? 'person' : opts.cls === 'bicycle' ? 'bike' : 'vehicle'
  const dims = opts.dims ?? DIMS[opts.cls] ?? DIMS.car
  const tEnd = opts.t0 + path.len / opts.speed
  return {
    id: nextId++,
    cls: opts.cls,
    kind,
    dims,
    color: opts.color,
    tStart: opts.t0,
    tEnd,
    speed: opts.speed,
    movement: opts.movement,
    path,
    stateAt(t) {
      if (t < this.tStart || t > this.tEnd) return null
      return atDistance(path, (t - this.tStart) * opts.speed)
    },
  }
}

export function parkedActor(cls: RoadUserClass, at: State, color: [number, number, number], dims?: [number, number, number]): Actor {
  return {
    id: nextId++,
    cls,
    kind: 'vehicle',
    dims: dims ?? DIMS[cls] ?? DIMS.car,
    color,
    tStart: -1e9,
    tEnd: 1e9,
    speed: 0,
    movement: 'unknown',
    parked: true,
    stateAt: () => at,
  }
}

/** Time (from the actor's own t0) at which its path centre is closest to a point. */
export function timeToPoint(a: Actor & { path: PathInfo }, p: Pt): number {
  let best = 0
  let bd = Infinity
  a.path.pts.forEach((q, i) => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1])
    if (d < bd) {
      bd = d
      best = a.path.cum[i]
    }
  })
  return best / a.speed
}

/** Closest approach between two polylines (spatial, ignoring time). */
export function crossingPoint(p: Pt[], q: Pt[]): Pt {
  let best: Pt = p[0]
  let bd = Infinity
  for (const a of p) for (const b of q) {
    const d = Math.hypot(a[0] - b[0], a[1] - b[1])
    if (d < bd) {
      bd = d
      best = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    }
  }
  return best
}

// ---- measurement --------------------------------------------------------------

export const DT = 1 / 30

/** Radius used for B in gap math. Vehicles get their half width (approximation). */
export function radiusOf(b: Actor) {
  return b.kind === 'person' ? 0.35 : b.kind === 'bike' ? 0.45 : b.dims[1] / 2
}

/** Gap between A's footprint and B (circle; vehicles as 3 circles along the body). */
export function gapAB(a: Actor, sa: State, b: Actor, sb: State): number {
  const [la, wa] = a.dims
  if (b.kind !== 'vehicle') return gapRectCircle(sa.x, sa.y, sa.hdg, la, wa, sb.x, sb.y, radiusOf(b))
  const h = (sb.hdg * Math.PI) / 180
  const off = b.dims[0] / 2 - b.dims[1] / 2
  let g = Infinity
  for (const k of [-1, 0, 1]) {
    g = Math.min(g, gapRectCircle(sa.x, sa.y, sa.hdg, la, wa, sb.x + Math.cos(h) * off * k, sb.y + Math.sin(h) * off * k, radiusOf(b)))
  }
  return g
}

/** Half-width an actor sweeps sideways (used to inflate the other's conflict zone). */
function halfWidth(actor: Actor) {
  return actor.kind === 'person' ? radiusOf(actor) : actor.dims[1] / 2
}

/**
 * Conflict-zone occupancy: the actor's body is within the other road user's
 * half-width of the conflict point. Using a zone rather than a bare point keeps
 * PET > 0 meaning "bodies never touched".
 */
function occupies(actor: Actor, s: State, p: Pt, other: Actor): boolean {
  const inflate = halfWidth(other)
  if (actor.kind === 'person') return Math.hypot(s.x - p[0], s.y - p[1]) <= radiusOf(actor) + inflate
  return gapRectCircle(s.x, s.y, s.hdg, actor.dims[0], actor.dims[1], p[0], p[1], inflate) <= 0
}

export interface Measure {
  pet: number
  first: 'a' | 'b'
  aIn: number
  aOut: number
  bIn: number
  bOut: number
  tConflict: number
  minTtc: number
  minGap: number
  overlap: boolean
}

export function measure(a: Actor, b: Actor, p: Pt): Measure | null {
  const t0 = Math.max(a.tStart, b.tStart)
  const t1 = Math.min(a.tEnd, b.tEnd)
  let aIn = NaN, aOut = NaN, bIn = NaN, bOut = NaN
  const scan = (actor: Actor, other: Actor, from: number, to: number) => {
    let i = NaN, o = NaN
    for (let t = from; t <= to; t += DT) {
      const s = actor.stateAt(t)
      if (s && occupies(actor, s, p, other)) {
        if (Number.isNaN(i)) i = t
        o = t
      }
    }
    return [i, o]
  }
  ;[aIn, aOut] = scan(a, b, a.tStart, a.tEnd)
  ;[bIn, bOut] = scan(b, a, b.tStart, b.tEnd)
  if ([aIn, aOut, bIn, bOut].some(Number.isNaN)) return null
  const overlap = !(aOut < bIn || bOut < aIn)
  const first: 'a' | 'b' = aIn < bIn ? 'a' : 'b'
  const pet = overlap ? 0 : first === 'a' ? bIn - aOut : aIn - bOut
  const tConflict = first === 'a' ? (aOut + bIn) / 2 : (bOut + aIn) / 2

  // Min TTC (constant-velocity extrapolation) and min gap while both present.
  let minTtc = Infinity
  let minGap = Infinity
  const R = (a.dims[0] + a.dims[1]) / 4 + radiusOf(b)
  for (let t = Math.max(t0, tConflict - 5); t <= Math.min(t1, tConflict + 3); t += DT) {
    const sa = a.stateAt(t), sb = b.stateAt(t)
    const sa2 = a.stateAt(t + DT), sb2 = b.stateAt(t + DT)
    if (!sa || !sb || !sa2 || !sb2) continue
    minGap = Math.min(minGap, gapAB(a, sa, b, sb))
    const px = sb.x - sa.x, py = sb.y - sa.y
    const vx = (sb2.x - sb.x - (sa2.x - sa.x)) / DT, vy = (sb2.y - sb.y - (sa2.y - sa.y)) / DT
    const A = vx * vx + vy * vy
    const B = 2 * (px * vx + py * vy)
    const C = px * px + py * py - R * R
    if (A < 1e-6 || B >= 0) continue
    const disc = B * B - 4 * A * C
    if (disc < 0) continue
    const tau = (-B - Math.sqrt(disc)) / (2 * A)
    if (tau > 0) minTtc = Math.min(minTtc, tau)
  }
  if (!Number.isFinite(minTtc)) minTtc = Math.min(5, pet + 0.6)
  return { pet, first, aIn, aOut, bIn, bOut, tConflict, minTtc: Math.min(minTtc, 5), minGap, overlap }
}

/** Choose A's start time so the measured PET hits `target` with the requested order. */
export function solveStart(a: Actor & { path: PathInfo }, b: Actor, p: Pt, target: number, first: 'a' | 'b') {
  const len = a.tEnd - a.tStart
  const tb = (() => {
    for (let t = b.tStart; t <= b.tEnd; t += DT) {
      const s = b.stateAt(t)
      if (s && occupies(b, s, p, a)) return t
    }
    throw new Error('B never reaches the conflict point')
  })()
  const ta = timeToPoint(a, p)
  const set = (t0: number) => {
    a.tStart = t0
    a.tEnd = t0 + len
    return measure(a, b, p)
  }
  // Bracket: A's centre at the point from 8 s before to 8 s after B arrives.
  let lo = first === 'b' ? tb - ta : tb - ta - 8
  let hi = first === 'b' ? tb - ta + 8 : tb - ta
  const f = (t0: number) => {
    const m = set(t0)
    if (!m || m.overlap || m.first !== first) return -target
    return m.pet - target
  }
  // PET grows as A moves later (b first) or earlier (a first).
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    const v = f(mid)
    if (first === 'b' ? v < 0 : v > 0) lo = mid
    else hi = mid
  }
  const m = set((lo + hi) / 2)
  if (!m || Math.abs(m.pet - target) > 0.05) throw new Error(`could not hit PET ${target} (got ${m?.pet})`)
  return m
}

/** WHAT-IF: shift A in time, measure min gap to B. */
export function gapCurve(a: Actor, b: Actor, tCenter: number) {
  const curve: [number, number][] = []
  let best = { shift: 0, gap: Infinity, t: 0, point: [0, 0] as Pt, speed: a.speed }
  for (let i = -60; i <= 60; i++) {
    const s = i * 0.05
    let g = Infinity
    let at = { t: 0, p: [0, 0] as Pt }
    for (let t = tCenter - 8; t <= tCenter + 8; t += DT) {
      const sa = a.stateAt(t - s)
      const sb = b.stateAt(t)
      if (!sa || !sb) continue
      const v = gapAB(a, sa, b, sb)
      if (v < g) {
        g = v
        at = { t, p: [sb.x, sb.y] }
      }
    }
    if (!Number.isFinite(g)) g = 99
    curve.push([+s.toFixed(2), +g.toFixed(3)])
    if (g < best.gap || (g === best.gap && Math.abs(s) < Math.abs(best.shift))) best = { shift: s, gap: g, t: at.t, point: at.p, speed: a.speed }
  }
  const ranges: [number, number][] = []
  let open: number | null = null
  curve.forEach(([s, g], i) => {
    if (g <= 0 && open === null) open = s
    if ((g > 0 || i === curve.length - 1) && open !== null) {
      ranges.push([open, g > 0 ? curve[i - 1][0] : s])
      open = null
    }
  })
  // First contact = the contact shift nearest to zero (in either direction).
  let first: number | null = null
  for (const [lo, hi] of ranges) {
    const cand = lo > 0 ? lo : hi < 0 ? hi : 0
    if (first === null || Math.abs(cand) < Math.abs(first)) first = cand
  }
  // Impact = a solid hit just past first contact (0.15 s deeper, clamped to the
  // range), so the snap marker, crash banner and slider position agree.
  let impact = null as null | { shift_s: number; t: number; point: Pt; speed_mps: number }
  if (first !== null) {
    const range = ranges.find(([lo, hi]) => first! >= lo && first! <= hi)!
    const dir = first > 0 ? 1 : first < 0 ? -1 : range[1] > -range[0] ? 1 : -1
    const shift = Math.max(range[0], Math.min(range[1], +(first + dir * 0.15).toFixed(2)))
    // Time + point of first touch at that shift.
    for (let t = tCenter - 8; t <= tCenter + 8; t += DT) {
      const sa = a.stateAt(t - shift)
      const sb = b.stateAt(t)
      if (sa && sb && gapAB(a, sa, b, sb) <= 0) {
        impact = { shift_s: shift, t: +t.toFixed(3), point: [+sb.x.toFixed(2), +sb.y.toFixed(2)], speed_mps: a.speed }
        break
      }
    }
  }
  return { curve, ranges, first, impact, best }
}

// ---- ground layout (shared with config.json) -----------------------------------

export function groundFor(layout: Layout): Ground {
  const R = ROAD_HALF
  const L = 45
  if (layout === 'midblock') {
    return {
      legs: {
        E: [[3, -R], [L, -R], [L, R], [3, R]],
        W: [[-L, -R], [-3, -R], [-3, R], [-L, R]],
      },
      crosswalks: [{ id: 'CW_MID', polygon: [[-1.5, -R], [1.5, -R], [1.5, R], [-1.5, R]] }],
      box: [[-3, -R], [3, -R], [3, R], [-3, R]],
    }
  }
  return {
    legs: {
      N: [[-R, CW_OUT], [R, CW_OUT], [R, L], [-R, L]],
      S: [[-R, -L], [R, -L], [R, -CW_OUT], [-R, -CW_OUT]],
      E: [[CW_OUT, -R], [L, -R], [L, R], [CW_OUT, R]],
      W: [[-L, -R], [-CW_OUT, -R], [-CW_OUT, R], [-L, R]],
    },
    crosswalks: [
      { id: 'CW_N', polygon: [[-R, CW_IN], [R, CW_IN], [R, CW_OUT], [-R, CW_OUT]] },
      { id: 'CW_S', polygon: [[-R, -CW_OUT], [R, -CW_OUT], [R, -CW_IN], [-R, -CW_IN]] },
      { id: 'CW_E', polygon: [[CW_IN, -R], [CW_OUT, -R], [CW_OUT, R], [CW_IN, R]] },
      { id: 'CW_W', polygon: [[-CW_OUT, -R], [-CW_IN, -R], [-CW_IN, R], [-CW_OUT, R]] },
    ],
    box: [[-R, -R], [R, -R], [R, R], [-R, R]],
  }
}

export interface CameraDef {
  camera_id: string
  site_id: string
  label: string
  layout: Layout
  night: boolean
  model: CameraModel
  pos: [number, number, number]
}
