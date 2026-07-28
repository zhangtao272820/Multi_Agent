export type PersonalityTraits = {
  tsundere: number;
  gentle: number;
  cheerful: number;
  clingy: number;
  mature: number;
  shy: number;
};

export type GrowthMode = "fixed" | "progressive";

export type CharacterProfile = {
  character_id?: string;
  name: string;
  age: number;
  relationship: string;
  occupation: string;
  backstory: string;
  personality: string;
  appearance: string;
  speaking_style: "casual" | "cute" | "formal" | "sharp";
  traits: PersonalityTraits;
  opening_line: string;
  live2d_model: string;
  vrm_model: string;
  tts_voice: string;
  theme_color: string;
  relationship_stage: string;
  growth_mode: GrowthMode;
  target_relationship: string;
  target_stage_id: string;
  initial_affinity: number;
  user_title: string;
  mbti_type?: string;
  mbti_label?: string;
  /** romance=可攻略女主；neutral=羁绊中立（影响结局） */
  cast_role?: "romance" | "neutral";
};

export type RelationshipStageDef = {
  id: string;
  label: string;
  affinity_min: number;
  user_title: string;
  tone: string;
  tts_hint: string;
};

export type RelationshipState = {
  stage_id: string;
  stage_label: string;
  affinity: number;
  trust: number;
  mood?: number;
  user_title: string;
  growth_mode: GrowthMode;
  target_stage_id: string;
  max_stage_id?: string;
  route_label?: string;
  turns: number;
  flags?: Record<string, boolean>;
  low_streak?: number;
  active_ending_id?: string | null;
};

export type MemoryFact = {
  text: string;
  source: "user" | "system";
  tags?: string[];
};

export type EndingPresentation = {
  bg?: string;
  bgm?: string;
  sprite?: { character_id?: string; outfit?: string; emotion?: string };
  /** 多段旁白（可翻页）；缺省则只用 description */
  pages?: string[];
};

export type EndingInfo = {
  id?: string;
  type?: string;
  title: string;
  subtitle?: string;
  description: string;
  cg_hint?: string;
  character_ids?: string[];
  presentation?: EndingPresentation;
};

export type CharacterRoute = {
  character_id: string;
  base_id: string;
  growth_mode: GrowthMode;
  start_stage_id: string;
  target_stage_id: string;
  max_stage_id: string;
  allowed_endings: string[];
  route_label: string;
  cast_role?: "romance" | "neutral";
};

export type GalSceneInfo = {
  id: string;
  label: string;
  css: string;
  /** full-bleed scenic CG, e.g. /api/bgs/campus.png */
  image?: string;
  season?: string;
};

export type EnsembleCastMember = {
  character_id: string;
  name: string;
  theme_color?: string;
  sprite_outfit?: string;
};

/** 双人同场会话快照（最多 2 人全身） */
export type EnsemblePublic = {
  enabled: boolean;
  cast_ids: string[];
  focus_id: string;
  speaking_id: string;
  guest_affinity_ok?: boolean;
  cast: EnsembleCastMember[];
  /** 旁观者短反应（可选，≤1 句） */
  guest_reaction?: string;
};

export type DailyState = {
  date: string;
  action_points: number;
  action_points_max: number;
  encounters_done: string[];
  active_encounter_id?: string | null;
};

export type DailyEncounterEntry = {
  id: string;
  label: string;
  description: string;
  scene_id?: string;
  cost: number;
};

export type QuestStepInfo = {
  id: string;
  label: string;
  description: string;
  status?: "done" | "active" | "locked";
};

export type QuestState = {
  chain_id?: string | null;
  chain_label?: string;
  active_step?: QuestStepInfo | null;
  completed_count: number;
  total_steps: number;
  steps_done?: string[];
  steps?: QuestStepInfo[];
};

export type EndingCatalogEntry = {
  id: string;
  type?: string;
  title: string;
  subtitle?: string;
  description: string;
  cg_hint?: string;
  character_ids?: string[];
  presentation?: EndingPresentation;
};

