export type GradeTier = "top" | "upper" | "mid" | "lower" | "struggling";

export interface CatalogItem {
  id: string;
  label: string;
  kind?: string;
}

export interface PresentPreview {
  id: string;
  name: string;
  sprite?: SpriteRef;
  q_sprite?: SpriteRef;
  is_pc?: boolean;
}

export interface LocationInfo {
  id: string;
  name: string;
  blurb: string;
  present_count?: number;
  present_preview?: PresentPreview[];
}

export interface SpriteRef {
  student_id?: string;
  path: string | null;
  file: string | null;
  fallback?: boolean;
  kind?: "sprite" | "q" | string;
}

export interface NpcMindPublic {
  mood: string;
  thought: string;
  judgment?: string;
  focus_id?: string | null;
  event_take?: string | null;
  updated_day?: number;
  updated_period?: string;
}

export interface StudentPublic {
  id: string;
  name: string;
  gender: "male" | "female";
  mbti: string;
  grade_tier: string;
  look_tag: string;
  charm?: number;
  is_pc?: boolean;
  sprite?: SpriteRef;
  q_sprite?: SpriteRef;
  scores?: Record<string, number>;
  seat?: { group: number; row: number; seat: number; student_id: string };
  rank?: number | null;
  mind?: NpcMindPublic | null;
  location_id?: string | null;
  seat_relation?: string | null;
  seat_label?: string | null;
  can_direct_chat?: boolean;
}

export interface PendingIntent {
  type: string;
  from_id: string;
  from_name?: string;
  blurb: string;
  mood?: string;
  location_id?: string | null;
  sprite?: SpriteRef;
}

export interface EventReaction {
  id: string;
  name?: string;
  mood?: string;
  event_take: string;
  sprite?: SpriteRef;
}

export interface ActiveEvent {
  id: string;
  label: string;
  blurb: string;
  talk_npc_id?: string | null;
  talk_npc_name?: string | null;
  talk_npc_q?: SpriteRef;
  location_id?: string | null;
  source?: string;
  effects?: Record<string, number>;
}

export interface PeriodRecapNeighbor {
  id: string;
  name: string;
  delta: number;
  seat_relation?: string;
  seat_label?: string;
}

export interface PeriodRecap {
  from_period?: { id?: string; label?: string; kind?: string } | null;
  to_period?: { id?: string; label?: string; kind?: string } | null;
  day_index?: number;
  days_left?: number;
  class_gain?: { subject_id: string; subject_label: string; pc_gain: number } | null;
  neighbors?: PeriodRecapNeighbor[];
  intents?: { from_id?: string; from_name?: string; blurb?: string; type?: string }[];
  event?: ActiveEvent | null;
  reactions?: EventReaction[];
  world_events?: WorldEvent[];
  skipped_periods?: { id?: string; label?: string; kind?: string }[];
  summary?: string;
  ended?: boolean;
}

export interface WorldEvent {
  type?: string;
  blurb?: string;
  a?: string;
  b?: string;
  a_name?: string;
  b_name?: string;
  location_id?: string;
  bond_kind?: string;
  dramatic?: boolean;
}

export interface CalendarState {
  day_index: number;
  days_left?: number;
  weekday?: number;
  day_kind?: string;
  period_id: string;
  period_label: string;
  period_kind?: string;
  weather_id?: string;
  weather_label?: string;
}

export interface HubState {
  save_id: string;
  calendar: CalendarState;
  location_id: string;
  locations: LocationInfo[];
  present: StudentPublic[];
  protagonist: {
    name: string;
    grade_tier: string;
    mbti: string;
  };
  class_name: string;
  edge_count: number;
  student_count: number;
  chat_actions_left?: number;
  note_actions_left?: number;
  club_action_used?: boolean;
  spot_action_used?: boolean;
  active_event?: ActiveEvent | null;
  pending_intents?: PendingIntent[];
  event_reactions?: EventReaction[];
  world_events?: WorldEvent[];
  pc_scores?: Record<string, number>;
  bg?: SpriteRef;
  last_action?: {
    type: string;
    subject_id?: string;
    gain?: number;
    neighbors?: { id: string; name: string; delta: number; seat_label?: string }[];
    from_period?: string;
    skipped?: number;
  };
  period_summary?: string;
  period_recap?: PeriodRecap | null;
  mind_tick?: { used_llm?: boolean; sampled?: string[]; intent_count?: number };
  ended?: boolean;
  ending?: EndingState | null;
}

