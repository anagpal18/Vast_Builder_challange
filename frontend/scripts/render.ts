// Software renderer for mock traffic-camera footage. The static ground is
// back-projected per pixel through the camera homography once per camera, then
// each frame copies it and rasterises road users as projected 3D boxes.
// Frames are piped to ffmpeg as raw RGB.

import { spawn } from 'node:child_process'
import { applyH, project } from '../src/lib/geometry.ts'
import type { Pt } from '../src/types.ts'
import { CW_IN, CW_OUT, ROAD_HALF, LANE, BIKE_LANE, mulberry32, type Actor, type CameraDef, type State } from './scene.ts'

export const W = 960
export const H = 540
export const FPS = 15

type RGB = [number, number, number]

// ---- background -----------------------------------------------------------------

function hashNoise(x: number, y: number) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

function groundColor(cam: CameraDef, gx: number, gy: number): RGB {
  const R = ROAD_HALF
  const ax = Math.abs(gx)
  const ay = Math.abs(gy)
  const n = hashNoise(Math.floor(gx * 6), Math.floor(gy * 6)) * 10 - 5
  const asphalt: RGB = [58 + n, 60 + n, 64 + n]
  const white: RGB = [214, 214, 206]
  const yellow: RGB = [214, 176, 60]
  const concrete: RGB = [146 + n, 144 + n, 138 + n]
  const inter = cam.layout === 'intersection'

  const onEW = ay <= R
  const onNS = inter && ax <= R
  if (onEW || onNS) {
    // Crosswalk zebra bands.
    if (inter) {
      if (ax >= CW_IN && ax <= CW_OUT && onEW && !onNS) return Math.floor((gy + R) / 0.6) % 2 === 0 ? white : asphalt
      if (ay >= CW_IN && ay <= CW_OUT && onNS && !onEW) return Math.floor((gx + R) / 0.6) % 2 === 0 ? white : asphalt
      // Stop lines.
      if (onNS && !onEW && ay > CW_OUT + 0.4 && ay < CW_OUT + 0.8 && gx * gy < 0) return white
      if (onEW && !onNS && ax > CW_OUT + 0.4 && ax < CW_OUT + 0.8 && gx * gy > 0) return white
    } else if (ax <= 1.5) {
      return Math.floor((gy + R) / 0.6) % 2 === 0 ? white : asphalt
    }
    const inBox = onEW && onNS
    if (!inBox) {
      // Double yellow centre line + dashed lane / bike-lane edges.
      const along = onEW && !onNS ? gx : gy
      const across = onEW && !onNS ? gy : gx
      const ac = Math.abs(across)
      if (Math.abs(ac - 0.12) < 0.06) return yellow
      if (Math.abs(ac - (LANE + 1.75)) < 0.07 && Math.floor(along / 3) % 2 === 0) return white
      if (cam.site_id === 'SITE_C' && Math.abs(ac - (BIKE_LANE - 1.25)) < 0.08) return white
      if (cam.site_id === 'SITE_C' && ac > BIKE_LANE - 1.25 && ac < R) return [62 + n, 92 + n, 70 + n] // green bike lane
    }
    return asphalt
  }
  // Sidewalks + curb.
  const nearRoad = (inter ? Math.min(ax, ay) : ay) - R
  if (nearRoad < 0.25) return [176, 174, 168]
  if (nearRoad < 3.5) {
    const joint = (Math.abs(gx) % 2 < 0.06 || Math.abs(gy) % 2 < 0.06)
    return joint ? [118, 116, 110] : concrete
  }
  // Lots: alternating grass / building roofs / parking by block.
  const bx = Math.floor(gx / 14)
  const by = Math.floor(gy / 14)
  const k = hashNoise(bx, by)
  if (k < 0.4) return [62 + n, 84 + n, 52 + n]
  if (k < 0.75) return [88 + n, 82 + n, 78 + n]
  return [70 + n, 72 + n, 76 + n]
}