export type ScreenId =
  | "title"
  | "hub"
  | "location"
  | "codex"
  | "saves"
  | "gallery"
  | "sprites"
  | "play"
  | "roster"
  | "settings";

export type WorldLocation = {
  id: string;
  label: string;
  scene_id?: string;
  travel_cost?: number;
  present_count?: number;
  /** 地图头像：该地点当前在场角色（轻量预览） */
  present?: { character_id: string; name: string; theme_color?: string }[];
};

export type BondSummary = {
  character_id: string;
  base_id?: string;
  name: string;
  cast_kind: string;
  social_role_to_pc: string;
  role_hint?: string;
  theme_color?: string;
  affinity: number;
  trust: number;
  mood?: number;
  stage_id: string;
  stage_label: string;
  user_title?: string;
  route_label?: string;
  turns: number;
  message_count: number;
  status_hint?: string;
  /** 当前时段/地点解析出的立绘前缀；空则用裸情绪图 */
  sprite_outfit?: string;
  /** 是否已交谈（后端计算） */
  met?: boolean;
  /** 以下字段：已交谈后才下发（看板性格区） */
  age?: number | null;
  occupation?: string;
  personality?: string;
  appearance?: string;
  mbti_type?: string;
  mbti_label?: string;
  speaking_style?: string;
  traits?: PersonalityTraits | Record<string, number>;
};

export type WorldCalendar = {
  day_index: number;
  weekday: number;
  period: string;
  period_label?: string;
  date_label?: string;
  season_label?: string;
  week_index?: number;
  next_festival?: string;
  days_to_next_festival?: number;
  china?: {
    date?: string;
    festival?: string;
    is_workday?: boolean;
    is_holiday?: boolean;
    label?: string;
    lunar?: string;
    season?: string;
    season_label?: string;
    week_index?: number;
    weekday_label?: string;
    next_festival?: string;
    days_to_next_festival?: number;
  };
};

export type WeekStripDay = {
  day_index: number;
  weekday: number;
  weekday_label: string;
  date: string;
  month: number;
  day: number;
  is_today: boolean;
  is_padded?: boolean;
  festival?: string;
  is_workday?: boolean;
  season_label?: string;
};

export type HubAppointment = {
  id: string;
  character_id: string;
  character_name?: string;
  day_index: number;
  period: string;
  period_label?: string;
  location_id?: string;
  label: string;
  date_id?: string;
  /** date = 目录约会；talk = 谈话见面 */
  kind?: string;
  status: string;
  date_label?: string;
  weekday_label?: string;
  due_today?: boolean;
  fulfillable?: boolean;
};

export type HubWeekReview = {
  character_id: string;
  name: string;
  text: string;
};

export type DateSlot = {
  id: string;
  label: string;
  when: string;
  day_index?: number;
  period?: string;
};

export type HubPing = {
  character_id: string;
  name: string;
  preview: string;
  text?: string;
  kind?: string;
};

export type HubSuggestion = {
  kind: string;
  text: string;
  target_id?: string;
};

export type WeeklyFocusEntry = {
  id: string;
  name: string;
  label?: string;
  tier?: string;
};

export type HubWeather = {
  kind: string;
  label: string;
};

export type EndingHint = {
  character_id: string;
  name: string;
  text: string;
};

export type StoryHint = {
  character_id: string;
  name: string;
  text: string;
  act_title?: string;
};

export type GiftShopItem = {
  id: string;
  label: string;
  tags?: string[];
  note?: string;
  money_cost?: number;
};

export type GiftShopRecipient = {
  character_id: string;
  name: string;
  role?: string;
};

export type GiftShop = {
  available: boolean;
  cost: number;
  money_cost?: number;
  gifts: GiftShopItem[];
  recipients: GiftShopRecipient[];
};

export type AbsenceNote = {
  character_id: string;
  name: string;
  reason: string;
};

export type HubRumor = {
  day: number;
  about_id: string;
  about_name?: string;
  text: string;
  source_id?: string;
};

export type HubStatusNote = {
  character_id: string;
  name: string;
  hint: string;
};

