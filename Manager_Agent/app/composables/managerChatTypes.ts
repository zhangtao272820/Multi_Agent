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
  adminUiCards?: unknown[]
  /** D1 用户态结构化载荷 */
  userFacing?: UserFacingPayload
  routeCap?: { intent: string; agents: string[]; capLabel?: string; needsWebSearch?: boolean }
  routePlanCard?: RoutePlanCardData
  planOutline?: { dag?: string; steps: PlanStepTodo[] }
  /** 本轮发送时的协作姿态（Ask/Plan/Agent/Debug） */
  collaborationPosture?: CollaborationPosture
  /** 姿态门禁原因，如 debug_no_observation / write_filtered */
  postureBlocked?: string
  postureReadOnly?: boolean
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
