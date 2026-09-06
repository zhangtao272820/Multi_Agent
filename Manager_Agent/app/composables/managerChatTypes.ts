/**
 * Manager 工作台共享类型（自 index.vue 抽出，纯类型无运行时依赖）
 */
export type MediaItem = { label: string; url: string }
export type MediaBundles = { videos: MediaItem[]; audios: MediaItem[]; midis: MediaItem[]; images: MediaItem[] }

export type SearchSourceItem = { title: string; url: string }
export type RagEvidenceItem = { source: string; title?: string; url?: string; excerpt?: string; score?: number }

export type WorkbenchMode = 'chat' | 'professional'
export type ThoughtViewMode = 'user' | 'developer'
/** 协作姿态合同（与 workbenchMode 正交） */
export type CollaborationPosture = 'ask' | 'plan' | 'agent' | 'debug'

export const COLLABORATION_POSTURE_OPTIONS: Array<{
  id: CollaborationPosture
  label: string
  title: string
}> = [
  { id: 'ask', label: 'Ask', title: '只读探查，不执行写操作' },
  { id: 'plan', label: 'Plan', title: '只对齐蓝图，批准前不执行' },
  { id: 'agent', label: 'Agent', title: '按风险策略自主推进' },
  { id: 'debug', label: 'Debug', title: '按步证据定点重验' }
]

export function collaborationPostureLabel(posture: CollaborationPosture | string | undefined): string {
  const id = String(posture || '').toLowerCase() as CollaborationPosture
  return COLLABORATION_POSTURE_OPTIONS.find((p) => p.id === id)?.label || 'Agent'
}

export type StepResultItem = {
  stepId: string
  agent: string
  status: 'success' | 'failed'
  title: string
  preview: string
  query?: string
  error?: string
  /** N2/U2：标准失败码 timeout | circuit_open | http_5xx | network | business | … */
  errorCode?: string
  empty?: boolean
  ragCitations?: Array<{ source: string; excerpt?: string }>
}


export type PlanStepTodo = {
  id: string
  agent: string
  query: string
  order: number
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped'
  optional?: boolean
}

export type RoutePlanCardData = {
  intent?: string
  agents?: string[]
  capLabel?: string
  dataSources?: string[]
  clauses?: Array<{ id: string; text: string; agents?: string[] }>
  blueprintSteps?: Array<{ agent: string; agentLabel?: string; queryFocus: string }>
  blueprintDag?: string
  lintIssues?: string[]
  lintSeverity?: 'ok' | 'warn' | 'fail'
  judgeRationale?: string
  orchestratorSource?: string
}

export type UserFacingPayload = {
  summary?: string
  /** 顶栏一行结论（服务端确定性截取） */
  headline?: string
  metrics?: Array<{ label: string; value: string }>
  chart?: { title: string; option: object }
  table?: { headers: string[]; rows: string[][] }
  actions?: Array<{
    id: string
    kind: string
    title: string
    summary: string
    risk: string
    status: string
    failureReasonZh?: string
    preview?: {
      screenshotUrl?: string
      pageUrl?: string
      fields?: Array<{ label: string; value: string }>
    }
  }>
  appendix?: string
  sources?: Array<{
    index: number
    title: string
    url?: string
    excerpt?: string
    kind?: 'web' | 'rag' | 'db' | 'doc'
  }>
  outcome?: 'completed' | 'failed' | 'needs_human'
  outcomeLabel?: string
  badge?: 'evidence_rejected' | 'needs_clarify'
  badgeLabel?: string
  replyTier?: 'lite' | 'standard' | 'report'
  /** Cursor 式 follow-up chips */
  suggestions?: string[]
  presentationPlan?: {
    replyTier?: 'lite' | 'standard' | 'report'
    modules?: Array<{ type: string; collapsed?: boolean; maxItems?: number }>
    suggestions?: string[]
    proseStyle?: string
    confidence?: number
    source?: string
  }
  artifacts?: Array<{
    id: string
    kind: 'chart' | 'table' | 'report'
    title: string
    surface: 'inline' | 'artifact_panel'
    collapsed?: boolean
  }>
  /** Canvas 中用户已编辑并应用报告 */
  reportEdited?: boolean
  reportEditedAt?: string
  /** 气泡内短注（与 appendix 分离，幂等） */
  reportRevisionNote?: string
}