export type ProtagonistPublic = {
  name: string;
  job_id: string;
  job_title: string;
  workplace_id: string;
  money: number;
  energy: number;
  money_vibe: string;
  worked_today: boolean;
  meals_today: number;
};

export type LifeWorkAction = {
  available: boolean;
  is_workday: boolean;
  already_worked: boolean;
  can_work?: boolean;
  job_title: string;
  workplace_id: string;
  pay: number;
  ap_cost: number;
  energy_cost: number;
  rest_day_note?: string;
};

export type LifeMealAction = {
  id: string;
  label: string;
  money_cost: number;
  ap_cost: number;
  energy_gain: number;
};

export type LifeErrandAction = {
  id: string;
  errand_id?: string;
  character_id: string;
  character_name?: string;
  label: string;
  location_id: string;
  ask_line?: string;
  can_complete_here?: boolean;
  day_assigned?: number;
};

export type LifeActions = {
  work: LifeWorkAction;
  meals: LifeMealAction[];
  date_slots?: DateSlot[];
  can_advance_period?: boolean;
  errand?: LifeErrandAction | null;
};

/** 地点装饰路人：不可点、不可对话 */
export type BackgroundExtra = {
  id: string;
  url: string;
  slot: string;
  decorative?: boolean;
};

export type Day1RecommendedChar = {
  id: string;
  name: string;
  role?: string;
};

export type HubState = {
  save_id: string;
  protagonist_name: string;
  protagonist?: ProtagonistPublic;
  calendar: WorldCalendar;
  action_points: number;
  action_points_max: number;
  location_id: string;
  onboarding_step?: string;
  /** Day1 软引导：非推荐地点灰显 + 二次确认 */
  onboarding_gate?: boolean;
  day1_recommended_locations?: string[];
  day1_recommended_chars?: Day1RecommendedChar[];
  locations: WorldLocation[];
  present_here: BondSummary[];
  /** 后期地点装饰路人（不可点、不可对话） */
  background_extras?: BackgroundExtra[];
  absence_notes?: AbsenceNote[];
  pings?: HubPing[];
  gift_shop?: GiftShop;
  rumors?: HubRumor[];
  status_notes?: HubStatusNote[];
  life_actions?: LifeActions;
  week_strip?: WeekStripDay[];
  appointments_upcoming?: HubAppointment[];
  week_reviews?: HubWeekReview[];
  weekly_focus?: WeeklyFocusEntry[];
  today_suggestions?: HubSuggestion[];
  week_beat?: { id?: string; label?: string; text?: string; week_index?: number };
  weather?: HubWeather;
  ending_hints?: EndingHint[];
  story_hints?: StoryHint[];
  copresence_note?: string;
};

export type WorldSocialResult = {
  ok?: boolean;
  error?: string;
  note?: string;
  kind?: string;
  ui_tone?: string;
  deferred_now?: boolean;
  ask_date?: { character_id: string; date_id: string; when?: string };
  scheduled?: {
    id?: string;
    day_index?: number;
    period?: string;
    label?: string;
    date_label?: string;
    impression?: string;
  };
  conflict?: { other_name?: string };
  hub?: HubState;
};

export type WorldPublic = {
  save_id: string;
  user_id: string;
  kind?: "auto" | "manual";
  label?: string;
  protagonist_name: string;
  protagonist?: ProtagonistPublic;
  calendar: WorldCalendar;
  action_points: number;
  action_points_max: number;
  location_id: string;
  onboarding_step?: string;
  bonds: Record<string, BondSummary>;
  unlocked_endings?: string[];
};

export type WorldSaveSummary = {
  save_id: string;
  user_id: string;
  kind: "auto" | "manual";
  label?: string;
  protagonist_name: string;
  day_index: number;
  period: string;
  location_id: string;
  bonds_met: number;
  bonds_total: number;
  updated_at: string;
};

export type DialogueTurn = {
  turn_id: number;
  role: string;
  content: string;
  ts?: string;
};

