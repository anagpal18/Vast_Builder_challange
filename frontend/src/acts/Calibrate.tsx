import { useEffect, useMemo, useRef, useState } from 'react'
import { api, mediaUrl } from '../data/api.ts'
import { useConfig } from '../data/hooks.ts'
import { useRoute } from '../store.ts'
import { applyH, invert3, reprojectionError, solveHomography } from '../lib/geometry.ts'
import type { Camera, Ground, Mat3, Pt } from '../types.ts'

interface Pair {
  img: Pt
  ground: [string, string] // typed text, parsed on solve
}

type PolyKey = 'N' | 'S' | 'E' | 'W' | 'box' | `CW_${string}`
type Mode = 'points' | 'draw'

const LEG_KEYS = ['N', 'S', 'E', 'W'] as const

/**
 * /calibrate/:cameraId — click >= 4 road points on a frame, type their ground
 * coordinates (meters), solve the homography client-side, check it against a
 * projected 5 m grid, draw legs / crosswalks / box, then PUT to the backend.
 */
export default function Calibrate({ cameraId }: { cameraId: string }) {
  const { config, cameras } = useConfig()
  const cam = cameras[cameraId]
  const go = useRoute((s) => s.go)
  if (!config) return <div className="p-10 text-mute">Loading cameras…</div>
  if (!cam) {
    return (
      <div className="p-10">
        <div className="mb-3 text-mute">Pick a camera to calibrate:</div>
        <div className="flex flex-wrap gap-2">
          {config.cameras.map((c) => (
            <button key={c.camera_id} onClick={() => go(`#/calibrate/${c.camera_id}`)} className="rounded border border-line px-3 py-1.5 font-mono text-sm hover:border-fog">{c.camera_id}</button>
          ))}
        </div>
      </div>
    )
  }
  return <Tool cam={cam} cameras={config.cameras} />
}

