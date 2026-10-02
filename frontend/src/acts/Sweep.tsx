import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useRef } from 'react'
import { useRun, useRoute } from '../store.ts'
import { useConfig } from '../data/hooks.ts'
import { mediaUrl } from '../data/api.ts'
import { applyH, invert3 } from '../lib/geometry.ts'
import { CONFLICT_LABEL, secs } from '../lib/labels.ts'
import { Counters, MarginBar, SeverityDot, VerdictBadge } from '../components/bits.tsx'
import type { AlmostEvent, Camera } from '../types.ts'

let autoOpenedRun = 0

export default function Sweep() {
  const run = useRun()
  const { config, cameras, sites } = useConfig()
  const go = useRoute((s) => s.go)
  const collapsed = run.stages.verify === 'done'
  const { candidateOrder, candidates } = run
  const events = useMemo(() => candidateOrder.map((id) => candidates[id]).filter(Boolean), [candidateOrder, candidates])
  const ranked = useMemo(() => events.filter((e) => e.status === 'verified').sort((a, b) => b.score - a.score), [events])

  // Demo flow: #1 card expands into the theater 1.5 s after the collapse.
  // Keyed on the top id (a stable string), so streaming updates don't reset the timer.
  const topId = ranked[0]?.event_id
  useEffect(() => {
    if (!collapsed || !topId || !run.runSeq || autoOpenedRun === run.runSeq) return
    const t = setTimeout(() => {
      autoOpenedRun = run.runSeq
      go(`#/event/${topId}`)
    }, 1500 + 600)
    return () => clearTimeout(t)
  }, [collapsed, topId, run.runSeq, go])

  if (!config) return <div className="p-10 text-mute">Loading cameras…</div>

  return (
    <div className="relative flex h-full flex-col gap-3 px-5 pb-5">
      <AnimatePresence mode="wait">
        {!collapsed ? (
          <motion.div key="wall" className="relative flex min-h-0 flex-1 gap-3" exit={{ opacity: 0, scale: 0.92, filter: 'blur(6px)' }} transition={{ duration: 0.6 }}>
            <Wall cameras={config.cameras} events={events} sites={sites} />
            {run.phase !== 'idle' && <VerdictTicker />}
          </motion.div>
        ) : (
          <motion.div key="cards" className="min-h-0 flex-1 overflow-y-auto" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Collapse ranked={ranked} events={events} cameras={cameras} siteName={(id) => sites[id]?.name ?? id} />
          </motion.div>
        )}
      </AnimatePresence>
      {run.phase !== 'idle' && !collapsed && <Counters counts={run.counts} />}
      {run.phase === 'idle' && <BigButton onClick={run.start} />}
    </div>
  )
}

function BigButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      <motion.button
        onClick={onClick}
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.97 }}
        className="pointer-events-auto rounded-2xl border border-brand/60 bg-ink/85 px-14 py-8 text-center shadow-[0_0_80px_rgba(255,107,61,0.35)] backdrop-blur-md"
      >
        <div className="text-5xl font-black tracking-tight text-brand">FIND THE ALMOSTS</div>
        <div className="mt-3 text-base text-mute">Scan every camera, measure every interaction, verify, find the pattern.</div>
      </motion.button>
    </div>
  )
}

function Wall({ cameras, events, sites }: { cameras: Camera[]; events: AlmostEvent[]; sites: Record<string, { name: string }> }) {
  const run = useRun()
  const dim = run.stage === 'verify' || run.stage === 'remember'
  const verifying = run.verdicts[run.verdicts.length - 1]?.event_id
  return (
    <div className="grid min-h-0 flex-1 grid-cols-4 content-center gap-2">
      {cameras.map((cam) => (
        <Tile
          key={cam.camera_id}
          cam={cam}
          siteName={sites[cam.site_id]?.name ?? cam.site_id}
          events={events.filter((e) => e.camera_id === cam.camera_id)}
          dim={dim && !events.some((e) => e.camera_id === cam.camera_id && e.event_id === verifying)}
        />
      ))}
      <div className="flex aspect-video flex-col items-center justify-center rounded-lg border border-line bg-panel text-center">
        <div className="text-4xl font-black tracking-tight">ALMOST</div>
        <div className="mt-1 max-w-[16rem] text-sm text-mute">Finds the crashes that almost happened, and proves how close they were.</div>
      </div>
    </div>
  )
}