export function renderBackground(cam: CameraDef): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(W * H * 3)
  const ss = [0.25, 0.75]
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      let r = 0, g = 0, b = 0
      for (const dy of ss) for (const dx of ss) {
        const [gx, gy] = applyH(cam.model.H_i2g, u + dx, v + dy)
        const ok = project(cam.model.P, gx, gy, 0) !== null
        const dist = Math.hypot(gx - cam.pos[0], gy - cam.pos[1])
        let c: RGB
        if (!ok || dist > 160) {
          const k = v / H
          c = cam.night ? [10 + 14 * k, 14 + 16 * k, 30 + 18 * k] : [150 + 40 * k, 168 + 30 * k, 186 + 16 * k]
        } else {
          c = groundColor(cam, gx, gy)
          const haze = Math.min(1, Math.max(0, (dist - 50) / 100))
          const hz: RGB = cam.night ? [16, 20, 34] : [170, 184, 198]
          c = [c[0] + (hz[0] - c[0]) * haze, c[1] + (hz[1] - c[1]) * haze, c[2] + (hz[2] - c[2]) * haze]
          if (cam.night) {
            // Street lights: warm pools every 20 m along both curbs.
            let light = 0.16
            for (let lx = -60; lx <= 60; lx += 20) for (const ly of [-ROAD_HALF - 1, ROAD_HALF + 1]) {
              const d = Math.hypot(gx - lx, gy - ly)
              light += 0.9 * Math.exp(-(d * d) / 60)
            }
            light = Math.min(1, light)
            c = [c[0] * light * 1.05, c[1] * light * 0.92, c[2] * light * 0.75]
          }
        }
        r += c[0]; g += c[1]; b += c[2]
      }
      const i = (v * W + u) * 3
      buf[i] = r / 4
      buf[i + 1] = g / 4
      buf[i + 2] = b / 4
    }
  }
  return buf
}

// ---- rasteriser -------------------------------------------------------------------

function fillPoly(buf: Uint8ClampedArray, pts: Pt[], c: RGB, alpha = 1) {
  if (pts.length < 3) return
  let minY = Infinity, maxY = -Infinity
  for (const p of pts) {
    minY = Math.min(minY, p[1])
    maxY = Math.max(maxY, p[1])
  }
  minY = Math.max(0, Math.ceil(minY))
  maxY = Math.min(H - 1, Math.floor(maxY))
  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length]
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]))
    }
    xs.sort((p, q) => p - q)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]))
      const x1 = Math.min(W - 1, Math.floor(xs[k + 1]))
      for (let x = x0; x <= x1; x++) {
        const i = (y * W + x) * 3
        if (alpha >= 1) {
          buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]
        } else {
          buf[i] += (c[0] - buf[i]) * alpha
          buf[i + 1] += (c[1] - buf[i + 1]) * alpha
          buf[i + 2] += (c[2] - buf[i + 2]) * alpha
        }
      }
    }
  }
}

function hull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Pt[] = []
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

function disc(buf: Uint8ClampedArray, cx: number, cy: number, r: number, c: RGB, alpha = 1) {
  const pts: Pt[] = Array.from({ length: 12 }, (_, i) => [cx + Math.cos((i / 12) * Math.PI * 2) * r, cy + Math.sin((i / 12) * Math.PI * 2) * r])
  fillPoly(buf, pts, c, alpha)
}

/** Ground-frame corners of a box footprint (for a state + dims), CCW. */
function footprint(s: State, len: number, wid: number): Pt[] {
  const h = (s.hdg * Math.PI) / 180
  const ux = Math.cos(h), uy = Math.sin(h)
  return [
    [s.x + ux * len / 2 - uy * wid / 2, s.y + uy * len / 2 + ux * wid / 2],
    [s.x + ux * len / 2 + uy * wid / 2, s.y + uy * len / 2 - ux * wid / 2],
    [s.x - ux * len / 2 + uy * wid / 2, s.y - uy * len / 2 - ux * wid / 2],
    [s.x - ux * len / 2 - uy * wid / 2, s.y - uy * len / 2 + ux * wid / 2],
  ]
}

