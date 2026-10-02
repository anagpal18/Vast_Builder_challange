import { useEffect, useState } from 'react'
import { API_BASE, USE_MOCK } from '../data/api.ts'

type Service = { key: string; name: string; state: 'live' | 'cached' | 'down'; detail?: string | null; recordings: number }
type Status = { services: Service[]; replay: { replayed: number; mode: string }; data_mode: string; checked_at: string }

const TONE = { live: 'bg-accept shadow-[0_0_8px_var(--color-accept)]', cached: 'bg-moderate', down: 'bg-severe' }
const WORD = { live: 'live', cached: 'cached', down: 'down' }

/** Corner panel: which parts of the stack are live right now, and which answer from the replay cache. */
export default function LiveStatus() {
  const [s, setS] = useState<Status | null>(null)
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (USE_MOCK) return
    let alive = true
    const load = () => fetch(`${API_BASE}/status`).then((r) => r.json()).then((d) => alive && setS(d)).catch(() => {})
    load()
    const t = setInterval(load, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  if (!s) return null
  const live = s.services.filter((x) => x.state === 'live').length
  return (
    <div className="no-print fixed bottom-4 left-4 z-30 w-[19rem] rounded-xl border border-line bg-panel/95 text-xs shadow-2xl backdrop-blur">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-3 py-2 uppercase tracking-widest text-mute hover:text-fog">
        <span className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${live === s.services.length ? TONE.live : TONE.cached}`} />
          Live stack · {live}/{s.services.length}
        </span>
        <span>{open ? '–' : '+'}</span>
      </button>
      {open && (
        <div className="space-y-1.5 px-3 pb-2.5">
          {s.services.map((x) => (
            <div key={x.key} className="flex items-start gap-2">
              <span className={`mt-1 size-2 shrink-0 rounded-full ${TONE[x.state]}`} />
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-2">
                  <span className="truncate text-fog">{x.name}</span>
                  <span className={`shrink-0 font-mono ${x.state === 'live' ? 'text-accept' : x.state === 'cached' ? 'text-moderate' : 'text-severe'}`}>{WORD[x.state]}</span>
                </div>
                {x.detail && <div className="truncate font-mono text-[10px] text-mute">{x.detail.replace(/^https?:\/\//, '')}</div>}
              </div>
            </div>
          ))}
          <div className="border-t border-line pt-1.5 font-mono text-[10px] text-mute">
            {s.data_mode === 'real' ? 'real archive footage' : 'simulated footage'} · replay {s.replay.mode} · {s.replay.replayed} answered from cache · {s.checked_at}
          </div>
        </div>
      )}
    </div>
  )
}
