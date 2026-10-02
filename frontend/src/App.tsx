import { useEffect } from 'react'
import { useRoute, useRun, parseHash } from './store.ts'
import { useConfig } from './data/hooks.ts'
import { USE_MOCK } from './data/api.ts'
import { StageRibbon } from './components/bits.tsx'
import EvalPanel from './components/EvalPanel.tsx'
import LiveStatus from './components/LiveStatus.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import Sweep from './acts/Sweep.tsx'
import Theater from './acts/Theater.tsx'
import Report from './acts/Report.tsx'
import Calibrate from './acts/Calibrate.tsx'

// MASTER's calibration route is a path (/calibrate/:cameraId); Vite's SPA
// fallback serves index.html there, so map it onto the hash router.
const calib = location.pathname.match(/^(.*)\/calibrate\/([^/]+)/)
if (calib) {
  const [, prefix, id] = calib
  history.replaceState(null, '', `${prefix}/#/calibrate/${id}`)
  useRoute.setState({ route: parseHash(`#/calibrate/${id}`) })
}

export default function App() {
  const route = useRoute((s) => s.route)
  const go = useRoute((s) => s.go)
  const { stages, stage, phase } = useRun()
  const { config } = useConfig()

  // Deep links (event / report) without a run in memory: load the finished investigation.
  useEffect(() => {
    if (route.name !== 'sweep' && route.name !== 'calibrate' && phase === 'idle') useRun.getState().hydrateFinished()
  }, [route.name, phase])

  return (
    <div className="flex h-full flex-col">
      <header className="no-print flex h-16 shrink-0 items-center gap-4 overflow-hidden px-5">
        <button onClick={() => go('#/')} className="flex items-baseline gap-2">
          <span className="text-2xl font-black tracking-tight">LOOKOUT</span>
          <span className="size-2 rounded-full bg-brand shadow-[0_0_12px_var(--color-brand)]" />
        </button>
        {phase !== 'idle' && <StageRibbon stages={stages} current={stage} />}
        <nav className="ml-auto flex items-center gap-0.5 text-[13px] whitespace-nowrap">
          {config?.sites.map((s) => (
            <button
              key={s.site_id}
              onClick={() => go(`#/report/${s.site_id}`)}
              className={`rounded-md px-2.5 py-1.5 hover:bg-panel-2 ${route.name === 'report' && route.siteId === s.site_id ? 'bg-panel-2 text-fog' : 'text-mute'}`}
              title={`Site report: ${s.name}`}
            >
              {s.name.replace(' (simulated)', '')}
            </button>
          ))}
          <button
            onClick={() => { useRun.getState().reset(); go('#/') }}
            className="mr-1 flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-fog hover:border-brand hover:text-brand"
            title="Back to the camera wall, ready for a new investigation"
          >
            <span aria-hidden>↺</span> Restart
          </button>
          <button onClick={() => go(`#/calibrate/${config?.cameras[0]?.camera_id ?? ''}`)} className={`rounded-md px-2.5 py-1.5 hover:bg-panel-2 ${route.name === 'calibrate' ? 'bg-panel-2 text-fog' : 'text-mute'}`}>
            Calibrate
          </button>
          {USE_MOCK && <span className="ml-2 rounded border border-moderate/40 px-1.5 py-0.5 font-mono text-[10px] text-moderate">MOCK DATA</span>}
        </nav>
      </header>
      <main className="min-h-0 flex-1">
        <ErrorBoundary key={JSON.stringify(route)}>
        {route.name === 'sweep' && <Sweep />}
        {route.name === 'event' && <Theater key={route.id} id={route.id} />}
        {route.name === 'report' && <Report key={route.siteId} siteId={route.siteId} />}
        {route.name === 'calibrate' && <Calibrate key={route.cameraId} cameraId={route.cameraId} />}
        </ErrorBoundary>
      </main>
      {route.name !== 'calibrate' && <EvalPanel />}
      <LiveStatus />
    </div>
  )
}
