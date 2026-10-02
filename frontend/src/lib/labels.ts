// Plain words for every id the UI shows. Never render raw type ids.

import type { ConflictType, RoadUserClass, Severity, Stage, Movement } from '../types.ts'

export const CONFLICT_LABEL: Record<ConflictType, string> = {
  ped_vs_right_turn: 'Turning car vs pedestrian',
  ped_vs_left_turn: 'Left-turning car vs pedestrian',
  ped_vs_through: 'Car vs crossing pedestrian',
  bike_vs_right_turn: 'Turning car vs cyclist',
  bike_vs_through: 'Car vs cyclist',
  veh_left_turn_vs_through: 'Left turn vs oncoming car',
  veh_angle: 'Cars crossing paths',
  veh_rear_end: 'Rear-end close call',
  other: 'Close call',
}

export const CLASS_LABEL: Record<RoadUserClass, string> = {
  person: 'pedestrian',
  bicycle: 'cyclist',
  motorcycle: 'motorcyclist',
  car: 'car',
  bus: 'bus',
  truck: 'truck',
}

export const MOVEMENT_LABEL: Record<Movement, string> = {
  through: 'going straight',
  left_turn: 'turning left',
  right_turn: 'turning right',
  u_turn: 'making a U-turn',
  crossing: 'crossing',
  unknown: 'moving',
}

export const STAGE_LABEL: Record<Stage, string> = {
  scan: 'Scan',
  measure: 'Measure',
  verify: 'Verify',
  remember: 'Remember',
  recall: 'Recall',
  pattern: 'Pattern',
  recommend: 'Recommend',
  report: 'Report',
}

export const SEVERITY_COLOR: Record<Severity, string> = {
  severe: 'var(--color-severe)',
  moderate: 'var(--color-moderate)',
  low: 'var(--color-low)',
}

export const mph = (mps: number) => Math.round(mps * 2.237)
export const secs = (s: number) => `${s.toFixed(1)} s`
export const vulnerable = (c: RoadUserClass) => c === 'person' || c === 'bicycle'

export function clock(t: number) {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
