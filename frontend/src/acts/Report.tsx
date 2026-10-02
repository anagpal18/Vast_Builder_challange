import { api, mediaUrl } from '../data/api.ts'
import { useAsync, useConfig } from '../data/hooks.ts'
import { useRoute } from '../store.ts'
import { CONFLICT_LABEL, SEVERITY_COLOR, clock } from '../lib/labels.ts'
import { MarginBar, SeverityDot } from '../components/bits.tsx'
import { PatternBlock } from './Cascade.tsx'
import type { AlmostEvent, Ground, Pt } from '../types.ts'

/** Per-site report: GET /report/{site_id}; export = /report/{site_id}.md; print-friendly. */
export default function Report({ siteId }: { siteId: string }) {
  const rep = useAsync(() => api.report(siteId), [siteId])
  const all = useAsync(api.events)
  const { config } = useConfig()
  const go = useRoute((s) => s.go)
  if (rep.error) return <div className="p-10 text-severe">Could not load report: {rep.error}</div>
  if (!rep.data || !config) return <div className="p-10 text-mute">Building report…</div>
  const r = rep.data
  const cams = config.cameras.filter((c) => c.site_id === siteId)
  const ground = cams[0]?.ground
  // Leg polygons give one shared ground frame; without them (auto-calibrated archive cameras) show snapshots
  const mapped = !!ground && Object.keys(ground.legs ?? {}).length > 0
  const siteEvents = (all.data ?? []).filter((e) => e.site_id === siteId && e.status === 'verified')
  const worst = siteEvents.length ? Math.min(...siteEvents.map((e) => e.pet_s)) : null

  return (
    <div className="h-full overflow-y-auto print:h-auto print:overflow-visible">
      <article className="mx-auto max-w-6xl space-y-6 px-6 pb-24 print:max-w-none print:px-0">
        <header className="flex items-end justify-between gap-6 border-b border-line pb-4 print-plain">
          <div>
            <div className="text-xs uppercase tracking-widest text-mute">LOOKOUT site report</div>
            <h1 className="text-4xl font-black tracking-tight">{r.site.name}</h1>
            <div className="mt-1 text-sm text-mute">
              {r.site.signalized ? 'Signalized' : 'Unsignalized'} · {r.site.speed_limit_mph} mph limit · cameras {r.site.camera_ids.join(', ')} · generated {new Date(r.generated_at).toLocaleString()}
            </div>
          </div>
          <div className="no-print flex gap-2">
            <a href={api.reportMarkdownUrl(siteId)} download={`LOOKOUT_${siteId}.md`} className="rounded-lg border border-line px-4 py-2 text-sm hover:border-fog">
              Export Markdown
            </a>
            <button onClick={() => window.print()} className="rounded-lg bg-fog px-4 py-2 text-sm font-semibold text-ink hover:brightness-95">
              Print / PDF
            </button>
          </div>
        </header>

        <section className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-6">
          <div className="rounded-xl border border-line bg-panel p-3 print-plain">
            <div className="mb-2 flex justify-between text-xs uppercase tracking-widest text-mute">
              <span>Verified close calls at this site</span>
              <span className="normal-case tracking-normal">{mapped ? 'dot = conflict point, color = severity' : 'snapshot at the moment of conflict'}</span>
            </div>
            {mapped && ground ? (
              <SiteMap ground={ground} events={siteEvents} onPick={(id) => go(`#/event/${id}`)} />
            ) : (
              <Snapshots events={siteEvents} onPick={(id) => go(`#/event/${id}`)} />
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 self-start">
            <Big value={String(siteEvents.length)} label="verified close calls" />
            <Big value={worst === null ? '–' : `${worst.toFixed(1)} s`} label="closest margin" color="var(--color-severe)" />
            <Big value={String(r.patterns.length)} label="recurring patterns" />
            <Big value={String(r.recommendations.length)} label="FHWA countermeasures suggested" color="var(--color-accept)" />
          </div>
        </section>

        {r.patterns.map((p) => (
          <section key={p.pattern_id} className="break-inside-avoid">
            <PatternBlock pattern={p} compact />
          </section>
        ))}

        <section className="break-inside-avoid">
          <div className="mb-2 text-xs uppercase tracking-widest text-mute">Top events · every number links to video</div>
          <div className="grid grid-cols-5 gap-3">
            {r.top_events.map((e) => (
              <TopEvent key={e.event_id} e={e} onOpen={() => go(`#/event/${e.event_id}`)} />
            ))}
          </div>
        </section>

        <p className="rounded-lg border border-line bg-panel/60 p-4 text-sm text-mute print-plain">{r.disclaimer}</p>
      </article>
    </div>
  )
}

function Big({ value, label, color }: { value: string; label: string; color?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4 print-plain">
      <div className="font-mono text-4xl font-black tabular" style={{ color }}>{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wider text-mute">{label}</div>
    </div>
  )
}

function TopEvent({ e, onOpen }: { e: AlmostEvent; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="overflow-hidden rounded-lg border border-line bg-panel text-left hover:border-mute print-plain">
      <img src={mediaUrl(e.clip.thumb)} alt="" className="aspect-video w-full object-cover" />
      <div className="space-y-1 p-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold"><SeverityDot severity={e.severity} />{CONFLICT_LABEL[e.conflict_type]}</div>
        <div className="flex justify-between font-mono text-xs text-mute">
          <span>{e.camera_id} · {clock(e.t_conflict)}</span>
          <b className="text-fog">{e.pet_s.toFixed(1)} s</b>
        </div>
        <MarginBar pet={e.pet_s} severity={e.severity} />
      </div>
    </button>
  )
}

function Snapshots({ events, onPick }: { events: AlmostEvent[]; onPick: (id: string) => void }) {
  if (!events.length) return <div className="grid h-48 place-items-center text-sm text-mute">No verified close calls yet.</div>
  const shown = [...events].sort((a, b) => a.pet_s - b.pet_s).slice(0, 9)
  return (
    <div className="grid grid-cols-3 gap-2">
      {shown.map((e) => (
        <button key={e.event_id} onClick={() => onPick(e.event_id)} className="group relative aspect-video overflow-hidden rounded-md border border-line bg-black text-left">
          <img src={mediaUrl(e.clip.thumb)} alt="" className="h-full w-full object-cover transition group-hover:scale-105" />
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/90 to-transparent px-2 pt-5 pb-1">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold"><SeverityDot severity={e.severity} />{CONFLICT_LABEL[e.conflict_type]}</span>
            <span className="font-mono text-[11px]" style={{ color: SEVERITY_COLOR[e.severity] }}>{e.pet_s.toFixed(1)} s</span>
          </div>
        </button>
      ))}
    </div>
  )
}

function SiteMap({ ground, events, onPick }: { ground: Ground; events: AlmostEvent[]; onPick: (id: string) => void }) {
  const poly = (pts: Pt[]) => pts.map(([x, y]) => `${x},${-y}`).join(' ')
  const S = 30
  return (
    <svg viewBox={`${-S} ${-S * 0.62} ${S * 2} ${S * 1.24}`} className="w-full rounded-lg bg-[#0a0f14] print:bg-white">
      {Object.values(ground.legs).map((pts, i) => pts && <polygon key={i} points={poly(pts)} className="fill-[#1b222c] print:fill-[#ddd]" />)}
      <polygon points={poly(ground.box)} className="fill-[#1b222c] print:fill-[#ddd]" />
      {ground.crosswalks.map((c) => (
        <polygon key={c.id} points={poly(c.polygon)} fill="rgba(255,255,255,0.14)" stroke="rgba(160,160,160,0.6)" strokeWidth="0.1" strokeDasharray="0.5 0.5" />
      ))}
      {events.map((e, i) => (
        <g key={e.event_id} onClick={() => onPick(e.event_id)} className="cursor-pointer">
          {/* small deterministic jitter so stacked events stay visible */}
          <circle cx={e.conflict_point[0] + ((i % 3) - 1) * 0.5} cy={-e.conflict_point[1] + (Math.floor(i / 3) % 3 - 1) * 0.5} r="0.75" fill={SEVERITY_COLOR[e.severity]} stroke="#06080b" strokeWidth="0.15">
            <title>{`${e.event_id}: ${e.pet_s.toFixed(1)} s apart`}</title>
          </circle>
        </g>
      ))}
      <text x={S - 1} y={-S * 0.62 + 2} textAnchor="end" fontSize="1.6" fill="#7d8a9c">N ↑</text>
    </svg>
  )
}
