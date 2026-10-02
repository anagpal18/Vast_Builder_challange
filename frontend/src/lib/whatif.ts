// Client-side helpers over a WHAT-IF payload: ghost positions, live gaps,
// occupancy intervals. Same conventions as the backend (shift = A arrives later).

import type { Pt, WhatIf } from '../types.ts'
import { applyH, gapRectCircle, rectCorners, samplePath } from './geometry.ts'

export interface Pose {
  x: number
  y: number
  hdg: number
}

export function poseA(w: WhatIf, t: number): Pose | null {
  const s = samplePath(w.a.path, t)
  return s ? { x: s[1], y: s[2], hdg: s[3] } : null
}

export function poseB(w: WhatIf, t: number): Pose | null {
  const s = samplePath(w.b.path as number[][], t)
  if (!s) return null
  return { x: s[1], y: s[2], hdg: s.length > 3 ? s[3] : 0 }
}

/** Gap (m) between A's footprint and B. Vehicle B = 3 circles along its body. */
export function gapAt(w: WhatIf, a: Pose, b: Pose): number {
  const [len, wid] = w.a.dims_m
  if (!w.b.dims_m) return gapRectCircle(a.x, a.y, a.hdg, len, wid, b.x, b.y, w.b.radius_m)
  const off = w.b.dims_m[0] / 2 - w.b.dims_m[1] / 2
  const h = (b.hdg * Math.PI) / 180
  let g = Infinity
  for (const k of [-1, 0, 1]) g = Math.min(g, gapRectCircle(a.x, a.y, a.hdg, len, wid, b.x + Math.cos(h) * off * k, b.y + Math.sin(h) * off * k, w.b.radius_m))
  return g
}

/** Min gap for a slider shift, read from the precomputed curve (linear interp). */
export function curveGap(w: WhatIf, shift: number): number {
  const c = w.gap_curve
  if (!c.length) return Infinity
  if (shift <= c[0][0]) return c[0][1]
  for (let i = 1; i < c.length; i++) {
    if (shift <= c[i][0]) {
      const [s0, g0] = c[i - 1]
      const [s1, g1] = c[i]
      return g0 + ((g1 - g0) * (shift - s0)) / (s1 - s0 || 1)
    }
  }
  return c[c.length - 1][1]
}

export const inContact = (w: WhatIf, shift: number) => w.contact_ranges.some(([lo, hi]) => shift >= lo - 1e-6 && shift <= hi + 1e-6)

/** First camera time at which the ghost (A shifted) touches B, or null. */
export function contactTime(w: WhatIf, shift: number): { t: number; point: Pt } | null {
  const b = w.b.path
  for (let i = 0; i < b.length; i++) {
    const t = b[i][0]
    const a = poseA(w, t - shift)
    if (!a) continue
    const pb = { x: b[i][1], y: b[i][2], hdg: (b[i] as number[])[3] ?? 0 }
    if (gapAt(w, a, pb) <= 0) return { t, point: [pb.x, pb.y] }
  }
  return null
}

/**
 * Times each road user occupies the conflict zone (body within the other's
 * half-width of the conflict point). Used for the margin timeline.
 */
export function occupancy(w: WhatIf, point: Pt, shift = 0) {
  const [len, wid] = w.a.dims_m
  const bHalf = w.b.dims_m ? w.b.dims_m[1] / 2 : w.b.radius_m
  const a: [number, number] | null = interval(w.a.path.map((r) => r[0]), (t) => {
    const p = poseA(w, t - shift)
    return !!p && gapRectCircle(p.x, p.y, p.hdg, len, wid, point[0], point[1], bHalf) <= 0
  })
  const b: [number, number] | null = interval(w.b.path.map((r) => r[0]), (t) => {
    const p = poseB(w, t)
    if (!p) return false
    if (w.b.dims_m) return gapRectCircle(p.x, p.y, p.hdg, w.b.dims_m[0], w.b.dims_m[1], point[0], point[1], wid / 2) <= 0
    return Math.hypot(p.x - point[0], p.y - point[1]) <= w.b.radius_m + wid / 2
  })
  return { a, b }
}

function interval(times: number[], inside: (t: number) => boolean): [number, number] | null {
  let lo = NaN
  let hi = NaN
  // Refine at 30 Hz between path samples.
  if (!times.length) return null
  for (let t = times[0]; t <= times[times.length - 1]; t += 1 / 30) {
    if (inside(t)) {
      if (Number.isNaN(lo)) lo = t
      hi = t
    }
  }
  return Number.isNaN(lo) ? null : [lo, hi]
}

export function footprintImage(w: WhatIf, p: Pose): Pt[] {
  const [len, wid] = w.a.dims_m
  return rectCorners(p.x, p.y, p.hdg, len, wid).map(([x, y]) => applyH(w.homography_inv, x, y))
}

export function toImage(w: WhatIf, x: number, y: number): Pt {
  return applyH(w.homography_inv, x, y)
}

export function shiftLabel(shift: number) {
  if (Math.abs(shift) < 0.025) return 'exactly when they did'
  return `${Math.abs(shift).toFixed(2)} s ${shift > 0 ? 'later' : 'earlier'}`
}
