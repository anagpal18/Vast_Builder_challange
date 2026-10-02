// Shared math for the browser (overlay, WHAT-IF ghost, calibration) and the
// Node mock generator. Plain TS with erasable syntax only so Node can run it.

import type { Mat3, Pt } from '../types.ts'

export type Vec3 = [number, number, number]
export type Mat34 = [Vec3 & number[], number[], number[]] | number[][]

/** Apply a 3x3 homography to a 2D point. */
export function applyH(H: Mat3 | number[][], x: number, y: number): Pt {
  const p0 = H[0][0] * x + H[0][1] * y + H[0][2]
  const p1 = H[1][0] * x + H[1][1] * y + H[1][2]
  const p2 = H[2][0] * x + H[2][1] * y + H[2][2]
  return [p0 / p2, p1 / p2]
}

export function invert3(m: number[][]): Mat3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) throw new Error('singular matrix')
  const s = 1 / det
  return [
    [A * s, -(b * i - c * h) * s, (b * f - c * e) * s],
    [B * s, (a * i - c * g) * s, -(a * f - c * d) * s],
    [C * s, -(a * h - b * g) * s, (a * e - b * d) * s],
  ]
}

/** Solve Ax=b (n x n) by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('degenerate point set')
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const k = M[r][c] / M[c][c]
      for (let k2 = c; k2 <= n; k2++) M[r][k2] -= k * M[c][k2]
    }
  }
  return M.map((row, i) => row[n] / row[i])
}

/**
 * Homography from >= 4 point pairs (src -> dst), least squares with h33 = 1.
 * Used by the calibration tool: src = image pixels, dst = ground meters.
 */
export function solveHomography(src: Pt[], dst: Pt[]): Mat3 {
  if (src.length < 4 || src.length !== dst.length) throw new Error('need >= 4 matching points')
  // Normal equations of the 2N x 8 DLT system.
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0))
  const Atb = new Array(8).fill(0)
  const addRow = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j]
    }
  }
  src.forEach(([x, y], k) => {
    const [X, Y] = dst[k]
    addRow([x, y, 1, 0, 0, 0, -x * X, -y * X], X)
    addRow([0, 0, 0, x, y, 1, -x * Y, -y * Y], Y)
  })
  const h = solve(AtA, Atb)
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ]
}

/** Mean reprojection error (in dst units) of a homography over point pairs. */
export function reprojectionError(H: Mat3, src: Pt[], dst: Pt[]): number {
  let sum = 0
  src.forEach(([x, y], i) => {
    const [X, Y] = applyH(H, x, y)
    sum += Math.hypot(X - dst[i][0], Y - dst[i][1])
  })
  return sum / src.length
}

// ---- Pinhole camera (generator only, but harmless in the browser) ----------

export interface CameraParams {
  /** camera position in ground meters, z up */
  pos: Vec3
  /** point on the ground the camera looks at */
  target: Vec3
  focal_px: number
  width: number
  height: number
}

export interface CameraModel {
  P: number[][] // 3x4
  /** ground -> image */
  H_g2i: Mat3
  /** image -> ground */
  H_i2g: Mat3
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2])
  return [a[0] / l, a[1] / l, a[2] / l]
}

export function cameraModel(c: CameraParams): CameraModel {
  const f = norm(sub(c.target, c.pos))
  const r = norm(cross(f, [0, 0, 1]))
  const d = cross(f, r) // image "down"
  const R = [r, d, f]
  const t = R.map((row) => -(row[0] * c.pos[0] + row[1] * c.pos[1] + row[2] * c.pos[2]))
  const K = [
    [c.focal_px, 0, c.width / 2],
    [0, c.focal_px, c.height / 2],
    [0, 0, 1],
  ]
  const Rt = R.map((row, i) => [row[0], row[1], row[2], t[i]])
  const P = K.map((krow) => [0, 1, 2, 3].map((j) => krow[0] * Rt[0][j] + krow[1] * Rt[1][j] + krow[2] * Rt[2][j]))
  const H_g2i: Mat3 = [
    [P[0][0], P[0][1], P[0][3]],
    [P[1][0], P[1][1], P[1][3]],
    [P[2][0], P[2][1], P[2][3]],
  ]
  return { P, H_g2i, H_i2g: invert3(H_g2i) }
}

/** Project a 3D ground-frame point; returns null when behind the camera. */
export function project(P: number[][], x: number, y: number, z: number): Pt | null {
  const w = P[2][0] * x + P[2][1] * y + P[2][2] * z + P[2][3]
  if (w <= 0.1) return null
  return [(P[0][0] * x + P[0][1] * y + P[0][2] * z + P[0][3]) / w, (P[1][0] * x + P[1][1] * y + P[1][2] * z + P[1][3]) / w]
}

// ---- Footprints + gaps ---------------------------------------------------------

/** Corners of an oriented rectangle (length along heading). heading in degrees, 0 = +x (east), CCW. */
export function rectCorners(cx: number, cy: number, headingDeg: number, len: number, wid: number): Pt[] {
  const h = (headingDeg * Math.PI) / 180
  const ux = Math.cos(h)
  const uy = Math.sin(h)
  const hl = len / 2
  const hw = wid / 2
  return [
    [cx + ux * hl - uy * hw, cy + uy * hl + ux * hw],
    [cx + ux * hl + uy * hw, cy + uy * hl - ux * hw],
    [cx - ux * hl + uy * hw, cy - uy * hl - ux * hw],
    [cx - ux * hl - uy * hw, cy - uy * hl + ux * hw],
  ]
}

/** Signed gap between an oriented rectangle and a circle (<= 0 means touching). */
export function gapRectCircle(
  cx: number, cy: number, headingDeg: number, len: number, wid: number,
  px: number, py: number, radius: number,
): number {
  const h = (headingDeg * Math.PI) / 180
  const dx = px - cx
  const dy = py - cy
  // circle center in the rectangle's local frame
  const lx = dx * Math.cos(h) + dy * Math.sin(h)
  const ly = -dx * Math.sin(h) + dy * Math.cos(h)
  const ox = Math.max(Math.abs(lx) - len / 2, 0)
  const oy = Math.max(Math.abs(ly) - wid / 2, 0)
  const outside = Math.hypot(ox, oy)
  const inside = outside === 0 ? -Math.min(len / 2 - Math.abs(lx), wid / 2 - Math.abs(ly)) : 0
  return (outside > 0 ? outside : inside) - radius
}

/** Linear interpolation into a time-sorted path of [t, ...values]. */
export function samplePath<T extends number[]>(path: T[], t: number): number[] | null {
  if (!path.length || t < path[0][0] || t > path[path.length - 1][0]) return null
  let lo = 0
  let hi = path.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (path[mid][0] <= t) lo = mid
    else hi = mid
  }
  const a = path[lo]
  const b = path[hi]
  const span = b[0] - a[0] || 1
  const k = (t - a[0]) / span
  return a.map((v, i) => {
    if (i === 3 && a.length === 4) {
      // heading: interpolate the short way round
      let d = b[i] - v
      if (d > 180) d -= 360
      if (d < -180) d += 360
      return v + d * k
    }
    return v + (b[i] - v) * k
  })
}
