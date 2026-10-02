import { motion } from 'framer-motion'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, mediaUrl } from '../data/api.ts'
import { useAsync, useConfig } from '../data/hooks.ts'
import { useRoute, useRun } from '../store.ts'
import { CONFLICT_LABEL, clock } from '../lib/labels.ts'
import { MarginBar, SeverityDot } from '../components/bits.tsx'
import type { AlmostEvent, Pattern, Recommendation, SimilarEvent } from '../types.ts'

/** Act 5: "This wasn't isolated" → pattern → FHWA recommendations. */
export default function Cascade({ ev }: { ev: AlmostEvent }) {
  const [open, setOpen] = useState(false)
  const similar = useAsync<SimilarEvent[] | null>(() => (open ? api.similar(ev.event_id) : Promise.resolve(null)), [open, ev.event_id])
  const patterns = useAsync(api.patterns)
  const pattern = patterns.data?.find((p) => p.pattern_id === ev.pattern_id) ?? null
  const ref = useRef<HTMLDivElement>(null)
  // During a live run, wait until the agent has finished recalling + finding patterns
  // so the stage ribbon and the screen tell the same story.
  const phase = useRun((s) => s.phase)
  const patternDone = useRun((s) => s.stages.pattern === 'done')
  const ready = phase !== 'running' || patternDone

  useEffect(() => {
    if (open) setTimeout(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150)
  }, [open])

  if (ev.status !== 'verified') {
    return (
      <div className="mt-6 rounded-xl border border-line bg-panel/60 p-5 text-mute">
        This candidate was {ev.status === 'rejected' ? 'rejected' : 'held as unsure'} by verification, so it is not part of any pattern.
      </div>
    )
  }

  return (
    <section ref={ref} className="mt-6 scroll-mt-4">
      {!open ? (
        <div className="flex justify-center">
          <motion.button
            onClick={() => setOpen(true)}
            disabled={!ready}
            whileHover={{ scale: ready ? 1.03 : 1 }}
            className="rounded-xl border border-low/50 bg-low/10 px-8 py-4 text-xl font-bold text-low shadow-[0_0_40px_rgba(78,168,255,0.2)]"
          >
            {ready ? 'Has this happened before? ↓' : 'Agent is searching memory for similar events…'}
          </motion.button>
        </div>
      ) : (
        <div className="space-y-6">
          <SimilarWall ev={ev} similar={similar.data ?? []} loading={similar.loading} />
          {pattern && similar.data && <PatternBlock pattern={pattern} />}
        </div>
      )}
    </section>
  )
}

function SimilarWall({ ev, similar, loading }: { ev: AlmostEvent; similar: SimilarEvent[]; loading: boolean }) {
  const { sites } = useConfig()
  const box = useRef<HTMLDivElement>(null)
  const center = useRef<HTMLDivElement>(null)
  const cards = useRef<(HTMLButtonElement | null)[]>([])
  const [lines, setLines] = useState<{ x1: number; y1: number; x2: number; y2: number; strong: boolean }[]>([])

  const measure = useCallback(() => {
    if (!box.current || !center.current) return
    const b = box.current.getBoundingClientRect()
    const c = center.current.getBoundingClientRect()
    const cx = c.left + c.width / 2 - b.left
    const cy = c.top + c.height / 2 - b.top
    setLines(
      cards.current.flatMap((el, i) => {
        if (!el) return []
        const r = el.getBoundingClientRect()
        return [{ x1: cx, y1: cy, x2: r.left + r.width / 2 - b.left, y2: r.top + r.height / 2 - b.top, strong: similar[i]?.score >= 0.75 }]
      }),
    )
  }, [similar])
  useLayoutEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  const left = similar.filter((_, i) => i % 2 === 0)
  const right = similar.filter((_, i) => i % 2 === 1)
  const sameSite = similar.filter((s) => s.event.site_id === ev.site_id).length

  return (
    <div>
      <div className="mb-3 text-center">
        <div className="text-xs uppercase tracking-widest text-low">Recalled from VAST memory</div>
        <h2 className="text-3xl font-black tracking-tight">
          {loading ? 'Searching memory…' : sameSite > 0 ? `This wasn't isolated. ${sameSite} more like it.` : 'No similar events found.'}
        </h2>
      </div>
      <div ref={box} className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-10 py-4">
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
          {lines.map((l, i) => (
            <motion.line
              key={i}
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              stroke={l.strong ? 'var(--color-low)' : 'var(--color-mute)'}
              strokeWidth={l.strong ? 2 : 1}
              strokeDasharray={l.strong ? undefined : '4 6'}
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 0.8 }}
              transition={{ delay: 0.4 + i * 0.15, duration: 0.6 }}
            />
          ))}
        </svg>
        <Column items={left} offset={0} dir={-1} cards={cards} onSettled={measure} siteName={(id) => sites[id]?.name ?? id} />
        <div ref={center} className="relative z-10 w-80 rounded-xl border-2 border-severe bg-panel p-3 shadow-[0_0_50px_rgba(255,75,75,0.25)]">
          <MiniCard e={ev} siteName={sites[ev.site_id]?.name ?? ev.site_id} current />
        </div>
        <Column items={right} offset={1} dir={1} cards={cards} onSettled={measure} siteName={(id) => sites[id]?.name ?? id} />
      </div>
    </div>
  )
}