export type LogItem = {
  ts: string
  kind: string
  text: string
  from?: string
  turn: number
  runId?: string
  logId?: string
  userMessageIndex?: number
  attachmentPreview?: string
  attachmentName?: string
  attachmentMediaType?: 'image' | 'video' | 'audio'
  searchSources?: SearchSourceItem[]
  ragEvidence?: RagEvidenceItem[]
  guiScreenshot?: string
  /** Lobster noVNC 实时画面（Stagehand/classic headed） */
  guiVncUrl?: string
  adminUiCards?: unknown[]
  /** D1 用户态结构化载荷 */
  userFacing?: UserFacingPayload
  presentationPlan?: UserFacingPayload['presentationPlan']
  /** Wave 8：记忆提案（记住答案/打法/偏好/规则） */
  memoryCapture?: MemoryCaptureProposal
  routeCap?: { intent: string; agents: string[]; capLabel?: string; needsWebSearch?: boolean }
  routePlanCard?: RoutePlanCardData
  planOutline?: { dag?: string; steps: PlanStepTodo[] }
  /** 本轮发送时的协作姿态（Ask/Plan/Agent/Debug） */
  collaborationPosture?: CollaborationPosture
  /** 编排建议切到的姿态（来自 plan_preview.suggestedPosture） */
  suggestedPosture?: CollaborationPosture
  /** 姿态门禁原因，如 debug_no_observation / write_filtered */
  postureBlocked?: string
  postureReadOnly?: boolean
}

export type MemoryCaptureProposal = {
  kind: string
  status: string
  source?: string
  title?: string
  summary?: string
  runId?: string
  skillId?: string
  ruleCandidateId?: string
  experienceCandidateId?: string
  note?: string
  proposedAt?: string
  /** UI 本地状态 */
  uiStatus?: 'open' | 'acked' | 'confirmed' | 'rejected' | 'sending'
}

export type TurnGroup = {
  id: number
  user?: LogItem
  results: LogItem[]
  errors: LogItem[]
  process: LogItem[]
  codePatches: string[]
  searchSources: SearchSourceItem[]
  ragEvidence: RagEvidenceItem[]
  adminUiCards?: unknown[]
  userFacing?: UserFacingPayload
  /** Synth 前 WS 下发的展示计划（user_facing 到达前可用） */
  presentationPlan?: UserFacingPayload['presentationPlan']
  memoryCapture?: MemoryCaptureProposal
}

export type PendingAttachment = {
  filePath: string
  mediaType: 'image' | 'video' | 'audio'
  filename: string
  previewUrl?: string
}

export type CollabAgent = 'clean' | 'visualize' | 'report'
export type CollabStatus = 'idle' | 'pending' | 'running' | 'success' | 'failed'

export type ClientLocation = {
  latitude: number
  longitude: number
  accuracy_m?: number
  address?: string
  updated_at?: string
}

export type SessionHistoryItem = {
  id: string
  title: string
  updatedAt: string
  messageCount: number
  userMessageCount: number
  customTitle?: boolean
  /** 对话 / 专业双工作区标签；遗留项可能缺失，打开或发送时补打 */
  workbenchMode?: WorkbenchMode
}

export const EMPTY_MEDIA: MediaBundles = { videos: [], audios: [], midis: [], images: [] }

/** 仅「进行中」事件同步 active runId；终态旁路（run_report/final/error）不得写回，否则会卡在「取消」 */
export const IN_FLIGHT_RUN_WS_EVENTS = new Set([
  'thinking',
  'thought_delta',
  'phase',
  'delta',
  'stream_start',
  'stream_revise',
  'stream_commit',
  'step_status',
  'plan_steps',
  'plan_preview',
  'route_cap',
  'route_plan_card',
  'plan_dag',
  'trace',
  'health',
  'message',
  'human_confirm_request',
  'dry_run_result'
])