const shade = (c: RGB, k: number): RGB => [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)]

/** Image-space box (+ foot point) of an actor, as YOLO would report it. */
export function imageBox(cam: CameraDef, a: Actor, s: State): { u: number; v: number; x1: number; y1: number; x2: number; y2: number } | null {
  const [len, wid, ht] = s.lying ? [1.75, 0.5, 0.35] : a.dims
  const fp = footprint(s, len, wid)
  const pts: Pt[] = []
  for (const [x, y] of fp) for (const z of [0, ht]) {
    const p = project(cam.model.P, x, y, z)
    if (!p) return null
    pts.push(p)
  }
  const foot = project(cam.model.P, s.x, s.y, 0)
  if (!foot) return null
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const box = { u: foot[0], v: foot[1], x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
  if (box.x2 < 0 || box.x1 > W || box.y2 < 0 || box.y1 > H) return null
  return box
}

function drawBox(buf: Uint8ClampedArray, cam: CameraDef, s: State, dims: [number, number, number], color: RGB, roof: RGB, z0 = 0) {
  const [len, wid, ht] = dims
  const fp = footprint(s, len, wid)
  const base = fp.map(([x, y]) => project(cam.model.P, x, y, z0))
  const top = fp.map(([x, y]) => project(cam.model.P, x, y, z0 + ht))
  if (base.some((p) => !p) || top.some((p) => !p)) return
  // Soft shadow on the ground (day only).
  if (!cam.night && z0 === 0) {
    const sh = fp.map(([x, y]) => project(cam.model.P, x + 0.5, y - 0.4, 0))
    if (sh.every(Boolean)) fillPoly(buf, hull([...(sh as Pt[]), ...(base as Pt[])]), [20, 22, 26], 0.35)
  }
  fillPoly(buf, hull([...(base as Pt[]), ...(top as Pt[])]), color)
  fillPoly(buf, top as Pt[], roof)
}

function drawActor(buf: Uint8ClampedArray, cam: CameraDef, a: Actor, s: State, t: number) {
  const night = cam.night
  const k = night ? 0.45 : 1
  const body = shade(a.color, k * 0.82)
  const roof = shade(a.color, k * 1.12)
  if (a.kind === 'vehicle') {
    drawBox(buf, cam, s, a.dims, body, roof)
    // Windshield band on the roof front for direction cues.
    const h = (s.hdg * Math.PI) / 180
    const fwd: State = { x: s.x + Math.cos(h) * a.dims[0] * 0.18, y: s.y + Math.sin(h) * a.dims[0] * 0.18, hdg: s.hdg }
    const glass = footprint(fwd, a.dims[0] * 0.22, a.dims[1] * 0.9).map(([x, y]) => project(cam.model.P, x, y, a.dims[2] + 0.01))
    if (glass.every(Boolean)) fillPoly(buf, glass as Pt[], night ? [20, 24, 30] : [40, 52, 64])
    if (night && !a.parked) {
      for (const side of [-1, 1]) {
        const off = a.dims[1] * 0.35 * side
        const fx = s.x + Math.cos(h) * a.dims[0] / 2 - Math.sin(h) * off
        const fy = s.y + Math.sin(h) * a.dims[0] / 2 + Math.cos(h) * off
        const p = project(cam.model.P, fx, fy, 0.7)
        if (p) {
          disc(buf, p[0], p[1], 9, [255, 236, 190], 0.25)
          disc(buf, p[0], p[1], 2.8, [255, 250, 230])
        }
        const rx = s.x - Math.cos(h) * a.dims[0] / 2 - Math.sin(h) * off
        const ry = s.y - Math.sin(h) * a.dims[0] / 2 + Math.cos(h) * off
        const q = project(cam.model.P, rx, ry, 0.8)
        if (q) disc(buf, q[0], q[1], 2.2, [230, 30, 30])
      }
      // Headlight throw on the road.
      const cone: Pt[] = []
      for (const [dx, dy] of [[a.dims[0] / 2, -0.9], [a.dims[0] / 2 + 14, -3], [a.dims[0] / 2 + 14, 3], [a.dims[0] / 2, 0.9]]) {
        const gx = s.x + Math.cos(h) * dx - Math.sin(h) * dy
        const gy = s.y + Math.sin(h) * dx + Math.cos(h) * dy
        const p = project(cam.model.P, gx, gy, 0)
        if (p) cone.push(p)
      }
      if (cone.length === 4) fillPoly(buf, cone, [255, 240, 200], 0.16)
    }
    return
  }
  if (a.kind === 'bike') {
    drawBox(buf, cam, s, [1.75, 0.18, 0.9], shade([30, 30, 34], k), shade([60, 60, 66], k))
    drawBox(buf, cam, s, [0.45, 0.42, 0.85], shade(a.color, k * 0.85), shade(a.color, k), 0.9)
    return
  }
  // Person: legs, torso, head; a slight bob while walking.
  if (s.lying) {
    drawBox(buf, cam, { ...s }, [1.75, 0.5, 0.35], shade(a.color, k * 0.8), shade(a.color, k))
    return
  }
  const bob = Math.abs(Math.sin(t * 7 + a.id)) * 0.03
  drawBox(buf, cam, s, [0.3, 0.36, 0.85], shade([40, 44, 58], k), shade([50, 54, 70], k))
  drawBox(buf, cam, s, [0.32, 0.46, 0.62], shade(a.color, k * 0.85), shade(a.color, k), 0.85 + bob)
  drawBox(buf, cam, s, [0.22, 0.22, 0.24], shade([206, 168, 140], k), shade([60, 44, 34], k), 1.47 + bob)
}

// ---- encode ------------------------------------------------------------------------

export async function renderVideo(opts: {
  cam: CameraDef
  actors: Actor[]
  duration: number
  out: string
  label: string
  background?: Uint8ClampedArray
}) {
  const bg = opts.background ?? renderBackground(opts.cam)
  const font = 'C\\:/Windows/Fonts/consola.ttf'
  const vf = `drawtext=fontfile='${font}':text='${opts.label}  %{pts\\:hms}':x=14:y=12:fontsize=17:fontcolor=white@0.85:box=1:boxcolor=black@0.45:boxborderw=6`
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-bf', '0',
    '-movflags', '+faststart', opts.out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] })
  const done = new Promise<void>((res, rej) => ff.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`)))))
  const frames = Math.round(opts.duration * FPS)
  const rand = mulberry32(7)
  const camXY = [opts.cam.pos[0], opts.cam.pos[1]]
  for (let f = 0; f < frames; f++) {
    const t = f / FPS
    const buf = new Uint8ClampedArray(bg)
    const live: { a: Actor; s: State; d: number }[] = []
    for (const a of opts.actors) {
      const s = a.stateAt(t)
      if (s) live.push({ a, s, d: Math.hypot(s.x - camXY[0], s.y - camXY[1]) })
    }
    live.sort((p, q) => q.d - p.d)
    for (const { a, s } of live) drawActor(buf, opts.cam, a, s, t)
    // Light sensor grain so it reads as camera footage.
    for (let i = 0; i < 2500; i++) {
      const p = Math.floor(rand() * W * H) * 3
      const d = (rand() - 0.5) * 30
      buf[p] += d; buf[p + 1] += d; buf[p + 2] += d
    }
    if (!ff.stdin.write(Buffer.from(buf.buffer))) await new Promise((r) => ff.stdin.once('drain', r))
  }
  ff.stdin.end()
  await done
}

export function ffmpeg(args: string[]) {
  return new Promise<void>((res, rej) => {
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' })
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${args.join(' ')} exited ${c}`))))
  })
}
