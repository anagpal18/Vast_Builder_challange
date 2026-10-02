import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, mediaUrl, USE_MOCK, API_BASE, MOCK_ROOT } from '../data/api.ts'
import { useAsync, useConfig } from '../data/hooks.ts'
import { useRoute, useRun } from '../store.ts'
import { CLASS_LABEL, CONFLICT_LABEL, MOVEMENT_LABEL, mph, SEVERITY_COLOR } from '../lib/labels.ts'
import { contactTime, curveGap, gapAt, inContact, occupancy, poseA, poseB, shiftLabel, toImage, footprintImage } from '../lib/whatif.ts'
import { rectCorners } from '../lib/geometry.ts'
import { MarginBar, VerdictBadge } from '../components/bits.tsx'
import Cascade from './Cascade.tsx'
import type { Camera, EventDetail, Ground, OverlayRow, Pt, WhatIf } from '../types.ts'

const COL_A = '#ff8a3d'
const COL_B = '#4ea8ff'
const COL_GHOST = '#a5f3fc'

type CrashPhase = 'idle' | 'approach' | 'impact' | 'after'

export default function Theater({ id }: { id: string }) {
  const ev = useAsync(() => api.event(id), [id])
  const wi = useAsync(() => api.whatif(id), [id])
  const { cameras, sites } = useConfig()
  const go = useRoute((s) => s.go)
  const candidates = useRun((s) => s.candidates)
  const ranked = useMemo(() => Object.values(candidates).filter((e) => e.status === 'verified').sort((a, b) => b.score - a.score), [candidates])

  if (ev.error) return <div className="p-10 text-severe">Could not load {id}: {ev.error}</div>
  if (!ev.data || !wi.data) return <div className="p-10 text-mute">Loading {id}…</div>
  const cam = cameras[ev.data.camera_id]
  if (!cam) return <div className="p-10 text-mute">Loading camera…</div>
  const idx = ranked.findIndex((e) => e.event_id === id)

  return (
    <div className="h-full overflow-y-auto px-5 pb-24">
      <div className="mb-3 flex items-center gap-3 text-sm">
        <button onClick={() => go('#/')} className="rounded-md border border-line px-3 py-1.5 text-mute hover:text-fog">← All close calls</button>
        {idx >= 0 && <span className="font-mono text-mute">#{idx + 1} of {ranked.length}</span>}
        {idx > 0 && <button onClick={() => go(`#/event/${ranked[idx - 1].event_id}`)} className="text-mute hover:text-fog">‹ prev</button>}
        {idx >= 0 && idx < ranked.length - 1 && <button onClick={() => go(`#/event/${ranked[idx + 1].event_id}`)} className="text-mute hover:text-fog">next ›</button>}
        <span className="ml-auto font-mono text-xs text-mute">{id} · {cam.camera_id} · {sites[ev.data.site_id]?.name}</span>
      </div>
      <Stage ev={ev.data} w={wi.data} cam={cam} />
      <Cascade ev={ev.data} />
    </div>
  )
}

function Stage({ ev, w, cam }: { ev: EventDetail; w: WhatIf; cam: Camera }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [T, setT] = useState(ev.clip.t0)
  const tRef = useRef(ev.clip.t0)
  const [shift, setShift] = useState(0)
  const shiftRef = useRef(0)
  shiftRef.current = shift
  const [freeze, setFreeze] = useState(false)
  const [crash, setCrash] = useState<CrashPhase>('idle')
  const crashRef = useRef<CrashPhase>('idle')
  crashRef.current = crash
  const impactAt = useRef<{ wall: number; point: Pt } | null>(null)
  const [shake, setShake] = useState(false)
  const [showCrashClip, setShowCrashClip] = useState(false)
  const frozeThisLoop = useRef(false)

  const contact = useMemo(() => (inContact(w, shift) ? contactTime(w, shift) : null), [w, shift])
  const contactRef = useRef(contact)
  contactRef.current = contact

  const toCamTime = (mediaTime: number) => ev.clip.t0 + mediaTime

  const onFrame = useCallback(
    (camT: number) => {
      const prev = tRef.current
      tRef.current = camT
      setT(camT)
      const v = videoRef.current
      if (!v) return
      if (camT < prev - 0.5) frozeThisLoop.current = false // looped
      // Act 3 beat: freeze one second at the real conflict, label the margin.
      if (shiftRef.current === 0 && crashRef.current === 'idle' && !frozeThisLoop.current && prev < ev.t_conflict && camT >= ev.t_conflict) {
        frozeThisLoop.current = true
        v.pause()
        setFreeze(true)
        setTimeout(() => {
          setFreeze(false)
          v.play().catch(() => {})
        }, 1400)
      }
      // Act 4: crash simulation when the ghost touches B.
      const c = contactRef.current
      if (c) {
        if (crashRef.current === 'approach' && camT >= c.t - 0.9) v.playbackRate = 0.3
        if (prev < c.t && camT >= c.t && crashRef.current !== 'impact') {
          v.pause()
          v.playbackRate = 1
          impactAt.current = { wall: performance.now(), point: c.point }
          setCrash('impact')
          setShake(true)
          setTimeout(() => setShake(false), 500)
          setTimeout(() => setCrash('after'), 1500)
        }
      }
    },
    [ev.t_conflict],
  )

  // `autoPlay` alone is unreliable after a programmatic route change (the
  // auto-open from the collapse); start playback explicitly once data is ready.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.muted = true
    const start = () => {
      if (v.paused) v.play().catch((e) => console.warn('theater play()', e.name, e.message))
    }
    if (v.readyState >= 2) start()
    v.addEventListener('canplay', start, { once: true })
    return () => v.removeEventListener('canplay', start)
  }, [])

  // Drive the clock from the decoder (requestVideoFrameCallback), with fallbacks.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    let handle = 0
    const rvfc = (_: number, meta: { mediaTime: number }) => {
      onFrame(toCamTime(meta.mediaTime))
      handle = v.requestVideoFrameCallback!(rvfc)
    }
    if (v.requestVideoFrameCallback) handle = v.requestVideoFrameCallback(rvfc)
    const onSeek = () => onFrame(toCamTime(v.currentTime))
    v.addEventListener('seeked', onSeek)
    let raf = 0
    if (!v.requestVideoFrameCallback) {
      const loop = () => {
        onFrame(toCamTime(v.currentTime))
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
    }
    return () => {
      v.cancelVideoFrameCallback?.(handle)
      cancelAnimationFrame(raf)
      v.removeEventListener('seeked', onSeek)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onFrame])

  const playCrash = () => {
    if (!w.impact) return
    const v = videoRef.current
    if (!v) return
    setShift(w.impact.shift_s)
    setCrash('approach')
    impactAt.current = null
    const target = Math.max(0, w.impact.t - 2.6 - ev.clip.t0)
    v.currentTime = target
    v.playbackRate = 1
    v.play().catch((e) => console.warn('crash play()', e.name, e.message))
  }

  const resetWhatIf = () => {
    setShift(0)
    setCrash('idle')
    impactAt.current = null
    const v = videoRef.current
    if (v) {
      v.playbackRate = 1
      v.play().catch(() => {})
    }
  }

  const onSlide = (s: number) => {
    setShift(s)
    if (crash !== 'idle') setCrash('idle')
    impactAt.current = null
  }

  const gapNow = curveGap(w, shift)
  const bannerShift = crash === 'impact' || crash === 'after' ? shift : null

  return (
    <div className={shake ? 'shake' : ''}>
      <div className="grid grid-cols-[minmax(0,1.62fr)_minmax(0,1fr)] gap-4">
        {/* LEFT: video + overlays, WHAT-IF, margin timeline */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="relative overflow-hidden rounded-xl border border-line bg-black">
            <video
              ref={videoRef}
              src={mediaUrl(ev.clip.url)}
              muted
              autoPlay
              loop
              playsInline
              className="block aspect-video w-full"
            />
            <OverlayCanvas ev={ev} w={w} cam={cam} tRef={tRef} shiftRef={shiftRef} impactAt={impactAt} freeze={freeze} />
            <AnimatePresence>
              {freeze && (
                <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute inset-x-0 top-6 text-center">
                  <span className="rounded-xl bg-ink/85 px-6 py-3 font-mono text-5xl font-black" style={{ color: SEVERITY_COLOR[ev.severity] }}>
                    {ev.pet_s.toFixed(1)} seconds apart
                  </span>
                </motion.div>
              )}
              {bannerShift !== null && (
                <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="pointer-events-none absolute inset-x-0 top-6 flex flex-col items-center gap-3">
                  <span className="rounded-xl bg-severe px-6 py-3 font-mono text-4xl font-black text-white shadow-[0_0_60px_rgba(255,75,75,0.7)]">
                    Collision at {bannerShift > 0 ? '+' : '−'}{Math.abs(bannerShift).toFixed(2)} s · {mph(w.impact?.speed_mps ?? ev.a.speed_mps)} mph
                  </span>
                  {crash === 'after' && (
                    <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-lg bg-ink/85 px-4 py-2 text-lg">
                      {ev.pet_s < 0.05 && ev.closest_m != null
                        ? `They made it home ${ev.closest_m.toFixed(1)} m apart, at the same moment.`
                        : `They made it home with ${ev.pet_s.toFixed(1)} seconds to spare.`}
                    </motion.span>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
            <VideoControls video={videoRef} T={T} ev={ev} />
          </div>

          <WhatIfPanel w={w} ev={ev} shift={shift} gap={gapNow} contact={!!contact} onSlide={onSlide} onCrash={playCrash} onReset={resetWhatIf} onShowClip={() => setShowCrashClip(true)} />
          <MarginTimeline ev={ev} w={w} T={T} shift={shift} />
        </div>

        {/* RIGHT: bird's-eye + verdict */}
        <div className="flex min-w-0 flex-col gap-3">
          <BirdsEye ev={ev} w={w} ground={cam.ground} T={T} shift={shift} crash={crash === 'impact' || crash === 'after'} />
          <VerdictPanel ev={ev} />
        </div>
      </div>
      <AnimatePresence>{showCrashClip && <CrashClip onClose={() => setShowCrashClip(false)} pet={ev.pet_s} />}</AnimatePresence>
    </div>
  )
}

// ---- Video overlay (canvas) ---------------------------------------------------------

function rowAt(rows: OverlayRow[], t: number): OverlayRow | null {
  let best: OverlayRow | null = null
  for (const r of rows) {
    if (r[0] <= t + 1e-3) best = r
    else break
  }
  if (best && t - best[0] > 0.2) return null
  return best
}

function OverlayCanvas({ ev, w, cam, tRef, shiftRef, impactAt, freeze }: {
  ev: EventDetail; w: WhatIf; cam: Camera
  tRef: React.RefObject<number>; shiftRef: React.RefObject<number>
  impactAt: React.RefObject<{ wall: number; point: Pt } | null>; freeze: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const freezeRef = useRef(freeze)
  freezeRef.current = freeze
  useEffect(() => {
    const c = ref.current!
    const ctx = c.getContext('2d')!
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const rect = c.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      if (c.width !== Math.round(rect.width * dpr)) {
        c.width = Math.round(rect.width * dpr)
        c.height = Math.round(rect.height * dpr)
      }
      const k = (rect.width / cam.width) * dpr
      ctx.setTransform(k, 0, 0, k, 0, 0)
      ctx.clearRect(0, 0, cam.width, cam.height)
      const T = tRef.current ?? ev.clip.t0
      const shift = shiftRef.current ?? 0

      const trail = (rows: OverlayRow[], color: string) => {
        ctx.strokeStyle = color
        ctx.lineWidth = 3
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        let n = 0
        for (const r of rows) {
          if (r[0] > T) break
          if (n++ === 0) ctx.moveTo(r[1], r[2])
          else ctx.lineTo(r[1], r[2])
        }
        ctx.stroke()
      }
      const box = (r: OverlayRow | null, color: string, label: string) => {
        if (!r) return
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.strokeRect(r[3], r[4], r[5] - r[3], r[6] - r[4])
        ctx.fillStyle = color
        ctx.font = '600 12px Inter, sans-serif'
        const tw = ctx.measureText(label).width + 8
        ctx.fillRect(r[3], r[4] - 16, tw, 16)
        ctx.fillStyle = '#06080b'
        ctx.fillText(label, r[3] + 4, r[4] - 4)
      }

      trail(ev.overlay.a, COL_A)
      trail(ev.overlay.b, COL_B)
      const ra = rowAt(ev.overlay.a, T)
      const rb = rowAt(ev.overlay.b, T)
      box(ra, COL_A, `${CLASS_LABEL[ev.a.cls]} · ${mph(ev.a.speed_mps)} mph`)
      box(rb, COL_B, CLASS_LABEL[ev.b.cls])

      // Conflict point.
      const [cu, cv] = toImage(w, ev.conflict_point[0], ev.conflict_point[1])
      ctx.strokeStyle = freezeRef.current ? SEVERITY_COLOR[ev.severity] : 'rgba(255,255,255,0.85)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(cu, cv, freezeRef.current ? 16 + Math.sin(performance.now() / 90) * 4 : 9, 0, Math.PI * 2)
      ctx.moveTo(cu - 14, cv)
      ctx.lineTo(cu + 14, cv)
      ctx.moveTo(cu, cv - 14)
      ctx.lineTo(cu, cv + 14)
      ctx.stroke()

      // Live gap line between the real A and B (ground distance).
      const pa = poseA(w, T)
      const pb = poseB(w, T)
      if (pa && pb && ra && rb && shift === 0) {
        const g = gapAt(w, pa, pb)
        if (g < 12) {
          ctx.setLineDash([6, 5])
          ctx.strokeStyle = g < 1 ? '#ff4b4b' : g < 2.5 ? '#ffad1f' : 'rgba(255,255,255,0.7)'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(ra[1], ra[2])
          ctx.lineTo(rb[1], rb[2])
          ctx.stroke()
          ctx.setLineDash([])
          const mx = (ra[1] + rb[1]) / 2
          const my = (ra[2] + rb[2]) / 2
          const txt = `${Math.max(0, g).toFixed(1)} m`
          ctx.font = '700 15px "JetBrains Mono", monospace'
          const tw = ctx.measureText(txt).width + 10
          ctx.fillStyle = 'rgba(6,8,11,0.85)'
          ctx.fillRect(mx - tw / 2, my - 22, tw, 20)
          ctx.fillStyle = ctx.strokeStyle
          ctx.fillText(txt, mx - tw / 2 + 5, my - 7)
        }
      }

      // WHAT-IF ghost: A along its own path, shifted in time, projected with H_inv.
      if (Math.abs(shift) > 0.001) {
        const ga = poseA(w, T - shift)
        // Ghost trail (same path, drawn up to the ghost's position).
        ctx.strokeStyle = 'rgba(165,243,252,0.6)'
        ctx.setLineDash([4, 6])
        ctx.lineWidth = 2
        ctx.beginPath()
        let n = 0
        for (const [t, u, v] of w.image_paths.a) {
          if (t > T - shift) break
          if (n++ === 0) ctx.moveTo(u, v)
          else ctx.lineTo(u, v)
        }
        ctx.stroke()
        ctx.setLineDash([])
        if (ga) {
          const fp = footprintImage(w, ga)
          const lift = ra ? Math.max(14, (ra[6] - ra[4]) * 0.55) : 24
          ctx.fillStyle = 'rgba(165,243,252,0.18)'
          ctx.strokeStyle = COL_GHOST
          ctx.lineWidth = 2
          for (const off of [0, lift]) {
            ctx.beginPath()
            fp.forEach(([u, v], i) => (i ? ctx.lineTo(u, v - off) : ctx.moveTo(u, v - off)))
            ctx.closePath()
            ctx.fill()
            ctx.stroke()
          }
          ctx.beginPath()
          for (const [u, v] of fp) {
            ctx.moveTo(u, v)
            ctx.lineTo(u, v - lift)
          }
          ctx.stroke()
          const top = fp.reduce((m, p) => (p[1] < m[1] ? p : m))
          ctx.font = '600 12px Inter, sans-serif'
          ctx.fillStyle = COL_GHOST
          ctx.fillText(`ghost ${CLASS_LABEL[ev.a.cls]} · ${shift > 0 ? '+' : '−'}${Math.abs(shift).toFixed(2)} s`, top[0] - 30, top[1] - lift - 8)
        }
      }

      // Impact burst.
      const imp = impactAt.current
      if (imp) {
        const age = (performance.now() - imp.wall) / 1000
        const [iu, iv] = toImage(w, imp.point[0], imp.point[1])
        for (let i = 0; i < 3; i++) {
          const a = age - i * 0.15
          if (a < 0 || a > 1.4) continue
          ctx.strokeStyle = `rgba(255,75,75,${1 - a / 1.4})`
          ctx.lineWidth = 6 - i * 1.5
          ctx.beginPath()
          ctx.arc(iu, iv, 10 + a * 110, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.fillStyle = `rgba(255,75,75,${Math.max(0.25, 0.9 - age * 0.5)})`
        ctx.beginPath()
        ctx.arc(iu, iv, 9, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [ev, w, cam, tRef, shiftRef, impactAt])
  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" />
}

function VideoControls({ video, T, ev }: { video: React.RefObject<HTMLVideoElement | null>; T: number; ev: EventDetail }) {
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    const v = video.current
    if (!v) return
    const sync = () => setPaused(v.paused)
    v.addEventListener('play', sync)
    v.addEventListener('pause', sync)
    return () => {
      v.removeEventListener('play', sync)
      v.removeEventListener('pause', sync)
    }
  }, [video])
  const dur = ev.clip.t1 - ev.clip.t0
  const pos = Math.max(0, Math.min(1, (T - ev.clip.t0) / dur))
  const conflictPos = (ev.t_conflict - ev.clip.t0) / dur
  return (
    <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/90 to-transparent px-3 pt-8 pb-2">
      <button
        onClick={() => (video.current?.paused ? video.current.play() : video.current?.pause())}
        className="w-16 rounded bg-white/10 px-2 py-1 text-xs font-semibold hover:bg-white/20"
      >
        {paused ? 'Play' : 'Pause'}
      </button>
      <div
        className="relative h-1.5 flex-1 cursor-pointer rounded-full bg-white/15"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          if (video.current) video.current.currentTime = ((e.clientX - r.left) / r.width) * dur
        }}
      >
        <div className="absolute inset-y-0 left-0 rounded-full bg-white/70" style={{ width: `${pos * 100}%` }} />
        <div className="absolute -top-1 h-3.5 w-0.5 bg-severe" style={{ left: `${conflictPos * 100}%` }} title="closest moment" />
      </div>
      <span className="font-mono text-xs text-mute tabular">t = {T.toFixed(2)} s</span>
    </div>
  )
}

// ---- WHAT-IF panel ---------------------------------------------------------------------

function WhatIfPanel({ w, ev, shift, gap, contact, onSlide, onCrash, onReset, onShowClip }: {
  w: WhatIf; ev: EventDetail; shift: number; gap: number; contact: boolean
  onSlide: (s: number) => void; onCrash: () => void; onReset: () => void; onShowClip: () => void
}) {
  const color = gap <= 0 ? 'var(--color-severe)' : gap < 0.6 ? 'var(--color-severe)' : gap < 1.5 ? 'var(--color-moderate)' : 'var(--color-accept)'
  const pct = (s: number) => ((s + 3) / 6) * 100
  const who = ev.a.cls === 'car' ? 'driver' : CLASS_LABEL[ev.a.cls]
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-xs uppercase tracking-widest text-ghost">What if</div>
          <div className="text-xl font-semibold">
            What if the {who} had arrived <span className="font-mono text-ghost">{shiftLabel(shift)}</span>?
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-widest text-mute">closest gap</div>
          <div className="font-mono text-4xl font-black tabular" style={{ color }}>
            {gap <= 0 ? 'CONTACT' : `${gap.toFixed(2)} m`}
          </div>
        </div>
      </div>
      <div className="relative mt-4 mb-1">
        {/* contact ranges + snap marker drawn under the range input */}
        <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-line">
          {w.contact_ranges.map(([lo, hi]) => (
            <div key={lo} className="absolute inset-y-0 rounded-full bg-severe/40" style={{ left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }} />
          ))}
          <div className="absolute -top-1 h-4 w-0.5 bg-fog/60" style={{ left: '50%' }} />
          {w.first_contact_shift_s !== null && (
            <button
              onClick={() => onSlide(w.first_contact_shift_s!)}
              className="absolute -top-7 -translate-x-1/2 rounded bg-severe px-1.5 py-0.5 font-mono text-[11px] font-bold text-white"
              style={{ left: `${pct(w.first_contact_shift_s)}%` }}
              title="First contact"
            >
              {w.first_contact_shift_s > 0 ? '+' : '−'}{Math.abs(w.first_contact_shift_s).toFixed(2)} s
            </button>
          )}
        </div>
        <input
          type="range"
          min={-3}
          max={3}
          step={0.05}
          value={shift}
          onChange={(e) => onSlide(+e.target.value)}
          aria-label="Shift the driver's arrival time"
          className="relative z-10 w-full cursor-pointer appearance-none bg-transparent accent-[var(--color-ghost)]"
        />
      </div>
      <div className="flex justify-between font-mono text-[11px] text-mute">
        <span>3 s earlier</span>
        <span>as it happened</span>
        <span>3 s later</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {w.impact && (
          <button onClick={onCrash} className="rounded-lg bg-severe px-4 py-2 text-sm font-bold text-white hover:brightness-110">
            ▶ Show the crash ({w.impact.shift_s > 0 ? '+' : '−'}{Math.abs(w.impact.shift_s).toFixed(2)} s)
          </button>
        )}
        <button onClick={onReset} className="rounded-lg border border-line px-3 py-2 text-sm text-mute hover:text-fog">
          Back to what happened
        </button>
        <button onClick={onShowClip} className="rounded-lg border border-line px-3 py-2 text-sm text-mute hover:text-fog">
          Show the simulated crash clip
        </button>
        {!w.impact && (
          <span className="text-sm text-mute">No arrival time within ±3 s makes them touch: they passed side by side, {w.observed.min_gap_m?.toFixed(1)} m clear.</span>
        )}
        {contact && <span className="ml-auto text-sm font-semibold text-severe">The {who} would have hit the {CLASS_LABEL[ev.b.cls]}.</span>}
      </div>
      <div className="mt-2 text-[11px] text-mute">{w.disclaimer}</div>
    </div>
  )
}

// ---- Margin timeline ----------------------------------------------------------------------

function MarginTimeline({ ev, w, T, shift }: { ev: EventDetail; w: WhatIf; T: number; shift: number }) {
  const occ = useMemo(() => occupancy(w, ev.conflict_point), [w, ev.conflict_point])
  const ghost = useMemo(() => (Math.abs(shift) > 0.001 ? occupancy(w, ev.conflict_point, shift).a : null), [w, ev.conflict_point, shift])
  const t0 = ev.t_conflict - 3.5
  const t1 = ev.t_conflict + 3.5
  const x = (t: number) => `${((Math.max(t0, Math.min(t1, t)) - t0) / (t1 - t0)) * 100}%`
  const wpx = (a: number, b: number) => `${((Math.min(t1, b) - Math.max(t0, a)) / (t1 - t0)) * 100}%`
  const gapStart = ev.first_through === 'a' ? occ.a?.[1] : occ.b?.[1]
  const gapEnd = ev.first_through === 'a' ? occ.b?.[0] : occ.a?.[0]
  const Bar = ({ iv, color, label, dashed }: { iv: [number, number] | null; color: string; label: string; dashed?: boolean }) => (
    <div className="relative h-7">
      <span className="absolute -left-0 top-1 w-28 text-xs text-mute">{label}</span>
      <div className="absolute inset-y-1 left-28 right-0">
        {iv && <div className="absolute inset-y-0 rounded" style={{ left: x(iv[0]), width: wpx(iv[0], iv[1]), background: dashed ? 'transparent' : color, border: dashed ? `2px dashed ${color}` : undefined }} />}
      </div>
    </div>
  )
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs uppercase tracking-widest text-mute">Margin at the conflict point</span>
        <span className="font-mono text-sm">
          post-encroachment time <b style={{ color: SEVERITY_COLOR[ev.severity] }}>{ev.pet_s.toFixed(2)} s</b> · min time to collision {ev.min_ttc_s == null ? '–' : `${ev.min_ttc_s.toFixed(2)} s`}
        </span>
      </div>
      <div className="relative">
        <Bar iv={occ.a} color={COL_A} label={`${CLASS_LABEL[ev.a.cls]} in zone`} />
        {ghost && <Bar iv={ghost} color={COL_GHOST} label="ghost" dashed />}
        <Bar iv={occ.b} color={COL_B} label={`${CLASS_LABEL[ev.b.cls]} in zone`} />
        <div className="absolute inset-y-0 left-28 right-0">
          {gapStart !== undefined && gapEnd !== undefined && (
            <div className="absolute top-0 bottom-0 border-x border-dashed border-fog/50" style={{ left: x(gapStart), width: wpx(gapStart, gapEnd) }}>
              <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 rounded bg-ink px-1 font-mono text-xs font-bold" style={{ color: SEVERITY_COLOR[ev.severity] }}>
                {ev.pet_s.toFixed(1)} s
              </span>
            </div>
          )}
          <div className="absolute top-0 bottom-0 w-px bg-white" style={{ left: x(T) }} />
        </div>
      </div>
    </div>
  )
}

// ---- Bird's-eye reconstruction ---------------------------------------------------------------

function BirdsEye({ ev, w, ground, T, shift, crash }: { ev: EventDetail; w: WhatIf; ground: Ground; T: number; shift: number; crash: boolean }) {
  const [cx, cy] = ev.conflict_point
  const W = 46
  const H = 30
  // SVG y grows down; ground y grows north. Flip with y' = -y.
  const P = (x: number, y: number) => `${x},${-y}`
  const poly = (pts: Pt[]) => pts.map(([x, y]) => P(x, y)).join(' ')
  const pa = poseA(w, T)
  const pb = poseB(w, T)
  const ga = Math.abs(shift) > 0.001 ? poseA(w, T - shift) : null
  const trailA = w.a.path.filter((r) => r[0] <= T).map((r) => P(r[1], r[2])).join(' ')
  const trailB = w.b.path.filter((r) => r[0] <= T).map((r) => P(r[1], r[2])).join(' ')
  const rect = (p: { x: number; y: number; hdg: number }, dims: [number, number]) => poly(rectCorners(p.x, p.y, p.hdg, dims[0], dims[1]))
  const gap = pa && pb ? gapAt(w, pa, pb) : null
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-widest text-mute">
        <span>Bird's-eye reconstruction</span>
        <span className="normal-case tracking-normal">ground meters · north up</span>
      </div>
      <svg viewBox={`${cx - W / 2} ${-cy - H / 2} ${W} ${H}`} className="w-full rounded-lg bg-[#0a0f14]" style={{ aspectRatio: `${W} / ${H}` }}>
        <defs>
          <pattern id="grid" width="5" height="5" patternUnits="userSpaceOnUse">
            <path d="M5 0H0V5" fill="none" stroke="#141c26" strokeWidth="0.08" />
          </pattern>
        </defs>
        <rect x={cx - W} y={-cy - H} width={W * 2} height={H * 2} fill="url(#grid)" />
        {Object.values(ground.legs).map((pts, i) => pts && <polygon key={i} points={poly(pts)} fill="#1b222c" />)}
        <polygon points={poly(ground.box)} fill="#1b222c" />
        {ground.crosswalks.map((c) => (
          <polygon key={c.id} points={poly(c.polygon)} fill="rgba(255,255,255,0.13)" stroke="rgba(255,255,255,0.35)" strokeWidth="0.08" strokeDasharray="0.5 0.5" />
        ))}
        {/* trails */}
        <polyline points={trailA} fill="none" stroke={COL_A} strokeWidth="0.25" strokeOpacity="0.8" strokeLinecap="round" />
        <polyline points={trailB} fill="none" stroke={COL_B} strokeWidth="0.2" strokeOpacity="0.8" strokeLinecap="round" />
        {/* conflict point */}
        <circle cx={cx} cy={-cy} r="0.7" fill="none" stroke="white" strokeWidth="0.12" />
        <circle cx={cx} cy={-cy} r="0.15" fill="white" />
        {/* ghost */}
        {ga && <polygon points={rect(ga, w.a.dims_m)} fill="rgba(165,243,252,0.18)" stroke={COL_GHOST} strokeWidth="0.15" strokeDasharray="0.4 0.25" />}
        {/* actors */}
        {pa && <polygon points={rect(pa, w.a.dims_m)} fill={COL_A} fillOpacity={ga ? 0.3 : 0.9} stroke={COL_A} strokeWidth="0.1" />}
        {pb && (w.b.dims_m ? (
          <polygon points={rect(pb, w.b.dims_m)} fill={COL_B} fillOpacity="0.9" />
        ) : (
          <circle cx={pb.x} cy={-pb.y} r={w.b.radius_m} fill={COL_B} />
        ))}
        {pa && pb && gap !== null && gap < 12 && !ga && (
          <g>
            <line x1={pa.x} y1={-pa.y} x2={pb.x} y2={-pb.y} stroke={gap < 1 ? '#ff4b4b' : '#ffffffaa'} strokeWidth="0.1" strokeDasharray="0.4 0.3" />
            <text x={(pa.x + pb.x) / 2} y={-(pa.y + pb.y) / 2 - 0.6} fontSize="1.3" fill="white" textAnchor="middle" fontFamily="JetBrains Mono, monospace">
              {Math.max(0, gap).toFixed(1)} m
            </text>
          </g>
        )}
        {crash && w.impact && (
          <g>
            <circle cx={w.impact.point[0]} cy={-w.impact.point[1]} r="2.2" fill="none" stroke="#ff4b4b" strokeWidth="0.3" className="pulse-ring" style={{ transformOrigin: `${w.impact.point[0]}px ${-w.impact.point[1]}px`, transformBox: 'view-box' }} />
            <circle cx={w.impact.point[0]} cy={-w.impact.point[1]} r="0.6" fill="#ff4b4b" />
          </g>
        )}
      </svg>
      <div className="mt-2 flex gap-4 text-xs text-mute">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: COL_A }} /> {CLASS_LABEL[ev.a.cls]} ({MOVEMENT_LABEL[ev.a.movement]})</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: COL_B }} /> {CLASS_LABEL[ev.b.cls]} ({MOVEMENT_LABEL[ev.b.movement]})</span>
        {ga && <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm border border-dashed" style={{ borderColor: COL_GHOST }} /> ghost</span>}
      </div>
    </div>
  )
}