function Tile({ cam, siteName, events, dim }: { cam: Camera; siteName: string; events: AlmostEvent[]; dim: boolean }) {
  const H_inv = useMemo(() => invert3(cam.homography), [cam.homography])
  const ref = useRef<HTMLVideoElement>(null)
  return (
    <motion.div
      animate={{ opacity: dim ? 0.38 : 1 }}
      transition={{ duration: 0.6 }}
      className="relative aspect-video overflow-hidden rounded-lg border border-line bg-black"
    >
      <video ref={ref} src={mediaUrl(cam.video_url)} muted autoPlay loop playsInline preload="auto" className="absolute inset-0 h-full w-full object-fill" />
      {/* Candidate scribbles: conflict points projected into the image. */}
      {events.map((e) => {
        const [u, v] = applyH(H_inv, e.conflict_point[0], e.conflict_point[1])
        const color = e.status === 'rejected' ? 'var(--color-reject)' : e.status === 'verified' ? 'var(--color-accept)' : 'var(--color-moderate)'
        return (
          <motion.div
            key={e.event_id}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${(u / cam.width) * 100}%`, top: `${(v / cam.height) * 100}%` }}
          >
            <span className="pulse-ring absolute -inset-3 rounded-full border-2" style={{ borderColor: color }} />
            <span className="block size-3 rounded-full border-2 border-ink" style={{ background: color }} />
          </motion.div>
        )
      })}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/85 to-transparent px-2.5 pt-6 pb-1.5 text-xs">
        <span className="font-semibold">{siteName.replace(' (simulated)', '')}</span>
        <span className="font-mono text-mute">{cam.camera_id}</span>
      </div>
    </motion.div>
  )
}

function VerdictTicker() {
  const verdicts = useRun((s) => s.verdicts)
  return (
    <aside className="flex w-[25rem] shrink-0 flex-col rounded-lg border border-line bg-panel">
      <div className="border-b border-line px-4 py-2.5 text-xs uppercase tracking-widest text-mute">NVIDIA verification</div>
      <div className="min-h-0 flex-1 overflow-hidden px-3 py-2">
        {verdicts.length === 0 && <div className="px-1 py-2 text-sm text-mute">Waiting for candidates…</div>}
        <AnimatePresence initial={false}>
          {[...verdicts].reverse().slice(0, 14).map((v) => (
            <motion.div
              key={v.event_id}
              layout
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              className={`mb-1.5 rounded-md border px-2.5 py-1.5 ${v.verdict === 'REJECT' ? 'border-line/60 opacity-60' : 'border-line bg-panel-2'}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-mute">{v.event_id}</span>
                <VerdictBadge verdict={v.verdict} />
              </div>
              <div className={`mt-0.5 text-[13px] leading-snug ${v.verdict === 'REJECT' ? 'text-reject line-through' : ''}`}>{v.reason}</div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </aside>
  )
}

function Collapse({ ranked, events, cameras, siteName }: { ranked: AlmostEvent[]; events: AlmostEvent[]; cameras: Record<string, Camera>; siteName: (id: string) => string }) {
  const go = useRoute((s) => s.go)
  const run = useRun()
  const rejected = events.filter((e) => e.status === 'rejected')
  const unsure = events.filter((e) => e.status === 'unsure')
  return (
    <div className="mx-auto max-w-[1700px] py-2">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <div className="text-sm uppercase tracking-widest text-mute">
            {run.counts.interactions.toLocaleString()} interactions → {events.length} candidates → verified close calls
          </div>
          <h1 className="text-4xl font-black tracking-tight">
            {ranked.length} times, someone <span className="text-brand">almost</span> got hit.
          </h1>
        </div>
        <button onClick={run.start} className="no-print rounded-lg border border-line px-4 py-2 text-sm text-mute hover:border-brand hover:text-fog">
          Run the investigation again
        </button>
      </div>
      <div className="grid grid-cols-4 gap-4">
        {ranked.map((e, i) => (
          <motion.button
            key={e.event_id}
            onClick={() => go(`#/event/${e.event_id}`)}
            initial={{ opacity: 0, y: 60, scale: 0.85 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ delay: 0.08 * i, type: 'spring', stiffness: 160, damping: 18 }}
            whileHover={{ y: -4 }}
            className="group overflow-hidden rounded-xl border bg-panel text-left"
            style={{ borderColor: i === 0 ? 'var(--color-severe)' : 'var(--color-line)' }}
          >
            <div className="relative aspect-video bg-black">
              <img src={mediaUrl(e.clip.thumb)} alt="" className="h-full w-full object-cover" />
              <span className="absolute top-2 left-2 rounded bg-ink/85 px-2 py-0.5 font-mono text-sm font-bold">#{i + 1}</span>
              <span className="absolute top-2 right-2 rounded bg-ink/85 px-2 py-0.5 font-mono text-xs text-mute">{cameras[e.camera_id]?.camera_id}</span>
            </div>
            <div className="space-y-2 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <SeverityDot severity={e.severity} />
                {CONFLICT_LABEL[e.conflict_type]}
              </div>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-3xl font-bold tabular">{e.pet_s.toFixed(1)}</span>
                <span className="text-sm text-mute">seconds apart</span>
              </div>
              <MarginBar pet={e.pet_s} severity={e.severity} />
              <div className="text-xs text-mute">{siteName(e.site_id)}</div>
            </div>
          </motion.button>
        ))}
      </div>
      {(rejected.length > 0 || unsure.length > 0) && (
        <div className="mt-6 rounded-xl border border-line bg-panel/60 p-4">
          <div className="mb-2 text-xs uppercase tracking-widest text-mute">We don't trust geometry alone · flagged by measurement, ruled out or held by NVIDIA</div>
          <div className="flex flex-wrap gap-2">
            {[...unsure, ...rejected].map((e) => (
              <button key={e.event_id} onClick={() => go(`#/event/${e.event_id}`)} className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-sm hover:border-mute">
                <span className="font-mono text-xs text-mute">{e.event_id}</span>
                <span className={e.status === 'rejected' ? 'text-reject line-through' : ''}>{CONFLICT_LABEL[e.conflict_type]}</span>
                <span className="font-mono text-xs text-mute">{secs(e.pet_s)}</span>
                <VerdictBadge verdict={e.status === 'rejected' ? 'REJECT' : 'UNSURE'} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
