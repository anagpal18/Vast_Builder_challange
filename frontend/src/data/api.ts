// REST client. With VITE_API_BASE unset, reads the generated mocks under /mock.
// With it set, talks to Shresth's backend using the exact MASTER section 5 paths.

import type {
  AlmostEvent, ConfigResponse, EvalResult, EventDetail, Pattern, SimilarEvent, SiteReport, WhatIf, Mat3, Ground,
} from '../types.ts'

export const API_BASE: string | undefined = import.meta.env.VITE_API_BASE || undefined
export const WS_URL: string = import.meta.env.VITE_WS_URL || (API_BASE ? API_BASE.replace(/^http/, 'ws') + '/ws' : '')
export const USE_MOCK = !API_BASE

const cache = new Map<string, Promise<unknown>>()

async function get<T>(real: string, mock: string): Promise<T> {
  const url = USE_MOCK ? `/mock/${mock}` : `${API_BASE}${real}`
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`)
      return r.json()
    }).catch((e) => {
      cache.delete(url)
      throw e
    }))
  }
  return cache.get(url) as Promise<T>
}

/** Media paths from the backend are relative (`/media/...`); mocks are already rooted. */
export function mediaUrl(path: string) {
  if (!path || USE_MOCK || /^https?:/.test(path)) return path
  return `${API_BASE}${path}`
}

export const api = {
  config: () => get<ConfigResponse>('/config', 'config.json'),
  events: () => get<AlmostEvent[]>('/events', 'events.json'),
  event: (id: string) => get<EventDetail>(`/events/${id}`, `events/${id}.json`),
  whatif: (id: string) => get<WhatIf>(`/events/${id}/whatif`, `whatif/${id}.json`),
  similar: (id: string) => get<SimilarEvent[]>(`/events/${id}/similar`, `similar/${id}.json`),
  patterns: () => get<Pattern[]>('/patterns', 'patterns.json'),
  report: (siteId: string) => get<SiteReport>(`/report/${siteId}`, `reports/${siteId}.json`),
  reportMarkdownUrl: (siteId: string) => (USE_MOCK ? `/mock/reports/${siteId}.md` : `${API_BASE}/report/${siteId}.md`),
  evalLatest: () => get<EvalResult>('/eval/latest', 'eval.json'),

  async investigate(): Promise<{ run_id: string }> {
    if (USE_MOCK) return { run_id: 'r1' }
    const r = await fetch(`${API_BASE}/investigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_ids: null }),
    })
    if (!r.ok) throw new Error(`investigate failed: ${r.status}`)
    return r.json()
  },

  async saveCalibration(cameraId: string, body: { homography: Mat3; ground: Ground }) {
    if (USE_MOCK) {
      console.info('[mock] PUT /cameras/%s/calibration', cameraId, body)
      return { ok: true, mock: true }
    }
    const r = await fetch(`${API_BASE}/cameras/${cameraId}/calibration`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`calibration save failed: ${r.status}`)
    return { ok: true, mock: false }
  },
}