export type DateOption = {
  id: string;
  label: string;
  location_id: string;
  cost: number;
  money_cost?: number;
  available_here: boolean;
  soft_reject?: boolean;
  reject_reason?: string;
};

export type SaveSummary = {
  save_id: string;
  character_id: string;
  character_name: string;
  stage_label: string;
  affinity: number;
  updated_at: string;
  route_label?: string;
};

export type SceneRunPublic = {
  mode: string;
  turns_max: number;
  turns_used: number;
  turns_left: number;
  ended: boolean;
  end_reason?: string;
  pool_hint?: string;
};

/** 专属故事幕节拍进度（有 beats 时由后端下发） */
export type StoryProgressPublic = {
  event_id: string;
  beat_index: number;
  beat_total: number;
  beat_id?: string;
  soft_options?: string[];
  act_summary?: string;
  completed?: boolean;
};

export type RelationshipUpdate = {
  relationship_state: RelationshipState;
  memories: MemoryFact[];
  affinity_delta?: number;
  trust_delta?: number;
  stage_changed?: boolean;
  previous_stage_id?: string | null;
  ending_id?: string | null;
  ending?: EndingInfo | null;
  judge_reason?: string;
  event?: GameEventInfo | null;
  event_applied?: GameEventInfo | null;
  pending_choices?: string[];
  /** soft=开场提示；branch=事件分支（会影响态度） */
  pending_choice_kind?: "soft" | "branch";
  message_summary_updated?: boolean;
  event_log?: EventLogEntry[];
  scene?: GalSceneInfo;
  daily_state?: DailyState;
  quest_state?: QuestState;
  quest_notice?: string;
  dialogue?: DialogueTurn[];
  world_save_id?: string;
  scene_run?: SceneRunPublic | null;
  story_progress?: StoryProgressPublic | null;
  scene_hint?: string;
  settle_note?: string;
  scene_ended?: boolean;
  closing_line?: string;
  end_reason?: string;
  hub?: HubState;
  world?: WorldPublic;
  world_social?: WorldSocialResult;
  /** 辅模型额度/降级等系统提示（非玩法错误） */
  aux_notice?: { message: string; code?: string } | null;
};

export type VoiceInfo = {
  id: string;
  label: string;
  gender?: string;
  age?: string;
  dialect?: string;
  tags?: string[];
};

export type Archetype = {
  id: string;
  label: string;
};

export type CharacterVariant = {
  id: string;
  label: string;
  tagline?: string;
  voice_id: string;
  profile: CharacterProfile;
};

export type CharacterBase = {
  id: string;
  label: string;
  description: string;
  live2d_model: string;
  theme_color: string;
  characters: CharacterVariant[];
};

/** @deprecated 旧结构，保留类型兼容 */
export type ModelRole = {
  archetype_id: string;
  label: string;
  voice_id: string;
  profile: CharacterProfile;
};

export type AvatarState = {
  emotion: string;
  expression: string;
  motion: string;
  mouth_open?: number;
  spoken?: string;
  raw?: string;
  actions?: string[];
  choices?: string[];
};

export type GameEventInfo = {
  id: string;
  label: string;
  scene_id?: string;
  beat_total?: number;
  /** 开幕 / 幕落字幕 */
  curtain?: string;
  story?: boolean;
};

export type EventLogEntry = {
  event_id: string;
  label: string;
  turn: number;
};

export type Preset = {
  id: string;
  label: string;
  profile: CharacterProfile;
};

export type Live2dEmotionMapEntry = {
  expression?: string;
  motion_group?: string;
  motion_index?: number;
};

/** Live2D 画布布局（每模型可独立调校） */
export type Live2dLayout = {
  flip_x?: boolean;
  fill_width?: number;
  fill_height?: number;
  anchor_x?: number;
  anchor_y?: number;
  x_ratio?: number;
  y_ratio?: number;
  scale_boost?: number;
  angle_x?: number;
  /** Shizuku/Epsilon 等含场景背景的模型：隐藏背景层并放大 */
  hide_scene_parts?: boolean;
};