function Column({ items, offset, dir, cards, onSettled, siteName }: {
  items: SimilarEvent[]; offset: number; dir: 1 | -1
  cards: React.RefObject<(HTMLButtonElement | null)[]>; onSettled: () => void; siteName: (id: string) => string
}) {
  const go = useRoute((s) => s.go)
  return (
    <div className={`flex flex-col gap-4 ${dir < 0 ? 'items-end' : 'items-start'}`}>
      {items.map((s, j) => {
        const i = j * 2 + offset
        return (
          <motion.button
            key={s.event.event_id}
            ref={(el) => {
              cards.current[i] = el
            }}
            onClick={() => go(`#/event/${s.event.event_id}`)}
            initial={{ x: dir * 700, opacity: 0, rotate: dir * 8 }}
            animate={{ x: 0, opacity: 1, rotate: 0 }}
            transition={{ delay: 0.15 * i, type: 'spring', stiffness: 90, damping: 16 }}
            onAnimationComplete={onSettled}
            whileHover={{ scale: 1.03 }}
            className={`relative z-10 w-72 rounded-xl border bg-panel p-3 text-left ${s.score >= 0.75 ? 'border-low/60' : 'border-line opacity-70'}`}
          >
            <MiniCard e={s.event} siteName={siteName(s.event.site_id)} score={s.score} />
          </motion.button>
        )
      })}
    </div>
  )
}

function MiniCard({ e, siteName, score, current }: { e: AlmostEvent; siteName: string; score?: number; current?: boolean }) {
  return (
    <div>
      <div className="relative mb-2 aspect-video overflow-hidden rounded-md bg-black">
        <video src={mediaUrl(e.clip.url)} poster={mediaUrl(e.clip.thumb)} muted autoPlay loop playsInline className="h-full w-full object-cover" />
        <span className="absolute top-1.5 left-1.5 rounded bg-ink/85 px-1.5 py-0.5 font-mono text-[11px]">{e.camera_id} · {clock(e.t_conflict)}</span>
        {score !== undefined && <span className="absolute top-1.5 right-1.5 rounded bg-ink/85 px-1.5 py-0.5 font-mono text-[11px] text-low">{Math.round(score * 100)}% similar</span>}
        {current && <span className="absolute top-1.5 right-1.5 rounded bg-severe px-1.5 py-0.5 text-[11px] font-bold">this event</span>}
      </div>
      <div className="flex items-center gap-1.5 text-sm font-semibold">
        <SeverityDot severity={e.severity} /> {CONFLICT_LABEL[e.conflict_type]}
      </div>
      <div className="mt-1 flex items-baseline justify-between">
        <span className="text-xs text-mute">{siteName}</span>
        <span className="font-mono text-sm font-bold">{e.pet_s.toFixed(1)} s</span>
      </div>
      <div className="mt-1.5">
        <MarginBar pet={e.pet_s} severity={e.severity} />
      </div>
    </div>
  )
}

