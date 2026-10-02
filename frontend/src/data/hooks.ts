import { useEffect, useState } from 'react'
import { api } from './api.ts'
import type { Camera, ConfigResponse, Site } from '../types.ts'

/** Minimal async loader: { data, error, loading }. Re-runs when `key` changes. */
export function useAsync<T>(fn: () => Promise<T>, key: unknown[] = []) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true })
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true, error: null }))
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e) => alive && setState({ data: null, error: String(e), loading: false }),
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, key)
  return state
}

export function useConfig() {
  const { data } = useAsync<ConfigResponse>(api.config)
  const cameras: Record<string, Camera> = Object.fromEntries((data?.cameras ?? []).map((c) => [c.camera_id, c]))
  const sites: Record<string, Site> = Object.fromEntries((data?.sites ?? []).map((s) => [s.site_id, s]))
  return { config: data, cameras, sites }
}