export type Live2dModelInfo = {
  id: string;
  path: string;
  label?: string;
  description?: string;
  preset_id?: string;
  recommended?: boolean;
  tap_motion_group?: string;
  available?: boolean;
  expressions?: Record<string, string>;
  emotion_map?: Record<string, Live2dEmotionMapEntry>;
  layout?: Live2dLayout;
};

/** @deprecated 保留兼容，Live2D 模式下 models 为 Live2dModelInfo */
export type VrmModelInfo = Live2dModelInfo;

export type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  spoken?: string;
  avatar?: AvatarState;
  pending?: boolean;
};

export type WsIncoming =
  | {
      type: "ready";
      payload: {
        model?: string;
        presets?: Preset[];
        character_bases?: CharacterBase[];
        relationship_stages?: RelationshipStageDef[];
        voices?: VoiceInfo[];
        tts_enabled?: boolean;
      };
    }
  | {
      type: "session_created";
      payload: {
        session_id: string;
        save_id?: string;
        world_save_id?: string;
        character_id?: string;
        greeting: string;
        avatar: AvatarState;
        profile: CharacterProfile;
        relationship_state?: RelationshipState;
        memories?: MemoryFact[];
        dialogue?: DialogueTurn[];
        scene?: GalSceneInfo;
        daily_state?: DailyState;
        daily_encounters?: DailyEncounterEntry[];
        quest_state?: QuestState;
        tts_voice?: string;
        tts_audio_b64?: string;
        tts_mime?: string;
        mode?: string;
        date?: { id: string; label: string };
        hub?: HubState;
        dates?: DateOption[];
        edges?: { other_id: string; relation: string }[];
        sprite_outfit?: string;
        pending_choices?: string[];
        pending_choice_kind?: "soft" | "branch";
        ping_text?: string;
        scene_run?: SceneRunPublic | null;
        ensemble?: EnsemblePublic | null;
        story_progress?: StoryProgressPublic | null;
      };
    }
  | { type: "world_ready"; payload: { world: WorldPublic; hub: HubState } }
  | {
      type: "world_traveled";
      payload: {
        ok: boolean;
        location_id: string;
        label?: string;
        present?: string[];
        scene?: GalSceneInfo;
        hub?: HubState;
        world?: WorldPublic;
        action_points?: number;
      };
    }
  | {
      type: "world_day_ended";
      payload: {
        ok: boolean;
        calendar?: WorldCalendar;
        night_event?: { type: string; character_id: string; message: string } | null;
        soft_tip?: string;
        pings?: HubPing[];
        hub?: HubState;
        world?: WorldPublic;
      };
    }
  | {
      type: "gift_bought";
      payload: {
        ok: boolean;
        gift_id?: string;
        label?: string;
        impression?: string;
        character_id?: string;
        action_points?: number;
        money?: number;
        money_spent?: number;
        hub?: HubState;
        world?: WorldPublic;
      };
    }
  | {
      type: "work_done";
      payload: {
        ok: boolean;
        pay?: number;
        job_title?: string;
        impression?: string;
        action_points?: number;
        money?: number;
        energy?: number;
        hub?: HubState;
        world?: WorldPublic;
      };
    }
  | {
      type: "meal_done";
      payload: {
        ok: boolean;
        meal_id?: string;
        label?: string;
        impression?: string;
        money_spent?: number;
        action_points?: number;
        money?: number;
        energy?: number;
        hub?: HubState;
        world?: WorldPublic;
      };
    }
  | {
      type: "errand_done";
      payload: {
        ok: boolean;
        label?: string;
        impression?: string;
        character_id?: string;
        action_points?: number;
        hub?: HubState;
        world?: WorldPublic;
      };
    }
  | {
      type: "date_scheduled";
      payload: {
        ok: boolean;
        scheduled?: { impression?: string; label?: string; date_label?: string };
        conflict?: { other_id?: string; other_name?: string; label?: string };
        impression?: string;
        hub?: HubState;
        world?: WorldPublic;
      };
    }
  | {
      type: "period_advanced";
      payload: {
        ok: boolean;
        period?: string;
        period_label?: string;
        hub?: HubState;
        world?: WorldPublic;
      };
    }
  | {
      type: "rollback_done";
      payload: {
        ok?: boolean;
        turn_id: number;
        messages?: DialogueTurn[];
        relationship_state?: RelationshipState;
      };
    }
  | {
      type: "session_reset";
      payload: {
        session_id: string;
        greeting: string;
        avatar: AvatarState;
        relationship_state?: RelationshipState;
        memories?: MemoryFact[];
      };
    }
  | { type: "relationship_state"; payload: RelationshipUpdate }
  | {
      type: "scene_ended";
      payload: {
        ok?: boolean;
        end_reason?: string;
        closing_line?: string;
        settle_note?: string;
        affinity_delta?: number;
        trust_delta?: number;
        stage_changed?: boolean;
        previous_stage_id?: string | null;
        relationship_state?: RelationshipState;
        scene_run?: SceneRunPublic | null;
        hub?: HubState;
        world?: WorldPublic;
        error?: string;
      };
    }
  | { type: "event_toast"; payload: GameEventInfo }
  | { type: "choices"; payload: { choices: string[]; kind?: "soft" | "branch" } }
  | { type: "game_scene"; payload: GalSceneInfo }
  | { type: "daily_state"; payload: DailyState }
  | { type: "quest_toast"; payload: { message: string } }
  | { type: "system_toast"; payload: { message: string; tone?: "warn" | "warm" | "cold" } }
  | { type: "tts_browser"; payload: { text: string; voice?: string } }
  | {
      type: "daily_encounter_started";
      payload: {
        encounter: DailyEncounterEntry;
        scene?: GalSceneInfo;
        daily_state: DailyState;
        kickoff_text?: string;
      };
    }
  | { type: "game_ending"; payload: EndingInfo }
  | { type: "reply_start"; payload: { session_id?: string } }
  | { type: "reply_delta"; payload: { delta: string; text: string } }
  | {
      type: "reply";
      payload: {
        text: string;
        spoken: string;
        avatar: AvatarState;
        choices?: string[];
        speaker_id?: string;
        guest_reaction?: string;
        ensemble?: EnsemblePublic | null;
      };
    }
  | { type: "avatar_state"; payload: AvatarState }
  | { type: "tts_audio"; payload: { mime: string; base64: string; voice?: string } }
  | { type: "tts_error"; payload: { message: string } }
  | { type: "done"; payload: Record<string, unknown> }
  | { type: "error"; payload: { message: string } };

