import { motion, AnimatePresence } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import type { RunCounts, Severity, Stage, Verdict } from '../types.ts'
import { STAGES } from '../types.ts'
import { STAGE_LABEL, SEVERITY_COLOR } from '../lib/labels.ts'
import type { StageStatus } from '../store.ts'

/** PET margin bar: 0 s (collision) on the left to 3 s (our threshold) on the right. */
export function MarginBar({ pet, severity, big = false }: { pet: number; severity: Severity; big?: boolean }) {
  const pct = Math.max(2, Math.min(100, (pet / 3) * 100))
  return (
    <div className="w-full">
      <div className={`relative w-full rounded-full bg-line ${big ? 'h-3' : 'h-1.5'}`}>
        <motion.div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ background: SEVERITY_COLOR[severity] }}
          initial={{ width: '100%' }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 1.1, ease: [0.2, 0.8, 0.2, 1] }}
        />
      </div>
      {big && (
        <div className="mt-1 flex justify-between text-[11px] text-mute font-mono">
          <span>0 s · collision</span>
          <span>3 s</span>
        </div>
      )}
    </div>
  )
}

export function SeverityDot({ severity }: { severity: Severity }) {
  return <span className="inline-block size-2.5 rounded-full" style={{ background: SEVERITY_COLOR[severity] }} />
}

const VERDICT_STYLE: Record<Verdict, string> = {
  ACCEPT: 'bg-accept/15 text-accept border-accept/40',
  REJECT: 'bg-reject/15 text-reject border-reject/40 line-through',
  UNSURE: 'bg-unsure/15 text-unsure border-unsure/40',
}

export function VerdictBadge({ verdict, size = 'sm' }: { verdict: Verdict; size?: 'sm' | 'lg' }) {
  return (
    <span className={`inline-flex items-center rounded border font-mono font-bold tracking-wider ${VERDICT_STYLE[verdict]} ${size === 'lg' ? 'px-2.5 py-1 text-sm' : 'px-1.5 py-0.5 text-[10px]'}`}>
      {verdict}
    </span>
  )
}

export function StageRibbon({ stages, current }: { stages: Partial<Record<Stage, StageStatus>>; current: Stage | null }) {
  return (
    <ol className="flex items-center gap-1">
      {STAGES.map((s, i) => {
        const st = stages[s] ?? 'pending'
        const active = st === 'active' || (current === s && st !== 'done')
        return (
          <li key={s} className="flex items-center gap-1">
            <span
              className={`relative rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide transition-colors duration-300 ${
                active ? 'bg-brand text-ink shadow-[0_0_24px_rgba(255,107,61,0.65)]' : st === 'done' ? 'bg-panel-2 text-fog' : 'text-mute'
              }`}
            >
              {st === 'done' && <span className="mr-1 text-accept">✓</span>}
              {STAGE_LABEL[s]}
            </span>
            {i < STAGES.length - 1 && <span className={`h-px w-2.5 ${st === 'done' ? 'bg-fog/40' : 'bg-line'}`} />}
          </li>
        )
      })}
    </ol>
  )
}

/** Number that eases toward its target (racing counters). */
export function RaceNumber({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const start = performance.now()
    const a = from.current
    let raf = 0
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / 350)
      const v = a + (value - a) * k
      setShown(v)
      from.current = v
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{shown.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</>
}

const COUNTERS: { key: keyof RunCounts; label: string; decimals?: number; tone?: string }[] = [
  { key: 'video_minutes', label: 'minutes of video scanned', decimals: 1 },
  { key: 'road_users', label: 'road users tracked' },
  { key: 'interactions', label: 'interactions measured' },
  { key: 'candidates', label: 'close-call candidates', tone: 'text-moderate' },
  { key: 'verified', label: 'verified by NVIDIA Cosmos3-Reason', tone: 'text-accept' },
  { key: 'rejected', label: 'rejected', tone: 'text-reject' },
]

export function Counters({ counts }: { counts: RunCounts }) {
  return (
    <div className="grid grid-cols-6 gap-3">
      {COUNTERS.map((c) => (
        <div key={c.key} className="rounded-lg border border-line bg-panel/80 px-4 py-2.5 backdrop-blur">
          <div className={`font-mono text-3xl font-bold tabular leading-none ${c.tone ?? ''}`}>
            <RaceNumber value={counts[c.key]} decimals={c.decimals} />
          </div>
          <div className="mt-1 text-[11px] uppercase tracking-wider text-mute">{c.label}</div>
        </div>
      ))}
    </div>
  )
}

export function Fade({ show, children }: { show: boolean; children: React.ReactNode }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
