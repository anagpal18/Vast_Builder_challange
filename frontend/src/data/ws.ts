// Run stream. Real mode: the backend WebSocket. Mock mode: replays
// public/mock/run.json (generated alongside the mock events) on timers.

import type { WsMessage } from '../types.ts'
import { MOCK_ROOT, USE_MOCK, WS_URL } from './api.ts'

export type Unsubscribe = () => void

export function connectRun(onMessage: (m: WsMessage) => void, opts: { speed?: number } = {}): Unsubscribe {
  if (!USE_MOCK) {
    const ws = new WebSocket(WS_URL)
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data))
      } catch (err) {
        console.warn('bad ws message', err)
      }
    }
    return () => ws.close()
  }

  const speed = opts.speed ?? 1
  const timers: number[] = []
  let cancelled = false
  fetch(`${MOCK_ROOT}/run.json`)
    .then((r) => r.json() as Promise<{ at: number; msg: WsMessage }[]>)
    .then((steps) => {
      if (cancelled) return
      for (const s of steps) timers.push(window.setTimeout(() => onMessage(s.msg), s.at / speed))
    })
  return () => {
    cancelled = true
    timers.forEach(clearTimeout)
  }
}