export const DEFAULT_TRAITS: PersonalityTraits = {
  tsundere: 0.1,
  gentle: 0.55,
  cheerful: 0.95,
  clingy: 0.65,
  mature: 0.25,
  shy: 0.2,
};

export const DEFAULT_PROFILE: CharacterProfile = {
  character_id: "qingcai",
  name: "夏晴彩",
  age: 21,
  relationship: "女朋友",
  occupation: "舞蹈社团成员",
  backstory: "",
  personality: "",
  appearance: "短发，笑容很亮，运动风穿搭",
  speaking_style: "cute",
  traits: DEFAULT_TRAITS,
  opening_line: "",
  live2d_model: "hiyori",
  vrm_model: "",
  tts_voice: "Momo",
  theme_color: "#fbbf24",
  relationship_stage: "dating",
  growth_mode: "fixed",
  target_relationship: "女朋友",
  target_stage_id: "",
  initial_affinity: 84,
  user_title: "",
};

export const SPEAKING_STYLE_LABELS: Record<CharacterProfile["speaking_style"], string> = {
  casual: "日常口语",
  cute: "可爱语气",
  formal: "礼貌克制",
  sharp: "毒舌尖酸",
};

export const TRAIT_LABELS: Record<keyof PersonalityTraits, string> = {
  tsundere: "傲娇",
  gentle: "温柔",
  cheerful: "开朗",
  clingy: "粘人",
  mature: "成熟",
  shy: "害羞",
};