export interface EndingRomance {
  id: string;
  name: string;
  affinity: number;
  stage: string;
  stage_label?: string;
  sprite?: SpriteRef;
  q_sprite?: SpriteRef;
}

export interface EndingState {
  kind: string;
  ending_id?: string;
  title: string;
  tone: string;
  blurb: string;
  grade_band?: string;
  romance_bucket?: string;
  pc_rank: number;
  pc_total: number;
  pc_scores?: Record<string, number>;
  ranking_top?: { id: string; name: string; total: number; rank: number; is_pc?: boolean }[];
  romance?: EndingRomance | null;
  social_epilogue?: {
    blurb?: string;
    couple_count?: number;
    couples?: { label: string; affinity?: number; stage?: string }[];
    rivals?: { label: string; affinity?: number }[];
    near_miss?: string[];
  } | null;
  day_index?: number;
  protagonist_name?: string;
}

export interface CampusMeta {
  map: {
    periods: CatalogItem[];
    weekday_periods?: CatalogItem[];
    weekend_periods?: CatalogItem[];
    locations: LocationInfo[];
  };
  personality: {
    grade_tiers: CatalogItem[];
    mbti_types: string[];
  };
  subjects?: {
    subjects: { id: string; label: string; max: number }[];
  };
  class_name: string;
  class_id: string;
  roster_size: number;
}

export interface BoardEdge {
  a: string;
  b: string;
  affinity: number;
  stage: string;
  track: string;
  bond_kind?: string;
  other_id?: string;
  other_name?: string;
  other_sprite?: SpriteRef;
  other_q_sprite?: SpriteRef;
  a_name?: string;
  b_name?: string;
  label?: string;
}

export interface BoardToday {
  weather_id?: string;
  weather_label?: string;
  active_event?: ActiveEvent | null;
  pending_intents?: PendingIntent[];
  pc_neighbors?: { id: string; name: string; seat_relation: string; seat_label: string }[];
  event_reactions?: EventReaction[];
  world_events?: WorldEvent[];
}

export interface BoardState {
  class_name: string;
  calendar: CalendarState;
  students: StudentPublic[];
  pc_edges: BoardEdge[];
  class_gossip?: BoardEdge[];
  world_events?: WorldEvent[];
  seating: { student_id: string; group: number; row: number; seat: number }[];
  last_mock?: { day_index: number; pc_rank?: number; ranking?: unknown[] } | null;
  name_by_id?: Record<string, string>;
  today?: BoardToday;
}

export interface SaveListItem {
  save_id: string;
  kind: string;
  slot: number | null;
  title: string;
  updated_at: string;
  cover?: {
    day_index?: number;
    weather_id?: string;
    period_id?: string;
    protagonist_name?: string;
    days_left?: number;
  };
}

export interface TalkPrep {
  target: StudentPublic;
  edge: { a: string; b: string; affinity: number; stage: string; track: string };
  seat_relation?: string | null;
  action_cost?: number;
  chat_actions_left?: number;
  note_actions_left?: number;
  calendar: CalendarState;
  location_id: string;
  bg?: SpriteRef;
  active_event?: ActiveEvent | null;
  /** Explicit Q portrait for dialogue nameplate (also on target.q_sprite). */
  q_sprite?: SpriteRef;
  sprite?: SpriteRef;
  /** "date" = weekend date short scene */
  scene?: "talk" | "date" | string;
  soft_options?: string[];
  opening_line?: string | null;
}

export interface ChatResult {
  line: string;
  emotion: string;
  thought?: string;
  judgment?: string;
  soft_options: string[];
  public_deltas?: { affinity_delta?: number; stage?: string; score_gain?: number; subject_id?: string };
  edge: { affinity: number; stage: string; track: string };
  sprite?: SpriteRef;
  q_sprite?: SpriteRef;
  judge_ok?: boolean;
  action_blurb?: string | null;
  verb?: string;
  scene?: string;
}

export type ScreenId =
  | "title"
  | "create"
  | "saves"
  | "save_slots"
  | "map"
  | "location"
  | "talk"
  | "ending";