export function PatternBlock({ pattern, compact = false }: { pattern: Pattern; compact?: boolean }) {
  return (
    <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: compact ? 0 : 1.2 }} className="space-y-4">
      <PatternCard pattern={pattern} />
      <div>
        <div className="mb-2 text-xs uppercase tracking-widest text-mute">Recommendations</div>
        {pattern.recommendations.length === 0 ? (
          <div className="rounded-xl border border-moderate/40 bg-moderate/5 p-4 text-sm">
            <b className="text-moderate">No FHWA catalog match.</b> None of the verified FHWA Proven Safety Countermeasures maps to this conflict type in our catalog, so nothing is recommended. Flagged for traffic engineer review.
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {pattern.recommendations.map((r, i) => (
              <RecCard key={r.countermeasure_id} r={r} delay={compact ? 0 : 1.5 + i * 0.2} />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  )
}

function EventChip({ id }: { id: string }) {
  const go = useRoute((s) => s.go)
  return (
    <button onClick={() => go(`#/event/${id}`)} className="mx-0.5 inline-block rounded border border-line bg-panel-2 px-1.5 font-mono text-[12px] text-low hover:border-low print-plain">
      {id}
    </button>
  )
}

/** Render text with any event ids turned into clickable chips. */
export function WithChips({ text }: { text: string }) {
  const parts = text.split(/(EV_[A-Z0-9]+_\d+)/g)
  return <>{parts.map((p, i) => (/^EV_/.test(p) ? <EventChip key={i} id={p} /> : <span key={i}>{p}</span>))}</>
}

function PatternCard({ pattern }: { pattern: Pattern }) {
  return (
    <div className="rounded-xl border border-low/40 bg-panel p-5 print-plain">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-xs uppercase tracking-widest text-low">Pattern {pattern.pattern_id} · {CONFLICT_LABEL[pattern.conflict_type]}</div>
          <h3 className="mt-1 text-2xl font-bold leading-tight">{pattern.signature}</h3>
        </div>
        <div className="flex shrink-0 gap-6 text-center">
          <Stat value={String(pattern.count)} label="close calls" />
          <Stat value={`${pattern.worst_pet_s.toFixed(1)} s`} label="worst margin" tone="text-severe" />
          <Stat value={`${pattern.median_pet_s.toFixed(1)} s`} label="median margin" />
          <Stat value={Object.entries(pattern.conditions).map(([k, v]) => `${v} ${k}`).join(' · ')} label="conditions" small />
        </div>
      </div>
      <p className="mt-3 text-[15px] leading-relaxed text-fog/90"><WithChips text={pattern.summary} /></p>
      <div className="mt-3 flex flex-wrap items-center gap-1 text-sm text-mute">
        Events: {pattern.event_ids.map((id) => <EventChip key={id} id={id} />)}
      </div>
    </div>
  )
}

function Stat({ value, label, tone = '', small = false }: { value: string; label: string; tone?: string; small?: boolean }) {
  return (
    <div>
      <div className={`font-mono font-bold tabular ${small ? 'text-sm leading-7' : 'text-2xl'} ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-mute">{label}</div>
    </div>
  )
}

function RecCard({ r, delay }: { r: Recommendation; delay: number }) {
  // Never render a recommendation without its FHWA link.
  if (!r.url) return null
  return (
    <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ delay }} className="flex flex-col rounded-xl border border-accept/40 bg-panel p-4 print-plain">
      <span className="self-start rounded border border-accept/50 bg-accept/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accept">FHWA Proven Safety Countermeasure</span>
      <a href={r.url} target="_blank" rel="noreferrer" className="mt-2 text-lg font-bold leading-snug hover:underline">
        {r.name} ↗
      </a>
      <div className="mt-2 text-xs uppercase tracking-widest text-mute">Why here</div>
      <p className="mt-1 flex-1 text-sm leading-relaxed"><WithChips text={r.why} /></p>
      <div className="mt-3 border-t border-line pt-2 text-xs text-moderate">{r.review_note}</div>
    </motion.div>
  )
}