function Tool({ cam, cameras }: { cam: Camera; cameras: Camera[] }) {
  const go = useRoute((s) => s.go)
  const [pairs, setPairs] = useState<Pair[]>([])
  const [mode, setMode] = useState<Mode>('points')
  const [ground, setGround] = useState<Ground>({ legs: {}, crosswalks: [], box: [] })
  const [active, setActive] = useState<PolyKey>('box')
  const [draft, setDraft] = useState<Pt[]>([])
  const [saved, setSaved] = useState<string | null>(null)

  const parsed = pairs.map((p) => [p.img, [parseFloat(p.ground[0]), parseFloat(p.ground[1])] as Pt] as const)
  const usable = parsed.filter(([, g]) => Number.isFinite(g[0]) && Number.isFinite(g[1]))
  const solved = useMemo(() => {
    if (usable.length < 4) return null
    try {
      const H = solveHomography(usable.map((u) => u[0]), usable.map((u) => u[1]))
      return { H, Hinv: invert3(H), err: reprojectionError(H, usable.map((u) => u[0]), usable.map((u) => u[1])) }
    } catch {
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(usable)])

  const onImageClick = (p: Pt) => {
    setSaved(null)
    if (mode === 'points') {
      setPairs((ps) => [...ps, { img: p, ground: ['', ''] }])
      return
    }
    if (!solved) return
    const g = applyH(solved.H, p[0], p[1])
    setDraft((d) => [...d, [+g[0].toFixed(2), +g[1].toFixed(2)]])
  }

  const closeDraft = () => {
    if (draft.length < 3) return
    setGround((g) => {
      if (active === 'box') return { ...g, box: draft }
      if (active.startsWith('CW_')) return { ...g, crosswalks: [...g.crosswalks.filter((c) => c.id !== active), { id: active, polygon: draft }] }
      return { ...g, legs: { ...g.legs, [active]: draft } }
    })
    setDraft([])
  }

  /** Demo / check: pre-fill 4 pairs and the polygons from the camera's current calibration. */
  const loadCurrent = () => {
    const Hinv = invert3(cam.homography)
    const pts: Pt[] = [[-6, -10], [6, -10], [6, 10], [-6, 10]]
    setPairs(pts.map((g) => ({ img: applyH(Hinv, g[0], g[1]), ground: [String(g[0]), String(g[1])] })))
    setGround(cam.ground)
    setSaved(null)
  }

  const save = async () => {
    if (!solved) return
    const res = await api.saveCalibration(cam.camera_id, { homography: solved.H as Mat3, ground })
    setSaved(res.mock ? 'Saved (mock mode: logged to the console; no backend)' : 'Saved to backend')
  }

  const nextCw = `CW_${ground.crosswalks.length + 1}` as PolyKey

  return (
    <div className="grid h-full grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-4 px-5 pb-5">
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex items-center gap-2">
          <select value={cam.camera_id} onChange={(e) => go(`#/calibrate/${e.target.value}`)} className="rounded border border-line bg-panel px-2 py-1.5 font-mono text-sm">
            {cameras.map((c) => <option key={c.camera_id} value={c.camera_id}>{c.camera_id} · {c.label}</option>)}
          </select>
          <div className="ml-2 flex rounded-lg border border-line p-0.5 text-sm">
            <button onClick={() => setMode('points')} className={`rounded-md px-3 py-1 ${mode === 'points' ? 'bg-panel-2 text-fog' : 'text-mute'}`}>1 · Reference points</button>
            <button onClick={() => setMode('draw')} disabled={!solved} className={`rounded-md px-3 py-1 disabled:opacity-40 ${mode === 'draw' ? 'bg-panel-2 text-fog' : 'text-mute'}`}>2 · Draw ground polygons</button>
          </div>
          <button onClick={loadCurrent} className="ml-auto rounded border border-line px-3 py-1.5 text-sm text-mute hover:text-fog">Load current calibration</button>
          <button onClick={() => { setPairs([]); setGround({ legs: {}, crosswalks: [], box: [] }); setDraft([]) }} className="rounded border border-line px-3 py-1.5 text-sm text-mute hover:text-fog">Clear</button>
        </div>
        <Frame cam={cam} pairs={parsed} Hinv={solved?.Hinv ?? null} ground={ground} draft={draft} onClick={onImageClick} mode={mode} />
        <div className="text-sm text-mute">
          {mode === 'points'
            ? 'Click a point on the road surface (crosswalk corner, stop-line end, lane marking), then type its ground position in meters on the right. At least 4 points, spread out, not in a line.'
            : `Click on the image to add corners to "${active}" (mapped to ground through the homography). Close the polygon when done.`}
        </div>
      </div>

      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        <section className="rounded-xl border border-line bg-panel p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs uppercase tracking-widest text-mute">Point pairs (image px → ground m)</span>
            <span className={`font-mono text-xs ${usable.length >= 4 ? 'text-accept' : 'text-moderate'}`}>{usable.length}/4+</span>
          </div>
          {pairs.length === 0 && <div className="text-sm text-mute">No points yet.</div>}
          <table className="w-full text-sm">
            <tbody>
              {pairs.map((p, i) => (
                <tr key={i} className="border-t border-line/60">
                  <td className="py-1.5 pr-2 font-mono text-moderate">{i + 1}</td>
                  <td className="pr-2 font-mono text-xs text-mute">({p.img[0].toFixed(0)}, {p.img[1].toFixed(0)})</td>
                  {[0, 1].map((k) => (
                    <td key={k} className="pr-1">
                      <input
                        value={p.ground[k]}
                        placeholder={k ? 'Y (north)' : 'X (east)'}
                        aria-label={`Point ${i + 1} ground ${k ? 'Y' : 'X'}`}
                        onChange={(e) => setPairs((ps) => ps.map((q, j) => (j === i ? { ...q, ground: (k ? [q.ground[0], e.target.value] : [e.target.value, q.ground[1]]) as [string, string] } : q)))}
                        className="w-24 rounded border border-line bg-ink px-2 py-1 font-mono"
                      />
                    </td>
                  ))}
                  <td>
                    <button onClick={() => setPairs((ps) => ps.filter((_, j) => j !== i))} className="text-mute hover:text-severe" aria-label={`Remove point ${i + 1}`}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 rounded-lg bg-ink/60 p-3 text-sm">
            {solved ? (
              <>
                <div className="flex justify-between">
                  <span className="text-accept">Homography solved</span>
                  <span className="font-mono">reprojection error {solved.err.toFixed(3)} m</span>
                </div>
                <div className="mt-1 text-xs text-mute">The cyan 5 m grid on the frame should lie flat on the road. If it bends away from lane lines, adjust points.</div>
              </>
            ) : (
              <span className="text-mute">Need at least 4 points with ground coordinates.</span>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <div className="mb-2 text-xs uppercase tracking-widest text-mute">Ground polygons</div>
          <div className="flex flex-wrap gap-1.5">
            {([...LEG_KEYS, 'box', ...ground.crosswalks.map((c) => c.id), nextCw] as PolyKey[]).filter((v, i, a) => a.indexOf(v) === i).map((k) => {
              const done = k === 'box' ? ground.box.length > 0 : k.startsWith('CW_') ? ground.crosswalks.some((c) => c.id === k) : !!ground.legs[k as 'N']
              return (
                <button
                  key={k}
                  onClick={() => { setActive(k); setDraft([]); setMode('draw') }}
                  disabled={!solved}
                  className={`rounded border px-2 py-1 font-mono text-xs disabled:opacity-40 ${active === k ? 'border-ghost text-ghost' : done ? 'border-accept/50 text-accept' : 'border-line text-mute'}`}
                >
                  {k.length === 1 ? `leg ${k}` : k === nextCw && !done ? '+ crosswalk' : k}{done ? ' ✓' : ''}
                </button>
              )
            })}
          </div>
          {mode === 'draw' && (
            <div className="mt-3 flex items-center gap-2 text-sm">
              <span className="text-mute">{draft.length} corner(s)</span>
              <button onClick={closeDraft} disabled={draft.length < 3} className="rounded bg-ghost/20 px-3 py-1 text-ghost disabled:opacity-40">Close polygon</button>
              <button onClick={() => setDraft([])} className="text-mute hover:text-fog">discard</button>
            </div>
          )}
          <GroundPreview ground={ground} draft={draft} pairs={usable.map((u) => u[1])} />
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <button onClick={save} disabled={!solved} className="w-full rounded-lg bg-brand py-2.5 font-bold text-ink disabled:opacity-40">
            Save calibration · PUT /cameras/{cam.camera_id}/calibration
          </button>
          {saved && <div className="mt-2 text-center text-sm text-accept">{saved}</div>}
        </section>
      </aside>
    </div>
  )
}

function Frame({ cam, pairs, Hinv, ground, draft, onClick, mode }: {
  cam: Camera; pairs: (readonly [Pt, Pt])[]; Hinv: Mat3 | null; ground: Ground; draft: Pt[]; onClick: (p: Pt) => void; mode: Mode
}) {
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = video.current
    if (!v) return
    const seek = () => { v.currentTime = 1 }
    v.addEventListener('loadedmetadata', seek, { once: true })
    return () => v.removeEventListener('loadedmetadata', seek)
  }, [cam.video_url])
  const toImg = (g: Pt) => (Hinv ? applyH(Hinv, g[0], g[1]) : null)
  const polyPts = (pts: Pt[]) => pts.map(toImg).filter(Boolean).map((p) => `${p![0]},${p![1]}`).join(' ')
  const grid: [Pt, Pt][] = []
  for (let k = -30; k <= 30; k += 5) {
    grid.push([[k, -30], [k, 30]], [[-30, k], [30, k]])
  }
  // A solved homography is only defined up to scale (including sign), so learn
  // which sign of w means "in front of the camera" from the image centre.
  const frontSign = (() => {
    if (!Hinv) return 1
    const c = applyH(invert3(Hinv), cam.width / 2, cam.height * 0.75)
    return Math.sign(Hinv[2][0] * c[0] + Hinv[2][1] * c[1] + Hinv[2][2]) || 1
  })()
  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-black">
      <video ref={video} src={mediaUrl(cam.video_url)} muted playsInline preload="auto" className="block aspect-video w-full" />
      <svg
        viewBox={`0 0 ${cam.width} ${cam.height}`}
        className={`absolute inset-0 h-full w-full ${mode === 'points' || Hinv ? 'cursor-crosshair' : ''}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          onClick([((e.clientX - r.left) / r.width) * cam.width, ((e.clientY - r.top) / r.height) * cam.height])
        }}
      >
        {Hinv && grid.map(([a, b], i) => {
          // Sample each grid line so perspective is visible; skip points behind the camera.
          const pts: string[] = []
          for (let s = 0; s <= 1.0001; s += 0.05) {
            const g: Pt = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]
            const p = applyH(Hinv, g[0], g[1])
            const w = Hinv[2][0] * g[0] + Hinv[2][1] * g[1] + Hinv[2][2]
            if (w * frontSign > 0 && Math.abs(p[0]) < 5000 && Math.abs(p[1]) < 5000) pts.push(`${p[0]},${p[1]}`)
          }
          return <polyline key={i} points={pts.join(' ')} fill="none" stroke="#a5f3fc" strokeOpacity="0.45" strokeWidth="1" />
        })}
        {Hinv && (
          <g>
            {Object.entries(ground.legs).map(([k, pts]) => pts && <polygon key={k} points={polyPts(pts)} fill="rgba(78,168,255,0.12)" stroke="#4ea8ff" strokeWidth="1.5" />)}
            {ground.box.length > 0 && <polygon points={polyPts(ground.box)} fill="rgba(255,173,31,0.1)" stroke="#ffad1f" strokeWidth="1.5" />}
            {ground.crosswalks.map((c) => <polygon key={c.id} points={polyPts(c.polygon)} fill="rgba(255,255,255,0.15)" stroke="white" strokeWidth="1.5" strokeDasharray="5 4" />)}
            {draft.length > 0 && <polyline points={polyPts(draft)} fill="none" stroke="#a5f3fc" strokeWidth="2" />}
          </g>
        )}
        {pairs.map(([p], i) => (
          <g key={i}>
            <circle cx={p[0]} cy={p[1]} r="7" fill="none" stroke="#ffad1f" strokeWidth="2" />
            <circle cx={p[0]} cy={p[1]} r="1.8" fill="#ffad1f" />
            <text x={p[0] + 10} y={p[1] - 8} fill="#ffad1f" fontSize="15" fontWeight="700" fontFamily="JetBrains Mono, monospace">{i + 1}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

function GroundPreview({ ground, draft, pairs }: { ground: Ground; draft: Pt[]; pairs: Pt[] }) {
  const poly = (pts: Pt[]) => pts.map(([x, y]) => `${x},${-y}`).join(' ')
  return (
    <svg viewBox="-30 -20 60 40" className="mt-3 w-full rounded-lg bg-[#0a0f14]">
      <path d={Array.from({ length: 13 }, (_, i) => `M${-30 + i * 5} -20V20M-30 ${-20 + i * 5}H30`).join('')} stroke="#141c26" strokeWidth="0.1" />
      {Object.values(ground.legs).map((pts, i) => pts && <polygon key={i} points={poly(pts)} fill="rgba(78,168,255,0.2)" stroke="#4ea8ff" strokeWidth="0.15" />)}
      {ground.box.length > 0 && <polygon points={poly(ground.box)} fill="rgba(255,173,31,0.15)" stroke="#ffad1f" strokeWidth="0.15" />}
      {ground.crosswalks.map((c) => <polygon key={c.id} points={poly(c.polygon)} fill="rgba(255,255,255,0.2)" stroke="white" strokeWidth="0.12" />)}
      {draft.length > 0 && <polyline points={poly(draft)} fill="none" stroke="#a5f3fc" strokeWidth="0.2" />}
      {pairs.map(([x, y], i) => <circle key={i} cx={x} cy={-y} r="0.6" fill="#ffad1f" />)}
      <text x="28.5" y="-17.5" fontSize="1.8" fill="#7d8a9c" textAnchor="end">N ↑ · meters</text>
    </svg>
  )
}
