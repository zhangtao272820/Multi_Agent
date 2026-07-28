import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { CollaborationPosture, LogItem, SearchSourceItem, StepResultItem, ThoughtViewMode, TurnGroup, MediaBundles } from './managerChatTypes'

export type ManagerChatThreadContext = {
  editingTurnId: Ref<number | null>
  editDraft: Ref<string>
  currentRunId: Ref<string>
  connected: Ref<boolean>
  thoughtViewMode: Ref<ThoughtViewMode>
  streamingSynthText: Ref<string>
  streamingSynthDisplayText: ComputedRef<string>
  streamingReplyEl: Ref<HTMLElement | null>
  copyAckTurnId: Ref<number | null>
  copyAckKey: Ref<string | null>
  feedbackSendingRunId: Ref<string | null>
  expandedProcessKeys: Ref<Set<string>>
  kindClass: (kind: string) => string
  kindLabel: (kind: string) => string
  userBubbleText: (m: LogItem) => string
  copyMessageText: (text: string, ack?: { turnId?: number; replyKey?: string }) => void | Promise<void>
  isTurnRunning: (t: TurnGroup) => boolean
  isTurnLive: (t: TurnGroup) => boolean
  startEditTurn: (turn: TurnGroup) => void | Promise<void>
  cancelEditTurn: () => void
  submitEditResend: (turn: TurnGroup) => void | Promise<void>
  withdrawTurn: (turnId: number) => void | Promise<void>
  regenerateTurn: (turn: TurnGroup) => void | Promise<void>
  hasAgentPipeline: (t: TurnGroup) => boolean
  turnAgentPipelineSteps: (t: TurnGroup) => Array<{
    id: string
    agent: string
    label: string
    status: string
    query?: string
    summary?: string
  }>
  turnAgentPipelineDoneCount: (t: TurnGroup) => number
  turnRouteCap: (t: TurnGroup) => { intent: string; agents: string[]; capLabel?: string } | null
  turnCollaborationPosture: (t: TurnGroup) => CollaborationPosture | undefined
  turnPostureNote: (t: TurnGroup) => string
  planAgentLabel: (agent: string) => string
  agentPipelineStatusLabel: (status: string) => string
  turnRoutePlanCard: (t: TurnGroup) => import('./managerChatTypes').RoutePlanCardData | null
  previewText: (text: string, max?: number) => string
  turnPlanOutline: (t: TurnGroup) => { dag?: string; steps: unknown[] } | null
  hasThoughtContent: (t: TurnGroup) => boolean
  thoughtPanelOpen: (t: TurnGroup) => boolean
  onThoughtPanelToggle: (t: TurnGroup, e: Event) => void
  thoughtPanelLabel: () => string
  stepResultsForTurn: (t: TurnGroup) => StepResultItem[]
  userThoughtNarrative: (t: TurnGroup) => Array<{
    text: string
    done?: boolean
    active?: boolean
    failed?: boolean
  }>
  thoughtPanelPreview: (t: TurnGroup) => string
  processStepKey: (t: TurnGroup, idx: number) => string
  isProcessStepClampable: (text: string, kind: string) => boolean
  phaseLabel: (p: LogItem) => string
  formatProcessText: (text: string, kind: string) => string
  toggleProcessStep: (t: TurnGroup, idx: number) => void
  isSynthPhaseActive: () => boolean
  onReplyMarkdownClick: (e: MouseEvent) => void
  renderAssistantMarkdown: (text: string, sources?: SearchSourceItem[]) => string
  renderReportMarkdown: (text: string) => string
  resultItemClasses: (r: LogItem) => string | Record<string, boolean> | Array<string | Record<string, boolean>>
  resultKindLabel: (r: LogItem) => string
  turnSearchSources: (t: TurnGroup) => SearchSourceItem[]
  webSourceHost: (hit: SearchSourceItem) => string
  mediaForReply: (r: LogItem, t: TurnGroup) => MediaBundles
  resolveMediaUrl: (url: string) => string
  openMediaInNewTab: (url: string) => void
  downloadMediaFile: (url: string, name: string) => void | Promise<void>
  mediaDownloadName: (url: string, kind: string) => string
  adminUiCardsFromTurn: (t: TurnGroup) => unknown[]
  replyMarkdownBody: (text: string, t: TurnGroup) => string
  replyExecutionSummaryMarkdown: (text: string, t?: TurnGroup) => string
  replyUserOutcomeBanner: (t?: TurnGroup) => { tone: 'fail' | 'human'; label: string } | null
  turnExpertFailureCards: (t?: TurnGroup) => Array<{
    agent: string
    label: string
    code: string
    codeLabel: string
    message: string
  }>
  replyExecSummaryTone: (text: string, t?: TurnGroup) => 'ok' | 'fail' | 'human' | ''
  replyHasInlineAnalytics: (text: string, agentResults?: unknown, turn?: TurnGroup) => boolean
  buildTurnAgentResults: (t: TurnGroup) => unknown
  extractEchartsOption: (text: string, agentResults?: unknown) => unknown
  chartTitleFromText: (text: string, agentResults?: unknown) => string
  downloadEchartsPng: (filename: string, option: unknown) => void | Promise<void>
  initChartEl: (el: HTMLElement, option: unknown) => void
  chartContainerClass: (option: unknown) => string | Record<string, boolean>
  chartContainerStyle: (option: unknown) => Record<string, string>
  extractTableData: (text: string) => unknown
  renderTableDataHtml: (text: string) => string
  userFacingChartOption: (t?: TurnGroup) => unknown | null
  userFacingChartTitle: (t?: TurnGroup) => string
  userFacingTableHtml: (t?: TurnGroup) => string
  canConfirmActionCard: (cardId: string) => boolean
  respondActionCardConfirm: (cardId: string) => void
  respondActionCardCancel: (cardId: string) => void
  humanConfirmSending: Ref<boolean>
  resolveReportBody: (text: string, t: TurnGroup) => string
  replyUserDetailAppendix: (t?: TurnGroup, replyText?: string) => string
  downloadMarkdown: (filename: string, body: string) => void
  replyHasCollapsibleSources: (text: string, t: TurnGroup) => boolean
  replySourceCount: (r: LogItem, t: TurnGroup) => number
  replySourcesMarkdown: (r: LogItem, t: TurnGroup) => string
  hasMediaContent: (text: string) => boolean
  replyHasAnalytics: (text: string, t: TurnGroup) => boolean
  shouldShowTurnFeedback: (t: TurnGroup) => boolean
  turnFeedbackSubmitted: (t: TurnGroup) => boolean
  turnFeedbackKey: (t: TurnGroup) => string
  sendFeedback: (turn: TurnGroup, score: 0 | 1) => void
  routeFeedbackSubmitted: (t: TurnGroup) => boolean
  sendRouteWrongFeedback: (turn: TurnGroup) => void
  turnFeedbackAckText: (t: TurnGroup) => string
  visibleTurnErrors: (t: TurnGroup) => LogItem[]
  errorItemKey: (e: LogItem, idx: number) => string
  dismissError: (item: LogItem) => void
  dismissAllTurnErrors: (turnId: number) => void
}

export const MANAGER_CHAT_THREAD_KEY: InjectionKey<ManagerChatThreadContext> = Symbol('managerChatThread')