// ---- Verdict + facts ---------------------------------------------------------------------------

function VerdictPanel({ ev }: { ev: EventDetail }) {
  const v = ev.verification
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-widest text-mute">NVIDIA Cosmos3-Reason verdict{v?.model ? ` · ${v.model.replace(/^nvidia\//, "")}` : ""}</span>
        {v && <span className="font-mono text-xs text-mute">confidence {(v.confidence * 100).toFixed(0)}%</span>}
      </div>
      {v ? (
        <>
          <div className="flex items-start gap-3">
            <VerdictBadge verdict={v.verdict} size="lg" />
            <p className="text-[15px] leading-snug font-medium">{v.reason}</p>
          </div>
          <p className="text-sm leading-relaxed text-mute">{v.description}</p>
          {v.contributing_factors.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {v.contributing_factors.map((f) => (
                <span key={f} className="rounded-full border border-moderate/40 bg-moderate/10 px-2.5 py-0.5 text-xs text-moderate">{f}</span>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-mute">
            <span>Lighting: <b className="text-fog">{v.conditions.lighting}</b></span>
            <span>Weather: <b className="text-fog">{v.conditions.weather}</b></span>
            {v.conditions.visibility_issue && <span className="text-moderate">visibility issue</span>}
            <span>Evasive action: <b className="text-fog">{v.evasive_action}</b></span>
          </div>
        </>
      ) : (
        <p className="text-sm text-mute">Awaiting verification.</p>
      )}
      <div className="grid grid-cols-4 gap-2 border-t border-line pt-3">
        <Fact label="margin (PET)" value={`${ev.pet_s.toFixed(2)} s`} color={SEVERITY_COLOR[ev.severity]} />
        <Fact label="min TTC" value={ev.min_ttc_s == null ? '–' : `${ev.min_ttc_s.toFixed(2)} s`} />
        <Fact label={`${CLASS_LABEL[ev.a.cls]} speed`} value={`${mph(ev.a.speed_mps)} mph`} />
        <Fact label={`${CLASS_LABEL[ev.b.cls]} speed`} value={`${mph(ev.b.speed_mps)} mph`} />
      </div>
      <MarginBar pet={ev.pet_s} severity={ev.severity} big />
      <div className="text-[11px] text-mute">
        {CONFLICT_LABEL[ev.conflict_type]} · Verified by NVIDIA Cosmos3-Reason · Embedded by NVIDIA Cosmos Embed1 · Tracked by YOLO11 · Stored in VAST
      </div>
    </div>
  )
}

function Fact({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="font-mono text-xl font-bold tabular" style={{ color }}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-mute">{label}</div>
    </div>
  )
}

function CrashClip({ onClose, pet }: { onClose: () => void; pet: number }) {
  const src = USE_MOCK ? `${MOCK_ROOT}/footage/CRASH_A.mp4` : `${API_BASE}/media/footage/CRASH_A.mp4`
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-10" onClick={onClose}>
      <div className="w-full max-w-5xl rounded-xl border border-line bg-panel p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-widest text-severe">Simulated crash, for comparison</div>
            <div className="text-lg font-semibold">This is what {pet.toFixed(1)} seconds less luck looks like.</div>
          </div>
          <button onClick={onClose} className="rounded border border-line px-3 py-1 text-sm text-mute hover:text-fog">Close</button>
        </div>
        <video src={src} autoPlay muted controls loop playsInline className="w-full rounded-lg" />
      </div>
    </motion.div>
  )
}
