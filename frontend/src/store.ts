import { create } from 'zustand'
import type { AlmostEvent, Pattern, Recommendation, RunCounts, Stage, Verdict, WsMessage } from './types.ts'
import { api } from './data/api.ts'
import { connectRun, type Unsubscribe } from './data/ws.ts'

export type Phase = 'idle' | 'running' | 'done'
export type StageStatus = 'pending' | 'active' | 'done'

export interface VerdictTick {
  event_id: string
  verdict: Verdict
  reason: string
  at: number
}

const ZERO: RunCounts = { video_minutes: 0, road_users: 0, interactions: 0, candidates: 0, verified: 0, rejected: 0, patterns: 0 }

interface RunState {
  phase: Phase
  runId: string | null
  /** Increments on every start(); the backend may reuse run ids. */
  runSeq: number
  stage: Stage | null
  stages: Partial<Record<Stage, StageStatus>>
  progress: number
  counts: RunCounts
  candidates: Record<string, AlmostEvent>
  candidateOrder: string[]
  verdicts: VerdictTick[]
  similar: Record<string, string[]>
  patterns: Record<string, Pattern>
  recommendations: Record<string, Recommendation[]>
  error: string | null

  start: () => Promise<void>
  reset: () => void
  /** Skip the replay and load the finished investigation (for direct links / reload). */
  hydrateFinished: () => Promise<void>
}

let unsub: Unsubscribe | null = null

const initial = () => ({
  phase: 'idle' as Phase,
  runId: null,
  runSeq: 0,
  stage: null,
  stages: {},
  progress: 0,
  counts: ZERO,
  candidates: {},
  candidateOrder: [],
  verdicts: [],
  similar: {},
  patterns: {},
  recommendations: {},
  error: null,
})

export const useRun = create<RunState>((set, get) => ({
  ...initial(),

  async start() {
    unsub?.()
    set({ ...initial(), phase: 'running', runSeq: get().runSeq + 1 })
    try {
      const { run_id } = await api.investigate()
      set({ runId: run_id })
      unsub = connectRun((m) => apply(m, set, get))
    } catch (e) {
      set({ phase: 'idle', error: String(e) })
    }
  },

  reset() {
    unsub?.()
    unsub = null
    set({ ...initial(), runSeq: get().runSeq })
  },

  async hydrateFinished() {
    if (get().phase === 'done') return
    const [events, patterns] = await Promise.all([api.events(), api.patterns()])
    const candidates = Object.fromEntries(events.map((e) => [e.event_id, e]))
    const verified = events.filter((e) => e.status === 'verified').length
    const rejected = events.filter((e) => e.status === 'rejected').length
    set({
      phase: 'done',
      stage: 'report',
      stages: Object.fromEntries(['scan', 'measure', 'verify', 'remember', 'recall', 'pattern', 'recommend', 'report'].map((s) => [s, 'done'])),
      candidates,
      candidateOrder: events.map((e) => e.event_id),
      verdicts: events.filter((e) => e.verification).map((e) => ({ event_id: e.event_id, verdict: e.verification!.verdict, reason: e.verification!.reason, at: 0 })),
      patterns: Object.fromEntries(patterns.map((p) => [p.pattern_id, p])),
      recommendations: Object.fromEntries(patterns.map((p) => [p.pattern_id, p.recommendations])),
      counts: { ...get().counts, candidates: events.length, verified, rejected, patterns: patterns.length },
    })
  },
}))

type Set = (p: Partial<RunState> | ((s: RunState) => Partial<RunState>)) => void

function apply(m: WsMessage, set: Set, get: () => RunState) {
  switch (m.type) {
    case 'run.stage': {
      set((s) => {
        const stages = { ...s.stages }
        if (m.status === 'start' || m.status === 'progress') stages[m.stage] = 'active'
        if (m.status === 'done') stages[m.stage] = 'done'
        return { stage: m.stage, stages, progress: m.progress, counts: m.counts }
      })
      break
    }
    case 'run.candidate':
      set((s) => ({
        candidates: { ...s.candidates, [m.event.event_id]: m.event },
        candidateOrder: s.candidateOrder.includes(m.event.event_id) ? s.candidateOrder : [...s.candidateOrder, m.event.event_id],
      }))
      break
    case 'run.verified':
      set((s) => {
        const ev = s.candidates[m.event_id]
        const status = m.verdict === 'ACCEPT' ? 'verified' : m.verdict === 'REJECT' ? 'rejected' : 'unsure'
        return {
          verdicts: [...s.verdicts, { event_id: m.event_id, verdict: m.verdict, reason: m.reason, at: Date.now() }],
          candidates: ev ? { ...s.candidates, [m.event_id]: { ...ev, status } } : s.candidates,
        }
      })
      break
    case 'run.similar':
      set((s) => ({ similar: { ...s.similar, [m.event_id]: m.similar_ids } }))
      break
    case 'run.pattern':
      set((s) => {
        const candidates = { ...s.candidates }
        for (const id of m.pattern.event_ids) if (candidates[id]) candidates[id] = { ...candidates[id], pattern_id: m.pattern.pattern_id }
        return { patterns: { ...s.patterns, [m.pattern.pattern_id]: m.pattern }, candidates }
      })
      break
    case 'run.recommendation':
      set((s) => ({
        recommendations: { ...s.recommendations, [m.pattern_id]: [...(s.recommendations[m.pattern_id] ?? []), m.recommendation] },
      }))
      break
    case 'run.done':
      set({ phase: 'done' })
      // Pull full verified events (with verification text) once the run is over.
      api.events().then((events) => {
        const merged = { ...get().candidates }
        for (const e of events) merged[e.event_id] = { ...merged[e.event_id], ...e }
        set({ candidates: merged })
      }).catch(() => {})
      break
  }
}

// ---- routing (hash based, no dependency) ------------------------------------------

export type Route =
  | { name: 'sweep' }
  | { name: 'event'; id: string }
  | { name: 'report'; siteId: string }
  | { name: 'calibrate'; cameraId: string }

export function parseHash(h: string): Route {
  const parts = h.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'event' && parts[1]) return { name: 'event', id: parts[1] }
  if (parts[0] === 'report' && parts[1]) return { name: 'report', siteId: parts[1] }
  if (parts[0] === 'calibrate' && parts[1]) return { name: 'calibrate', cameraId: parts[1] }
  return { name: 'sweep' }
}

export const useRoute = create<{ route: Route; go: (hash: string) => void }>((set) => {
  window.addEventListener('hashchange', () => set({ route: parseHash(location.hash) }))
  return {
    route: parseHash(location.hash),
    go: (hash) => {
      location.hash = hash
    },
  }
})

if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__run = useRun
}
