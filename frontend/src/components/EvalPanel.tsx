import { useState } from 'react'
import { api, USE_MOCK } from '../data/api.ts'
import { useAsync } from '../data/hooks.ts'

function Gauge({ label, value, unit = '%', good }: { label: string; value: number; unit?: string; good: boolean }) {
  const shown = unit === '%' ? Math.round(value * 100) : value.toFixed(2)
  return (
    <div className="flex flex-col items-center px-2">
      <div className={`font-mono text-xl font-bold tabular ${good ? 'text-accept' : 'text-moderate'}`}>
        {shown}
        <span className="text-xs text-mute">{unit === '%' ? '%' : ` ${unit}`}</span>
      </div>
      <div className="text-center text-[10px] uppercase leading-tight tracking-wider text-mute">{label}</div>
    </div>
  )
}

/** Small instrument cluster in the corner: GET /eval/latest. */
export default function EvalPanel() {
  const { data } = useAsync(api.evalLatest)
  const [open, setOpen] = useState(false)
  if (!data) return null
  return (
    <div className="no-print fixed right-4 bottom-4 z-30 rounded-xl border border-line bg-panel/95 shadow-2xl backdrop-blur">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-6 px-3 pt-2 text-[11px] uppercase tracking-widest text-mute hover:text-fog">
        <span>Evaluation · Weave{USE_MOCK ? ' (mock)' : ''}</span>
        <span>{open ? '–' : '+'}</span>
      </button>
      {open && (
        <div className="px-2 pt-2 pb-2.5">
          <div className="grid grid-cols-4 gap-y-2">
            <Gauge label="detection recall" value={data.detection.recall} good={data.detection.recall >= 0.85} />
            <Gauge label="precision" value={data.detection.precision} good={data.detection.precision >= 0.8} />
            <Gauge label="PET error" value={data.measurement.pet_mae_s} unit="s" good={data.measurement.pet_mae_s <= 0.2} />
            <Gauge label="verify accuracy" value={data.verification.accuracy} good={data.verification.accuracy >= 0.85} />
            <Gauge label="pattern purity" value={data.patterns.purity} good={data.patterns.purity >= 0.9} />
            <Gauge label="recs from catalog" value={data.recommendations.from_catalog} good={data.recommendations.from_catalog === 1} />
            <Gauge label="FHWA links valid" value={data.recommendations.urls_valid} good={data.recommendations.urls_valid === 1} />
            <div className="flex flex-col items-center px-2">
              <div className="font-mono text-xl font-bold text-accept">{data.verification.decoys_rejected}</div>
              <div className="text-center text-[10px] uppercase leading-tight tracking-wider text-mute">decoys rejected</div>
            </div>
          </div>
          <a href={data.weave_url} target="_blank" rel="noreferrer" className="mt-2 block text-center text-xs text-low hover:underline">
            Open in Weave ↗
          </a>
        </div>
      )}
    </div>
  )
}
