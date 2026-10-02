// Team contract. Field names follow MASTER.md sections 3–5 exactly; do not rename.
// Times `t` are seconds from the start of that camera's video. Ground units are meters.

export type Pt = [number, number]
export type Mat3 = [[number, number, number], [number, number, number], [number, number, number]]

// ---- 3. Static configuration ----------------------------------------------

export interface Site {
  site_id: string
  name: string
  camera_ids: string[]
  speed_limit_mph: number
  signalized: boolean
}

export interface Crosswalk {
  id: string
  polygon: Pt[]
}

export interface Ground {
  legs: Partial<Record<'N' | 'S' | 'E' | 'W', Pt[]>>
  crosswalks: Crosswalk[]
  box: Pt[]
}

export interface Camera {
  camera_id: string
  site_id: string
  label: string
  video_url: string
  fps: number
  width: number
  height: number
  /** image pixels -> ground meters */
  homography: Mat3
  ground: Ground
}

export interface ConfigResponse {
  sites: Site[]
  cameras: Camera[]
}

// ---- 4.1 / 4.2 Tracks ------------------------------------------------------

export type RoadUserClass = 'person' | 'bicycle' | 'motorcycle' | 'car' | 'bus' | 'truck'
export type Movement = 'through' | 'left_turn' | 'right_turn' | 'u_turn' | 'crossing' | 'unknown'

export interface TrackSummary {
  camera_id: string
  track_id: number
  cls: RoadUserClass
  t_in: number
  t_out: number
  entry_leg: string
  exit_leg: string
  movement: Movement
  /** [t, gx, gy] at 10 Hz */
  path: [number, number, number][]
  max_speed_mps: number
  dims_m: [number, number]
}

// ---- 4.3 Event --------------------------------------------------------------

export type ConflictType =
  | 'ped_vs_right_turn'
  | 'ped_vs_left_turn'
  | 'ped_vs_through'
  | 'bike_vs_right_turn'
  | 'bike_vs_through'
  | 'veh_left_turn_vs_through'
  | 'veh_angle'
  | 'veh_rear_end'
  | 'other'

export type Verdict = 'ACCEPT' | 'REJECT' | 'UNSURE'
export type EventStatus = 'candidate' | 'verified' | 'rejected' | 'unsure'
export type Severity = 'severe' | 'moderate' | 'low'

export interface EventActor {
  track_id: number
  cls: RoadUserClass
  movement: Movement
  speed_mps: number
}

export interface Verification {
  verdict: Verdict
  reason: string
  description: string
  contributing_factors: string[]
  conditions: { lighting: 'day' | 'night' | 'dusk'; weather: string; visibility_issue: boolean }
  evasive_action: string
  model: string
  confidence: number
}

export interface AlmostEvent {
  event_id: string
  site_id: string
  camera_id: string
  t_conflict: number
  clip: { t0: number; t1: number; url: string; thumb: string }
  a: EventActor
  b: EventActor
  conflict_type: ConflictType
  conflict_point: Pt
  pet_s: number
  min_ttc_s: number
  first_through: 'a' | 'b'
  severity: Severity
  score: number
  verification?: Verification
  pattern_id?: string | null
  status: EventStatus
}

/** `/events/{id}` adds image-space tracks for the clip: [t, u, v, x1, y1, x2, y2] */
export type OverlayRow = [number, number, number, number, number, number, number]
export interface EventDetail extends AlmostEvent {
  overlay: { a: OverlayRow[]; b: OverlayRow[] }
}

// ---- 4.4 WHAT-IF ------------------------------------------------------------

export interface WhatIf {
  event_id: string
  shift_actor: 'a' | 'b'
  a: { cls: RoadUserClass; dims_m: [number, number]; path: [number, number, number, number][] }
  /**
   * Extension beyond MASTER 4.4 (see TEAM_NOTES.md): path rows may carry heading
   * as a 4th value, and `dims_m` is present when B is a vehicle.
   */
  b: { cls: RoadUserClass; radius_m: number; dims_m?: [number, number]; path: ([number, number, number] | [number, number, number, number])[] }
  image_paths: { a: [number, number, number][]; b: [number, number, number][] }
  /** ground meters -> image pixels */
  homography_inv: Mat3
  observed: { pet_s: number; min_gap_m: number }
  /** [shift_s, min_gap_m] every 0.05 s from -3 to +3 */
  gap_curve: [number, number][]
  contact_ranges: [number, number][]
  first_contact_shift_s: number | null
  impact: { shift_s: number; t: number; point: Pt; speed_mps: number } | null
  disclaimer: string
}

// ---- 4.5 Pattern + recommendation ----------------------------------------

export interface Recommendation {
  countermeasure_id: string
  name: string
  source: string
  url: string
  why: string
  cited_event_ids: string[]
  review_note: string
}

export interface Pattern {
  pattern_id: string
  site_id: string
  conflict_type: ConflictType
  signature: string
  event_ids: string[]
  count: number
  worst_pet_s: number
  median_pet_s: number
  conditions: Record<string, number>
  summary: string
  recommendations: Recommendation[]
}

// ---- 5. API responses -------------------------------------------------------

export interface SimilarEvent {
  event: AlmostEvent
  score: number
}

export interface SiteReport {
  site: Site
  patterns: Pattern[]
  recommendations: Recommendation[]
  top_events: AlmostEvent[]
  generated_at: string
  disclaimer: string
}

export interface EvalResult {
  detection: { recall: number; precision: number }
  measurement: { pet_mae_s: number }
  verification: { accuracy: number; decoys_rejected: string }
  patterns: { purity: number }
  recommendations: { from_catalog: number; urls_valid: number; claims_cited: number }
  weave_url: string
  run_at: string
}

export type Stage = 'scan' | 'measure' | 'verify' | 'remember' | 'recall' | 'pattern' | 'recommend' | 'report'
export const STAGES: Stage[] = ['scan', 'measure', 'verify', 'remember', 'recall', 'pattern', 'recommend', 'report']

export interface RunCounts {
  video_minutes: number
  road_users: number
  interactions: number
  candidates: number
  verified: number
  rejected: number
  patterns: number
}

export type WsMessage =
  | { type: 'run.stage'; run_id: string; stage: Stage; status: 'start' | 'progress' | 'done'; progress: number; counts: RunCounts }
  | { type: 'run.candidate'; event: AlmostEvent }
  | { type: 'run.verified'; event_id: string; verdict: Verdict; reason: string }
  | { type: 'run.similar'; event_id: string; similar_ids: string[] }
  | { type: 'run.pattern'; pattern: Pattern }
  | { type: 'run.recommendation'; pattern_id: string; recommendation: Recommendation }
  | { type: 'run.done'; run_id: string }
