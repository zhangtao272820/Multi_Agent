import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import {
  FEEDBACK_HYDRATE_COLD_OPTS,
  FEEDBACK_HYDRATE_WARM_OPTS,
  retryFeedbackHydrate
} from '#agent-shared/feedbackHydrateRetry'
import { resolveClientMediaUrl } from '#agent-shared/mediaUrls'
import { normalizeModelReplyHtml } from '#agent-shared/replyHtmlNormalize'
import { extractAuxBlocksStructural, pickRicherNarrativeWithAuxBlocks } from '#agent-shared/auxBlocks'
import {
  stripSynthPromptLeakage,
  stripStructuredExecReport,
  looksLikeExecAuditDump,
  looksLikeStepDumpSummary,
  looksLikeTruncatedSummary,
  isReportTierSummaryTooThin,
} from '#agent-shared/synthOutputSanitize'
import { resolveRenderableEchartsOptionFromText } from '#agent-shared/codeAuthorityPayload'
import { isRenderableChartOption, readChartTitle, readPanelCount, suggestChartContainerHeight } from '#agent-shared/chartOption'
import { buildChartPngExportMeta } from '#agent-shared/chartExportMeta'
import {
  formatReportRevisionNote,
  mergeSummaryWithRevisionNote,
  tableToCsv,
  buildArtifactExportManifest,
  buildZipStore,
  base64PngToBytes
} from '~/composables/managerArtifactExport'
import {
  artifactPanelSlots,
  artifactTabLabel,
  hasArtifactPanel,
  pickDefaultArtifactTab,
  shouldShowInlineChart,
  shouldShowInlineReportAppendix,
  shouldShowInlineTable,
  shouldStripAuxBlocksDuringStream,
  streamingArtifactHint,
  turnHasEditedReport
} from '~/composables/managerPresentationUi'
import {
  planAgentLabel as planAgentLabelFromDisplay,
  planAgentLabelProfessional,
  agentObsColor,
  agentDisplayLabel as formatAgentDisplayLabel
} from '~/composables/managerAgentDisplay'
import {
  EMPTY_MEDIA,
  type CollabAgent,
  type CollabStatus,
  type ClientLocation,
  type LogItem,
  type PendingAttachment,
  type PlanStepTodo,
  type RagEvidenceItem,
  type RoutePlanCardData,
  type SearchSourceItem,
  type SessionHistoryItem,
  type StepResultItem,
  type ThoughtViewMode,
  type TurnGroup,
  type WorkbenchMode,
  type CollaborationPosture
} from '~/composables/managerChatTypes'
import { buildManagerWsUrl as buildManagerWsUrlRaw, withManagerWsAuth as withManagerWsAuthRaw } from '~/composables/managerWsAuth'
import { handleManagerWsInboundMessage, type ManagerWsInboundCtx } from '~/composables/managerWsInbound'
import { useManagerSession, FEEDBACK_PENDING_ACK, type ManagerSessionHost } from '~/composables/useManagerSession'
import { MANAGER_CHAT_THREAD_KEY } from '~/composables/managerChatThreadContext'
import { MANAGER_WORKBENCH_SIDEBAR_KEY } from '~/composables/managerWorkbenchSidebarContext'
import { MANAGER_CHAT_RAIL_KEY } from '~/composables/managerChatRailContext'
import { extractAdminUiCardsFromTurn, turnMemoSignature } from '~/composables/managerTurnDisplayCache'
import {
  buildClientDegradeMessage,
  errorCodeBadgeLabel,
  normalizeClientErrorCode
} from '~/utils/expertDegradeUi'

export function useManagerChatPage() {
  const runtimeConfig = useRuntimeConfig()
  const managerWsToken = computed(() => String(runtimeConfig.public.managerWsToken || '').trim())
  const {
    withUserAuth,
    loadFromStorage: loadClawhiveAuth,
    token: clawhiveToken,
    ready: clawhiveAuthReady
  } = useClawhiveLogin()

  function withManagerWsAuth(payload: Record<string, unknown>): Record<string, unknown> {
    return withUserAuth(withManagerWsAuthRaw(payload, managerWsToken.value))
  }

  function buildManagerWsUrl(): string {
    return buildManagerWsUrlRaw(managerWsToken.value)
  }
  
  const clientLocation = ref<ClientLocation | null>(null)
  
  const WORKBENCH_MODE_KEY = 'manager_workbench_mode'
  /** 默认专业工作台；对话/专业会话槽彻底分轨 */
  const workbenchMode = ref<WorkbenchMode>('professional')
  
  function loadWorkbenchMode() {
    if (typeof localStorage === 'undefined') return
    const raw = String(localStorage.getItem(WORKBENCH_MODE_KEY) || '').trim().toLowerCase()
    if (raw === 'chat' || raw === 'professional' || raw === 'pro') {
      workbenchMode.value = raw === 'chat' ? 'chat' : 'professional'
      return
    }
    // 无历史偏好时落盘默认专业，避免与旧默认「对话」混淆
    localStorage.setItem(WORKBENCH_MODE_KEY, 'professional')
    workbenchMode.value = 'professional'
  }
  
  function setWorkbenchMode(mode: WorkbenchMode) {
    void switchWorkbenchMode(mode)
  }

  async function switchWorkbenchMode(mode: WorkbenchMode) {
    if (mode === workbenchMode.value) return
    const prev = workbenchMode.value
    rememberSessionForMode(prev, sessionId.value)
    stampCurrentSessionMode(prev)

    workbenchMode.value = mode
    if (typeof localStorage !== 'undefined') localStorage.setItem(WORKBENCH_MODE_KEY, mode)

    // 切换工作区时展开历史侧栏，让列表过滤与模式 hint 立刻可见
    historyPanelOpen.value = true
    sidebarOpen.value = false
    if (mode === 'chat') {
      thoughtViewMode.value = 'user'
      if (typeof localStorage !== 'undefined') localStorage.setItem(THOUGHT_VIEW_MODE_KEY, 'user')
      collaborationPosture.value = 'agent'
      if (typeof localStorage !== 'undefined') localStorage.setItem(COLLABORATION_POSTURE_KEY, 'agent')
      debugObservationPanelOpen.value = false
    }

    const targetId = getSessionSlot(mode)
    if (targetId && targetId !== sessionId.value) {
      await switchSession(targetId)
    } else if (!targetId) {
      await newSession({ skipPersistCurrent: true })
    } else {
      // 目标槽碰巧指向当前会话：若历史已标为另一模式，禁止混用，新开专业/对话会话
      const item = sessionHistoryItems.value.find((s) => s.id === sessionId.value)
      if (item?.workbenchMode && item.workbenchMode !== mode) {
        await newSession({ skipPersistCurrent: true })
      } else {
        stampCurrentSessionMode(mode)
      }
    }
    rememberSessionForMode(mode, sessionId.value)
    add(
      'status',
      mode === 'professional' ? '已切换到专业工作台（独立会话槽）' : '已切换到对话模式（独立会话槽）',
      undefined,
      0
    )
  }

  async function selectHistorySession(id: string) {
    const item = sessionHistoryItems.value.find((s) => s.id === id)
    const tagged = item?.workbenchMode
    if (tagged && tagged !== workbenchMode.value) {
      rememberSessionForMode(workbenchMode.value, sessionId.value)
      stampCurrentSessionMode(workbenchMode.value)
      workbenchMode.value = tagged
      if (typeof localStorage !== 'undefined') localStorage.setItem(WORKBENCH_MODE_KEY, tagged)
      sidebarOpen.value = false
      if (tagged === 'chat') {
        thoughtViewMode.value = 'user'
        if (typeof localStorage !== 'undefined') localStorage.setItem(THOUGHT_VIEW_MODE_KEY, 'user')
        collaborationPosture.value = 'agent'
        if (typeof localStorage !== 'undefined') localStorage.setItem(COLLABORATION_POSTURE_KEY, 'agent')
        debugObservationPanelOpen.value = false
      }
      await switchSession(id)
      rememberSessionForMode(tagged, id)
      return
    }
    if (!tagged) stampSessionMode(id, workbenchMode.value)
    await switchSession(id)
    rememberSessionForMode(workbenchMode.value, id)
  }
  
  const THOUGHT_VIEW_MODE_KEY = 'manager_thought_view_mode'
  const thoughtViewMode = ref<ThoughtViewMode>('user')
  
  function loadThoughtViewMode() {
    thoughtViewMode.value = 'user'
    if (typeof localStorage !== 'undefined') localStorage.setItem(THOUGHT_VIEW_MODE_KEY, 'user')
  }
  
  function setThoughtViewMode(_mode: ThoughtViewMode) {
    thoughtViewMode.value = 'user'
    if (typeof localStorage !== 'undefined') localStorage.setItem(THOUGHT_VIEW_MODE_KEY, 'user')
  }

  const COLLABORATION_POSTURE_KEY = 'manager_collaboration_posture'
  const collaborationPosture = ref<CollaborationPosture>('agent')
  /** Debug：展开过程/步证据面板（thought 开发视图优先） */
  const debugObservationPanelOpen = ref(false)

  function loadCollaborationPosture() {
    if (typeof localStorage === 'undefined') return
    const raw = String(localStorage.getItem(COLLABORATION_POSTURE_KEY) || '')
      .trim()
      .toLowerCase()
    if (raw === 'ask' || raw === 'plan' || raw === 'agent' || raw === 'debug') {
      collaborationPosture.value = raw
      if (raw === 'debug') {
        debugObservationPanelOpen.value = true
      }
    }
  }

  function setCollaborationPosture(mode: CollaborationPosture) {
    collaborationPosture.value = mode
    if (typeof localStorage !== 'undefined') localStorage.setItem(COLLABORATION_POSTURE_KEY, mode)
    if (mode === 'debug') {
      debugObservationPanelOpen.value = true
    } else {
      debugObservationPanelOpen.value = false
    }
  }

  const lastPostureHint = ref<{
    reason: string
    suggest?: CollaborationPosture | string
    text: string
  } | null>(null)

  function dismissPostureHint() {
    lastPostureHint.value = null
  }

  function applyPostureHint(payload: unknown) {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
    const reason = String(p.reason || '').trim() || 'posture_blocked'
    const suggest = String(p.suggest || '').trim() || undefined
    const textFromPayload = String(p.text || p.message || '').trim()
    const text =
      textFromPayload ||
      (reason === 'debug_needs_observation' || reason === 'debug_no_observation'
        ? 'Debug 需要上轮/本轮 Step Observation 才能定点重验。请先切到 Agent 跑一轮，再回来 Debug。'
        : reason === 'write_filtered' || reason === 'ask_read_only'
          ? 'Ask/Debug 为只读姿态：已跳过 admin/gui 等写操作专才。'
          : `协作姿态门禁：${reason}`)
    lastPostureHint.value = { reason, ...(suggest ? { suggest } : {}), text }
  }

  function buildClientContextPayload(): Record<string, unknown> {
    const ctx: Record<string, unknown> = {
      interactionMode: workbenchMode.value,
      workbenchMode: workbenchMode.value,
      collaborationPosture: collaborationPosture.value
    }
    if (clientLocation.value) ctx.location = clientLocation.value
    return ctx
  }
  
  function requestBrowserLocation() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clientLocation.value = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy_m: pos.coords.accuracy,
          updated_at: new Date().toISOString()
        }
      },
      () => {},
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 }
    )
  }
  
  const logs = ref<LogItem[]>([])
  let nextLogId = 0
  function bumpNextLogId() {
    return ++nextLogId
  }
  
  const sessionHost = {} as ManagerSessionHost
  const {
    sessionId,
    userId,
    historyPanelOpen,
    sessionHistoryItems,
    historyBackdropVisible,
    sessionSwitching,
    feedbackByRunId,
    feedbackAckByRunId,
    routeFeedbackByUserIndex,
    feedbackSendingRunId,
    withdrawnTurns,
    formatHistoryTime,
    ensureUserId,
    ensureSessionId,
    loadSessionHistoryList,
    touchCurrentSessionHistory,
    rememberSessionForMode,
    getSessionSlot,
    stampSessionMode,
    stampCurrentSessionMode,
    persistChatLogs,
    restoreChatLogs,
    hydrateLogsFromServerHistory,
    sanitizeWithdrawnTurns,
    restoreWithdrawnTurns,
    persistWithdrawnTurns,
    rebuildTurnCountersFromLogs,
    fetchServerSessionHistory,
    hydrateSessionFromServer,
    renameSessionHistory,
    deleteSessionHistory,
    pruneEmptySessionHistory,
    withdrawTurn,
    newSession,
    switchSession,
    persistSessionFeedback,
    restoreSessionFeedback,
    hydrateSessionFeedbackFromServer,
    syncSessionFeedbackDelete,
    applyTurnFeedback,
    reconcileTurnFeedbackKeys,
    feedbackUserIndexForTurn,
    turnFeedbackKey,
    feedbackKeyForTurn,
    isFeedbackPendingForTurn,
    turnFeedbackSubmitted,
    turnFeedbackAckText,
    routeFeedbackSubmitted,
    shouldShowTurnFeedback,
    clearFeedbackForUserIndex,
    clearFeedbackFromTurnId,
    resetLocalFeedbackState,
    updateHistoryBackdropVisible
  } = useManagerSession(sessionHost)
  
  function errorItemKey(e: LogItem, idx: number) {
    return resolveLogItemId(e) || `err-${idx}`
  }
  
  function resolveLogItemId(m: LogItem): string {
    const id = String(m.logId || '').trim()
    if (id) return id
    return `${m.turn}|${m.ts}|${m.kind}|${String(m.text || '').slice(0, 64)}`
  }
  
  function visibleTurnErrors(t: TurnGroup): LogItem[] {
    return t.errors.filter((e) => String(e.text || '').trim().length > 0)
  }
  
  function dismissError(item: LogItem) {
    const id = resolveLogItemId(item)
    const idx = logs.value.findIndex((m) => resolveLogItemId(m) === id)
    if (idx >= 0) logs.value.splice(idx, 1)
    if ((item.turn || 0) > 0) persistChatLogs()
  }
  
  function dismissAllTurnErrors(turnId: number) {
    const before = logs.value.length
    logs.value = logs.value.filter((m) => !(m.turn === turnId && String(m.kind).toLowerCase() === 'error'))
    if (logs.value.length !== before) persistChatLogs()
  }
  const input = ref('')
  const connected = ref(false)
  const pendingHumanConfirm = ref<{
    runId?: string
    confirmId?: string
    title: string
    message: string
    agent: string
    screenshotDataUrl?: string
    pageUrl?: string
    failureType?: string
    lobsterRunId?: string
  } | null>(null)
  const latestGuiScreenshot = ref('')
  const latestGuiVncUrl = ref('')
  const guiVncAutoOpenedRunId = ref('')
  const humanConfirmSending = ref(false)
  let lastHumanConfirmDecision: 'confirm' | 'cancel' | null = null
  let lastHumanConfirmId = ''
  const taskConstraintsLive = ref<{
    timeHints?: string[]
    subjectHints?: string[]
    wantsVisualize?: boolean
    wantsReport?: boolean
  } | null>(null)
  type RunPhaseItem = { phase: string; ms: number; agent?: string; tokens?: number }
  type RunTokenSummary = {
    totalTokens?: number
    totalUsd?: number
    byAgent?: Record<string, number>
    byPhase?: Record<string, number>
    byModelTier?: Record<string, number>
  }
  const runObservabilityLive = ref<{
    runId?: string
    phaseTimeline: RunPhaseItem[]
    tokenSummary: RunTokenSummary | null
    wallClockMs: number
  } | null>(null)
  const conversationCompactLive = ref<{
    compacted: boolean
    fullChars?: number
    compactChars?: number
    savedRatio?: number
    turns?: number
  } | null>(null)
  const runPhaseBarMaxMs = computed(() => {
    const items = runObservabilityLive.value?.phaseTimeline || []
    return Math.max(1, ...items.map((x) => Number(x.ms) || 0))
  })
  const runTokenByAgentEntries = computed(() => {
    const by = runObservabilityLive.value?.tokenSummary?.byAgent || {}
    return Object.entries(by).sort((a, b) => b[1] - a[1])
  })
  const runTokenByTierEntries = computed(() => {
    const by = runObservabilityLive.value?.tokenSummary?.byModelTier || {}
    return Object.entries(by)
      .filter(([, n]) => Number(n) > 0)
      .sort((a, b) => b[1] - a[1])
  })
  const runTokenBarMax = computed(() => {
    const entries = runTokenByAgentEntries.value
    return Math.max(1, ...entries.map(([, n]) => Number(n) || 0))
  })
  
  const OBS_AGENT_COLORS: Record<string, string> = {
    manager_llm: agentObsColor('manager'),
    manager: agentObsColor('manager'),
    db: agentObsColor('db'),
    rag: agentObsColor('rag'),
    crawler: agentObsColor('crawler'),
    code: agentObsColor('code'),
    clean: agentObsColor('clean'),
    visualize: agentObsColor('visualize'),
    report: agentObsColor('report'),
    admin: agentObsColor('admin'),
    gui: agentObsColor('gui'),
    multimodal: agentObsColor('multimodal'),
    music: agentObsColor('music'),
    video: agentObsColor('video'),
    synth: agentObsColor('synth'),
    planner: agentObsColor('planner'),
    route: agentObsColor('route')
  }
  const logEl = ref<HTMLElement | null>(null)
  const chatRailStackEl = ref<HTMLElement | null>(null)
  const chatColumnEl = ref<HTMLElement | null>(null)
  const chatMainEl = ref<HTMLElement | null>(null)
  const chatScrollHostEl = ref<HTMLElement | null>(null)
  let chatColumnWheelCleanup: (() => void) | null = null
  const echartsModule = ref<any>(null)
  const currentPhase = ref('')
  /** 发送后、runId 到达前用户点了取消 */
  const cancelAfterRunId = ref(false)
  
  const modalOpen = ref(false)
  const modalMode = ref<'alert' | 'confirm' | 'prompt'>('alert')
  const modalTitle = ref('提示')
  const modalMessage = ref('')
  const modalConfirmText = ref('确定')
  const modalCancelText = ref('取消')
  const modalInputValue = ref('')
  const modalInputPlaceholder = ref('')
  let modalResolve: ((value: boolean) => void) | null = null
  let modalPromptResolve: ((value: string | null) => void) | null = null
  
  function onModalConfirm(inputValue?: string) {
    if (modalMode.value === 'prompt') {
      const v = String(inputValue ?? modalInputValue.value ?? '').trim()
      modalPromptResolve?.(v || null)
      modalPromptResolve = null
    } else {
      modalResolve?.(true)
      modalResolve = null
    }
  }
  
  function onModalCancel() {
    if (modalMode.value === 'prompt') {
      modalPromptResolve?.(null)
      modalPromptResolve = null
    } else {
      modalResolve?.(false)
      modalResolve = null
    }
  }
  
  function showAlert(message: string, title = '提示') {
    modalMode.value = 'alert'
    modalTitle.value = title
    modalMessage.value = message
    modalConfirmText.value = '确定'
    modalOpen.value = true
    return new Promise<void>((resolve) => {
      modalPromptResolve = null
      modalResolve = () => resolve()
    })
  }
  
  function showConfirm(message: string, title = '请确认') {
    modalMode.value = 'confirm'
    modalTitle.value = title
    modalMessage.value = message
    modalConfirmText.value = '确定'
    modalCancelText.value = '取消'
    modalOpen.value = true
    return new Promise<boolean>((resolve) => {
      modalPromptResolve = null
      modalResolve = (ok: boolean) => resolve(ok)
    })
  }
  
  function showPrompt(message: string, title = '重命名', defaultValue = '', placeholder = '请输入会话标题') {
    modalMode.value = 'prompt'
    modalTitle.value = title
    modalMessage.value = message
    modalConfirmText.value = '保存'
    modalCancelText.value = '取消'
    modalInputValue.value = defaultValue
    modalInputPlaceholder.value = placeholder
    modalOpen.value = true
    return new Promise<string | null>((resolve) => {
      modalResolve = null
      modalPromptResolve = resolve
    })
  }
  
  const currentRunId = ref('')
  const streamingSynthText = ref('')
  const streamingSynthProvisional = ref(false)
  const streamingReplyEl = ref<HTMLElement | null>(null)
  const streamingSynthDisplayText = computed(() => stripSynthPromptLeakage(String(streamingSynthText.value || '')))
  
  function isSynthPhaseActive(): boolean {
    const p = String(currentPhase.value || '')
    return p === 'synth' || p === 'synth_stream'
  }

  /** 主栏运行态胶囊：思考中 / 调度专才 / 生成中（用户面） */
  function turnRunStatusPill(
    t: TurnGroup
  ): { label: string; kind: 'think' | 'dispatch' | 'synth'; elapsed?: string } | null {
    if (!isTurnRunning(t) && !isTurnLive(t)) return null
    const phase = String(currentPhase.value || '')
    const steps = turnAgentPipelineSteps(t)
    const specialistBusy = steps.some((s) => s.status === 'running' || s.status === 'replan')
    const hasSpecialists =
      specialistBusy ||
      Boolean(turnRouteCap(t)?.agents?.length) ||
      phase.startsWith('execute:')

    let kind: 'think' | 'dispatch' | 'synth' = 'think'
    let label = '思考中'
    if (isSynthPhaseActive() || (isTurnLive(t) && streamingSynthText.value)) {
      kind = 'synth'
      label = '生成中'
    } else if (hasSpecialists && (specialistBusy || phase.startsWith('execute:') || phase === 'multi')) {
      kind = 'dispatch'
      label = '调度专才'
    } else if (phase === 'planner' || phase === 'plan_preview') {
      kind = 'think'
      label = '制定计划'
    } else if (phase === 'route' || phase === 'prefetch' || !phase) {
      kind = 'think'
      label = '思考中'
    } else if (hasSpecialists) {
      kind = 'dispatch'
      label = '调度专才'
    }

    const ms = runObservabilityLive.value?.wallClockMs
    const elapsed = ms != null && ms > 0 ? formatObsMs(ms) : undefined
    return { label, kind, elapsed }
  }

  const planStepsTodo = ref<PlanStepTodo[]>([])
  const routeCapLive = ref<{ intent: string; agents: string[]; capLabel: string; dag?: string } | null>(null)
  const pendingPlanPreview = ref<{
    runId: string
    previewId: string
    hint?: string
    constraints?: string
    approveTier?: 'auto' | 'plan' | 'strict'
    riskScore?: number
    suggestedPosture?: CollaborationPosture
    routePlan?: RoutePlanCardData | null
    steps: Array<{
      id: string
      agent: string
      agentLabel?: string
      query: string
      enabled: boolean
      optional?: boolean
      confirmMode?: 'hitl' | 'auto_confirm' | 'none'
      confirmReason?: string
    }>
  } | null>(null)
  const planPreviewSending = ref(false)
  const stepResultsByTurn = ref<Record<number, StepResultItem[]>>({})
  /** 发送后至 run 结束：拉高背景宇宙动效（含等待首包阶段） */
  const cosmicRunPending = ref(false)
  const agentCosmicActive = computed(() => cosmicRunPending.value || !!currentRunId.value)
  const isRunActive = computed(() => cosmicRunPending.value || !!currentRunId.value)
  const sendCancelDisabled = computed(() => {
    if (isRunActive.value) return !connected.value
    return !connected.value || uploadingAttachment.value || (!input.value.trim() && !pendingAttachment.value)
  })
  
  function clearActiveRun(runId?: string) {
    if (runId && currentRunId.value && currentRunId.value !== runId) return
    currentRunId.value = ''
    cosmicRunPending.value = false
    cancelAfterRunId.value = false
    streamingSynthText.value = ''
    streamingSynthProvisional.value = false
    if (!runId || pendingPlanPreview.value?.runId === runId) {
      pendingPlanPreview.value = null
      planPreviewSending.value = false
    }
  }
  
  function planAgentLabel(agent: string) {
    return planAgentLabelFromDisplay(agent)
  }

  function planAgentLabelForMode(agent: string) {
    return workbenchMode.value === 'professional'
      ? planAgentLabelProfessional(agent)
      : planAgentLabelFromDisplay(agent)
  }
  
  function userPhaseLabel(phase: string): string {
    const p = String(phase || '').trim()
    if (!p) return '准备就绪'
    if (p === 'route') return '理解你的问题…'
    if (p === 'planner') return '制定执行计划…'
    if (p === 'prefetch') return '预取背景资料…'
    if (p === 'plan_preview') return '等待你确认计划…'
    if (p === 'synth' || p === 'synth_stream') return '整理回答…'
    if (p === 'critic') return '核对结果…'
    if (p === 'evaluator') return '质量评估…'
    if (p === 'optimizer') return '优化输出…'
    if (p === 'verifier') return '验证结果…'
    if (p === 'finalize') return '完成'
    if (p === 'clarify') return '需要补充信息…'
    if (p.startsWith('execute:')) {
      const agent = p.slice('execute:'.length)
      return `正在${planAgentLabel(agent)}…`
    }
    return p
  }
  
  const livePhaseText = computed(() => userPhaseLabel(currentPhase.value))
  
  const planStepsDoneCount = computed(
    () => planStepsTodo.value.filter((s) => s.status === 'success' || s.status === 'skipped').length
  )
  
  const enabledPlanPreviewCount = computed(
    () => pendingPlanPreview.value?.steps.filter((s) => s.enabled).length ?? 0
  )
  
  function planStepStatusIcon(status: string) {
    if (status === 'running') return '…'
    if (status === 'success') return '✓'
    if (status === 'failed') return '×'
    if (status === 'skipped') return '−'
    return '○'
  }
  
  function applyPlanStepsPayload(payload: unknown) {
    const p = payload as { steps?: unknown[] }
    const steps = Array.isArray(p?.steps) ? p.steps : []
    if (!steps.length) return
    const prevById = new Map(planStepsTodo.value.map((s) => [s.id, s]))
    const terminal = new Set(['success', 'failed', 'skipped'])
    planStepsTodo.value = steps.map((raw, i) => {
      const s = raw as Record<string, unknown>
      const id = String(s.id || `step_${i + 1}`)
      const prev = prevById.get(id)
      const incoming = String(s.status || '').trim()
      // plan_steps 重发时 normalize 全是 pending：保留本地已终态，避免进度条回退成「待执行」
      const statusRaw =
        incoming && !(incoming === 'pending' && prev && terminal.has(String(prev.status)))
          ? incoming
          : String(prev?.status || incoming || 'pending')
      const allowed = ['pending', 'running', 'success', 'failed', 'skipped'] as const
      return {
        id,
        agent: String(s.agent || prev?.agent || ''),
        query: String(s.query || prev?.query || ''),
        order: Number(s.order ?? i),
        status: (allowed.includes(statusRaw as (typeof allowed)[number])
          ? statusRaw
          : 'pending') as PlanStepTodo['status'],
        optional: Boolean(s.optional ?? prev?.optional)
      }
    })
  }
  
  function updatePlanStepFromStatus(payload: Record<string, unknown>) {
    if (!planStepsTodo.value.length) return
    const stepId = String(payload.stepId || '')
    const agent = String(payload.agent || '').toLowerCase()
    const status = String(payload.status || '') as PlanStepTodo['status']
    planStepsTodo.value = planStepsTodo.value.map((s) => {
      if (stepId && s.id === stepId) return { ...s, status }
      if (!stepId && agent && s.agent.toLowerCase() === agent && (s.status === 'pending' || s.status === 'running')) {
        return { ...s, status }
      }
      return s
    })
  }
  
  function resetPlanSteps() {
    planStepsTodo.value = []
    routeCapLive.value = null
    pendingPlanPreview.value = null
    planPreviewSending.value = false
  }
  
  function stepResultsForTurn(t: TurnGroup): StepResultItem[] {
    return stepResultsByTurn.value[t.id] || []
  }

  /** 执行步数（路由卡/步骤结果），区别于 process 日志条数 */
  function executionStepCountForTurn(t: TurnGroup): number {
    const results = stepResultsForTurn(t)
    if (results.length) return results.length
    const outline = turnPlanOutline(t)?.steps || []
    if (outline.length) return outline.length
    return 0
  }

  function thoughtLogCountForTurn(t: TurnGroup): number {
    return t.process.length
  }
  
  function hasThoughtContent(t: TurnGroup): boolean {
    if (thoughtViewMode.value === 'user') {
      const gui = turnGuiVisuals(t)
      return (
        userThoughtStreamText(t).length > 0 ||
        userThoughtNarrative(t).length > 0 ||
        t.searchSources.length > 0 ||
        Boolean(gui.shot || gui.vncUrl) ||
        isTurnRunning(t)
      )
    }
    return !!(t.process.length || t.ragEvidence.length || t.codePatches.length || t.searchSources.length || isTurnRunning(t))
  }
  
  function stepResultIcon(sr: StepResultItem): string {
    if (sr.status === 'failed') return '✕'
    const agent = String(sr.agent || '').toLowerCase()
    if (agent.includes('db')) return '🗄'
    if (agent.includes('rag')) return '📚'
    if (agent.includes('code')) return '⌨'
    if (agent.includes('crawler') || agent.includes('web')) return '🌐'
    if (agent.includes('visual')) return '📊'
    if (agent.includes('report')) return '📝'
    if (agent.includes('music')) return '🎵'
    if (agent.includes('video')) return '🎬'
    return sr.status === 'success' ? '✓' : '○'
  }
  
  function respondPlanPreview(action: 'execute' | 'cancel') {
    if (!ws || !connected.value || !pendingPlanPreview.value) return
    planPreviewSending.value = true
    const p = pendingPlanPreview.value
    ws.send(
      JSON.stringify(
        withManagerWsAuth({
          type: 'plan_confirm',
          runId: p.runId,
          previewId: p.previewId,
          action,
          constraints: action === 'execute' ? String(p.constraints || '').trim().slice(0, 500) : undefined,
          steps:
            action === 'execute'
              ? p.steps.map((s) => ({
                  id: s.id,
                  agent: s.agent,
                  query: String(s.query || '').trim(),
                  enabled: s.enabled
                }))
              : undefined,
          sessionId: sessionId.value
        })
      )
    )
  }
  
  const lastFinalRunId = ref('')
  const runArtifactsByRunId = ref<Record<string, Record<string, unknown>>>({})
  const copyAckTurnId = ref<number | null>(null)
  const copyAckKey = ref<string | null>(null)
  const editingTurnId = ref<number | null>(null)
  const editDraft = ref('')
  let copyAckTimer: ReturnType<typeof setTimeout> | null = null
  const clearingExperience = ref(false)
  const clearingMemory = ref(false)
  const clearingEvolution = ref(false)
  const evolutionLoading = ref(false)
  const evolutionRaw = ref<Record<string, unknown> | null>(null)
  const worldModelSnapshot = ref<Record<string, unknown> | null>(null)
  const evolutionExperiments = ref<
    Array<{
      id: string
      artifact: string
      status: string
      rationale: string
      verdict?: { liftFinalConfidence: number; reason: string }
    }>
  >([])
  const toolHealthLive = ref<Record<string, unknown> | null>(null)
  const pendingAttachment = ref<PendingAttachment | null>(null)
  const uploadingAttachment = ref(false)
  const chatComposerRef = ref<{ resetFileInput: () => void } | null>(null)
  const quickQuestions = ref([
    '打开 https://httpbin.org/forms/post ，在 Customer name 字段填写 lobster_mgr_test，截图给我。',
    '打开 https://ant.design/components/form-cn ，在演示表单里填写姓名「张三」和邮箱 test@example.com，不要点提交，截图给我。',
    '打开百度搜索 Python 教程，点第一条结果，把标题和链接告诉我。',
    '在数据库中查询林婉清足底压力测试记录，汇总后生成报告（结论与注意事项）。',
    '先从数据库中取出林婉清足底压力测试记录，再从公开网站检索同年龄段足底压力参考区间或指南摘要，对照后生成报告。',
    '在知识库中检索个人月度财务情况，提炼要点并生成对比图表，并帮我创建明天上午 10 点的会议日程，标题为「项目周会」，并设置会议提醒。',
    '对上传图片做 OCR，提取可见文字并用一句话概括。',
    '生成 20 秒轻松钢琴纯音乐，用于演示开场。',
  ])
  
  type TaskPriority = 'critical' | 'high' | 'normal' | 'low'
  type TaskStatus = 'active' | 'paused' | 'done'
  type TaskStackItem = {
    id: string
    title: string
    note: string
    status: TaskStatus
    priority: TaskPriority
    deadline?: string
    source?: string
    linkedFailureCategory?: string
    linkedPlannerRuleId?: string
    createdAt?: string
    updatedAt?: string
  }
  
  const taskStack = ref<TaskStackItem[]>([])
  const taskStackDraft = ref('')
  const taskStackPriority = ref<TaskPriority>('high')
  const taskStackDeadline = ref('')
  const proactiveNudges = ref<Array<{ id: string; title: string; message: string; reason: string }>>([])
  const userGoals = ref<
    Array<{
      id: string
      title: string
      note: string
      status: TaskStatus
      priority: TaskPriority
      deadline?: string
      createdAt?: string
      updatedAt?: string
    }>
  >([])
  const learningChartEl = ref<HTMLElement | null>(null)
  const learningChartPoints = ref<Array<{ i: number; composite: number; feedback: number | null }>>([])
  const opsToken = ref('')
  const opsBusy = ref(false)
  const OPS_TOKEN_KEY = 'manager_ops_token'
  const userGoalDraft = ref('')
  const userGoalPriority = ref<TaskPriority>('high')
  const userGoalDeadline = ref('')
  const userGoalsSaving = ref(false)
  const sidebarOpen = ref(false)
  const learningRecent = ref<
    Array<{
      intent?: string
      compositeScore?: number
      feedbackScore?: number
      searchRequested?: boolean
      searchHitCount?: number
      searchRounds?: number
      searchFailed?: boolean
    }>
  >([])
  const searchMetricsSummary = ref<{
    runsWithSearch?: number
    hitRate?: number | null
    zeroHitRate?: number | null
    avgHits?: number | null
  } | null>(null)
  const taskStackSaving = ref(false)
  const taskStackSyncing = ref(false)
  const TASK_STACK_KEY = 'manager_task_stack_v1'
  
  const taskStackActiveCount = computed(() => taskStack.value.filter((t) => t.status === 'active').length)
  const userGoalsActiveCount = computed(() => userGoals.value.filter((g) => g.status === 'active').length)
  const toolsBadgeCount = computed(() => proactiveNudges.value.length + taskStackActiveCount.value)
  
  function previewText(text: string, max = 100) {
    const t = String(text || '').replace(/\s+/g, ' ').trim()
    if (t.length <= max) return t
    return `${t.slice(0, max)}…`
  }
  
  function formatShortDate(iso: string) {
    try {
      return new Date(iso).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      })
    } catch {
      return String(iso || '').slice(0, 16)
    }
  }
  
  function formatObsMs(ms: number) {
    if (!ms || ms < 0) return '—'
    if (ms < 1000) return `${Math.round(ms)}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }
  
  function formatTokenCount(n: number) {
    const v = Number(n) || 0
    if (v >= 10000) return `${(v / 1000).toFixed(1)}k`
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
    return String(Math.round(v))
  }
  
  function obsAgentColor(agent: string) {
    const key = String(agent || '').toLowerCase().replace(/[^a-z0-9_]/g, '')
    return OBS_AGENT_COLORS[key] || OBS_AGENT_COLORS[key.split('_')[0] || ''] || '#64748b'
  }
  
  function obsPhaseColor(item: RunPhaseItem) {
    if (item.agent) return obsAgentColor(item.agent)
    const phase = String(item.phase || '').toLowerCase()
    if (phase.includes('route')) return '#6366f1'
    if (phase.includes('plan')) return '#a78bfa'
    if (phase.includes('execute') || phase.includes('synth')) return '#38bdf8'
    if (phase.includes('finalize')) return '#34d399'
    return '#64748b'
  }
  
  function obsDisplayLabel(item: RunPhaseItem) {
    const agent = String(item.agent || '').trim()
    if (agent) return planAgentLabel(agent)
    const phase = String(item.phase || '').trim()
    if (!phase) return '—'
    return userPhaseLabel(phase.startsWith('execute:') ? phase.slice('execute:'.length) : phase).replace(/…$/, '')
  }
  
  function renderLearningChart() {
    const mod = echartsModule.value
    const el = learningChartEl.value
    const pts = learningChartPoints.value
    if (!mod || !el || !pts.length) return
    const echarts = mod.init ? mod : mod.default
    if (!echarts?.init) return
    let inst = (el as HTMLElement & { __learning_chart__?: { setOption: (o: unknown) => void; resize?: () => void } })
      .__learning_chart__
    if (!inst) {
      inst = echarts.init(el)
      ;(el as HTMLElement & { __learning_chart__?: typeof inst }).__learning_chart__ = inst
    }
    inst.setOption({
      backgroundColor: 'transparent',
      grid: { left: 40, right: 12, top: 28, bottom: 32 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['综合分', '反馈'], textStyle: { color: '#94a3b8', fontSize: 10 } },
      xAxis: {
        type: 'category',
        data: pts.map((p) => `#${p.i}`),
        axisLabel: { color: '#64748b', fontSize: 10 }
      },
      yAxis: { type: 'value', min: 0, max: 1, axisLabel: { color: '#64748b', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(99,102,241,.08)' } } },
      series: [
        { name: '综合分', type: 'line', data: pts.map((p) => p.composite), smooth: true, symbolSize: 6, lineStyle: { color: '#60a5fa' } },
        {
          name: '反馈',
          type: 'line',
          data: pts.map((p) => p.feedback),
          smooth: true,
          connectNulls: false,
          symbolSize: 6,
          lineStyle: { color: '#34d399' }
        }
      ]
    })
    requestAnimationFrame(() => inst?.resize?.())
  }
  
  async function postManagerOps(action: string, extra?: Record<string, unknown>) {
    const token = opsToken.value.trim()
    if (!token) {
      add('error', '请先填写运维 Token（与 .env 中 MANAGER_OPS_TOKEN 一致）', undefined, 0)
      return null
    }
    opsBusy.value = true
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem(OPS_TOKEN_KEY, token)
      const data = await $fetch<{ ok?: boolean; message?: string; result?: { ok?: boolean; message?: string } }>(
        '/api/manager/ops',
        {
          method: 'POST',
          headers: { 'x-manager-ops-token': token },
          body: { action, ...extra }
        }
      )
      return data
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      add('error', `运维操作失败：${msg}`, undefined, 0)
      return null
    } finally {
      opsBusy.value = false
    }
  }
  
  async function promoteExperiment(experimentId: string) {
    const data = await postManagerOps('evolution_experiment_promote', { experimentId })
    if (data?.ok) {
      add('status', `实验 ${experimentId.slice(0, 8)} 已晋级`, undefined, 0)
      void loadEvolutionDashboard()
    }
  }
  
  async function rollbackExperiment(experimentId: string) {
    const data = await postManagerOps('evolution_experiment_rollback', { experimentId })
    if (data?.ok) {
      add('status', `实验 ${experimentId.slice(0, 8)} 已回滚`, undefined, 0)
      void loadEvolutionDashboard()
    }
  }
  
  function closeSidebar() {
    sidebarOpen.value = false
  }
  
  function closeHistoryPanel() {
    historyPanelOpen.value = false
  }
  
  function closeFloatingPanels() {
    if (modalOpen.value) {
      if (modalMode.value === 'alert') onModalConfirm()
      else onModalCancel()
      return
    }
    closeHistoryPanel()
    closeSidebar()
  }
  
  function userGoalOverdue(goal: { deadline?: string; status: TaskStatus }) {
    if (goal.status === 'done' || !goal.deadline) return false
    const ms = Date.parse(goal.deadline)
    return Number.isFinite(ms) && ms < Date.now()
  }
  
  let ws: WebSocket | null = null
  let wsManualClose = false
  const wsReconnectDelayMs = 2500
  let currentAssistant = ''
  let activeTurn = 0
  let turnSeq = 0
  let userMessageIndexCounter = 0
  const pendingTurns: number[] = []
  const runIdToTurn = new Map<string, number>()
  const collabStates = ref<Record<CollabAgent, CollabStatus>>({
    clean: 'idle',
    visualize: 'idle',
    report: 'idle'
  })
  const collabPreviews = ref<Partial<Record<CollabAgent, string>>>({})
  const collabStatusItems = computed(() => [
    {
      agent: 'clean' as const,
      short: '清',
      label: '清洗',
      status: collabStates.value.clean,
      preview: collabPreviews.value.clean
    },
    {
      agent: 'visualize' as const,
      short: '视',
      label: '可视化',
      status: collabStates.value.visualize,
      preview: collabPreviews.value.visualize
    },
    {
      agent: 'report' as const,
      short: '报',
      label: '报告',
      status: collabStates.value.report,
      preview: collabPreviews.value.report
    }
  ])
  
  type StepProgressEntry = {
    stepId: string
    agent: string
    status: string
    pct?: number
    eta_ms?: number
    stage?: string
    trace_id?: string
  }
  const stepProgressMap = ref<Record<string, StepProgressEntry>>({})
  const activeTraceId = ref('')
  const traceDrawerOpen = ref(false)

  function openTraceDrawer() {
    if (!activeTraceId.value && !currentRunId.value) return
    if (!activeTraceId.value && currentRunId.value) activeTraceId.value = currentRunId.value
    traceDrawerOpen.value = true
  }

  function closeTraceDrawer() {
    traceDrawerOpen.value = false
  }

  const streamAgentLabel = ref('')
  
  const stepProgressLine = computed(() => {
    const entries = Object.values(stepProgressMap.value)
    if (!entries.length) return ''
    const rank = (s: string) => (s === 'running' ? 0 : s === 'pending' ? 1 : 2)
    const active = entries
      .filter((e) => e.status === 'running' || e.status === 'pending')
      .sort((a, b) => rank(a.status) - rank(b.status) || (b.pct ?? 0) - (a.pct ?? 0))
    const focus = active[0] || entries[entries.length - 1]
    if (!focus) return ''
    const eta =
      typeof focus.eta_ms === 'number' && focus.eta_ms > 0 ? ` · 约${Math.round(focus.eta_ms / 1000)}s` : ''
    const pct = typeof focus.pct === 'number' ? ` ${focus.pct}%` : ''
    const stage = focus.stage ? ` · ${focus.stage}` : ''
    const stream = streamAgentLabel.value ? ` · 流式:${streamAgentLabel.value}` : ''
    return `${focus.agent}${pct}${eta}${stage}${stream}`
  })
  
  function resetStepProgress() {
    stepProgressMap.value = {}
    activeTraceId.value = ''
    streamAgentLabel.value = ''
    resetPlanSteps()
    streamingSynthText.value = ''
    streamingSynthProvisional.value = false
    stepResultsByTurn.value = {}
  }
  
  function resetCollabStates(status: CollabStatus) {
    collabStates.value = {
      clean: status,
      visualize: status,
      report: status
    }
    collabPreviews.value = {}
  }
  
  function setCollabPreview(agent: string, summary: string) {
    if (agent !== 'clean' && agent !== 'visualize' && agent !== 'report') return
    const text = String(summary ?? '').trim()
    if (!text) return
    collabPreviews.value = { ...collabPreviews.value, [agent]: text }
  }
  
  function setCollabStatus(agent: string, status: CollabStatus) {
    if (agent !== 'clean' && agent !== 'visualize' && agent !== 'report') return
    collabStates.value = { ...collabStates.value, [agent]: status }
  }
  
  /** 固定协作三件套状态缩写（主行展示） */
  function collabStatusShort(status: CollabStatus) {
    if (status === 'pending') return '候'
    if (status === 'running') return '…'
    if (status === 'success') return '✓'
    if (status === 'failed') return '×'
    return '闲'
  }
  
  function pickNumber(text: string, patterns: RegExp[]) {
    for (const re of patterns) {
      const m = text.match(re)
      if (!m) continue
      const v = Number(String(m[1] ?? '').replace(/,/g, ''))
      if (Number.isFinite(v)) return v
    }
    return null
  }
  
  function chartTitleFromText(text: string, agentResults?: Record<string, string>): string {
    return readChartTitle(extractEchartsOption(text, agentResults))
  }
  
  const TURN_RESULT_AGENTS = new Set(['code', 'rag', 'db', 'crawler', 'gui', 'clean', 'visualize', 'report', 'music', 'video', 'multimodal'])
  
  /** 从本轮日志拼出各 Agent 输出，供 ECharts 渲染 */
  function buildTurnAgentResults(turn?: TurnGroup): Record<string, string> | undefined {
    if (!turn) return undefined
    const out: Record<string, string> = {}
    for (const r of [...(turn.results || []), ...(turn.process || [])]) {
      const agent = String(r.from || '').trim().toLowerCase()
      if (!TURN_RESULT_AGENTS.has(agent)) continue
      const chunk = String(r.text || '').trim()
      if (!chunk) continue
      out[agent] = out[agent] ? `${out[agent]}\n\n${chunk}` : chunk
    }
    return Object.keys(out).length ? out : undefined
  }
  
  function adminUiCardsFromTurn(turn?: TurnGroup): unknown[] {
    if (!turn) return []
    return extractAdminUiCardsFromTurn(turn)
  }
  
  function turnCollaborationPosture(turn?: TurnGroup): CollaborationPosture | undefined {
    const raw = turn?.user?.collaborationPosture || turn?.process?.find((p) => p.collaborationPosture)?.collaborationPosture
    if (raw === 'ask' || raw === 'plan' || raw === 'agent' || raw === 'debug') return raw
    return undefined
  }

  function turnPostureNote(turn?: TurnGroup): string {
    if (!turn) return ''
    if (
      turn.user?.postureBlocked === 'debug_no_observation' ||
      turn.process.some((p) => p.postureBlocked === 'debug_no_observation')
    ) {
      return 'Debug 门禁：缺少 Step Observation，已拒绝空猜全图重跑'
    }
    if (turn.user?.postureReadOnly || turn.process.some((p) => p.postureReadOnly)) {
      return 'Ask/Debug 只读：已跳过写操作专才（admin/gui）'
    }
    const filteredThinking = turn.process.some((p) => /已剔除写副作用专才/.test(String(p.text || '')))
    if (filteredThinking) return 'Ask/Debug 只读：已跳过写操作专才（admin/gui）'
    const posture = turnCollaborationPosture(turn)
    if (posture === 'plan' && !turn.results.length) return 'Plan：批准前对齐蓝图，确认后才执行'
    return ''
  }

  function turnRouteCap(turn?: TurnGroup) {
    if (!turn) return null
    for (let i = turn.process.length - 1; i >= 0; i--) {
      const cap = turn.process[i]?.routeCap
      if (cap?.agents?.length) return cap
    }
    return null
  }
  
  function turnRoutePlanCard(turn?: TurnGroup): RoutePlanCardData | null {
    if (!turn) return null
    for (let i = turn.process.length - 1; i >= 0; i--) {
      const card = turn.process[i]?.routePlanCard
      if (card && (card.agents?.length || card.clauses?.length || card.blueprintDag)) return card
    }
    return null
  }
  
  function turnPlanOutline(turn?: TurnGroup) {
    if (!turn) return null
    for (let i = turn.process.length - 1; i >= 0; i--) {
      const outline = turn.process[i]?.planOutline
      if (outline?.steps?.length) return outline
    }
    return null
  }
  
  function turnUsedAgents(turn?: TurnGroup): string[] {
    if (!turn) return []
    const agents = new Set<string>()
    const cap = turnRouteCap(turn)
    if (cap?.agents?.length) {
      for (const a of cap.agents) agents.add(planAgentLabel(a))
    }
    for (const p of turn.process) {
      if (String(p.kind || '').toLowerCase() !== 'trace') continue
      try {
        const obj = JSON.parse(String(p.text || ''))
        if (obj?.type === 'step_end' && obj?.status === 'ok' && obj?.agent) {
          agents.add(planAgentLabel(String(obj.agent)))
        }
      } catch {
        /* ignore non-json trace */
      }
    }
    return Array.from(agents)
  }
  
  type AgentPipelineStep = {
    id: string
    agent: string
    label: string
    query?: string
    summary?: string
    status: 'pending' | 'running' | 'success' | 'failed'
  }
  
  function hasAgentPipeline(t: TurnGroup): boolean {
    const has = !!(turnRouteCap(t) || turnPlanOutline(t)?.steps?.length || stepResultsForTurn(t).length)
    if (!has) return false
    // 用户视图：单步 admin 写操作不展示沉重「任务执行」面板
    if (thoughtViewMode.value === 'user' && isSimpleAdminOnlyPipeline(t)) return false
    return true
  }

  function turnSuggestedPosture(t: TurnGroup): CollaborationPosture | undefined {
    const fromProcess = t.process.find((p) => p.suggestedPosture)?.suggestedPosture
    if (fromProcess === 'ask' || fromProcess === 'plan' || fromProcess === 'agent' || fromProcess === 'debug') {
      return fromProcess
    }
    const pending = pendingPlanPreview.value
    const runId = t.user?.runId || t.process.find((p) => p.runId)?.runId
    if (pending?.suggestedPosture && (!runId || pending.runId === runId)) {
      return pending.suggestedPosture
    }
    return undefined
  }

  function turnAwaitingPlanConfirm(t: TurnGroup): boolean {
    const pending = pendingPlanPreview.value
    if (!pending) return false
    const runId = t.user?.runId || t.process.find((p) => p.runId)?.runId
    if (runId && pending.runId !== runId) return false
    if (!runId && !isTurnRunning(t) && !isTurnLive(t)) return false
    return true
  }

  function turnHitlInfo(t: TurnGroup): { title?: string; agent?: string } {
    if (pendingHumanConfirm.value && (isTurnRunning(t) || isTurnLive(t))) {
      return {
        title: pendingHumanConfirm.value.title || '需要人工确认',
        agent: pendingHumanConfirm.value.agent
      }
    }
    const action = (t.userFacing?.actions || []).find(
      (a) => String(a.status || '').toLowerCase() === 'pending' || String(a.status || '').toLowerCase() === 'awaiting'
    )
    if (action) {
      return { title: action.title || '需要确认', agent: undefined }
    }
    return {}
  }

  function hasTurnActivity(t: TurnGroup): boolean {
    if (hasAgentPipeline(t)) return true
    if (turnPostureNote(t)) return true
    const posture = turnCollaborationPosture(t)
    if (posture && posture !== 'agent') return true
    if (turnSuggestedPosture(t)) return true
    if (turnAwaitingPlanConfirm(t)) return true
    if (turnHitlInfo(t).title) return true
    return false
  }

  /** 用户视图弱化：仅个人助理单步（或等价单 agent admin） */
  function isSimpleAdminOnlyPipeline(t: TurnGroup): boolean {
    const steps = turnAgentPipelineSteps(t)
    if (steps.length === 1 && steps[0]?.agent === 'admin') return true
    const outline = turnPlanOutline(t)?.steps || []
    if (outline.length === 1 && String(outline[0]?.agent || '') === 'admin') return true
    const caps = turnRouteCap(t)?.agents || []
    if (caps.length === 1 && String(caps[0] || '').toLowerCase() === 'admin') {
      const results = stepResultsForTurn(t)
      if (!results.length || results.every((r) => r.agent === 'admin')) return true
    }
    return false
  }
  
  function resolvePipelineStepStatus(
    t: TurnGroup,
    agent: string,
    stepId: string,
    index: number,
    results: StepResultItem[]
  ): AgentPipelineStep['status'] {
    const sr = results.find((r) => r.stepId === stepId || r.agent === agent)
    if (sr) return sr.status === 'success' ? 'success' : 'failed'
    const outline = turnPlanOutline(t)
    if (outline?.steps?.length) {
      const planStep = outline.steps.find((s) => s.id === stepId || s.agent === agent)
      const ps = String(planStep?.status || '')
      if (ps === 'running') return 'running'
      if (ps === 'success' || ps === 'skipped') return 'success'
      if (ps === 'failed') return 'failed'
    }
    if (isTurnRunning(t)) {
      const doneCount = results.filter((r) => r.status === 'success').length
      if (index === doneCount) return 'running'
      if (index < doneCount) return 'success'
    }
    return 'pending'
  }
  
  function turnAgentPipelineSteps(t: TurnGroup): AgentPipelineStep[] {
    const results = stepResultsForTurn(t)
    const outline = turnPlanOutline(t)
    const queryLen = thoughtViewMode.value === 'user' ? 56 : 96
  
    if (outline?.steps?.length) {
      return outline.steps.map((step, i) => {
        const agent = String(step.agent || '')
        const sr = results.find((r) => r.stepId === step.id || r.agent === agent)
        const status = resolvePipelineStepStatus(t, agent, step.id, i, results)
        return {
          id: step.id || `plan-${i}`,
          agent,
          label: planAgentLabelForMode(agent),
          query: previewText(String(step.query || ''), queryLen),
          summary:
            sr?.status === 'failed' && sr.error
              ? previewText(sr.error, 60)
              : sr?.title && thoughtViewMode.value === 'user'
                ? previewText(sr.title, 80)
                : sr?.status === 'success' && sr.preview
                  ? previewText(sr.preview, queryLen)
                  : undefined,
          status
        }
      })
    }
  
    const cap = turnRouteCap(t)
    if (cap?.agents?.length) {
      return cap.agents.map((agent, i) => {
        const sr = results.find((r) => r.agent === agent)
        return {
          id: `cap-${i}`,
          agent,
          label: planAgentLabelForMode(agent),
          query: sr?.query ? previewText(sr.query, queryLen) : undefined,
          summary: sr?.title ? previewText(sr.title, 80) : undefined,
          status: sr
            ? sr.status === 'success'
              ? 'success'
              : 'failed'
            : resolvePipelineStepStatus(t, agent, `cap-${i}`, i, results)
        }
      })
    }
  
    return results.map((sr, i) => ({
      id: sr.stepId || `sr-${i}`,
      agent: sr.agent,
      label: planAgentLabel(sr.agent),
      query: sr.query ? previewText(sr.query, queryLen) : undefined,
      summary: sr.title ? previewText(sr.title, 80) : undefined,
      status: sr.status === 'success' ? 'success' : 'failed'
    }))
  }
  
  function turnAgentPipelineDoneCount(t: TurnGroup): number {
    return turnAgentPipelineSteps(t).filter((s) => s.status === 'success').length
  }
  
  function agentPipelineStatusLabel(status: AgentPipelineStep['status']): string {
    if (status === 'running') return '进行中'
    if (status === 'success') return '完成'
    if (status === 'failed') return '失败'
    return '等待'
  }
  
  function downloadMarkdown(filename: string, content: string) {
    const blob = new Blob([String(content ?? '')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  
  // ---------- 可视化/报告解析与渲染 ----------
  
  type SimpleChartData = {
    categories: string[]
    values: number[]
    seriesName: string
    chartType: 'bar' | 'line' | 'pie'
  }
  
  function extractEchartsOption(text: string, agentResults?: Record<string, string>): any | null {
    const sources = [String(text || '')]
    if (agentResults?.visualize) sources.push(String(agentResults.visualize))
    for (const src of sources) {
      const opt = resolveRenderableEchartsOptionFromText(src)
      if (opt) return opt
    }
    return null
  }
  
  function extractTableData(text: string): string {
    const s = String(text || '')
    const start = s.indexOf('<!--TABLE_DATA-->')
    const end = s.indexOf('<!--/TABLE_DATA-->')
    if (start < 0 || end <= start) return ''
    const raw = s.slice(start + '<!--TABLE_DATA-->'.length, end).trim()
    if (!raw) return ''
    // 空壳（仅表头）视为无表，避免打开空白「数据看板」
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l.includes('|'))
    for (const line of lines.slice(1)) {
      if (/^\|?\s*:?-{3,}/.test(line)) continue
      const cells = line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
      if (cells.some((c) => c.length > 0)) return raw
    }
    return ''
  }
  
  function extractCrawlerTableData(text: string): string {
    const s = String(text || '')
    const start = s.indexOf('<!--CRAWLER_TABLE-->')
    const end = s.indexOf('<!--/CRAWLER_TABLE-->')
    if (start >= 0 && end > start) {
      return s.slice(start + '<!--CRAWLER_TABLE-->'.length, end).trim()
    }
    return ''
  }
  
  function extractReportBlock(text: string): string {
    const s = String(text || '')
    const start = s.indexOf('<!--REPORT-->')
    const end = s.indexOf('<!--/REPORT-->')
    if (start >= 0 && end > start) {
      return s.slice(start + '<!--REPORT-->'.length, end).trim()
    }
    // 仅有起始标记、无闭合：不展示半截占位（完整正文由主区域展示或由服务端补全闭合块）
    if (start >= 0 && end < 0) {
      const after = s.slice(start + '<!--REPORT-->'.length)
      const stop = after.search(/\n##\s+/m)
      const stub = (stop >= 0 ? after.slice(0, stop) : after).trim()
      const visible = stub.replace(/<!--[\s\S]*?-->/g, '').trim()
      if (visible.length >= 40) return stub
      return ''
    }
    // 回退：尝试提取 "## 详细报告" 之后的内容（到下一个二级标题 ## ）
    const reportHeader = s.indexOf('## 详细报告')
    if (reportHeader >= 0) {
      const nextHeader = s.indexOf('\n## ', reportHeader + 1)
      return s.slice(reportHeader, nextHeader > 0 ? nextHeader : undefined).trim()
    }
    return ''
  }
  
  const MEDIA_LABEL_RE =
    /^(?:视频|短片|音频|音乐|BGM|试听|MP3|MIDI)[:：]\s*((?:https?:\/\/|\/api\/)[^\s#]+)/i
  
  function isValidMediaUrl(url: string): boolean {
    const u = String(url || '')
      .trim()
      .replace(/[),.;`'"]+$/g, '')
    if (!u || u.includes('#') || /\s/.test(u)) return false
    if (!/^https?:\/\//i.test(u) && !/^\/api\//i.test(u)) return false
    return (
      /\.(mp4|webm|mov|mp3|wav|m4a|ogg|mid|midi|png|jpe?g|gif|webp)(\?|$)/i.test(u) ||
      /\/api\/video\//i.test(u) ||
      /\/api\/media\/remote\?url=/i.test(u)
    )
  }
  
  function defaultMediaLabel(url: string): string {
    if (/\.mid/i.test(url)) return 'MIDI 曲目'
    if (/\.(mp3|wav|m4a|ogg)/i.test(url)) return '试听音频'
    if (/\.(mp4|webm|mov)/i.test(url) || /\/api\/video\//i.test(url)) return '生成视频'
    if (/\.(png|jpe?g|gif|webp)/i.test(url)) return '图片'
    return '媒体文件'
  }
  
  function sanitizeMediaLabel(label: string, url: string): string {
    let L = String(label || '')
      .trim()
      .replace(/^#+\s*|\s*#+$/g, '')
      .trim()
    if (!L || L.length > 36 || /^#/.test(L) || /报告|专业|结论|核心|任务执行|分析|概览/i.test(L)) {
      return defaultMediaLabel(url)
    }
    return L
  }
  
  const MEDIA_PATH_LINE_RE =
    /(?:视频|音频|音乐|BGM|成片|输出|文件|路径|URL|链接|video|audio|file)[:：\s]*(?:\/api\/|https?:\/\/)/i
  
  function pushMediaUnique(list: MediaItem[], item: MediaItem) {
    if (!item.url || list.some((x) => x.url === item.url)) return
    list.push(item)
  }
  
  function mediaFor(text: string): MediaBundles {
    try {
      const b = extractMediaBundles(String(text ?? ''))
      return {
        videos: Array.isArray(b?.videos) ? b.videos : [],
        audios: Array.isArray(b?.audios) ? b.audios : [],
        midis: Array.isArray(b?.midis) ? b.midis : [],
        images: Array.isArray(b?.images) ? b.images : [],
      }
    } catch {
      return EMPTY_MEDIA
    }
  }
  
  /** 从最终回复 + 本轮 music/video 步骤输出中解析可播放媒体 */
  function mediaForReply(r: LogItem, turn?: TurnGroup): MediaBundles {
    const chunks = [String(r.text ?? '')]
    const agentOut = buildTurnAgentResults(turn)
    if (agentOut) {
      for (const k of ['music', 'video', 'multimodal'] as const) {
        if (agentOut[k]) chunks.push(agentOut[k]!)
      }
    }
    return mediaFor(chunks.join('\n'))
  }
  
  function hasMediaContent(text: string, turn?: TurnGroup): boolean {
    const b = turn ? mediaForReply({ text } as LogItem, turn) : mediaFor(text)
    return b.videos.length > 0 || b.audios.length > 0 || b.midis.length > 0 || b.images.length > 0
  }
  
  /** 生成了可播放的音视频（需单独展示播放器） */
  function isGeneratedMediaReply(text: string, turn?: TurnGroup): boolean {
    const b = turn ? mediaForReply({ text } as LogItem, turn) : mediaFor(text)
    return b.videos.length > 0 || b.audios.length > 0 || b.midis.length > 0
  }
  
  /** 含 ECharts / REPORT 标签 / 财务柱状图等「报告级」产物（不含 synth 里的 Markdown 小标题） */
  function isStructuredReportArtifact(text: string): boolean {
    const t = String(text || '')
    if (/<!--\s*REPORT\s*-->/i.test(t)) return true
    if (/<!--\s*ECHARTS_OPTION\s*-->/i.test(t)) return true
    if (/<!--\s*TABLE_DATA\s*-->/i.test(t)) return true
    if (/<!--\s*CRAWLER_TABLE\s*-->/i.test(t)) return true
    if (extractEchartsOption(t)) return true
    const rb = extractReportBlock(t)
    if (rb.length >= 120 && /##\s*详细报告/i.test(t)) return true
    return false
  }
  
  function isRichAnalyticsReply(text: string): boolean {
    return isStructuredReportArtifact(text)
  }
  
  /** 普通对话式回复（识图描述、含 ### 核心结论 的 synth 汇总等） */
  function isPlainChatReply(text: string): boolean {
    return !isStructuredReportArtifact(text) && !isGeneratedMediaReply(text)
  }
  
  function resultItemClasses(r: LogItem): string[] {
    const from = r.from ? `from-${String(r.from).toLowerCase()}` : ''
    const tone = isRichAnalyticsReply(r.text) ? 'reply-tone-analytics' : 'reply-tone-chat'
    return ['kind-assistant', tone, from].filter(Boolean) as string[]
  }
  
  function replyHasAnalytics(text: string, turn?: TurnGroup): boolean {
    return replyHasInlineAnalytics(text) || !!resolveReportBody(text, turn) || replyHasCollapsibleSources(text, turn)
  }
  
  function replyHasInlineAnalytics(text: string, agentResults?: Record<string, string>, turn?: TurnGroup): boolean {
    const hasChart = Boolean(userFacingChartOption(turn) || extractEchartsOption(text, agentResults))
    const hasTable = Boolean(userFacingTableHtml(turn) || extractTableData(text))
    return shouldShowInlineChart(turn, hasChart) || shouldShowInlineTable(turn, hasTable)
  }

  function shouldShowUserFacingMetrics(turn?: TurnGroup): boolean {
    const metrics = turn?.userFacing?.metrics
    if (!metrics?.length) return false
    const plan = turn?.userFacing?.presentationPlan
    if (plan && Number(plan.confidence ?? 0) >= 0.42) {
      return (plan.modules || []).some((m) => m.type === 'metrics')
    }
    return true
  }

  function shouldShowUserFacingHeadline(turn?: TurnGroup): boolean {
    if (!turn?.userFacing?.headline) return false
    const plan = turn?.userFacing?.presentationPlan
    if (plan && Number(plan.confidence ?? 0) >= 0.42) {
      return (plan.modules || []).some((m) => m.type === 'headline')
    }
    return turn.userFacing.replyTier !== 'lite'
  }

  function applyFollowUpSuggestion(q: string) {
    input.value = String(q || '').trim()
  }

  function userFacingChartOption(turn?: TurnGroup): unknown | null {
    const opt = turn?.userFacing?.chart?.option
    return opt && typeof opt === 'object' ? opt : null
  }

  function userFacingChartTitle(turn?: TurnGroup): string {
    return String(turn?.userFacing?.chart?.title || '').trim()
  }

  function userFacingTableHtml(turn?: TurnGroup): string {
    const table = turn?.userFacing?.table
    if (!table?.headers?.length || !table.rows?.length) return ''
    // 仅有表头/空单元格时不抢占 Markdown TABLE_DATA 回退（避免「一闪有数 → 定稿空表」）
    const hasValues = table.rows.some((row) =>
      (row || []).some((c) => String(c ?? '').trim())
    )
    if (!hasValues) return ''
    return renderStructuredTableHtml(table.headers, table.rows)
  }

  /** 单行 → 纵向键值；多行 → 常规表（避免宽表把头挤成竖排） */
  function renderStructuredTableHtml(headers: string[], rows: string[][]): string {
    const cols = (headers || []).map((h) => String(h ?? '').trim())
    const bodyRows = (rows || []).filter((row) => (row || []).some((c) => String(c ?? '').trim()))
    if (!cols.length || !bodyRows.length) return ''

    // 单行明细：竖向 KV，可读性远好于横向宽表
    if (bodyRows.length === 1) {
      const row = bodyRows[0] || []
      const items = cols
        .map((h, i) => {
          const v = String(row[i] ?? '').trim()
          if (!h && !v) return ''
          return `<div class="data-kv-row"><div class="data-kv-k">${escapeHtmlBasic(h || '—')}</div><div class="data-kv-v">${escapeHtmlBasic(v || '—')}</div></div>`
        })
        .filter(Boolean)
        .join('')
      return `<div class="data-table data-table-kv" role="table">${items}</div>`
    }

    const head = `<tr>${cols.map((h) => `<th>${escapeHtmlBasic(h)}</th>`).join('')}</tr>`
    const body = bodyRows
      .map((row) => {
        const cells = cols.map((_, i) => `<td>${escapeHtmlBasic(String(row[i] ?? ''))}</td>`).join('')
        return `<tr>${cells}</tr>`
      })
      .join('')
    return `<table class="data-table data-table-grid"><thead>${head}</thead><tbody>${body}</tbody></table>`
  }

  function escapeHtmlBasic(s: string): string {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function canConfirmActionCard(cardId: string): boolean {
    const p = pendingHumanConfirm.value
    if (!p || humanConfirmSending.value || !connected.value) return false
    const id = String(cardId || '').trim()
    if (!id) return false
    return !p.confirmId || p.confirmId === id
  }
  
  function replyHasCollapsibleExtras(text: string): boolean {
    const t = String(text || '')
    return !!(extractCrawlerTableData(t) || extractReportBlock(t) || /<!--\s*REPORT\s*-->/i.test(t))
  }
  
  function replyHasCollapsibleSources(text: string, turn?: TurnGroup): boolean {
    if (turn && turnUnifiedCiteSources(turn).length) return true
    if (extractCrawlerTableData(text)) return true
    return !!(turn && turnSearchSources(turn).length)
  }
  
  function normalizeReportBodyText(text: string): string {
    let s = String(text || '')
      .replace(/<!--\/?REPORT-->/gi, '')
      .replace(/\r\n/g, '\n')
      .trim()
    if (!s) return ''

    const isStructuralLine = (t: string) =>
      !t
        ? true
        : /^#{1,6}\s*$/.test(t)
          || /^#{1,6}\s+\S/.test(t)
          || /^[-*]\s+/.test(t)
          || /^\d+\.\s+/.test(t)
          || /^>\s+/.test(t)
          || t.includes('|')
          || /^```/.test(t)
          || /^[-—]{3,}$/.test(t)

    const lines = s.split('\n')
    const merged: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim()
      if (/^#{1,6}\s*$/.test(t)) {
        const next = (lines[i + 1] || '').trim()
        if (next && !isStructuralLine(next)) {
          merged.push(`${t} ${next}`)
          i += 1
          continue
        }
      }
      merged.push(lines[i])
    }

    const out: string[] = []
    let fragRun = ''
    const flushFrag = () => {
      if (fragRun) {
        out.push(fragRun)
        fragRun = ''
      }
    }
    for (const line of merged) {
      const t = line.trim()
      if (!t) {
        flushFrag()
        if (out.length && out[out.length - 1] !== '') out.push('')
        continue
      }
      if (!isStructuralLine(t) && t.length <= 3) {
        fragRun += t
        continue
      }
      flushFrag()
      out.push(line.trimEnd())
    }
    flushFrag()
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  function resolveReportBody(text: string, turn?: TurnGroup): string {
    const stripExec = (s: string) => stripStructuredExecReport(String(s || '').trim())
    const tagged = stripExec(normalizeReportBodyText(extractReportBlock(text)))
    if (tagged && !looksLikeExecAuditDump(tagged)) return tagged
    const agentOut = buildTurnAgentResults(turn)
    const fromAgent = stripExec(normalizeReportBodyText(String(agentOut?.report || '')))
    if (fromAgent.length >= 40 && !looksLikeExecAuditDump(fromAgent)) return fromAgent
    return ''
  }
  
  /** 展示用正文：用户视图优先 UserFacingPayload，并剥离开发者腔 */
  function stripDeveloperJargonUi(text: string): string {
    let s = stripStructuredExecReport(String(text || ''))
    s = s.replace(/\[CTX:[^\]]*\]/gi, '')
    s = s.replace(/\(ok\)|\(OK\)/gi, '')
    s = s
      .split('\n')
      .map((line) => {
        let t = line.replace(
          /^(?:from\s*=\s*)?(db|rag|crawler|code|clean|visualize|report|admin|gui|multimodal|music|video|multi)\s*[：:]\s*/i,
          ''
        )
        if (/\b(agent_result|needs_clarify|error_code)\b/i.test(t) && t.trim().length < 80) return ''
        t = t.replace(/\bagent_result\b/gi, '结果')
        return t
      })
      .filter((line) => line.trim().length > 0)
      .join('\n')
    return stripStructuredExecReport(s.replace(/\n{3,}/g, '\n\n').trim())
  }

  function replyMarkdownBody(text: string, turn?: TurnGroup): string {
    let source = String(text || '')
    if (thoughtViewMode.value === 'user' && turn?.userFacing?.summary) {
      const uf = String(turn.userFacing.summary || '').trim()
      const finalText = String(text || '').trim()
      // 始终与 final 做有数表合并，禁止 userFacing 空壳盖掉 final/流式已有 TABLE_DATA
      if (!uf) {
        source = finalText
      } else {
        const cleanedFinal = stripStructuredExecReport(finalText)
        source = pickRicherNarrativeWithAuxBlocks(uf, cleanedFinal || finalText)
        if (
          (looksLikeTruncatedSummary(source) || looksLikeStepDumpSummary(source)) &&
          (cleanedFinal || finalText).length > source.length
        ) {
          source = pickRicherNarrativeWithAuxBlocks(cleanedFinal || finalText, source)
        }
      }
    }
    const { narrative } = extractAuxBlocksStructural(source)
    let s = preprocessReplyMarkdown(stripMediaLabelLines(narrative || source))
    s = s
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        if (!t || t === '#') return false
        if (/^-{2,}$/.test(t) && !t.includes('|')) return false
        if (MEDIA_PATH_LINE_RE.test(t)) return false
        if (/\/api\/(?:video|files)\/[^\s]+/i.test(t) && /\.(mp4|webm|mov|mp3|wav|m4a|ogg|mid|midi)/i.test(t)) return false
        return true
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    // 主气泡去掉结构化执行摘要（单独折叠展示）
    s = stripStructuredExecReport(s)
    if (thoughtViewMode.value === 'user') s = stripDeveloperJargonUi(s)
    const revNote = String(turn?.userFacing?.reportRevisionNote || '').trim()
    if (thoughtViewMode.value === 'user' && turn?.userFacing?.reportEdited && revNote) {
      s = mergeSummaryWithRevisionNote(s, revNote)
    }
    return s
  }

  /** 用户视图：详细说明正文（过滤执行摘要 dump；Artifact 面板已承载时去重） */
  function replyUserDetailAppendix(turn?: TurnGroup, replyText?: string): string {
    if (thoughtViewMode.value === 'user' && !shouldShowInlineReportAppendix(turn)) return ''
    const raw = String(
      turn?.userFacing?.appendix || resolveReportBody(String(replyText || ''), turn) || ''
    ).trim()
    if (!raw) return ''
    if (thoughtViewMode.value === 'user' && looksLikeExecAuditDump(raw)) return ''
    const cleaned = stripStructuredExecReport(raw)
    if (!cleaned || looksLikeExecAuditDump(cleaned)) return ''
    return cleaned
  }

  function replyExecutionSummaryMarkdown(text: string, turn?: TurnGroup): string {
    // 用户视图：不展示执行摘要（完成态隐藏；失败/待确认走 replyUserOutcomeBanner）
    if (thoughtViewMode.value === 'user') return ''
    void turn
    const raw = String(text || '')
    const m = raw.match(/(?:^|\n)(## 执行摘要[\s\S]*)$/)
    return m?.[1]?.trim() || ''
  }

  /** 用户视图短状态条：仅失败 / 待确认 */
  function replyUserOutcomeBanner(turn?: TurnGroup): { tone: 'fail' | 'human'; label: string } | null {
    if (thoughtViewMode.value !== 'user') return null
    const o = turn?.userFacing?.outcome
    if (o === 'failed') {
      return { tone: 'fail', label: `本轮未完成：${turn?.userFacing?.outcomeLabel || '未完成'}` }
    }
    if (o === 'needs_human') {
      return { tone: 'human', label: `需要你确认：${turn?.userFacing?.outcomeLabel || '待你确认'}` }
    }
    return null
  }

  /** U2：本轮专家失败 → 可解释降级卡片 */
  function turnExpertFailureCards(
    turn?: TurnGroup
  ): Array<{ agent: string; label: string; code: string; codeLabel: string; message: string }> {
    if (!turn) return []
    const results = stepResultsForTurn(turn).filter((r) => r.status === 'failed')
    const planFailed = (turnPlanOutline(turn)?.steps || []).filter((s: any) => String(s?.status) === 'failed')
    const seen = new Set<string>()
    const cards: Array<{ agent: string; label: string; code: string; codeLabel: string; message: string }> = []

    const push = (agent: string, errorCode?: string, errorDetail?: string) => {
      const key = `${agent}|${errorCode || ''}|${errorDetail || ''}`
      if (seen.has(key) || seen.has(agent)) return
      seen.add(key)
      seen.add(agent)
      const code = normalizeClientErrorCode(errorCode, errorDetail)
      cards.push({
        agent,
        label: planAgentLabel(agent),
        code,
        codeLabel: errorCodeBadgeLabel(code),
        message: buildClientDegradeMessage(agent, code, errorDetail)
      })
    }

    for (const r of results) {
      push(String(r.agent || ''), r.errorCode, r.error || r.preview)
    }
    for (const s of planFailed as Array<{ agent?: string; id?: string }>) {
      const agent = String(s.agent || '')
      if (!agent || seen.has(agent)) continue
      const sr = results.find((r) => r.agent === agent || r.stepId === s.id)
      push(agent, sr?.errorCode, sr?.error)
    }
    return cards
  }

  function replyExecSummaryTone(text: string, turn?: TurnGroup): 'ok' | 'fail' | 'human' | '' {
    if (thoughtViewMode.value === 'user') {
      const banner = replyUserOutcomeBanner(turn)
      return banner?.tone || ''
    }
    const md = replyExecutionSummaryMarkdown(text, turn)
    if (!md) return ''
    if (/结果：失败/.test(md) || /判定：failed_steps/.test(md)) return 'fail'
    if (/结果：需人工/.test(md) || /⚠/.test(md)) return 'human'
    if (/结果：完成/.test(md)) return 'ok'
    return ''
  }
  
  function resolveMediaUrl(raw: string): string {
    return resolveClientMediaUrl(raw)
  }
  
  function mediaDownloadName(url: string, kind: 'video' | 'audio' | 'image'): string {
    const base = String(url || '').split(/[/?#]/).pop() || ''
    if (/\.[a-z0-9]{2,5}$/i.test(base)) return base
    if (kind === 'video') return 'generated-video.mp4'
    if (kind === 'audio') return 'generated-audio.wav'
    return 'image.png'
  }
  
  async function getMediaBlobFromUrl(url: string): Promise<Blob> {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.blob()
  }
  
  function downloadObjectBlob(blob: Blob, filename: string) {
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(href), 1000)
  }
  
  function openMediaInNewTab(url: string) {
    if (!url) return
    window.open(url, '_blank', 'noopener,noreferrer')
  }
  
  async function downloadMediaFile(url: string, filename: string) {
    if (!url) return
    try {
      const blob = await getMediaBlobFromUrl(url)
      downloadObjectBlob(blob, filename)
    } catch (e: any) {
      void showAlert(`下载失败：${String(e?.message || e)}`)
    }
  }
  
  
  /** 把挤在一行的 Markdown 表格拆成多行（禁止按 | | 拆，否则会打碎正常列） */
  function normalizeInlineMarkdownTables(text: string): string {
    const lines = String(text || '').split(/\r?\n/)
    const out: string[] = []
    for (const line of lines) {
      const t = line.trim()
      if (t.includes('|') && (t.match(/\|/g) || []).length >= 10) {
        const parts = t.split(/\|\s*(?=\|[-:\s]{3,}\|)/)
        if (parts.length > 1) {
          for (let i = 0; i < parts.length; i++) {
            let p = parts[i].trim()
            if (!p) continue
            if (!p.startsWith('|')) p = `| ${p}`
            if (!p.endsWith('|')) p = `${p} |`
            out.push(p)
          }
          continue
        }
      }
      out.push(line)
    }
    return out.join('\n')
  }
  
  /** 无竖线的分隔行「--- ---」→ 标准 Markdown 分隔行 */
  function repairMarkdownTableSeparators(text: string): string {
    return String(text || '')
      .split(/\r?\n/)
      .map((line) => {
        const t = line.trim()
        if (t.includes('|')) return line
        if (!/-{3,}/.test(t)) return line
        const parts = t.split(/\s+/).filter((p) => /^:?-{2,}:?$/.test(p))
        if (parts.length >= 2) return `| ${parts.join(' | ')} |`
        return line
      })
      .join('\n')
  }
  
  function stripInlineHtml(s: string): string {
    return String(s ?? '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .trim()
  }
  
  /** 模型偶发输出前端同款 HTML 时，还原为 Markdown 再渲染 */
  function normalizeReplyHtmlToMarkdown(text: string): string {
    return normalizeModelReplyHtml(String(text ?? ''))
  }
  
  const TABLE_HEADER_LINE_HINT =
    /^(指标|项目|名称|类型|维度|您的|健康|参考|状态|数值|区间|单位|说明|月份|年度|收入|支出|结余|率)/
  
  /** 模型把表头拆成多行纯文本时，合并进下一行表格 */
  function mergeFloatingTableHeaders(text: string): string {
    const lines = String(text || '').split(/\r?\n/)
    const out: string[] = []
    let i = 0
    while (i < lines.length) {
      const headers: string[] = []
      while (i < lines.length) {
        const t = lines[i].trim()
        if (t.includes('|') || !t || /^#{1,6}\s/.test(t) || /^[-*]\s/.test(t) || /^\d+\.\s/.test(t) || /^>\s/.test(t)) break
        if (t.length >= 2 && t.length <= 16 && TABLE_HEADER_LINE_HINT.test(t) && headers.length < 8) {
          headers.push(t)
          i++
          continue
        }
        break
      }
      if (headers.length && i < lines.length && lines[i].trim().includes('|')) {
        const rowCells = parseMarkdownTableCells(lines[i])
        if (rowCells.length) {
          out.push(`| ${[...headers, ...rowCells].join(' | ')} |`)
          i++
          continue
        }
      }
      if (headers.length) out.push(...headers)
      if (i < lines.length) {
        out.push(lines[i])
        i++
      }
    }
    return out.join('\n')
  }
  
  function removeMarkdownSection(text: string, header: string): string {
    const s = String(text || '')
    const idx = s.indexOf(header)
    if (idx < 0) return s
    const tail = s.slice(idx + header.length)
    const next = tail.search(/\n##\s+|\n---\s*(?:\n|$)/)
    return (s.slice(0, idx) + (next >= 0 ? tail.slice(next) : '')).replace(/\n{3,}/g, '\n\n').trim()
  }
  
  function stripEmbeddedChartJson(text: string): string {
    const s = String(text || '')
    const opt = extractEchartsOption(s)
    if (!opt) return s
    let rest = s
    while (rest.includes('{')) {
      const start = rest.indexOf('{')
      let depth = 0
      let inStr = false
      let esc = false
      let end = -1
      for (let i = start; i < rest.length; i += 1) {
        const ch = rest[i]
        if (inStr) {
          if (esc) {
            esc = false
            continue
          }
          if (ch === '\\') {
            esc = true
            continue
          }
          if (ch === '"') inStr = false
          continue
        }
        if (ch === '"') {
          inStr = true
          continue
        }
        if (ch === '{') depth += 1
        if (ch === '}') {
          depth -= 1
          if (depth === 0) {
            end = i + 1
            break
          }
        }
      }
      if (end < 0) break
      const chunk = rest.slice(start, end)
      try {
        const parsed = JSON.parse(chunk.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim())
        if (parsed && typeof parsed === 'object' && (parsed.series || parsed.xAxis || parsed.yAxis)) {
          rest = rest.slice(0, start) + rest.slice(end)
          continue
        }
      } catch {}
      rest = rest.slice(start + 1)
    }
    return rest.replace(/\n{3,}/g, '\n\n').trim()
  }
  
  /** 表格行尾粘连引用块（如 `| ... | > 注：`）拆成独立行，避免整表无法解析 */
  function detachBlockquoteFromTableRows(text: string): string {
    return String(text || '').replace(/(\|[^|\n]+\|)\s*(>\s+)/g, '$1\n\n$2')
  }
  
  /** 标题与表格之间补空行（模型常输出 `#### 摘要\n| 表头`） */
  function ensureBlankLineBeforeMarkdownTables(text: string): string {
    return String(text || '')
      .replace(/(#{1,6}\s+[^\n|]+)\n(\|)/g, '$1\n\n$2')
      .replace(/(#{1,6}\s+[^\n|]+)(\|)/g, '$1\n\n$2')
  }
  
  /** 合并连续空列分隔符 `| 项目 |||` → `| 项目 |` */
  function collapseRedundantTablePipes(text: string): string {
    return String(text || '')
      .split(/\r?\n/)
      .map((line) => {
        if (!line.includes('|')) return line
        return line.replace(/\|{2,}/g, '|').replace(/\|\s+\|/g, '| ')
      })
      .join('\n')
  }
  
  /** 长段落按句号拆行，避免整墙文字 */
  function splitLongParagraphLines(text: string): string {
    const lines = String(text || '').split(/\r?\n/)
    const out: string[] = []
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.length < 140 || /^[#>\-*\d|]/.test(t) || t.includes('|')) {
        out.push(line)
        continue
      }
      const parts = t
        .split(/(?<=[。；！？])\s*/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (parts.length <= 1) {
        out.push(line)
        continue
      }
      for (let i = 0; i < parts.length; i++) {
        out.push(parts[i])
        if (i < parts.length - 1) out.push('')
      }
    }
    return out.join('\n')
  }
  
  /** 连续「标签：说明」行提升为 Markdown 列表 */
  function promoteColonLinesToList(text: string): string {
    const lines = String(text || '').split(/\r?\n/)
    const out: string[] = []
    let buf: string[] = []
  
    const isColonLine = (t: string) =>
      /^[\u4e00-\u9fffA-Za-z0-9（()）\-\s]{2,32}[:：]/.test(t) &&
      !/^#{1,6}\s/.test(t) &&
      !/^[-*]\s/.test(t) &&
      !t.includes('|')
  
    const flush = () => {
      if (buf.length >= 2) {
        for (const b of buf) out.push(`- ${b.trim()}`)
      } else {
        out.push(...buf)
      }
      buf = []
    }
  
    for (const line of lines) {
      const t = line.trim()
      if (isColonLine(t)) {
        buf.push(t)
        continue
      }
      flush()
      out.push(line)
    }
    flush()
    return out.join('\n')
  }
  
  /** 独立短标题行（如「指标」）提升为 ### */
  function promoteStandaloneSectionTitles(text: string): string {
    const lines = String(text || '').split(/\r?\n/)
    const out: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim()
      const next = (lines[i + 1] || '').trim()
      if (
        t.length >= 2 &&
        t.length <= 14 &&
        !/[:：。，,!?！？]/.test(t) &&
        !/^[#>\-*\d|]/.test(t) &&
        /^[\u4e00-\u9fffA-Za-z0-9（()）]+$/.test(t) &&
        next &&
        (next.startsWith('-') || /^[\u4e00-\u9fff].+[:：]/.test(next) || next.includes('|'))
      ) {
        out.push(`### ${t}`)
        continue
      }
      out.push(lines[i])
    }
    return out.join('\n')
  }
  
  function preprocessReplyMarkdown(text: string): string {
    let s = normalizeReplyHtmlToMarkdown(String(text || ''))
    s = detachBlockquoteFromTableRows(s)
    s = ensureBlankLineBeforeMarkdownTables(s)
    s = collapseRedundantTablePipes(s)
    s = normalizeInlineMarkdownTables(s)
    s = repairMarkdownTableSeparators(s)
    s = mergeFloatingTableHeaders(s)
    s = s.replace(/<details[\s\S]*?<\/details>/gi, '\n')
    s = s.replace(/<summary[^>]*>[\s\S]*?<\/summary>/gi, '\n')
    s = s.replace(/```json\s*[\s\S]*?```/gi, '\n')
    // 保留 ```code``` 供回复面板渲染与在线运行；仅去掉内部 JSON 调试块
    s = s.replace(/<!--[\s\S]*?-->/g, '\n')
    s = s.replace(/^#{1,6}\s*$/gm, '\n')
    s = s.replace(/^-{3,}\s*$/gm, '\n')
    s = s.replace(/^\*[-*]{2,}\*$/gm, '\n')
    s = stripStrayMarkdownHashes(s)
    s = repairSplitMarkdownTableRows(s)
    s = fixAllMarkdownTables(s)
    s = promoteStandaloneSectionTitles(s)
    s = promoteColonLinesToList(s)
    s = splitLongParagraphLines(s)
    s = s.replace(/\n{3,}/g, '\n\n').trim()
    return s
  }
  
  /** 去掉行尾/标题尾多余 #（模型偶发输出） */
  function stripStrayMarkdownHashes(text: string): string {
    return String(text || '')
      .replace(/^(#{1,6}\s+[^\n#]+?)\s*#\s*$/gm, '$1')
      .replace(/([^\n#|])\s+#\s*$/gm, '$1')
      .replace(/^\s*#\s*$/gm, '')
  }
  
  function isPartialMarkdownTableLine(line: string): boolean {
    const t = line.trim()
    if (!t.includes('|')) return false
    const inner = t.replace(/\|/g, '').trim()
    if (/^[\s:\-]+$/.test(inner)) return false
    const cells = parseMarkdownTableCells(t).filter((c) => c.length > 0)
    if (cells.length >= 2) return false
    if (cells.length === 1 && /^:?-+:?$/.test(cells[0])) return false
    return true
  }
  
  /** 合并被拆成多行的表格单元格，如「| 体重」+「| 50.7 kg |」→ 一行 */
  function repairSplitMarkdownTableRows(text: string): string {
    const lines = String(text || '').split(/\r?\n/)
    const out: string[] = []
    let buf: string[] = []
  
    const mergedBufCells = (): string[] => {
      const cells: string[] = []
      for (const part of buf) {
        cells.push(...parseMarkdownTableCells(part).filter((c) => c.length > 0))
      }
      return cells
    }
  
    const flushBuf = () => {
      if (!buf.length) return
      const cells = mergedBufCells()
      if (cells.length === 1 && /\s/.test(cells[0])) {
        const dual = cells[0].trim().split(/\s+/)
        if (dual.length === 2) {
          out.push(`| ${dual[0]} | ${dual[1]} |`)
          buf = []
          return
        }
      }
      if (cells.length) out.push(`| ${cells.join(' | ')} |`)
      else out.push(...buf)
      buf = []
    }
  
    for (const line of lines) {
      const t = line.trim()
      if (buf.length && t.includes('|') && !t.startsWith('|')) {
        const cleaned = t.replace(/\s*#\s*$/, '').trim()
        buf.push(cleaned.startsWith('|') ? cleaned : `| ${cleaned}`)
        if (mergedBufCells().length >= 2) flushBuf()
        continue
      }
      if (isPartialMarkdownTableLine(line)) {
        if (buf.length && mergedBufCells().length >= 2) flushBuf()
        buf.push(t.replace(/\s*#\s*$/, ''))
        continue
      }
      flushBuf()
      out.push(line)
    }
    flushBuf()
    return out.join('\n')
  }
  
  function isMarkdownHeadingLine(line: string): boolean {
    return /^#{1,6}\s+\S/.test(String(line || '').trim())
  }

  function isMarkdownTableRow(line: string): boolean {
    const t = line.trim()
    if (!t) return false
    // 标题行不得被松散表解析吞进表格（避免「### 建议」进单元格）
    if (isMarkdownHeadingLine(t)) return false
    if (!t.includes('|') && /^[\s:\-|]+$/.test(t) && /-{3,}/.test(t)) {
      const parts = t.split(/\s+/).filter((p) => /^:?-{2,}:?$/.test(p))
      return parts.length >= 2
    }
    if (parseLooseTableRow(t) && parseLooseTableRow(t)!.length >= 2) return true
    if (!t.includes('|')) return false
    const inner = t.replace(/\|/g, '').trim()
    if (/^[\s:\-]+$/.test(inner)) return true
    const cells = parseMarkdownTableCells(t)
    if (cells.some((c) => isMarkdownHeadingLine(c))) return false
    if (cells.filter((c) => c.length > 0).length >= 2) return true
    return cells.length >= 2 && (t.match(/\|/g) || []).length >= 2
  }
  
  function parseMarkdownTableCells(line: string): string[] {
    let t = line.trim()
    if (!t.startsWith('|')) t = `|${t}`
    if (!t.endsWith('|')) t = `${t}|`
    const cells = t
      .slice(1, -1)
      .split('|')
      .map((c) => stripInlineHtml(c.trim()))
    while (cells.length > 1 && cells[cells.length - 1] === '') cells.pop()
    return cells
  }
  
  function dropAllEmptyTableColumns(rows: string[][]): string[][] {
    if (!rows.length) return rows
    const maxCols = Math.max(...rows.map((r) => r.length), 0)
    const keep: number[] = []
    for (let c = 0; c < maxCols; c++) {
      if (rows.some((r) => String(r[c] ?? '').trim().length > 0)) keep.push(c)
    }
    if (!keep.length) return rows
    return rows.map((r) => keep.map((c) => String(r[c] ?? '').trim()))
  }
  
  function parseLooseTableRow(line: string): string[] | null {
    const t = line.trim().replace(/\s*#\s*$/, '')
    if (!t || t.includes('<!--')) return null
    if (isMarkdownHeadingLine(t)) return null
    if (t.includes('|')) {
      const cells = parseMarkdownTableCells(t).filter((c) => c.length > 0)
      if (cells.some((c) => isMarkdownHeadingLine(c))) return null
      return cells
    }
    const quad = t.match(/^(.+?)\s+([\d,.]+(?:\s*元)?)\s+(.+?)\s+(偏高|偏低|正常|良好|达标|不达标)$/u)
    if (quad) return [quad[1], quad[2], quad[3], quad[4]].map((x) => String(x).trim())
    const dual = t.match(/^([\u4e00-\u9fa5A-Za-z_（）()]{2,16})\s+(.+)$/u)
    if (dual && /\d/.test(dual[2])) return [dual[1].trim(), dual[2].trim()]
    return null
  }
  
  function isTableSeparatorCells(cells: string[]): boolean {
    return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(String(c).trim()))
  }
  
  /** 规范化表格块：补齐列数、插入分隔行、合并无 pipe 的数据行 */
  function normalizeTableBlock(block: string[]): string[] {
    const rows: string[][] = []
    for (const line of block) {
      const cells = parseLooseTableRow(line)
      if (cells?.length) rows.push(cells)
    }
    if (!rows.length) return block
  
    let norm = rows.map((r) => r.map((c) => stripInlineHtml(String(c).trim())))
    norm = dropAllEmptyTableColumns(norm)
    const maxCols = Math.max(...norm.map((r) => r.length), 2)
    norm = norm.map((r) => {
      const cells = [...r]
      while (cells.length < maxCols) cells.push('')
      return cells
    })
  
    const header = norm[0]
    let body = norm.slice(1).filter((cells) => !isTableSeparatorCells(cells))
    if (!body.length && norm.length > 1) body = norm.slice(1)
  
    const out: string[] = [`| ${header.join(' | ')} |`]
    if (body.length) {
      out.push(`| ${header.map(() => '---').join(' | ')} |`)
      for (const row of body) out.push(`| ${row.join(' | ')} |`)
    }
    return out
  }
  
  function lineInTableBlock(line: string, blockLen: number): boolean {
    const t = line.trim()
    if (!t) return blockLen > 0
    if (t.includes('|') || isPartialMarkdownTableLine(line)) return true
    if (blockLen > 0 && parseLooseTableRow(line)) return true
    return false
  }
  
  function fixAllMarkdownTables(text: string): string {
    const lines = String(text || '').split(/\r?\n/)
    const out: string[] = []
    let i = 0
    while (i < lines.length) {
      if (lineInTableBlock(lines[i], 0)) {
        const block: string[] = []
        while (i < lines.length && lineInTableBlock(lines[i], block.length)) {
          block.push(lines[i])
          i++
        }
        out.push(...normalizeTableBlock(block))
        continue
      }
      out.push(lines[i])
      i++
    }
    return out.join('\n')
  }
  
  function renderTableDataHtml(text: string): string {
    const raw = extractTableData(text)
    if (!raw) return ''
    // 空壳表（仅表头）不渲染，避免定稿后「数据看板」空白闪烁
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l.includes('|'))
    if (lines.length < 2) return ''

    const splitRow = (line: string) =>
      line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())

    const headers = splitRow(lines[0] || '')
    const dataRows: string[][] = []
    for (const line of lines.slice(1)) {
      if (/^\|?\s*:?-{3,}/.test(line)) continue
      const cells = splitRow(line)
      if (cells.every((c) => !c)) continue
      while (cells.length < headers.length) cells.push('')
      dataRows.push(cells.slice(0, headers.length))
    }
    if (!dataRows.length || !headers.some((h) => h)) return ''
    const hasCell = dataRows.some((row) => row.some((c) => String(c ?? '').trim()))
    if (!hasCell) return ''
    return renderStructuredTableHtml(headers, dataRows)
  }
  
  function resultKindLabel(r: LogItem): string {
    if (isPlainChatReply(r.text) || isGeneratedMediaReply(r.text)) return '助手'
    return kindLabel(r.kind)
  }
  
  function escapeHtml(s: string): string {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }
  
  type MarkdownSegmentPart =
    | { kind: 'text'; text: string }
    | { kind: 'code'; lang: string; code: string }
  
  const inlineCodePayloads = new Map<string, { lang: string; code: string }>()
  let inlineCodeSeq = 0
  const inlineCodeRunBusy = ref<Set<string>>(new Set())
  
  function splitMarkdownWithCodeFences(text: string): MarkdownSegmentPart[] {
    const parts: MarkdownSegmentPart[] = []
    const re = /```([^\n`]*)\n?([\s\S]*?)```/g
    let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      if (match.index > lastIndex) parts.push({ kind: 'text', text: text.slice(lastIndex, match.index) })
      parts.push({ kind: 'code', lang: String(match[1] || 'text').trim(), code: match[2] || '' })
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < text.length) parts.push({ kind: 'text', text: text.slice(lastIndex) })
    return parts.length ? parts : [{ kind: 'text', text }]
  }
  
  function stashInlineCode(lang: string, code: string): string {
    const id = `ic-${++inlineCodeSeq}-${Date.now().toString(36)}`
    inlineCodePayloads.set(id, { lang, code: code.replace(/\s+$/, '') })
    return id
  }
  
  function isRunnableInlineLang(lang: string): boolean {
    const v = String(lang || '').trim().toLowerCase()
    return !v || ['python', 'py', 'javascript', 'js', 'node', 'typescript', 'ts', 'text'].includes(v)
  }
  
  function renderCodeFencePanel(lang: string, code: string): string {
    const id = stashInlineCode(lang, code)
    const safeLang = escapeHtml(lang || 'code')
    const safeCode = escapeHtml(code.replace(/\s+$/, ''))
    const runnable = isRunnableInlineLang(lang)
    return [
      `<div class="reply-code-block" data-code-id="${id}">`,
      '<div class="reply-code-toolbar">',
      `<span class="reply-code-lang">${safeLang}</span>`,
      '<div class="reply-code-actions">',
      runnable ? `<button type="button" class="reply-code-btn" data-action="run-code" data-code-id="${id}">运行</button>` : '',
      `<button type="button" class="reply-code-btn" data-action="copy-code" data-code-id="${id}">复制</button>`,
      '</div></div>',
      `<pre class="reply-code-pre"><code>${safeCode}</code></pre>`,
      `<pre class="reply-code-output" data-output-for="${id}" hidden></pre>`,
      '</div>'
    ]
      .filter(Boolean)
      .join('')
  }
  
  function webSourceHost(hit: SearchSourceItem): string {
    const url = String(hit.url || '').trim()
    if (url) {
      try {
        return new URL(url).hostname.replace(/^www\./, '')
      } catch {
        return url.slice(0, 24)
      }
    }
    return String(hit.title || '来源').slice(0, 16)
  }
  
  async function onReplyMarkdownClick(e: MouseEvent) {
    const el = (e.target as HTMLElement | null)?.closest('[data-action]') as HTMLElement | null
    if (!el) return
    const action = el.getAttribute('data-action')
    const id = el.getAttribute('data-code-id') || ''
    const payload = inlineCodePayloads.get(id)
    if (!payload) return
    if (action === 'copy-code') {
      await copyMessageText(payload.code, { replyKey: `code-${id}` })
      return
    }
    if (action !== 'run-code' || inlineCodeRunBusy.value.has(id)) return
    inlineCodeRunBusy.value.add(id)
    const outputEl = document.querySelector(`[data-output-for="${CSS.escape(id)}"]`) as HTMLElement | null
    if (outputEl) {
      outputEl.textContent = '运行中…'
      outputEl.hidden = false
      outputEl.classList.remove('is-error')
    }
    try {
      const res = await fetch('/api/manager/code-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: payload.lang, code: payload.code })
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        stdout?: string
        stderr?: string
        statusMessage?: string
      }
      const stdout = String(data.stdout || '').trim()
      const stderr = String(data.stderr || '').trim()
      const errMsg = !res.ok ? String(data.statusMessage || stderr || `HTTP ${res.status}`) : ''
      const text = errMsg || [stdout, stderr].filter(Boolean).join('\n') || (data.ok ? '（无输出）' : '运行失败')
      if (outputEl) {
        outputEl.textContent = text
        outputEl.classList.toggle('is-error', Boolean(errMsg) || data.ok === false)
      }
    } catch (err) {
      if (outputEl) {
        outputEl.textContent = String((err as Error)?.message || err)
        outputEl.classList.add('is-error')
      }
    } finally {
      inlineCodeRunBusy.value.delete(id)
    }
  }
  
  /** 轻量 Markdown → HTML（标题、加粗、列表、表格、换行） */
  function renderAssistantMarkdown(text: string, citeSources?: SearchSourceItem[]): string {
    const raw = preprocessReplyMarkdown(String(text ?? '')).trim()
    if (!raw) return ''
    return splitMarkdownWithCodeFences(raw)
      .map((part) =>
        part.kind === 'code'
          ? renderCodeFencePanel(part.lang, part.code)
          : renderMarkdownTextSegment(part.text, citeSources)
      )
      .join('')
  }

  const resultMarkdownHtmlCache = new Map<string, string>()
  const streamingMarkdownHtml = ref('')

  function cachedResultMarkdownHtml(text: string, turn: TurnGroup, resultIdx: number): string {
    const body = replyMarkdownBody(text, turn)
    if (!body) return ''
    const cite = citeSourcesForMarkdown(turn)
    const citeSig = cite.map((c) => c.url).join('|').slice(0, 120)
    const key = `${thoughtViewMode.value}:${turn.id}:${resultIdx}:${body.length}:${body.slice(0, 80)}:${citeSig}`
    const hit = resultMarkdownHtmlCache.get(key)
    if (hit !== undefined) return hit
    const html = renderAssistantMarkdown(body, cite)
    resultMarkdownHtmlCache.set(key, html)
    if (resultMarkdownHtmlCache.size > 240) {
      const first = resultMarkdownHtmlCache.keys().next().value
      if (first) resultMarkdownHtmlCache.delete(first)
    }
    return html
  }

  function turnRenderMemoKey(t: TurnGroup): string {
    return turnMemoSignature(t, {
      thoughtViewMode: thoughtViewMode.value,
      editingTurnId: editingTurnId.value,
      expandedProcessKeys: expandedProcessKeys.value,
      feedbackRunId: feedbackSendingRunId.value,
      copyAckTurnId: copyAckTurnId.value,
    })
  }

  /** 报告附录专用渲染：先合并碎片化换行，再转 Markdown */
  function renderReportMarkdown(text: string): string {
    const raw = preprocessReplyMarkdown(normalizeReportBodyText(String(text ?? ''))).trim()
    if (!raw) return ''
    return splitMarkdownWithCodeFences(raw)
      .map((part) =>
        part.kind === 'code'
          ? renderCodeFencePanel(part.lang, part.code)
          : renderMarkdownTextSegment(part.text)
      )
      .join('')
  }
  
  function renderMarkdownTextSegment(text: string, citeSources?: SearchSourceItem[]): string {
    const raw = String(text ?? '').trim()
    if (!raw) return ''
    const lines = raw.split(/\r?\n/)
    const out: string[] = []
    let para: string[] = []
    let list: string[] = []
    let listOrdered = false
    let tableRows: string[][] = []
  
    const inlineFmt = (s: string) => {
      let x = normalizeModelReplyHtml(s)
      x = escapeHtml(x).replace(/\*\*(.+?)\*\*/g, '<strong class="md-strong">$1</strong>')
      x = x.replace(/\[(\d{1,2})\]/g, (_m, n) => {
        const idx = Number(n) - 1
        const src = citeSources?.[idx]
        if (src?.url) {
          const title = escapeHtml(String(src.title || src.url))
          const url = escapeHtml(String(src.url))
          return `<sup class="md-cite"><a href="${url}" target="_blank" rel="noopener noreferrer" title="${title}">[${n}]</a></sup>`
        }
        return `<sup class="md-cite">[${n}]</sup>`
      })
      x = x.replace(/(偏高|偏低|不达标|略低于标准|略高|略低|需关注)/g, '<span class="md-badge md-badge-warn">$1</span>')
      x = x.replace(/(正常|良好|达标)/g, '<span class="md-badge md-badge-ok">$1</span>')
      x = x.replace(/(注意|风险|警告|缺失)/g, '<span class="md-badge md-badge-warn">$1</span>')
      // 「建议」作节标题时不整词徽章化；仅短标签语境由 Synth 用状态词
      return x
    }
  
    const flushPara = () => {
      if (!para.length) return
      const joined = para.join(' ').trim()
      const chunks =
        joined.length > 180
          ? joined
              .split(/(?<=[。；！？])\s*/)
              .map((s) => s.trim())
              .filter(Boolean)
          : [joined]
      for (const chunk of chunks) {
        if (!chunk) continue
        out.push(`<p class="md-p">${inlineFmt(chunk)}</p>`)
      }
      para = []
    }
    const flushList = () => {
      if (!list.length) return
      const tag = listOrdered ? 'ol' : 'ul'
      const cls = listOrdered ? 'md-ol' : 'md-ul'
      out.push(`<${tag} class="${cls}">${list.map((li) => `<li>${li}</li>`).join('')}</${tag}>`)
      list = []
      listOrdered = false
    }
    const flushTable = () => {
      if (!tableRows.length) return
      const rows = tableRows.map((r) => r.map((c) => c.trim()))
      tableRows = []
      if (!rows.length) return
  
      let head = rows[0]
      let body = rows.slice(1)
      if (body.length && isTableSeparatorCells(body[0])) body = body.slice(1)
  
      const merged = dropAllEmptyTableColumns([head, ...body])
      head = merged[0] || head
      body = merged.slice(1)
  
      if (!body.length && rows.length === 1) {
        out.push(
          '<div class="md-table-scroll"><table class="md-table md-table-single"><tbody><tr>' +
            head.map((c) => `<td>${c}</td>`).join('') +
            '</tr></tbody></table></div>'
        )
        return
      }
      if (body.length === 0) {
        para.push(head.join(' | '))
        return
      }
  
      const maxCols = Math.max(head.length, ...body.map((r) => r.length))
      const pad = (r: string[]) => {
        const x = [...r]
        while (x.length < maxCols) x.push('')
        return x
      }
      head = pad(head)
      // 单元格若整段是 Markdown 标题，挪出表外再渲染（防 Synth 把 ### 建议写进末格）
      const leakedHeadings: string[] = []
      body = body.map((row) =>
        pad(row).map((c) => {
          const cell = String(c || '').trim()
          if (isMarkdownHeadingLine(cell)) {
            leakedHeadings.push(cell)
            return ''
          }
          return c
        })
      )
  
      out.push(
        '<div class="md-table-scroll"><table class="md-table"><thead><tr>' +
          head.map((c) => `<th>${decorateTableCell(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          body
            .map(
              (row) =>
                '<tr>' +
                row.map((c) => `<td>${decorateTableCell(c)}</td>`).join('') +
                '</tr>'
            )
            .join('') +
            '</tbody></table></div>'
      )
      for (const h of leakedHeadings) {
        const level = (h.match(/^#+/) || ['###'])[0].length
        const text = h.replace(/^#{1,6}\s+/, '')
        const cls = level <= 2 ? 'md-h2' : level === 3 ? 'md-h3' : 'md-h4'
        out.push(`<h${Math.min(level, 4)} class="${cls}">${inlineFmt(text)}</h${Math.min(level, 4)}>`)
      }
    }
    const decorateTableCell = (raw: string) => {
      let s = escapeHtml(normalizeModelReplyHtml(stripInlineHtml(raw)))
      s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      s = s.replace(/(偏高|偏低|不达标|略低于标准|略高|略低|需关注)/g, '<span class="md-badge md-badge-warn">$1</span>')
      s = s.replace(/(正常|良好|达标)/g, '<span class="md-badge md-badge-ok">$1</span>')
      s = s.replace(/([\d,.]+)\s*元/g, '<span class="md-num">$1</span> 元')
      return s
    }
    for (const line of lines) {
      const t = line.trim()
      if (!t.includes('|') && /^[\s:\-|]+$/.test(t) && /-{3,}/.test(t)) {
        const parts = t.split(/\s+/).filter((p) => /^:?-{2,}:?$/.test(p))
        if (parts.length >= 2) {
          flushPara()
          flushList()
          tableRows.push(parts)
          continue
        }
      }
      if (isMarkdownTableRow(t)) {
        flushPara()
        flushList()
        tableRows.push(parseMarkdownTableCells(t))
        continue
      }
      if (tableRows.length) flushTable()
  
      if (!t) {
        flushPara()
        flushList()
        continue
      }
      if (/^####\s*/.test(t)) {
        flushPara()
        flushList()
        out.push(`<h4 class="md-h4">${inlineFmt(t.replace(/^####\s*/, ''))}</h4>`)
        continue
      }
      if (/^###\s*/.test(t)) {
        flushPara()
        flushList()
        out.push(`<h3 class="md-h3">${inlineFmt(t.replace(/^###\s*/, ''))}</h3>`)
        continue
      }
      if (/^##\s*/.test(t)) {
        flushPara()
        flushList()
        out.push(`<h2 class="md-h2">${inlineFmt(t.replace(/^##\s*/, ''))}</h2>`)
        continue
      }
      if (/^#\s*/.test(t)) {
        flushPara()
        flushList()
        out.push(`<h1 class="md-h1">${inlineFmt(t.replace(/^#\s*/, ''))}</h1>`)
        continue
      }
      if (/^[-*]\s+/.test(t)) {
        flushPara()
        if (list.length && listOrdered) flushList()
        listOrdered = false
        list.push(inlineFmt(t.replace(/^[-*]\s+/, '')))
        continue
      }
      if (/^\d+\.\s+/.test(t)) {
        flushPara()
        if (list.length && !listOrdered) flushList()
        listOrdered = true
        list.push(inlineFmt(t.replace(/^\d+\.\s+/, '')))
        continue
      }
      if (/^>\s+/.test(t)) {
        flushPara()
        flushList()
        out.push(`<blockquote class="md-quote">${inlineFmt(t.replace(/^>\s+/, ''))}</blockquote>`)
        continue
      }
      if (/^[-—]{3,}$/.test(t)) {
        flushPara()
        flushList()
        out.push('<hr class="md-hr" />')
        continue
      }
      flushList()
      para.push(inlineFmt(t))
    }
    flushList()
    flushTable()
    flushPara()
    return out.join('')
  }
  
  /** 服务端 final 为空时，从同轮 trace 里捞 multimodal 的 outputSummary */
  function extractMultimodalFromTraceLogs(turn: number, runId?: string): string {
    for (let i = logs.value.length - 1; i >= 0; i--) {
      const m = logs.value[i] as LogItem
      if (m.turn !== turn) continue
      if (runId && String(m.runId || '') !== String(runId)) continue
      if (String(m.kind || '').toLowerCase() !== 'trace') continue
      try {
        const obj = JSON.parse(String(m.text || '{}'))
        if (String(obj?.agent || '') !== 'multimodal') continue
        const summary = String(obj?.outputSummary || '').trim()
        if (summary.length >= 12) return summary
      } catch {
        void 0
      }
    }
    return ''
  }
  
  function classifyMediaUrl(url: string, hint = ''): 'video' | 'audio' | 'midi' | 'image' | null {
    const u = String(url || '')
    const h = String(hint || '')
    if (/\.(mid|midi)(\?|$)/i.test(u) || /^midi$/i.test(h.trim())) return 'midi'
    if (
      /\.(mp4|webm|mov)(\?|$)/i.test(u) ||
      /video\/out/i.test(u) ||
      /\/api\/media\/remote\?url=.*\.(mp4|webm|mov)/i.test(u) ||
      /视频|短片/i.test(h)
    )
      return 'video'
    if (/\.(mp3|wav|m4a|ogg)(\?|$)/i.test(u) || /试听|mp3|wav|音频|bgm/i.test(h)) return 'audio'
    if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(u) || /图片|图像/i.test(h)) return 'image'
    return null
  }
  
  function pushClassifiedMedia(
    seen: Set<string>,
    videos: MediaItem[],
    audios: MediaItem[],
    midis: MediaItem[],
    images: MediaItem[],
    url: string,
    label: string
  ) {
    const clean = url.replace(/[),.;`'"]+$/g, '').trim()
    if (!isValidMediaUrl(clean) || seen.has(clean)) return
    seen.add(clean)
    const kind = classifyMediaUrl(clean, label)
    const item = { label: sanitizeMediaLabel(label, clean), url: clean }
    if (kind === 'video') pushMediaUnique(videos, item)
    else if (kind === 'audio') pushMediaUnique(audios, item)
    else if (kind === 'midi') pushMediaUnique(midis, item)
    else if (kind === 'image') pushMediaUnique(images, item)
    else if (/\/api\/video\//i.test(clean) || /\/api\/media\/remote\?url=/i.test(clean))
      pushMediaUnique(videos, { label: defaultMediaLabel(clean), url: clean })
  }
  
  function extractMediaBundles(text: string): MediaBundles {
    const videos: MediaItem[] = []
    const audios: MediaItem[] = []
    const midis: MediaItem[] = []
    const images: MediaItem[] = []
    const seen = new Set<string>()
    const raw = String(text || '')
    const lines = raw.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (/^#{1,3}\s/.test(trimmed) && !MEDIA_LABEL_RE.test(trimmed)) continue
      const m = trimmed.match(MEDIA_LABEL_RE)
      if (m?.[1]) {
        const tag = trimmed.split(/[:：]/)[0]?.trim() || ''
        pushClassifiedMedia(seen, videos, audios, midis, images, m[1], tag)
        continue
      }
      const pathInline = trimmed.match(
        /(?:视频|音频|音乐|BGM|MIDI|成片|成片路径|视频路径|音频路径|输出路径|文件路径|final_video|video_url|video_path|audio_path)[:：\s]+((?:\/api\/|https?:\/\/)[^\s,，。；;#]+)/i
      )
      if (pathInline?.[1]) {
        const tag = trimmed.split(/[:：]/)[0]?.trim() || ''
        pushClassifiedMedia(seen, videos, audios, midis, images, pathInline[1].trim(), tag)
      }
    }
    const urlRe = /(?:https?:\/\/[^\s)\]>"'#]+|\/api\/(?:video|files|media)\/[^\s)\]>"'#]+)/gi
    let um: RegExpExecArray | null = null
    while ((um = urlRe.exec(raw))) {
      pushClassifiedMedia(seen, videos, audios, midis, images, um[0], '')
    }
    return { videos, audios, midis, images }
  }
  
  function stripMediaLabelLines(text: string): string {
    return String(text || '')
      .split('\n')
      .filter((line) => !MEDIA_LABEL_RE.test(line.trim()))
      .join('\n')
  }
  
  function displayUserText(text: string): string {
    return String(text || '')
      .replace(/\n\[附件:[^\]]+\]\s*$/i, '')
      .replace(/^\[附件:[^\]]+\]\s*$/i, '')
      .trim()
  }
  
  function userBubbleText(user?: LogItem): string {
    if (!user) return ''
    const shown = displayUserText(user.text)
    if (shown) return shown
    return String(user.text || '').trim()
  }
  
  function inferClientMediaType(file: File): 'image' | 'video' | 'audio' {
    const t = String(file.type || '').toLowerCase()
    if (t.startsWith('video/')) return 'video'
    if (t.startsWith('audio/')) return 'audio'
    const n = file.name.toLowerCase()
    if (/\.(mp4|webm|mov|avi|mkv)$/.test(n)) return 'video'
    if (/\.(mp3|wav|m4a|ogg|flac|aac)$/.test(n)) return 'audio'
    return 'image'
  }
  
  function revokePreviewUrl(att: PendingAttachment | null) {
    if (att?.previewUrl?.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(att.previewUrl)
      } catch {}
    }
  }
  
  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error || new Error('read failed'))
      reader.readAsDataURL(file)
    })
  }
  
  function clearPendingAttachment() {
    revokePreviewUrl(pendingAttachment.value)
    pendingAttachment.value = null
    chatComposerRef.value?.resetFileInput()
  }
  
  /** 发送后只清空待发送区，保留已写入日志的 data URL 预览 */
  function clearPendingInputOnly() {
    pendingAttachment.value = null
    chatComposerRef.value?.resetFileInput()
  }
  
  async function ingestAttachmentFile(file: File) {
    if (!file) return
    if (file.size > 80 * 1024 * 1024) {
      add('error', '文件过大（上限 80MB）', undefined, activeTurn || turnSeq)
      return
    }
    uploadingAttachment.value = true
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('media_type', inferClientMediaType(file))
      const res = await fetch('/api/multimodal-upload', { method: 'POST', body: fd })
      const data = (await res.json().catch(() => ({}))) as any
      if (!res.ok) throw new Error(String(data?.statusMessage || data?.message || res.statusText || '上传失败'))
      revokePreviewUrl(pendingAttachment.value)
      const mediaType = (String(data.mediaType || inferClientMediaType(file)) as PendingAttachment['mediaType']) || 'image'
      let previewUrl: string | undefined
      if (mediaType === 'image') {
        previewUrl = URL.createObjectURL(file)
        void readFileAsDataUrl(file)
          .then((dataUrl) => {
            const cur = pendingAttachment.value
            if (!cur || cur.filename !== String(data.filename || file.name)) return
            const old = cur.previewUrl
            pendingAttachment.value = { ...cur, previewUrl: dataUrl }
            if (old?.startsWith('blob:')) {
              try {
                URL.revokeObjectURL(old)
              } catch {}
            }
          })
          .catch(() => {})
      }
      pendingAttachment.value = {
        filePath: String(data.filePath || ''),
        mediaType,
        filename: String(data.filename || file.name),
        previewUrl
      }
      add('status', `附件已上传：${pendingAttachment.value.filename}`, undefined, 0)
    } catch (e: any) {
      add('error', `附件上传失败：${String(e?.message || e)}`, undefined, activeTurn || turnSeq)
    } finally {
      uploadingAttachment.value = false
    }
  }

  async function onFileSelected(ev: Event) {
    const input = ev.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    try {
      await ingestAttachmentFile(file)
    } finally {
      input.value = ''
    }
  }

  async function onAttachmentFile(file: File) {
    await ingestAttachmentFile(file)
  }
  
  function flattenFormalReportHeadings(text: string): string {
    let s = String(text || '')
    s = s.replace(/^#{1,3}\s*报告（[^）]+）\s*$/gm, '')
    s = s.replace(/\*\*(核心结论|要点摘要|计算口径|风险与建议|参考来源|关键数据依据|风险提示|下一步建议)\*\*[：:]\s*/g, '')
    s = s.replace(/^#{1,4}\s*(核心结论|要点摘要|计算口径|风险与建议|参考来源|关键数据依据|风险提示|下一步建议)[：:\s]*$/gim, '')
    s = s.replace(/\n*\[参考来源\][\s\S]*?(?=\n{2,}|$)/gi, '')
    s = s.replace(/\n*---+\s*\n*##\s*详细报告[\s\S]*?(?=\n{2,}|$)/gi, '')
    return s.trim()
  }
  
  function stripBrokenMarkdownTablesUi(s: string): string {
    const lines = s.split('\n')
    const out: string[] = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]!
      if (/^\s*\|/.test(line)) {
        let j = i
        while (j < lines.length && (/^\s*\|/.test(lines[j]!) || /^\s*[-—]{2,}\s*$/.test(lines[j]!))) j++
        i = j
        continue
      }
      if (/https?:\/\/\S+/i.test(line) && line.length < 220 && !/[。；！？]/.test(line) && (line.match(/https?:\/\//gi) || []).length >= 1) {
        const linkish = /^\s*(\d+[\.\)、]?\s*)?(\[.*\]\(https?:\/\/|https?:\/\/)/i.test(line.trim())
        if (linkish) {
          i++
          continue
        }
      }
      out.push(line)
      i++
    }
    return out.join('\n')
  }
  
  function stripMdLinkCell(text: string): string {
    return String(text || '')
      .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')
      .trim()
  }
  
  function inferSourceFromUrl(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./i, '')
    } catch {
      return '—'
    }
  }
  
  function parseCrawlerTableRowsUi(md: string): Array<{ title: string; url: string; source: string; excerpt: string }> {
    const lines = String(md || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('|'))
    if (lines.length < 2) return []
  
    const headers = lines[0]!
      .split('|')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean)
    const idx = (names: string[]) => headers.findIndex((h) => names.some((n) => h.includes(n)))
    const idxTitle = idx(['标题', 'title', '名称'])
    const idxSource = idx(['站点', '来源', 'source'])
    const idxUrl = idx(['链接', 'url', 'link'])
    const idxRank = idx(['序号', '排名', 'rank'])
  
    return lines
      .slice(2)
      .filter((l) => !/^\|\s*[-—:]+\s*\|/.test(l) && !/排名/.test(l))
      .map((row) => {
        const cells = row
          .split('|')
          .map((c) => c.trim())
          .filter(Boolean)
        let title = idxTitle >= 0 ? stripMdLinkCell(cells[idxTitle] || '') : ''
        let url = idxUrl >= 0 ? (cells[idxUrl]?.match(/https?:\/\/[^\s)]+/i)?.[0] || '') : ''
        let source = idxSource >= 0 ? stripMdLinkCell(cells[idxSource] || '') : ''
        if (!url) {
          for (const c of cells) {
            const u = c.match(/https?:\/\/[^\s)]+/i)?.[0]
            if (u) {
              url = u
              break
            }
          }
        }
        if (!title) {
          for (let i = 0; i < cells.length; i++) {
            if (i === idxTitle || i === idxUrl || i === idxRank) continue
            const c = stripMdLinkCell(cells[i] || '')
            if (!c || /^[-—]+$/.test(c) || /^\d{1,3}$/.test(c) || /https?:\/\//i.test(c)) continue
            title = c
            break
          }
        }
        if (!source && url) source = inferSourceFromUrl(url)
        if (!title && url) title = inferSourceFromUrl(url)
        return { title: title || '—', url, source: source || '—', excerpt: '' }
      })
  }
  
  function parseCrawlerItemsFromText(text: string): Array<{ title: string; url: string; source: string; excerpt: string }> {
    const t = String(text || '')
    const md = extractCrawlerTableData(t)
    if (md) {
      const rows = parseCrawlerTableRowsUi(md)
      if (rows.length) return rows
    }
    try {
      const parsed = JSON.parse(t)
      const arr = Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.results)
          ? parsed.results
          : Array.isArray(parsed?.data)
            ? parsed.data
            : []
      return arr
        .filter((x: any) => x && typeof x === 'object')
        .map((x: any) => {
          const url = String(x.url ?? x.link ?? '').trim()
          let title = String(x.title ?? x.name ?? '').trim()
          let source = String(x.source ?? '').trim()
          if (!source && url) source = inferSourceFromUrl(url)
          if (!title || title === '-') title = url ? inferSourceFromUrl(url) : '—'
          return {
            title,
            url,
            source: source || '—',
            excerpt: String(x.excerpt ?? x.snippet ?? x.description ?? '').trim()
          }
        })
    } catch {
      return []
    }
  }
  
  function dedupeSearchSources(items: SearchSourceItem[]): SearchSourceItem[] {
    const seen = new Set<string>()
    const out: SearchSourceItem[] = []
    for (const it of items) {
      const key = `${String(it.url || '').trim()}|${String(it.title || '').trim()}`
      if (!key.replace(/\|/g, '').trim() || seen.has(key)) continue
      seen.add(key)
      out.push(it)
    }
    return out
  }
  
  function normalizeSearchHits(hits: unknown[]): SearchSourceItem[] {
    return dedupeSearchSources(
      hits
        .map((h) => {
          const row = h && typeof h === 'object' ? (h as Record<string, unknown>) : {}
          const url = String(row.url || '').trim()
          const title = String(row.title || url || '来源').trim()
          if (!title && !url) return null
          return { title, url }
        })
        .filter((x): x is SearchSourceItem => Boolean(x))
    )
  }
  
  function mergeSearchSources(existing: SearchSourceItem[], incoming: SearchSourceItem[]): SearchSourceItem[] {
    return dedupeSearchSources([...(existing || []), ...(incoming || [])])
  }
  
  function dedupeRagEvidence(items: RagEvidenceItem[]): RagEvidenceItem[] {
    const seen = new Set<string>()
    const out: RagEvidenceItem[] = []
    for (const it of items) {
      const key = `${String(it.source || '').trim()}|${String(it.title || '').trim()}|${String(it.excerpt || '').slice(0, 40)}`
      if (!key.replace(/\|/g, '').trim() || seen.has(key)) continue
      seen.add(key)
      out.push(it)
    }
    return out
  }
  
  function normalizeRagCitations(citations: unknown[]): RagEvidenceItem[] {
    return dedupeRagEvidence(
      citations
        .map((c) => {
          const row = c && typeof c === 'object' ? (c as Record<string, unknown>) : {}
          const source = String(row.source || row.doc || row.document || '').trim()
          const title = String(row.title || source || '').trim()
          const excerpt = String(row.excerpt || row.quote || row.content || row.snippet || '').trim()
          const url = String(row.url || '').trim()
          if (!source && !title && !excerpt) return null
          const scoreRaw = Number(row.score)
          return {
            source: source || title || '文档',
            title: title || undefined,
            url: url || undefined,
            excerpt: excerpt || undefined,
            score: Number.isFinite(scoreRaw) ? scoreRaw : undefined
          } as RagEvidenceItem
        })
        .filter((x): x is RagEvidenceItem => x != null)
    )
  }
  
  function mergeRagEvidence(existing: RagEvidenceItem[], incoming: RagEvidenceItem[]): RagEvidenceItem[] {
    return dedupeRagEvidence([...(existing || []), ...(incoming || [])])
  }
  
  function turnRagEvidence(t: TurnGroup): RagEvidenceItem[] {
    return mergeRagEvidence(t.ragEvidence, [])
  }
  
  function turnSearchSources(t: TurnGroup): SearchSourceItem[] {
    const fromFinal = t.results.flatMap((r) =>
      parseCrawlerItemsFromText(String(r.text || ''))
        .filter((it) => String(it.url || it.title || '').trim())
        .map((it) => ({
          title: String(it.title || it.url || '来源').trim(),
          url: String(it.url || '').trim()
        }))
    )
    return mergeSearchSources(t.searchSources, fromFinal)
  }

  /** 统一编号来源：优先 userFacing.sources，否则合并 RAG + 联网 */
  function turnUnifiedCiteSources(t: TurnGroup): Array<{
    index: number
    title: string
    url?: string
    excerpt?: string
    kind?: string
  }> {
    const uf = Array.isArray(t.userFacing?.sources) ? t.userFacing!.sources! : []
    if (uf.length) {
      return uf.slice(0, 12).map((s, i) => ({
        index: Number((s as { index?: number }).index) || i + 1,
        title: String(s.title || '来源').trim().slice(0, 120),
        url: s.url ? String(s.url).trim() : undefined,
        excerpt: (s as { excerpt?: string }).excerpt
          ? String((s as { excerpt?: string }).excerpt).trim().slice(0, 240)
          : undefined,
        kind: (s as { kind?: string }).kind
      }))
    }
    const out: Array<{ index: number; title: string; url?: string; excerpt?: string; kind?: string }> = []
    const seen = new Set<string>()
    const push = (title: string, url?: string, excerpt?: string, kind?: string) => {
      const t0 = String(title || '').trim()
      if (!t0) return
      const key = `${String(url || '').toLowerCase()}|${t0.toLowerCase().slice(0, 60)}`
      if (seen.has(key)) return
      seen.add(key)
      out.push({
        index: out.length + 1,
        title: t0.slice(0, 120),
        url: url || undefined,
        excerpt: excerpt ? excerpt.slice(0, 240) : undefined,
        kind
      })
    }
    for (const hit of turnRagEvidence(t)) {
      push(String(hit.title || hit.source || '文档'), hit.url, hit.excerpt, 'rag')
    }
    for (const hit of turnSearchSources(t)) {
      push(String(hit.title || hit.url || '来源'), hit.url, undefined, 'web')
    }
    return out.slice(0, 12)
  }

  /** 供 Markdown [n] 角标：与 turnUnifiedCiteSources 顺序一致 */
  function citeSourcesForMarkdown(t: TurnGroup): SearchSourceItem[] {
    return turnUnifiedCiteSources(t).map((s) => ({
      title: s.title,
      url: s.url || ''
    }))
  }
  
  function replySourceCount(r: LogItem, t: TurnGroup): number {
    const unified = turnUnifiedCiteSources(t).length
    if (unified) return unified
    const fromText = crawlerSourceCount(r.text)
    if (fromText) return fromText
    return turnSearchSources(t).length + turnRagEvidence(t).length
  }
  
  function replySourcesMarkdown(r: LogItem, t: TurnGroup): string {
    const fromText = compactCrawlerTableForUi(r.text)
    if (fromText) return fromText
    const ragItems = turnRagEvidence(t).slice(0, 8)
    const webItems = turnSearchSources(t).slice(0, 8)
    const blocks: string[] = []
    if (ragItems.length) {
      const header = '| 序号 | 文档 | 摘录 |'
      const sep = '| --- | --- | --- |'
      const rows = ragItems.map((item, idx) => {
        const title = String(item.title || item.source || '—').slice(0, 48)
        const excerpt = String(item.excerpt || '—').slice(0, 80)
        return `| ${idx + 1} | ${title} | ${excerpt} |`
      })
      blocks.push(['**知识库引用**', header, sep, ...rows].join('\n'))
    }
    if (webItems.length) {
      const header = '| 序号 | 标题 | 站点 | 链接 |'
      const sep = '| --- | --- | --- | --- |'
      const rows = webItems.map((item, idx) => {
        const title = String(item.title || '—').slice(0, 40)
        let source = '—'
        if (item.url) {
          try {
            source = new URL(item.url).hostname.replace(/^www\./i, '')
          } catch {
            source = '—'
          }
        }
        const url = item.url ? `[查看](${item.url})` : '—'
        return `| ${idx + 1} | ${title} | ${source} | ${url} |`
      })
      blocks.push(['**联网来源**', header, sep, ...rows].join('\n'))
    }
    return blocks.join('\n\n')
  }
  
  function crawlerSourceCount(text: string): number {
    return parseCrawlerItemsFromText(text).length
  }
  
  function compactCrawlerTableForUi(text: string): string {
    const items = parseCrawlerItemsFromText(text).slice(0, 5)
    if (!items.length) return ''
    const header = '| 序号 | 标题 | 站点 | 链接 |'
    const sep = '| --- | --- | --- | --- |'
    const rows = items.map((item, idx) => {
      const title = String(item.title || '—').slice(0, 40)
      const source = String(item.source || '—').slice(0, 28)
      const url = item.url ? `[查看](${String(item.url)})` : '—'
      return `| ${idx + 1} | ${title} | ${source} | ${url} |`
    })
    return [header, sep, ...rows].join('\n')
  }
  
  function cleanDisplayText(text: string): string {
    let s = preprocessReplyMarkdown(stripMediaLabelLines(String(text || '')))
    s = stripBrokenMarkdownTablesUi(s)
    // 移除 ECharts 标记块
    const eStart = s.indexOf('<!--ECHARTS_OPTION-->')
    const eEnd = s.indexOf('<!--/ECHARTS_OPTION-->')
    if (eStart >= 0 && eEnd > eStart) {
      s = s.slice(0, eStart) + s.slice(eEnd + '<!--/ECHARTS_OPTION-->'.length)
    }
    // 移除 TABLE_DATA 标记块
    const tStart = s.indexOf('<!--TABLE_DATA-->')
    const tEnd = s.indexOf('<!--/TABLE_DATA-->')
    if (tStart >= 0 && tEnd > tStart) {
      s = s.slice(0, tStart) + s.slice(tEnd + '<!--/TABLE_DATA-->'.length)
    }
    // 历史终稿可能残留「本次展示字段」清单；用户面不再展示
    s = removeMarkdownSection(s, '### 本次展示字段')
    s = removeMarkdownSection(s, '## 本次展示字段')
    s = s.replace(/\n*仅展示与本次问句相关的列。?\n*/g, '\n')
    // 表已进数据看板时，「查询结果」空标题无意义
    s = s.replace(/(^|\n)#{2,3}\s*查询结果\s*(?=\n|$)/g, '\n')
    const cStart = s.indexOf('<!--CRAWLER_TABLE-->')
    const cEnd = s.indexOf('<!--/CRAWLER_TABLE-->')
    if (cStart >= 0 && cEnd > cStart) {
      s = s.slice(0, cStart) + s.slice(cEnd + '<!--/CRAWLER_TABLE-->'.length)
    }
    s = removeMarkdownSection(s, '## 抓取列表')
    s = removeMarkdownSection(s, '### 网页抓取列表')
    // 移除 REPORT 标记块（含仅有起始、无闭合的占位）
    const rStart = s.indexOf('<!--REPORT-->')
    const rEnd = s.indexOf('<!--/REPORT-->')
    if (rStart >= 0 && rEnd > rStart) {
      s = s.slice(0, rStart) + s.slice(rEnd + '<!--/REPORT-->'.length)
    } else if (rStart >= 0) {
      s = s.slice(0, rStart) + s.slice(rStart + '<!--REPORT-->'.length)
    }
    s = removeMarkdownSection(s, '## 图表与可视化（ECharts）')
    s = removeMarkdownSection(s, '## 图表与可视化')
    s = removeMarkdownSection(s, '## 数据')
    s = stripEmbeddedChartJson(s)
    // 移除 "## 详细报告" 及之后直到下一个 ## 或 --- 的内容
    s = removeMarkdownSection(s, '## 详细报告（结构化摘要）')
    s = removeMarkdownSection(s, '## 图表与可视化（结构化摘要）')
    s = removeMarkdownSection(s, '## 数据清洗结果（结构化摘要）')
    s = flattenFormalReportHeadings(s)
    // 移除路由置信度尾注（仅内部监控用，不必展示给用户）
    s = s
      .replace(/\n*\[置信度\]\s*[\d.]+\s*/gi, '\n')
      .replace(/\n*\[不确定性\]\s*(?:低|中|高)\s*/gi, '\n')
    // 压缩成一行时，为 Markdown 标题补换行
    s = s.replace(/([^\n])(#{1,3}\s+)/g, '$1\n\n$2')
    s = s.replace(/([^\n])(\|[^|\n]+\|)/g, '$1\n$2')
    // 清理多余空行
    s = s.replace(/\n{3,}/g, '\n\n').trim()
    return s
  }
  
  function getChartDataFromOption(option: any): SimpleChartData | null {
    if (!option) return null
    const series = Array.isArray(option.series) ? option.series[0] : option.series
    if (!series) return null
    const type = series.type || 'bar'
    if (type === 'pie') {
      const data = Array.isArray(series.data) ? series.data : []
      return {
        categories: data.map((d: any) => String(d.name || d.label || '')),
        values: data.map((d: any) => Number(d.value || 0)),
        seriesName: String(series.name || '占比'),
        chartType: 'pie'
      }
    }
    const xData = option.xAxis?.data || option.xAxis?.[0]?.data || []
    const sData = Array.isArray(series.data) ? series.data : []
    return {
      categories: xData.map((d: any) => String(d)),
      values: sData.map((d: any) => (typeof d === 'number' ? d : Number(d.value || 0))),
      seriesName: String(series.name || '数值'),
      chartType: type === 'line' ? 'line' : 'bar'
    }
  }
  
  function renderEchartsToCanvas(canvas: HTMLCanvasElement, option: any, width = 640, height = 360) {
    try {
      const ec = echartsModule.value
      if (!ec) return
      const chart = ec.init(canvas, undefined, { renderer: 'canvas', width, height })
      const patched = patchDarkTheme(option)
      chart.setOption(patched)
      chart.dispose()
    } catch (e) {
      console.error('echarts render error', e)
    }
  }
  
  function drawChartExportWatermark(canvas: HTMLCanvasElement, subtitle: string) {
    const ctx = canvas.getContext('2d')
    if (!ctx || !subtitle) return
    ctx.save()
    ctx.font = '11px system-ui, sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    ctx.fillText(subtitle, canvas.width - 12, canvas.height - 8)
    ctx.restore()
  }
  
  function downloadEchartsPng(filename: string, option: any) {
    try {
      const meta = buildChartPngExportMeta(option, { filenameHint: filename.replace(/\.png$/i, '') })
      const canvas = document.createElement('canvas')
      canvas.width = meta.width
      canvas.height = meta.height
      renderEchartsToCanvas(canvas, option, meta.width, meta.height)
      drawChartExportWatermark(canvas, meta.subtitle)
      const url = canvas.toDataURL('image/png')
      const a = document.createElement('a')
      a.href = url
      a.download = meta.filename || filename
      a.click()
    } catch {}
  }
  
  /** 霜白冰蓝轴色（函数名保留，调用点不变） */
  function patchAxisDark(axis: any, isX: boolean) {
    if (!axis) return axis
    const axes = Array.isArray(axis) ? axis : [axis]
    for (const ax of axes) {
      if (!ax) continue
      ax.axisLine = { ...(ax.axisLine || {}), lineStyle: { ...(ax.axisLine?.lineStyle || {}), color: 'rgba(70,110,150,0.35)' } }
      ax.axisLabel = { ...(ax.axisLabel || {}), color: '#3a536c' }
      ax.splitLine = { ...(ax.splitLine || {}), lineStyle: { ...(ax.splitLine?.lineStyle || {}), color: 'rgba(120,165,210,0.22)' } }
      ax.nameTextStyle = { ...(ax.nameTextStyle || {}), color: '#1a2f44' }
    }
    return Array.isArray(axis) ? axes : axes[0]
  }
  
  /** 霜白系列标签/描边（函数名保留） */
  function patchSeriesDark(series: any[]) {
    if (!Array.isArray(series)) return series
    return series.map((s) => {
      if (!s) return s
      const patched = { ...s }
      if (patched.label) patched.label = { ...patched.label, color: '#1a2f44' }
      if (patched.type === 'gauge') {
        if (patched.detail) {
          patched.detail = {
            ...patched.detail,
            color: patched.detail.color ?? '#0e1f30',
            fontSize: patched.detail.fontSize ?? 18,
            fontWeight: patched.detail.fontWeight ?? 600
          }
        }
        if (patched.title) patched.title = { ...patched.title, show: false }
        if (patched.axisLabel) patched.axisLabel = { ...patched.axisLabel, color: '#5a738c' }
      }
      if (patched.itemStyle && patched.itemStyle.color && typeof patched.itemStyle.color === 'string') {
        patched.itemStyle = { ...patched.itemStyle, borderColor: 'rgba(255,255,255,0.85)', borderWidth: 1 }
      }
      return patched
    })
  }
  
  function chartContainerStyle(option: any): Record<string, string> {
    if (!option) return {}
    const h = suggestChartContainerHeight(option)
    return { height: `${h}px`, minHeight: `${h}px` }
  }
  
  function chartContainerClass(option: any): Record<string, boolean> {
    return { 'echarts-container--multi': readPanelCount(option) > 1 }
  }
  
  /** 雪主题图表配色（函数名保留以免改调用点；原为深色） */
  function patchDarkTheme(option: any) {
    const o = JSON.parse(JSON.stringify(option || {}))
    const multiPanel = readPanelCount(o) > 1
    o.backgroundColor = 'transparent'
    o.textStyle = { ...(o.textStyle || {}), color: '#1a2f44' }
    if (o.title) {
      const patchOneTitle = (t: any) => ({
        ...t,
        textStyle: { ...(t?.textStyle || {}), color: t?.textStyle?.color ?? '#0e1f30' },
        subtextStyle: { ...(t?.subtextStyle || {}), color: '#5a738c' }
      })
      o.title = Array.isArray(o.title) ? o.title.map(patchOneTitle) : patchOneTitle(o.title)
    }
    if (o.legend) {
      o.legend = { ...(o.legend || {}), textStyle: { ...(o.legend?.textStyle || {}), color: '#3a536c' } }
    }
    if (o.tooltip) {
      o.tooltip = {
        ...(o.tooltip || {}),
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: 'rgba(70,110,150,0.28)',
        textStyle: { ...(o.tooltip?.textStyle || {}), color: '#122536' }
      }
    }
    if (o.xAxis) o.xAxis = patchAxisDark(o.xAxis, true)
    if (o.yAxis) o.yAxis = patchAxisDark(o.yAxis, false)
    if (o.series) o.series = patchSeriesDark(o.series)
    if (!multiPanel) {
      o.grid = { ...(o.grid || {}), left: '12%', right: '8%', top: '15%', bottom: '12%', containLabel: true }
    } else if (Array.isArray(o.grid)) {
      o.grid = o.grid.map((g: any) => ({ ...g, containLabel: g?.containLabel ?? true }))
    }
    return o
  }
  
  function initChartEl(el: HTMLElement, option: any) {
    if (!el || !option) return
    if ((el as any).__chart_inited__) return
    try {
      const ec = echartsModule.value
      if (!ec) return
      const chart = ec.init(el, undefined, { renderer: 'canvas' })
      const patched = patchDarkTheme(option)
      chart.setOption(patched)
      ;(el as any).__chart_inited__ = true
      ;(el as any).__chart_inst__ = chart
      // 确保尺寸正确
      requestAnimationFrame(() => chart.resize())
    } catch (e) {
      console.error('init chart error', e)
    }
  }
  
  const systemEvents = computed(() => logs.value.filter((m: any) => (typeof m?.turn === 'number' ? m.turn : 0) === 0))
  
  const evolutionRawJson = computed(() => JSON.stringify(evolutionRaw.value ?? {}, null, 2))
  
  const healthChips = computed(() => {
    const th = toolHealthLive.value as {
      agents?: Array<{ agent: string; status: string; transport?: string; liveProbe?: string; samples?: number }>
    } | null
    const agents = th?.agents || []
    return agents
      .filter((a) => ['db', 'rag', 'code', 'crawler', 'gui', 'admin', 'multimodal', 'music', 'video'].includes(a.agent))
      .map((a) => ({
        agent: a.agent,
        status: a.status,
        transport: a.transport === 'ws' || a.transport === 'ws+http' ? ' WS' : a.transport === 'http' ? ' HTTP' : '',
        tip: `${a.agent} ${a.status}${a.transport ? ` · ${a.transport}` : ''}${a.liveProbe ? ` · probe=${a.liveProbe}` : ''}`
      }))
  })
  
  function quickCardTitle(q: string) {
    const s = String(q || '').trim()
    if (s.length <= 18) return s
    const m = s.match(/^在[^，,。]+/)
    return m ? m[0].slice(0, 22) : s.slice(0, 18) + '…'
  }
  
  function taskStackStorageKey() {
    return `${TASK_STACK_KEY}_${sessionId.value || 'default'}`
  }
  
  function taskStackMigratedKey() {
    return `${TASK_STACK_KEY}_migrated_${sessionId.value || 'default'}`
  }
  
  function normalizeTaskStackItems(raw: unknown[]): TaskStackItem[] {
    return raw
      .filter((item) => item && typeof item === 'object')
      .map((item: any) => ({
        id: String(item.id || `task_${Date.now()}_${Math.random().toString(16).slice(2)}`),
        title: String(item.title || '').trim(),
        note: String(item.note || '').trim(),
        status: (item.status === 'paused' || item.status === 'done' ? item.status : 'active') as TaskStatus,
        priority: (['critical', 'high', 'normal', 'low'].includes(String(item.priority))
          ? item.priority
          : 'normal') as TaskPriority,
        deadline: item.deadline ? String(item.deadline) : undefined,
        source: item.source ? String(item.source) : undefined,
        linkedFailureCategory: item.linkedFailureCategory ? String(item.linkedFailureCategory) : undefined,
        linkedPlannerRuleId: item.linkedPlannerRuleId ? String(item.linkedPlannerRuleId) : undefined,
        createdAt: item.createdAt ? String(item.createdAt) : undefined,
        updatedAt: item.updatedAt ? String(item.updatedAt) : undefined
      }))
      .filter((item) => item.title)
  }
  
  function applyTaskStackFromServer(items: unknown[]) {
    taskStack.value = normalizeTaskStackItems(items)
  }
  
  async function postTaskStackAction(body: Record<string, unknown>) {
    const sid = sessionId.value
    if (!sid) return null
    return await $fetch<{ ok: boolean; stack?: { items: unknown[] }; added?: number; merged?: number }>(
      '/api/manager/task-stack',
      { method: 'POST', body: { sessionId: sid, ...body } }
    )
  }
  
  async function fetchTaskStackFromServer(sync = false) {
    const sid = sessionId.value
    if (!sid) return
    try {
      const data = await $fetch<{ stack?: { items: unknown[] }; insightAdded?: number }>(
        `/api/manager/task-stack?sessionId=${encodeURIComponent(sid)}&sync=${sync ? '1' : '0'}`
      )
      if (Array.isArray(data?.stack?.items)) applyTaskStackFromServer(data.stack.items)
    } catch {}
  }
  
  async function migrateLocalTaskStackIfNeeded() {
    const sid = sessionId.value
    if (!sid) return
    try {
      if (window.localStorage.getItem(taskStackMigratedKey())) return
      const raw = window.localStorage.getItem(taskStackStorageKey())
      if (!raw) {
        window.localStorage.setItem(taskStackMigratedKey(), '1')
        return
      }
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed) || !parsed.length) {
        window.localStorage.setItem(taskStackMigratedKey(), '1')
        return
      }
      const data = await postTaskStackAction({ action: 'migrate', items: parsed })
      if (data?.stack?.items) applyTaskStackFromServer(data.stack.items)
      window.localStorage.setItem(taskStackMigratedKey(), '1')
      window.localStorage.removeItem(taskStackStorageKey())
    } catch {}
  }
  
  function taskPriorityLabel(p: TaskPriority) {
    return ({ critical: '紧急', high: '高', normal: '普通', low: '低' } as const)[p] || p
  }
  
  function taskStatusLabel(s: TaskStatus) {
    return ({ active: '进行中', paused: '已暂停', done: '已完成' } as const)[s] || s
  }
  
  function formatTaskDeadline(deadline?: string) {
    const ms = Date.parse(String(deadline || ''))
    if (!Number.isFinite(ms)) return ''
    const label = new Date(ms).toLocaleString('zh-CN', { hour12: false })
    return ms < Date.now() ? `已逾期 · ${label}` : `截止 ${label}`
  }
  
  function taskOverdue(task: TaskStackItem) {
    if (task.status === 'done' || !task.deadline) return false
    const ms = Date.parse(task.deadline)
    return Number.isFinite(ms) && ms < Date.now()
  }
  
  function deadlineIsoFromLocalInput(v: string) {
    const s = String(v || '').trim()
    if (!s) return undefined
    const ms = Date.parse(s)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
  }
  
  async function addTaskToStack() {
    const title = taskStackDraft.value.trim()
    if (!title || taskStackSaving.value) return
    taskStackSaving.value = true
    try {
      const data = await postTaskStackAction({
        action: 'upsert',
        task: {
          title,
          note: '用户手动添加的高优先级事项。',
          status: 'active',
          priority: taskStackPriority.value,
          deadline: deadlineIsoFromLocalInput(taskStackDeadline.value),
          source: 'manual'
        }
      })
      if (data?.stack?.items) applyTaskStackFromServer(data.stack.items)
      taskStackDraft.value = ''
      taskStackDeadline.value = ''
    } catch {} finally {
      taskStackSaving.value = false
    }
  }
  
  async function setTaskStackItemStatus(taskId: string, status: TaskStatus) {
    if (taskStackSaving.value) return
    taskStackSaving.value = true
    try {
      const data = await postTaskStackAction({ action: 'set_status', taskId, status })
      if (data?.stack?.items) applyTaskStackFromServer(data.stack.items)
    } catch {} finally {
      taskStackSaving.value = false
    }
  }
  
  async function removeTaskFromStack(taskId: string) {
    if (taskStackSaving.value) return
    taskStackSaving.value = true
    try {
      const data = await postTaskStackAction({ action: 'delete', taskId })
      if (data?.stack?.items) {
        applyTaskStackFromServer(data.stack.items)
        await fetchProactiveNudges()
      }
    } catch {} finally {
      taskStackSaving.value = false
    }
  }
  
  async function markTaskStackDone() {
    if (taskStackSaving.value) return
    taskStackSaving.value = true
    try {
      for (const task of taskStack.value.filter((t) => t.status !== 'done')) {
        await postTaskStackAction({ action: 'set_status', taskId: task.id, status: 'done' })
      }
      await fetchTaskStackFromServer(false)
    } catch {} finally {
      taskStackSaving.value = false
    }
  }
  
  async function clearDoneTasks() {
    if (taskStackSaving.value) return
    taskStackSaving.value = true
    try {
      const data = await postTaskStackAction({ action: 'clear_done' })
      if (data?.stack?.items) applyTaskStackFromServer(data.stack.items)
    } catch {} finally {
      taskStackSaving.value = false
    }
  }
  
  async function clearTaskStack() {
    if (taskStackSaving.value) return
    taskStackSaving.value = true
    try {
      const data = await postTaskStackAction({ action: 'clear_all' })
      if (data?.stack?.items) applyTaskStackFromServer(data.stack.items)
    } catch {} finally {
      taskStackSaving.value = false
    }
  }
  
  async function resetTaskStackForSession() {
    taskStack.value = []
    taskStackDraft.value = ''
    taskStackDeadline.value = ''
    try {
      window.localStorage.removeItem(taskStackStorageKey())
      window.localStorage.removeItem(taskStackMigratedKey())
    } catch {}
    void postTaskStackAction({ action: 'clear_all' }).catch(() => undefined)
  }
  
  function clearTaskStackForSwitch() {
    taskStack.value = []
    taskStackDraft.value = ''
    taskStackDeadline.value = ''
  }
  
  async function syncTaskStackInsights() {
    if (taskStackSyncing.value) return
    taskStackSyncing.value = true
    try {
      const data = await postTaskStackAction({ action: 'sync_insights' })
      if (data?.stack?.items) applyTaskStackFromServer(data.stack.items)
    } catch {} finally {
      taskStackSyncing.value = false
    }
  }
  
  function ensureTaskStackVisible() {
    // 保留 hook；不再自动展开面板以免遮挡对话
  }
  
  async function upsertTaskFromText(
    title: string,
    note: string,
    status: TaskStatus = 'active',
    priority: TaskPriority = 'high'
  ) {
    const normalized = String(title || '').trim()
    if (!normalized) return
    try {
      const existing = taskStack.value.find((task) => task.title === normalized)
      const data = await postTaskStackAction({
        action: 'upsert',
        task: {
          id: existing?.id,
          title: normalized,
          note: note || existing?.note || '',
          status,
          priority: existing?.priority || priority,
          deadline: existing?.deadline,
          source: 'assistant'
        }
      })
      if (data?.stack?.items) applyTaskStackFromServer(data.stack.items)
      ensureTaskStackVisible()
    } catch {}
  }
  
  /** 可选：服务端 LLM 提取待办（MANAGER_TASK_STACK_LLM_EXTRACT=1），不再用前端正则扫消息 */
  async function maybeExtractTasksWithLlm(assistantText: string, userContext?: string) {
    const sid = sessionId.value
    if (!sid || assistantText.length < 40) return
    try {
      const data = await postTaskStackAction({
        action: 'extract_llm',
        assistantText: assistantText.slice(0, 12000),
        userContext: userContext?.slice(0, 4000)
      })
      if (data?.stack?.items) applyTaskStackFromServer(data.stack.items)
    } catch {}
  }
  
  async function dismissProactiveNudge(nudgeId: string) {
    proactiveNudges.value = proactiveNudges.value.filter((n) => n.id !== nudgeId)
    try {
      await $fetch(`/api/manager/proactive?sessionId=${encodeURIComponent(sessionId.value)}&nudgeId=${encodeURIComponent(nudgeId)}&consume=1`)
      await fetchProactiveNudges()
    } catch {}
  }
  
  async function fetchProactiveNudges() {
    const sid = sessionId.value
    if (!sid) return
    try {
      const data = await $fetch<{ nudges?: Array<{ id: string; title: string; message: string; reason: string }> }>(
        `/api/manager/proactive?sessionId=${encodeURIComponent(sid)}`
      )
      if (Array.isArray(data?.nudges)) {
        proactiveNudges.value = data.nudges
      }
    } catch {}
  }
  
  function absorbProactiveNudges(raw: unknown) {
    const arr = Array.isArray(raw) ? raw : []
    if (!arr.length) return
    proactiveNudges.value = arr as typeof proactiveNudges.value
    for (const n of arr.slice(0, 2)) {
      const msg = String((n as { message?: string }).message || '')
      if (msg) add('status', `[主动推进] ${msg}`, 'manager', 0)
    }
  }
  
  async function postUserGoalAction(body: Record<string, unknown>) {
    ensureUserId()
    ensureSessionId()
    return $fetch<{ goals?: typeof userGoals.value; userId?: string }>('/api/manager/user-goals', {
      method: 'POST',
      body: { userId: userId.value, sessionId: sessionId.value, ...body }
    })
  }
  
  async function fetchUserGoalsFromServer() {
    ensureUserId()
    ensureSessionId()
    try {
      const data = await $fetch<{ goals?: typeof userGoals.value }>(
        `/api/manager/user-goals?userId=${encodeURIComponent(userId.value)}&sessionId=${encodeURIComponent(sessionId.value)}`
      )
      if (Array.isArray(data?.goals)) userGoals.value = data.goals as typeof userGoals.value
    } catch {}
  }
  
  async function hydrateUserGoals() {
    await fetchUserGoalsFromServer()
  }
  
  async function addUserGoal() {
    const title = userGoalDraft.value.trim()
    if (!title) return
    userGoalsSaving.value = true
    try {
      const data = await postUserGoalAction({
        action: 'upsert',
        goal: {
          title,
          note: '',
          status: 'active',
          priority: userGoalPriority.value,
          deadline: userGoalDeadline.value ? new Date(userGoalDeadline.value).toISOString() : undefined
        }
      })
      if (Array.isArray(data?.goals)) userGoals.value = data.goals
      userGoalDraft.value = ''
      userGoalDeadline.value = ''
      add('status', '已添加用户级目标', undefined, 0)
    } catch (e: unknown) {
      add('error', `用户目标保存失败：${e instanceof Error ? e.message : String(e)}`, undefined, 0)
    } finally {
      userGoalsSaving.value = false
    }
  }
  
  async function setUserGoalStatus(goalId: string, status: TaskStatus) {
    userGoalsSaving.value = true
    try {
      const data = await postUserGoalAction({ action: 'set_status', goalId, status })
      if (Array.isArray(data?.goals)) userGoals.value = data.goals
    } catch {}
    finally {
      userGoalsSaving.value = false
    }
  }
  
  async function removeUserGoal(goalId: string) {
    userGoalsSaving.value = true
    try {
      const data = await postUserGoalAction({ action: 'delete', goalId })
      if (Array.isArray(data?.goals)) userGoals.value = data.goals
    } catch {}
    finally {
      userGoalsSaving.value = false
    }
  }
  
  async function hydrateTaskStack() {
    await migrateLocalTaskStackIfNeeded()
    await fetchTaskStackFromServer(false)
    await fetchProactiveNudges()
  }
  
  const evolutionSummary = computed(() => {
    const raw = evolutionRaw.value
    if (!raw) return null
    const evo = (raw.evolution as Record<string, unknown>) || {}
    const th = toolHealthLive.value as { summary?: string; agents?: Array<{ agent: string; status: string }> } | null
    const healthLine = th?.summary
      ? `工具健康：${th.summary}`
      : th?.agents?.length
        ? `工具健康：${th.agents.map((a) => `${a.agent}=${a.status}`).join('，')}`
        : ''
    const metricLine = [
      typeof evo.experienceCount === 'number' ? `经验 ${evo.experienceCount}` : '',
      evo.avgFinalConfidence != null ? `均分 ${evo.avgFinalConfidence}` : '',
      evo.firstPassSuccessRate != null ? `一次成功率 ${(Number(evo.firstPassSuccessRate) * 100).toFixed(0)}%` : ''
    ]
      .filter(Boolean)
      .join(' · ')
    const pr = evo.plannerRules as { activeCount?: number; shadowCount?: number } | undefined
    const pp = evo.promptPatches as { activeRouterLines?: number; shadowPlannerLines?: number } | undefined
    const evolveLine = [
      pr ? `规划规则 active=${pr.activeCount ?? 0} shadow=${pr.shadowCount ?? 0}` : '',
      pp ? `Prompt 补丁 active/shadow` : ''
    ]
      .filter(Boolean)
      .join(' · ')
    const canary = raw.policyCanary as { enabled?: boolean; percent?: number } | undefined
    const pc = evo.policyCanary as { sampleCount?: number; avgFinalConfidence?: number } | undefined
    const canaryLine = canary?.enabled
      ? `策略金丝雀 ${canary.percent}%（样本 ${pc?.sampleCount ?? 0}，均分 ${pc?.avgFinalConfidence ?? '—'}）`
      : ''
    const expDash = (evo.experiments as Record<string, unknown>) || {}
    const mem = (evo.layeredMemory as Record<string, unknown>) || {}
    const expAuto = Boolean(raw.evolutionAutoExperiment)
    const runningCount = Number(expDash.runningCount ?? 0)
    const hypothesisCount = Number(expDash.hypothesisCount ?? 0)
    const memoryLine =
      mem.enabled !== false
        ? `记忆 反思${mem.reflectionCount ?? 0} 语义${mem.semanticCount ?? 0} 工作${mem.workingSessions ?? 0}`
        : ''
    const experimentLine =
      hypothesisCount || runningCount
        ? `实验 ${runningCount} 进行中 / 假设 ${hypothesisCount}${expAuto ? ' · 自动晋级' : ''}`
        : ''
    const learn = (evo.unifiedLearning as Record<string, unknown>) || {}
    const pro = (evo.proactive as Record<string, unknown>) || {}
    const learningLine =
      learn.enabled !== false && typeof learn.avgComposite === 'number'
        ? `学习信号 均分${learn.avgComposite}（${learn.sampleCount ?? 0}条）`
        : learn.enabled !== false && Number(learn.sampleCount) > 0
          ? `学习信号 ${learn.sampleCount}条`
          : ''
    const sm = searchMetricsSummary.value
    const searchMetricsLine =
      sm && Number(sm.runsWithSearch) > 0 && typeof sm.hitRate === 'number'
        ? `联网命中 ${Math.round(sm.hitRate * 100)}%（${sm.runsWithSearch} 次）`
        : ''
    const searchMetricsTip =
      sm && Number(sm.runsWithSearch) > 0
        ? [
            typeof sm.zeroHitRate === 'number' ? `零命中 ${Math.round(sm.zeroHitRate * 100)}%` : '',
            typeof sm.avgHits === 'number' ? `平均 ${sm.avgHits} 条/次` : ''
          ]
            .filter(Boolean)
            .join(' · ')
        : ''
    const proactiveLine =
      pro.enabled !== false && Number(pro.pendingNudges) > 0
        ? `主动推进 ${pro.pendingNudges} 条待办提醒`
        : ''
    const ug = (evo.userGoals as Record<string, unknown>) || {}
    const userGoalsLine =
      ug.enabled !== false && Number(ug.activeCount) > 0
        ? `用户目标 ${ug.activeCount} 进行中`
        : ug.enabled !== false && Number(ug.totalCount) > 0
          ? `用户目标 ${ug.totalCount} 条`
          : ''
    const w = (learn.weights as Record<string, unknown>) || {}
    const weightsLine =
      learn.weightTuneEnabled !== false && w.tunedAt
        ? `权重已调 fb=${Math.round(Number(w.feedback ?? 0) * 100)}%`
        : learn.weightTuneEnabled !== false
          ? `学习权重 fb=${Math.round(Number(w.feedback ?? 0.2) * 100)}%`
          : ''
    const satisfactionLine =
      typeof learn.avgFeedback === 'number'
        ? `满意度 ${learn.avgFeedback}（覆盖 ${Math.round(Number(learn.feedbackCoverage ?? 0) * 100)}%）`
        : ''
    const rs = (evo.routeStrategy as Record<string, unknown>) || {}
    const routeStrategyLine = rs.enabled !== false ? '统一策略决策 已启用' : ''
    const aq = (evo.autonomousQueue as Record<string, unknown>) || {}
    const flags = (raw.evolutionFlags as Record<string, unknown>) || {}
    const autonomousLine =
      aq.enabled !== false && (Number(aq.pending) > 0 || Number(aq.running) > 0)
        ? `自治队列 待执行 ${aq.pending ?? 0}${
            Number(aq.planStepPending) > 0 ? `（多步 ${aq.planStepPending}）` : ''
          }`
        : aq.enabled !== false
          ? flags.autonomousReplan !== false
            ? `自治 replan 已启用${Number(aq.activePlans) > 0 ? ` · ${aq.activePlans} 计划` : ''}`
            : '自治队列 已启用'
          : ''
    const wm = worldModelSnapshot.value as {
      posture?: string
      risk?: number
      benefit?: number
      cost?: number
      notes?: string[]
      recommendedAgents?: string[]
    } | null
    const postureZh: Record<string, string> = {
      aggressive: '积极',
      balanced: '均衡',
      conservative: '保守',
      clarify_first: '先澄清'
    }
    const worldModelLine =
      wm && typeof wm.risk === 'number'
        ? `世界模型 ${postureZh[String(wm.posture || '')] || wm.posture} R${wm.risk.toFixed(2)}${
            wm.recommendedAgents?.length ? ` →${wm.recommendedAgents.slice(0, 3).join('/')}` : ''
          }`
        : flags.worldModel !== false
          ? '世界模型 已启用'
          : ''
    const banditLine = flags.routeBandit !== false ? '路由 Bandit 已启用' : ''
    const policyRlLine = flags.routePolicyRl !== false ? '策略梯度 RL 已启用' : ''
    const causalLine = flags.routeCausal !== false ? '路由因果图 已启用' : ''
    const finalizeExtractLine =
      flags.taskStackFinalizeLlmExtract !== false ? 'Finalize 自动入栈 已启用' : ''
    const worldModelTip = wm?.notes?.length ? wm.notes.join('；') : ''
    const writeGateLine = flags.adminWriteGate !== false ? '写操作闸门 已启用' : ''
    const llmHypoLine = flags.evolutionLlmHypothesis !== false ? 'LLM 进化假设 已启用' : ''
    if (
      !healthLine &&
      !metricLine &&
      !evolveLine &&
      !canaryLine &&
      !experimentLine &&
      !memoryLine &&
      !learningLine &&
      !searchMetricsLine &&
      !proactiveLine &&
      !userGoalsLine &&
      !weightsLine &&
      !satisfactionLine &&
      !routeStrategyLine &&
      !autonomousLine &&
      !worldModelLine &&
      !writeGateLine &&
      !llmHypoLine &&
      !banditLine &&
      !policyRlLine &&
      !causalLine &&
      !finalizeExtractLine
    )
      return null
    return {
      healthLine,
      metricLine,
      evolveLine,
      canaryLine,
      experimentLine,
      memoryLine,
      learningLine,
      searchMetricsLine,
      searchMetricsTip,
      proactiveLine,
      userGoalsLine,
      weightsLine,
      satisfactionLine,
      routeStrategyLine,
      autonomousLine,
      worldModelLine,
      worldModelTip,
      writeGateLine,
      llmHypoLine,
      banditLine,
      policyRlLine,
      causalLine,
      finalizeExtractLine
    }
  })
  
  async function loadEvolutionDashboard() {
    evolutionLoading.value = true
    ensureUserId()
    ensureSessionId()
    try {
      const [met, reg, exp, learn, goals, wmRes] = await Promise.all([
        $fetch<Record<string, unknown>>('/api/metrics').catch(() => null),
        $fetch<Record<string, unknown>>('/api/agents/registry').catch(() => null),
        $fetch<{ experiments?: Array<{ id: string; artifact: string; status: string; rationale: string; verdict?: { liftFinalConfidence: number; reason: string } }> }>(
          '/api/manager/evolution-experiments'
        ).catch(() => null),
        $fetch<{
          recent?: typeof learningRecent.value
          chartPoints?: typeof learningChartPoints.value
          searchMetrics?: typeof searchMetricsSummary.value
        }>(`/api/manager/learning-signals?sessionId=${encodeURIComponent(sessionId.value)}`).catch(() => null),
        $fetch<{ goals?: typeof userGoals.value }>(
          `/api/manager/user-goals?userId=${encodeURIComponent(userId.value)}&sessionId=${encodeURIComponent(sessionId.value)}`
        ).catch(() => null),
        $fetch<{ snapshot?: Record<string, unknown> | null }>(
          `/api/manager/world-model?sessionId=${encodeURIComponent(sessionId.value)}&userId=${encodeURIComponent(userId.value)}&refresh=1`
        ).catch(() => null)
      ])
      worldModelSnapshot.value = wmRes?.snapshot ?? null
      if (Array.isArray(learn?.recent)) learningRecent.value = learn.recent
      learningChartPoints.value = Array.isArray(learn?.chartPoints) ? learn.chartPoints : []
      searchMetricsSummary.value =
        learn?.searchMetrics && typeof learn.searchMetrics === 'object' ? learn.searchMetrics : null
      nextTick(() => renderLearningChart())
      if (Array.isArray(goals?.goals)) userGoals.value = goals.goals
      evolutionRaw.value = {
        evolution: met?.evolution ?? null,
        policyCanary: met?.policyCanary ?? null,
        promptCanary: met?.promptCanary ?? null,
        plannerRulesCanary: met?.plannerRulesCanary ?? null,
        evolutionAutoExperiment: met?.evolutionAutoExperiment ?? false,
        runs: met?.runs,
        registry: reg?.registry ?? null,
        evolutionFlags: reg?.evolution ?? null
      }
      toolHealthLive.value =
        (met?.toolHealth as Record<string, unknown>) ?? (reg?.toolHealth as Record<string, unknown>) ?? toolHealthLive.value
      const running = (exp?.experiments || []).filter((e) => e.status === 'running')
      evolutionExperiments.value = running.length ? running : (exp?.experiments || []).slice(0, 4)
      add('status', '已刷新进化看板', undefined, 0)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      add('error', `进化看板加载失败：${msg}`, undefined, 0)
    } finally {
      evolutionLoading.value = false
    }
  }
  
  function extractPatchBlocks(text: string) {
    const s = String(text ?? '')
    const blocks: string[] = []
    const begin = '*** Begin Patch'
    const end = '*** End Patch'
    let i = 0
    while (i < s.length) {
      const bi = s.indexOf(begin, i)
      if (bi < 0) break
      const ei = s.indexOf(end, bi)
      if (ei < 0) break
      blocks.push(s.slice(bi, ei + end.length).trim())
      i = ei + end.length
    }
    const diffRe = /```diff\s*([\s\S]*?)```/g
    let m: RegExpExecArray | null = null
    while ((m = diffRe.exec(s))) {
      const b = String(m[1] ?? '').trim()
      if (b) blocks.push(b)
    }
    return blocks
  }
  
  const BOGUS_FINAL_TEXT = /^(finalize|synth|critic|optimizer|verifier|monitor|planner|route|multi|clarify)$/i
  
  const turnGroups = computed<TurnGroup[]>(() => {
    const groups = new Map<number, TurnGroup>()
    for (const m of logs.value as any[]) {
      const turn = typeof m?.turn === 'number' ? m.turn : 0
      if (turn === 0) continue
      let g = groups.get(turn)
      if (!g) {
        g = { id: turn, results: [], errors: [], process: [], codePatches: [], searchSources: [], ragEvidence: [] }
        groups.set(turn, g)
      }
      const k = String(m.kind || '').toLowerCase()
      if (k === 'user') {
        g.user = m
        continue
      }
      if (k === 'final') {
        g.results.push(m)
        continue
      }
      if (k === 'assistant') {
        const t = String(m.text || '').trim()
        if (t.length >= 80) g.results.push(m)
        else g.process.push(m)
        continue
      }
      if (k === 'error') {
        if (String(m.text || '').trim()) g.errors.push(m)
        continue
      }
      if (k === 'search_sources' && Array.isArray(m.searchSources) && m.searchSources.length) {
        g.searchSources = mergeSearchSources(g.searchSources, m.searchSources)
        continue
      }
      if (k === 'agent_evidence' && Array.isArray(m.ragEvidence) && m.ragEvidence.length) {
        g.ragEvidence = mergeRagEvidence(g.ragEvidence, m.ragEvidence)
        continue
      }
      if (k === 'admin_ui_cards' && Array.isArray(m.adminUiCards) && m.adminUiCards.length) {
        g.adminUiCards = m.adminUiCards
        continue
      }
      if (k === 'presentation_plan' && m.presentationPlan && typeof m.presentationPlan === 'object') {
        g.presentationPlan = m.presentationPlan as TurnGroup['presentationPlan']
        if (g.userFacing) {
          g.userFacing = {
            ...g.userFacing,
            presentationPlan: g.presentationPlan
          }
        }
        continue
      }
      if (k === 'user_facing' && m.userFacing && typeof m.userFacing === 'object') {
        g.userFacing = m.userFacing as import('./managerChatTypes').UserFacingPayload
        if (g.presentationPlan && !g.userFacing.presentationPlan) {
          g.userFacing = { ...g.userFacing, presentationPlan: g.presentationPlan }
        }
        continue
      }
      if (k === 'memory_capture') {
        const payload =
          m.memoryCapture && typeof m.memoryCapture === 'object'
            ? m.memoryCapture
            : (() => {
                try {
                  return JSON.parse(String(m.text || ''))
                } catch {
                  return null
                }
              })()
        if (payload && typeof payload === 'object') {
          g.memoryCapture = {
            ...(payload as import('./managerChatTypes').MemoryCaptureProposal),
            uiStatus:
              (payload as import('./managerChatTypes').MemoryCaptureProposal).uiStatus || 'open',
          }
        }
        continue
      }
      if (isPlanStepsJsonLog(String(m.text || ''))) continue
      // 正文流只进回复气泡，不进过程时间线（避免「流式」扁卡片墙）
      if (k === 'delta') continue
      if (String(m.kind || '').toLowerCase() === 'thinking') {
        const txt = String(m.text || '').trim()
        if (txt.startsWith('记忆提案')) continue
        if (
          txt.startsWith('路由：multi（置信度') &&
          txt.includes('用户需要分别检索两源公开信息并生成对比报告')
        ) {
          continue
        }
      }
      g.process.push(m)
    }
    for (const g of groups.values()) {
      const codeText = g.process
        .filter((p) => String(p?.from || '').toLowerCase() === 'code')
        .map((p) => String(p?.text ?? ''))
        .join('\n')
      g.codePatches = extractPatchBlocks(codeText)
      if (!g.adminUiCards?.length) {
        const cards = extractAdminUiCardsFromTurn(g)
        if (cards.length) g.adminUiCards = cards
      }
    }
    const sorted = Array.from(groups.values()).sort((a, b) => a.id - b.id)
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!
      const cur = sorted[i]!
      if (
        prev.user &&
        !prev.results.length &&
        !prev.errors.length &&
        !cur.user &&
        !prev.user.attachmentPreview &&
        !prev.user.attachmentName &&
        (cur.results.length || cur.process.length || cur.errors.length)
      ) {
        // 保留 user/userMessageIndex 在原 turn，把误挂到下一 turn 的输出并回来（避免反馈索引错位）
        prev.results.push(...cur.results)
        prev.process.push(...cur.process)
        prev.errors.push(...cur.errors)
        if (cur.searchSources.length) {
          prev.searchSources = mergeSearchSources(prev.searchSources, cur.searchSources)
        }
        if (cur.ragEvidence.length) {
          prev.ragEvidence = mergeRagEvidence(prev.ragEvidence, cur.ragEvidence)
        }
        if (cur.adminUiCards) prev.adminUiCards = cur.adminUiCards
        if (cur.userFacing) prev.userFacing = cur.userFacing
        if (cur.presentationPlan) prev.presentationPlan = cur.presentationPlan
        cur.results = []
        cur.process = []
        cur.errors = []
        cur.searchSources = []
        cur.ragEvidence = []
      }
    }
    return sorted.filter((g) => g.user || g.results.length || g.errors.length || g.process.length)
  })
  
  const visibleTurnGroups = computed(() => turnGroups.value.filter((t) => !withdrawnTurns.value.has(t.id)))

  const artifactDrawerOpen = ref(false)
  const artifactDrawerTurnId = ref<number | null>(null)
  const artifactDrawerTab = ref<'chart' | 'table' | 'report'>('chart')
  const artifactDrawerDismissedTurns = new Set<number>()
  /** Canvas：本地编辑过的报告 Markdown（turnId → md） */
  const artifactReportEdits = ref<Record<number, string>>({})

  const artifactDrawerTurn = computed(
    () => visibleTurnGroups.value.find((t) => t.id === artifactDrawerTurnId.value) || null
  )

  const artifactDrawerReportDraft = computed(() => {
    const id = artifactDrawerTurnId.value
    if (id == null) return ''
    return String(artifactReportEdits.value[id] || '').trim()
  })

  function openReplyArtifactDrawer(turnId: number, tab?: 'chart' | 'table' | 'report') {
    const turn = visibleTurnGroups.value.find((t) => t.id === turnId)
    artifactDrawerTurnId.value = turnId
    artifactDrawerTab.value = tab || pickDefaultArtifactTab(turn)
    artifactDrawerOpen.value = true
  }

  function closeReplyArtifactDrawer() {
    artifactDrawerOpen.value = false
    if (artifactDrawerTurnId.value != null) {
      artifactDrawerDismissedTurns.add(artifactDrawerTurnId.value)
    }
  }

  function setArtifactDrawerTab(tab: 'chart' | 'table' | 'report') {
    artifactDrawerTab.value = tab
  }

  function applyArtifactReportEdit(payload: { turnId: number; markdown: string }) {
    const turnId = Number(payload.turnId)
    const md = String(payload.markdown || '').trim()
    if (!Number.isFinite(turnId) || !md) return
    artifactReportEdits.value = { ...artifactReportEdits.value, [turnId]: md }
    const editedAt = new Date().toISOString()
    const note = formatReportRevisionNote(editedAt)
    for (const m of logs.value as LogItem[]) {
      if (m.turn !== turnId) continue
      if (String(m.kind || '').toLowerCase() !== 'user_facing') continue
      if (!m.userFacing || typeof m.userFacing !== 'object') continue
      const prevSummary = String(m.userFacing.summary || '').trim()
      m.userFacing = {
        ...m.userFacing,
        appendix: md,
        reportEdited: true,
        reportEditedAt: editedAt,
        reportRevisionNote: note,
        // summary 本体保留；修订注经 reportRevisionNote 注入气泡，避免重复污染
        summary: prevSummary
      }
    }
    resultMarkdownHtmlCache.clear()
  }

  function echartsOptionToPngDataUrl(option: unknown): string | null {
    if (!option || typeof option !== 'object') return null
    try {
      const meta = buildChartPngExportMeta(option as object, { filenameHint: 'chart' })
      const canvas = document.createElement('canvas')
      canvas.width = meta.width
      canvas.height = meta.height
      renderEchartsToCanvas(canvas, option, meta.width, meta.height)
      drawChartExportWatermark(canvas, meta.subtitle)
      return canvas.toDataURL('image/png')
    } catch {
      return null
    }
  }

  async function exportArtifactBundle(turnId: number) {
    const turn = visibleTurnGroups.value.find((t) => t.id === turnId)
    if (!turn) return
    const resultText = String(turn.results?.[0]?.text || '')
    const reportMd =
      String(artifactReportEdits.value[turnId] || turn.userFacing?.appendix || '').trim() ||
      resolveReportBody(resultText, turn)
    const table = turn.userFacing?.table
    const csv = tableToCsv(table)
    const chartOpt =
      userFacingChartOption(turn) ||
      extractEchartsOption(resultText, buildTurnAgentResults(turn))
    const pngUrl = chartOpt ? echartsOptionToPngDataUrl(chartOpt) : null
    const pngBytes = pngUrl ? base64PngToBytes(pngUrl) : null

    const zipFiles: Array<{ name: string; data: Uint8Array }> = []
    if (reportMd.trim()) {
      zipFiles.push({ name: 'report.md', data: new TextEncoder().encode(reportMd) })
    }
    if (csv.trim()) {
      zipFiles.push({ name: 'table.csv', data: new TextEncoder().encode(csv) })
    }
    if (pngBytes?.length) {
      zipFiles.push({ name: 'chart.png', data: pngBytes })
    }
    const title =
      turn.userFacing?.headline ||
      turn.userFacing?.summary?.split('\n')[0]?.slice(0, 48) ||
      `turn_${turnId}`
    zipFiles.push({
      name: 'manifest.json',
      data: new TextEncoder().encode(
        buildArtifactExportManifest({
          turnId,
          title,
          hasReport: Boolean(reportMd.trim()),
          hasTable: Boolean(csv.trim()),
          hasChart: Boolean(pngBytes?.length),
          reportEdited: Boolean(turn.userFacing?.reportEdited)
        })
      )
    })
    if (zipFiles.length <= 1) return
    const zip = buildZipStore(zipFiles)
    const blob = new Blob([zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength)], {
      type: 'application/zip'
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `artifact_turn_${turnId}.zip`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  }

  function shouldShowArtifactLaunchBar(turn?: TurnGroup): boolean {
    return hasArtifactPanel(turn)
  }

  function turnReportEditedBadge(turn?: TurnGroup): boolean {
    return turnHasEditedReport(turn) || Boolean(turn?.id != null && artifactReportEdits.value[turn.id])
  }

  function streamingArtifactHintForTurn(turn?: TurnGroup): string {
    return streamingArtifactHint(turn)
  }

  function stripStreamingAuxForPlan(text: string, turn?: TurnGroup): string {
    const raw = String(text || '')
    if (!shouldStripAuxBlocksDuringStream(turn)) return raw
    try {
      const { narrative } = extractAuxBlocksStructural(raw)
      return String(narrative || raw).trim() || raw
    } catch {
      return raw
        .replace(/<!--\s*ECHARTS_OPTION\s*-->[\s\S]*?<!--\s*\/ECHARTS_OPTION\s*-->/gi, '')
        .replace(/<!--\s*TABLE_DATA\s*-->[\s\S]*?<!--\s*\/TABLE_DATA\s*-->/gi, '')
        .replace(/<!--\s*REPORT\s*-->[\s\S]*?<!--\s*\/REPORT\s*-->/gi, '')
        .trim()
    }
  }

  watch(
    visibleTurnGroups,
    (groups) => {
      const last = groups[groups.length - 1]
      if (!last || artifactDrawerDismissedTurns.has(last.id)) return
      if (last.userFacing?.replyTier !== 'report') return
      if (!hasArtifactPanel(last)) return
      if (artifactDrawerOpen.value && artifactDrawerTurnId.value === last.id) return
      artifactDrawerTurnId.value = last.id
      artifactDrawerTab.value = pickDefaultArtifactTab(last)
      artifactDrawerOpen.value = true
    },
    { deep: true }
  )

  function turnRunId(t: TurnGroup, r?: LogItem): string {
    if (r?.runId) return String(r.runId)
    if (t.user?.runId) return String(t.user.runId)
    for (const x of t.results) if (x.runId) return String(x.runId)
    for (const x of t.process) if (x.runId) return String(x.runId)
    for (const x of t.errors) if (x.runId) return String(x.runId)
    return ''
  }

  function isValidServerRunId(rid: string): boolean {
    return /^[A-Za-z0-9_-]{8,80}$/.test(String(rid || '').trim())
  }

  function isTurnRunning(t: TurnGroup): boolean {
    const rid = turnRunId(t)
    return !!rid && rid === currentRunId.value
  }

  /** 本轮是否仍在进行（含已发送但 runId 尚未绑到日志的窗口期） */
  function isTurnLive(t: TurnGroup): boolean {
    if (t.results.length) return false
    if (isTurnRunning(t)) return true
    if (cosmicRunPending.value && findLatestOpenUserTurn() === t.id) return true
    return false
  }
  
  function parseRoutePlanCardPayload(p: Record<string, unknown>): RoutePlanCardData {
    return {
      intent: String(p.intent || ''),
      agents: Array.isArray(p.agents) ? (p.agents as string[]).map(String) : [],
      capLabel: String(p.capLabel || ''),
      dataSources: Array.isArray(p.dataSources) ? (p.dataSources as string[]).map(String) : [],
      clauses: Array.isArray(p.clauses)
        ? (p.clauses as Array<Record<string, unknown>>).map((c) => ({
            id: String(c.id || ''),
            text: String(c.text || ''),
            agents: Array.isArray(c.agents) ? (c.agents as string[]).map(String) : []
          }))
        : [],
      blueprintSteps: Array.isArray(p.blueprintSteps)
        ? (p.blueprintSteps as Array<Record<string, unknown>>).map((s) => ({
            agent: String(s.agent || ''),
            agentLabel: String(s.agentLabel || ''),
            queryFocus: String(s.queryFocus || '')
          }))
        : [],
      blueprintDag: String(p.blueprintDag || ''),
      lintIssues: Array.isArray(p.lintIssues) ? (p.lintIssues as string[]).map(String) : [],
      lintSeverity: (p.lintSeverity as RoutePlanCardData['lintSeverity']) || 'ok',
      judgeRationale: p.judgeRationale ? String(p.judgeRationale) : undefined,
      orchestratorSource: p.orchestratorSource ? String(p.orchestratorSource) : undefined
    }
  }
  
  async function copyMessageText(text: string, ack?: { turnId?: number; replyKey?: string }) {
    const t = String(text || '').trim()
    if (!t) return
    try {
      await navigator.clipboard.writeText(t)
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = t
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      } catch {
        return
      }
    }
    if (copyAckTimer) clearTimeout(copyAckTimer)
    copyAckTurnId.value = ack?.turnId ?? null
    copyAckKey.value = ack?.replyKey ?? null
    copyAckTimer = setTimeout(() => {
      copyAckTurnId.value = null
      copyAckKey.value = null
      copyAckTimer = null
    }, 1600)
  }
  
  function truncateLogsFromTurn(turnId: number, opts?: { userText?: string }) {
    logs.value = logs.value.filter(
      (m) =>
        m.turn < turnId ||
        (m.turn === turnId && ['user'].includes(String(m.kind).toLowerCase()))
    )
    if (opts?.userText !== undefined) {
      const userLog = logs.value.find((m) => m.turn === turnId && String(m.kind).toLowerCase() === 'user')
      if (userLog) userLog.text = opts.userText
    }
    for (const [rid, t] of [...runIdToTurn.entries()]) {
      if (t > turnId) runIdToTurn.delete(rid)
    }
    expandedProcessKeys.value = new Set(
      [...expandedProcessKeys.value].filter((k) => {
        const n = Number(String(k).split('-')[0])
        return Number.isFinite(n) && n <= turnId
      })
    )
    const nextWithdrawn = new Set([...withdrawnTurns.value].filter((id) => id < turnId))
    withdrawnTurns.value = nextWithdrawn
    persistWithdrawnTurns()
    for (const rid of Object.keys(feedbackByRunId.value)) {
      const t = runIdToTurn.get(rid)
      if (t === undefined || t >= turnId) {
        const nextFb = { ...feedbackByRunId.value }
        delete nextFb[rid]
        feedbackByRunId.value = nextFb
        const nextAck = { ...feedbackAckByRunId.value }
        delete nextAck[rid]
        feedbackAckByRunId.value = nextAck
      }
    }
    clearFeedbackFromTurnId(turnId)
    persistSessionFeedback()
    turnSeq = Math.max(turnSeq, turnId)
    activeTurn = turnId
  }
  
  function prepareTurnRerun(turn: TurnGroup, opts?: { userText?: string }) {
    truncateLogsFromTurn(turn.id, opts)
    persistChatLogs()
    resetCollabStates('pending')
    resetStepProgress()
    runObservabilityLive.value = null
    conversationCompactLive.value = null
    taskConstraintsLive.value = null
    currentRunId.value = ''
    cosmicRunPending.value = true
    pendingTurns.push(turn.id)
  }
  
  function sendChatPayload(payload: Record<string, unknown>) {
    if (!ws || !connected.value) return
    ensureSessionId()
    payload.sessionId = sessionId.value
    payload.userId = ensureUserId()
    const clientCtx = buildClientContextPayload()
    if (clientCtx) payload.clientContext = clientCtx
    ws.send(JSON.stringify(withManagerWsAuth(payload)))
  }
  
  async function regenerateTurn(turn: TurnGroup) {
    if (!ws || !connected.value || currentRunId.value) return
    if (editingTurnId.value === turn.id && editDraft.value.trim()) {
      submitEditResend(turn)
      return
    }
    const uidx = turn.user?.userMessageIndex
    const text = userBubbleText(turn.user)
    if (typeof uidx !== 'number' && !text) {
      await showAlert('无法定位该轮用户消息，请重新发送新问题。')
      return
    }
    if (isTurnRunning(turn)) {
      await showAlert('该轮对话正在执行中，请先取消任务。')
      return
    }
    cancelEditTurn()
    if (typeof uidx === 'number') {
      clearFeedbackForUserIndex(uidx)
      void syncSessionFeedbackDelete({ fromUserIndex: uidx, atUserIndexOnly: true })
    }
    prepareTurnRerun(turn)
    sendChatPayload({
      type: 'chat',
      text,
      mode: 'regenerate',
      ...(typeof uidx === 'number' ? { userMessageIndex: uidx } : {})
    })
  }
  
  async function startEditTurn(turn: TurnGroup) {
    if (!turn.user || currentRunId.value) return
    if (isTurnRunning(turn)) {
      await showAlert('该轮对话正在执行中，请先取消任务。')
      return
    }
    editingTurnId.value = turn.id
    editDraft.value = userBubbleText(turn.user)
  }
  
  function cancelEditTurn() {
    editingTurnId.value = null
    editDraft.value = ''
  }
  
  function resetChatUiState() {
    logs.value = []
    expandedProcessKeys.value = new Set()
    thoughtPanelCollapsed.value = new Set()
    currentPhase.value = ''
    clearActiveRun()
    resetCollabStates('idle')
    resetStepProgress()
    currentAssistant = ''
    activeTurn = 0
    turnSeq = 0
    pendingTurns.length = 0
    runIdToTurn.clear()
    withdrawnTurns.value = new Set()
    resetLocalFeedbackState()
    userMessageIndexCounter = 0
    cancelEditTurn()
    cancelAfterRunId.value = false
    runObservabilityLive.value = null
    conversationCompactLive.value = null
    taskConstraintsLive.value = null
    proactiveNudges.value = []
    pendingHumanConfirm.value = null
    activeTraceId.value = ''
  }
  
  async function reconnectWs() {
    const wasConnected = connected.value
    if (ws && wasConnected) {
      wsManualClose = true
      const old = ws
      ws = null
      connected.value = false
      try {
        old.close()
      } catch {}
    }
    await nextTick()
    if (wasConnected) {
      setTimeout(() => connect(), 0)
    } else {
      connect()
    }
  }
  
  async function submitEditResend(turn: TurnGroup) {
    const text = editDraft.value.trim()
    if (!ws || !connected.value || !text || currentRunId.value) return
    const uidx = turn.user?.userMessageIndex
    const anchorText = userBubbleText(turn.user)
    if (typeof uidx !== 'number' && !anchorText) {
      await showAlert('无法定位该轮用户消息，请重新发送新问题。')
      return
    }
    if (isTurnRunning(turn)) {
      await showAlert('该轮对话正在执行中，请先取消任务。')
      return
    }
    cancelEditTurn()
    prepareTurnRerun(turn, { userText: text })
    sendChatPayload({
      type: 'chat',
      text,
      mode: 'edit_resend',
      ...(typeof uidx === 'number' ? { userMessageIndex: uidx } : {}),
      ...(anchorText ? { anchorText } : {})
    })
  }
  
  const expandedProcessKeys = ref<Set<string>>(new Set())
  /** 开发视图：用户手动折叠的思考面板（默认展开） */
  const thoughtPanelCollapsed = ref<Set<number>>(new Set())
  /** 用户视图：手动展开的思考面板（默认收起，Cursor 式） */
  const thoughtPanelUserExpanded = ref<Set<number>>(new Set())
  
  function thoughtPanelOpen(t: TurnGroup): boolean {
    if (!hasThoughtContent(t)) return false
    if (collaborationPosture.value === 'debug') return true
    if (thoughtViewMode.value === 'user') {
      // 运行中默认展开流式思考；结束后收起，用户可手动点开
      if (isTurnRunning(t)) return true
      return thoughtPanelUserExpanded.value.has(t.id)
    }
    return !thoughtPanelCollapsed.value.has(t.id)
  }
  
  function onThoughtPanelToggle(t: TurnGroup, e: Event) {
    const open = Boolean((e.target as HTMLDetailsElement)?.open)
    if (thoughtViewMode.value === 'user') {
      const next = new Set(thoughtPanelUserExpanded.value)
      if (open) next.add(t.id)
      else next.delete(t.id)
      thoughtPanelUserExpanded.value = next
      return
    }
    const next = new Set(thoughtPanelCollapsed.value)
    if (open) next.delete(t.id)
    else next.add(t.id)
    thoughtPanelCollapsed.value = next
  }
  
  type UserThoughtLine = { text: string; done?: boolean; active?: boolean; failed?: boolean }
  
  function isDevProcessKind(kind: string): boolean {
    const k = String(kind || '').toLowerCase()
    return ['route_cap', 'route_plan_card', 'plan_outline', 'delta', 'gui_screenshot', 'gui_live_view', 'db_explain', 'search_sources', 'run_report'].includes(k)
  }
  
  function isUserVisibleProcessKind(kind: string): boolean {
    const k = String(kind || '').toLowerCase()
    return k === 'thinking' || k === 'thought_delta' || k === 'phase' || k === 'status'
  }
  
  function isUserThoughtBoilerplate(text: string): boolean {
    const s = String(text || '').trim()
    if (!s) return true
    if (s.startsWith('路由：') && s.includes('（置信度')) return true
    if (s.startsWith('路由：multi（置信度')) return true
    if (s.startsWith('{') && (s.includes('"event"') || s.includes('"type"'))) return true
    if (isPlanStepsJsonLog(s)) return true
    if (s.includes('工具健康')) return true
    if (/^▸\s*(manager|db|rag|crawler|code)\s*·/.test(s)) return true
    if (/治理建议|allowedAgents|blueprintDag|prioritize_|bandit|canary|HITL|error_code|agent_result|ops_token|trace_id/i.test(s)) {
      return true
    }
    if (/status=\s*(start|end|running|queued)/i.test(s)) return true
    return false
  }

  /** 内部过程日志 → 用户可读一句；无法翻译则丢弃 */
  function toUserFacingThoughtLine(text: string): string {
    let s = String(text || '').trim().replace(/^▸\s*/, '')
    if (!s || isUserThoughtBoilerplate(s)) return ''

    if (/^Synth[：:]/i.test(s) || /对话式解读|整理回答|standard\s*档/i.test(s)) return '正在整理回答…'
    if (/^预取[：:]/i.test(s) || /prefetch/i.test(s)) {
      if (/DB|数据库|\bdb\b/i.test(s)) return '正在准备数据库查询…'
      if (/RAG|知识/i.test(s)) return '正在准备知识库检索…'
      return '正在准备相关资料…'
    }
    if (/侦察完成|库表\/知识库\/服务可用性/i.test(s)) return '已了解可用资料…'
    if (/写库预览|须.*确认后执行|写操作.*确认/i.test(s)) return '涉及写入，需你确认后才会执行'
    if (/正在理解你的问题|选择能力/i.test(s)) return '正在理解你的问题…'
    if (/专才执行中/i.test(s)) return '正在处理中…'

    const agentStep = s.match(
      /^(?:数据库|RAG|网页爬虫|代码助手|个人助手|GUI|音乐|视频|多模态)\s*Agent[：:]\s*(.+)$/i
    )
    if (agentStep) {
      const rest = String(agentStep[1] || '').trim()
      const step = rest.toLowerCase()
      if (step === 'understand' || /理解/.test(rest)) return '正在理解查询需求…'
      if (step === 'sql' || /生成.*sql|写.*sql/i.test(rest)) return '正在生成查询…'
      if (step === 'guard' || /安全|预检|guard/i.test(rest)) return '正在做安全检查…'
      if (step === 'execute' || /执行|查询中|调用中/i.test(rest)) return '正在查询数据…'
      if (/http|websocket|ws\b|备用地址|服务尚未就绪/i.test(rest)) return '正在连接服务…'
      if (/检索/i.test(rest)) return '正在检索资料…'
      if (/失败|错误|error/i.test(rest)) return '处理时遇到问题，正在重试或换路…'
      if (rest.length <= 24 && /^[a-z0-9_\-.=]+$/i.test(rest)) return '正在处理中…'
      if (rest.length > 120) return `${rest.slice(0, 100)}…`
      return rest
    }

    if (/^RAG\s*(Agent|思考)[：:]/i.test(s)) return '正在检索知识库…'
    if (/WebSocket|HTTP\s*调用|dev\s*服务/i.test(s)) return '正在连接服务…'
    if (/\b(understand|sql|guard|execute|prefetch|orchestrate|multi)\b/i.test(s) && s.length < 96) {
      return ''
    }
    if (/^[a-z][a-z0-9_\-]*(?:\s*[→>\-]+\s*[a-z][a-z0-9_\-]*)+$/i.test(s)) return ''
    if (/^[\w.\-]+\s*(WS|HTTP)\b/i.test(s)) return ''

    s = s
      .replace(/\bHITL\b/gi, '人工确认')
      .replace(/\ballowedAgents\b/gi, '能力')
      .replace(/\bDB\s*plan\b/gi, '数据库查询')
      .replace(/\bRAG\b/g, '知识库')
      .replace(/\bSynth\b/gi, '回答整理')
    if (s.length > 180) s = `${s.slice(0, 180)}…`
    return s
  }
  
  function sanitizeUserThoughtRaw(text: string): string {
    let s = String(text || '').trim()
    if (!s || isUserThoughtBoilerplate(s)) return ''
    if (s.includes('<!--CRAWLER_TABLE-->') || s.includes('### 网页抓取列表')) return '正在搜索网页资料…'
    return toUserFacingThoughtLine(s)
  }
  
  function formatUserThoughtText(text: string, kind: string): string {
    const k = String(kind || '').toLowerCase()
    if (k === 'phase') {
      return userPhaseLabel(String(text || '').trim())
    }
    const raw = sanitizeUserThoughtRaw(text)
    if (!raw) return ''
    if (k === 'thinking' || k === 'thought_delta' || k === 'status') {
      return raw.length > 220 ? `${raw.slice(0, 220)}…` : raw
    }
    return raw
  }

  /** 用户面执行计划：中文专才名，不展示 raw agent key / DAG */
  function userCreatedPlanLabels(t: TurnGroup): string[] {
    const card = turnRoutePlanCard(t)
    const raw = card?.dataSources?.length
      ? card.dataSources
      : turnRouteCap(t)?.agents || []
    const out: string[] = []
    const seen = new Set<string>()
    for (const a of raw) {
      const label = planAgentLabel(String(a || ''))
      if (!label || seen.has(label)) continue
      seen.add(label)
      out.push(label)
    }
    return out
  }
  
  function userThoughtNarrative(t: TurnGroup): UserThoughtLine[] {
    const lines: UserThoughtLine[] = []
    const seen = new Set<string>()
    let streamBuf = ''

    const pushLine = (text: string, opts: Partial<UserThoughtLine> = {}) => {
      const line = text.trim()
      if (!line || seen.has(line)) return
      seen.add(line)
      lines.push({ text: line, done: true, active: false, failed: false, ...opts })
    }

    const flushStream = (active = false) => {
      const formatted = formatUserThoughtText(streamBuf, 'thought_delta')
      if (formatted) {
        pushLine(formatted, { done: !active, active })
      }
      streamBuf = ''
    }

    for (const p of t.process) {
      const k = String(p.kind || '').toLowerCase()
      if (isDevProcessKind(k)) continue

      if (k === 'thought_delta') {
        streamBuf += String(p.text || '')
        continue
      }

      flushStream(false)

      if (k === 'trace') {
        try {
          const o = JSON.parse(String(p.text || '')) as Record<string, unknown>
          const type = String(o.type || '')
          if (type === 'step_start') {
            pushLine(`正在${planAgentLabel(String(o.agent || ''))}…`, { done: false })
          } else if (type === 'step_end') {
            const summary = String(o.outputSummary || '').trim()
            if (summary && !isUserThoughtBoilerplate(summary)) {
              pushLine(previewText(summary, 160))
            } else if (String(o.status) === 'success') {
              pushLine(`${planAgentLabel(String(o.agent || ''))}已完成`)
            }
          }
        } catch {
          /* skip non-json trace */
        }
        continue
      }
      if (!isUserVisibleProcessKind(k)) continue
      const text = formatUserThoughtText(String(p.text || ''), k)
      if (text) pushLine(text, { done: !isTurnRunning(t) || k !== 'phase' })
    }

    flushStream(isTurnRunning(t))

    if (t.ragEvidence.length) pushLine(`查阅了 ${t.ragEvidence.length} 条知识库资料`)

    if (isTurnRunning(t) && lines.length) {
      const last = lines[lines.length - 1]!
      last.active = true
      last.done = false
    }

    return lines
  }

  /** DeepSeek harness：用户面思考为连续灰字流，不拆成状态行列表 */
  function userThoughtStreamText(t: TurnGroup): string {
    const parts: string[] = []
    let deltaBuf = ''
    const flushDelta = () => {
      const cleaned = sanitizeUserThoughtRaw(deltaBuf.replace(/^▸\s*/, ''))
      if (cleaned.trim()) parts.push(cleaned.trim())
      deltaBuf = ''
    }
    for (const p of t.process) {
      const k = String(p.kind || '').toLowerCase()
      if (isDevProcessKind(k)) continue
      if (k === 'thought_delta') {
        deltaBuf += String(p.text || '')
        continue
      }
      flushDelta()
      if (k === 'trace') {
        try {
          const o = JSON.parse(String(p.text || '')) as Record<string, unknown>
          const type = String(o.type || '')
          if (type === 'step_start') {
            parts.push(`正在${planAgentLabel(String(o.agent || ''))}…`)
          } else if (type === 'step_end') {
            const summary = String(o.outputSummary || '').trim()
            if (summary && !isUserThoughtBoilerplate(summary)) {
              parts.push(previewText(summary, 200))
            } else if (String(o.status) === 'success') {
              parts.push(`${planAgentLabel(String(o.agent || ''))}已完成`)
            }
          }
        } catch {
          /* skip */
        }
        continue
      }
      if (!isUserVisibleProcessKind(k)) continue
      const text = formatUserThoughtText(String(p.text || ''), k)
      if (text) parts.push(text)
    }
    flushDelta()
    if (t.ragEvidence.length) parts.push(`查阅了 ${t.ragEvidence.length} 条知识库资料`)
    return parts.join('\n\n').trim()
  }

  /** Cursor 风：按阶段折叠 Thought（编排 / 看图 / 规划 / 执行） */
  function turnThoughtStages(t: TurnGroup): Array<{ label: string; text: string; secs?: number }> {
    type StageKey = 'orchestrate' | 'caption' | 'plan' | 'exec' | 'other'
    const buckets: Record<StageKey, string[]> = {
      orchestrate: [],
      caption: [],
      plan: [],
      exec: [],
      other: []
    }
    const classify = (raw: string): StageKey => {
      const s = String(raw || '')
      if (/看图摘要|画面摘要|轻量 VL|附件预读/.test(s)) return 'caption'
      if (/编排|路由结论|续轮复用|姿态/.test(s)) return 'orchestrate'
      if (/计划|蓝图|Plan Mode|局部修订|plan_preview|Created Plan/.test(s)) return 'plan'
      if (/正在|已完成|专才|执行|多模态|查库|知识库|Building/.test(s)) return 'exec'
      return 'other'
    }
    let deltaBuf = ''
    const flushDelta = () => {
      const cleaned = sanitizeUserThoughtRaw(deltaBuf.replace(/^▸\s*/, '')).trim()
      if (cleaned) buckets[classify(cleaned)].push(cleaned)
      deltaBuf = ''
    }
    for (const p of t.process) {
      const k = String(p.kind || '').toLowerCase()
      if (isDevProcessKind(k)) continue
      if (k === 'thought_delta') {
        deltaBuf += String(p.text || '')
        continue
      }
      flushDelta()
      if (k === 'phase') {
        const ph = String(p.text || '').toLowerCase()
        if (ph.includes('orchestrate')) buckets.orchestrate.push('编排决策中…')
        else if (ph.includes('plan')) buckets.plan.push('规划步骤中…')
        else if (ph.includes('execute') || ph.includes('multi')) buckets.exec.push('专才执行中…')
        continue
      }
      if (k === 'trace') {
        try {
          const o = JSON.parse(String(p.text || '')) as Record<string, unknown>
          if (String(o.type || '') === 'step_start') {
            buckets.exec.push(`正在${planAgentLabel(String(o.agent || ''))}…`)
          } else if (String(o.type || '') === 'step_end') {
            buckets.exec.push(`${planAgentLabel(String(o.agent || ''))}已完成`)
          }
        } catch {
          /* skip */
        }
        continue
      }
      if (!isUserVisibleProcessKind(k)) continue
      const text = formatUserThoughtText(String(p.text || ''), k)
      if (text) buckets[classify(text)].push(text)
    }
    flushDelta()
    const labels: Record<StageKey, string> = {
      orchestrate: '理解问题',
      caption: '看图',
      plan: '制定计划',
      exec: '处理中',
      other: '思考'
    }
    const order: StageKey[] = ['orchestrate', 'caption', 'plan', 'exec', 'other']
    const startedTs =
      Date.parse(String(t.user?.ts || t.process[0]?.ts || '')) || 0
    const elapsed =
      startedTs > 0 ? Math.max(1, Math.round((Date.now() - startedTs) / 1000)) : undefined
    const out: Array<{ label: string; text: string; secs?: number }> = []
    for (const key of order) {
      const lines = buckets[key].filter(Boolean)
      if (!lines.length) continue
      const uniq: string[] = []
      for (const line of lines) {
        if (!uniq.includes(line)) uniq.push(line)
      }
      out.push({
        label: labels[key],
        text: uniq.slice(-6).join('\n'),
        secs: out.length === 0 ? elapsed : undefined
      })
    }
    return out
  }

  function userThoughtPreviewText(t: TurnGroup): string {
    const stream = userThoughtStreamText(t)
    if (stream) return stream.replace(/\s+/g, ' ').slice(0, 120)
    const lines = userThoughtNarrative(t)
    const active = lines.find((l) => l.active) || lines[lines.length - 1]
    return active?.text?.slice(0, 120) || ''
  }
  
  function thoughtPanelLabel(): string {
    return '思考过程'
  }
  
  function thoughtPanelPreview(t: TurnGroup): string {
    return thoughtViewMode.value === 'user' ? userThoughtPreviewText(t) : thoughtPreviewText(t)
  }
  
  function thoughtPreviewText(t: TurnGroup): string {
    const cap = turnRouteCap(t)
    const plan = turnPlanOutline(t)
    if (cap?.agents?.length) {
      const agents = cap.agents.map((a) => planAgentLabel(a)).join(' → ')
      const planHint = plan?.steps?.length ? ` · ${plan.steps.length} 步` : ''
      return `路由：${agents}${planHint}`.slice(0, 140)
    }
    const prefer = t.process.filter((p) => {
      const k = String(p.kind || '').toLowerCase()
      if (k === 'route_cap' || k === 'route_plan_card' || k === 'plan_outline') return true
      return k === 'thinking' || k === 'phase' || k === 'trace'
    })
    const skipBoilerplate = (text: string) => {
      const s = String(text || '').trim()
      if (!s) return true
      if (s.startsWith('路由：multi（置信度') && s.includes('用户需要分别检索两源公开信息')) return true
      if (s.startsWith('路由：') && s.includes('（置信度:') && !s.startsWith('编排 ·')) return true
      return false
    }
    const last =
      [...prefer].reverse().find((p) => !skipBoilerplate(String(p.text || ''))) ||
      prefer[prefer.length - 1] ||
      t.process[t.process.length - 1]
    if (!last) return ''
    const line = formatProcessText(String(last.text || ''), String(last.kind || '')).split('\n')[0] || ''
    return line.slice(0, 140)
  }
  
  function phaseLabel(p: LogItem): string {
    const k = String(p.kind || '').toLowerCase()
    if (k !== 'phase') return ''
    const raw = String(p.text || '').trim()
    if (!raw) return ''
    return userPhaseLabel(raw.startsWith('execute:') ? raw.slice('execute:'.length) : raw)
  }
  
  function processStepKey(t: TurnGroup, idx: number) {
    return `${t.id}-${idx}`
  }
  
  function isPlanStepsJsonLog(text: string): boolean {
    const raw = String(text || '').trim()
    if (!raw.startsWith('{')) return false
    try {
      const o = JSON.parse(raw) as Record<string, unknown>
      const ev = String(o.event || '').toLowerCase()
      if (ev === 'plan_steps' || ev === 'plan_preview') return true
      const data = o.data
      if (data && typeof data === 'object' && Array.isArray((data as { steps?: unknown[] }).steps)) {
        const hint = String((data as { hint?: string }).hint || '')
        if (hint.includes('确认后将按顺序执行') || ev === 'plan_steps' || ev === 'plan_preview') return true
      }
    } catch {
      /* ignore */
    }
    return false
  }
  
  function isProcessStepClampable(text: string, kind: string) {
    const raw = String(text || '').trim()
    if (!raw) return false
    const k = String(kind || '').toLowerCase()
    if (k === 'trace') {
      try {
        const o = JSON.parse(raw) as Record<string, unknown>
        if (String(o.type || '') === 'step_end') {
          const summary = String(o.outputSummary || '').trim()
          return summary.length > 220
        }
      } catch {
        /* fall through */
      }
    }
    return raw.length > 320 || raw.split(/\r?\n/).length > 6
  }
  
  function toggleProcessStep(t: TurnGroup, idx: number) {
    const k = processStepKey(t, idx)
    const next = new Set(expandedProcessKeys.value)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    expandedProcessKeys.value = next
  }
  
  function formatProcessText(text: string, kind: string) {
    let raw = String(text || '').trim()
    if (!raw) return '（无内容）'
    const k = String(kind || '').toLowerCase()
    if (k === 'phase') {
      const phase = raw.startsWith('execute:') ? raw.slice('execute:'.length) : raw
      return userPhaseLabel(phase)
    }
    if (k === 'thinking' && (raw.includes('<!--CRAWLER_TABLE-->') || raw.includes('### 网页抓取列表'))) {
      const rows = raw.match(/\|\s*\d+\s*\|/g)?.length ?? 0
      return rows > 0
        ? `网页抓取完成（${rows} 条，完整列表见回复下方「来源」）`
        : '网页抓取完成（详情见回复下方「来源」）'
    }
    if (k === 'trace') {
      try {
        const o = JSON.parse(raw) as Record<string, unknown>
        const type = String(o.type || '')
        if (type === 'step_end') {
          const agent = String(o.agent || '—')
          const status = String(o.status || '—')
          const ms = o.ms != null ? `${o.ms}ms` : ''
          const summary = String(o.outputSummary || '').trim()
          return [`▸ ${agent} · ${status}${ms ? ` · ${ms}` : ''}`, summary ? summary : ''].filter(Boolean).join('\n')
        }
        if (type === 'step_start') {
          return `▸ 启动 ${String(o.agent || '—')}`
        }
        if (type === 'vote') {
          return `▸ 投票 ${String(o.selected || '')} · ${String(o.winnerReason || '')}`
        }
      } catch {
        /* 非 JSON 保持原文 */
      }
    }
    return raw
  }
  
  function kindLabel(kind: string) {
    const k = String(kind || '').toLowerCase()
    if (k === 'user') return '你'
    if (k === 'assistant') return '助手'
    if (k === 'final') return '最终'
    if (k === 'thinking') return '思考'
    if (k === 'thought_delta') return '进展'
    if (k === 'run_report') return '执行摘要'
    if (k === 'route_cap') return '路由'
    if (k === 'route_plan_card') return '编排'
    if (k === 'plan_outline') return '计划'
    if (k === 'phase') return '阶段'
    if (k === 'status') return '状态'
    if (k === 'delta') return '流式'
    if (k === 'trace') return '追踪'
    if (k === 'search_sources') return '联网来源'
    if (k === 'gui_screenshot') return 'GUI 截图'
    if (k === 'gui_live_view') return '浏览器画面'
    if (k === 'db_explain') return 'SQL 预检'
    if (k === 'error') return '错误'
    return k || 'event'
  }

  /** 本轮最新 GUI 截图 / noVNC（用户态与开发态共用） */
  function turnGuiVisuals(t: TurnGroup): { shot?: string; vncUrl?: string } {
    let shot = ''
    let vncUrl = ''
    for (const p of t.process) {
      const k = String(p.kind || '').toLowerCase()
      if (k === 'gui_screenshot' && p.guiScreenshot) shot = String(p.guiScreenshot)
      if (k === 'gui_live_view' && p.guiVncUrl) vncUrl = String(p.guiVncUrl)
    }
    return {
      ...(shot ? { shot } : {}),
      ...(vncUrl ? { vncUrl } : {}),
    }
  }
  
  function kindClass(kind: string) {
    const k = String(kind || '').toLowerCase()
    return k ? `kind-${k}` : 'kind-event'
  }
  
  function formatLogText(kind: string, text: string) {
    const k = String(kind || '').toLowerCase()
    let raw = String(text ?? '')
    if (k === 'thinking' && (raw.includes('<!--CRAWLER_TABLE-->') || raw.includes('### 网页抓取列表'))) {
      const rows = raw.match(/\|\s*\d+\s*\|/g)?.length ?? 0
      raw = rows > 0
        ? `网页抓取完成（${rows} 条，完整列表见回复下方「来源」）`
        : '网页抓取完成（详情见回复下方「来源」）'
    }
    if (k === 'run_report') {
      try {
        const o = JSON.parse(raw.trim()) as {
          outcome?: string
          goal?: string
          verifierVerdict?: string
          conflictNote?: string
          steps?: Array<{ agent?: string; status?: string }>
          failures?: string[]
        }
        if (o && typeof o === 'object') {
          const outcomeLabel =
            o.outcome === 'completed' ? '完成' : o.outcome === 'failed' ? '失败' : o.outcome === 'needs_human' ? '需人工' : String(o.outcome || '')
          const failN = Array.isArray(o.failures) ? o.failures.length : 0
          const stepN = Array.isArray(o.steps) ? o.steps.length : 0
          const bits = [
            outcomeLabel ? `结果 ${outcomeLabel}` : '',
            o.verifierVerdict ? `判定 ${o.verifierVerdict}` : '',
            stepN ? `${stepN} 步` : '',
            failN ? `${failN} 失败` : '',
            o.conflictNote ? `⚠ ${o.conflictNote}` : ''
          ].filter(Boolean)
          return bits.join(' · ') || raw
        }
      } catch {
        /* keep raw */
      }
    }
    if (k === 'event' || k === 'trace' || k === 'status') {
      const t = raw.trim()
      if (t.startsWith('{') || t.startsWith('[')) {
        // 用户过程区：一行摘要，禁止 pretty-print 占屏
        if (thoughtViewMode.value === 'user') {
          try {
            const o = JSON.parse(t) as Record<string, unknown>
            const ev = String(o.event || o.type || o.status || '').trim()
            return ev ? `系统事件：${ev}` : '系统事件'
          } catch {
            return '系统事件'
          }
        }
        try {
          return JSON.stringify(JSON.parse(t), null, 2)
        } catch {}
      }
    }
    return raw
  }
  
  function findLatestOpenUserTurn(): number | null {
    const seen = new Set<number>()
    for (let i = logs.value.length - 1; i >= 0; i--) {
      const m = logs.value[i]!
      if (String(m.kind).toLowerCase() !== 'user') continue
      const turn = typeof m.turn === 'number' ? m.turn : 0
      if (!turn || seen.has(turn)) continue
      seen.add(turn)
      const hasReply = logs.value.some((x) => {
        if (x.turn !== turn) return false
        const k = String(x.kind).toLowerCase()
        return k === 'final' || (k === 'assistant' && String(x.text || '').trim().length >= 80)
      })
      if (!hasReply) return turn
    }
    return null
  }
  
  function resolveIncomingRunTurn(runId: string): number {
    const mapped = runIdToTurn.get(runId)
    if (mapped) return mapped

    if (pendingTurns.length) {
      const turn = pendingTurns.shift() as number
      runIdToTurn.set(runId, turn)
      return turn
    }

    // 新提问已占用 activeTurn 时，禁止把 runId 绑到更早的「未完成」轮次
    if (activeTurn > 0) {
      const hasUserOnActive = logs.value.some(
        (m) => m.turn === activeTurn && String(m.kind).toLowerCase() === 'user'
      )
      if (hasUserOnActive) {
        runIdToTurn.set(runId, activeTurn)
        return activeTurn
      }
    }

    const openUserTurn = findLatestOpenUserTurn()
    if (openUserTurn && (!activeTurn || openUserTurn >= activeTurn)) {
      runIdToTurn.set(runId, openUserTurn)
      return openUserTurn
    }

    if (activeTurn > 0) {
      runIdToTurn.set(runId, activeTurn)
      return activeTurn
    }

    turnSeq += 1
    activeTurn = turnSeq
    runIdToTurn.set(runId, turnSeq)
    return turnSeq
  }
  
  function attachRunToTurnLogs(turn: number, runId: string) {
    if (!turn || !runId) return
    for (const m of logs.value as LogItem[]) {
      if (m.turn !== turn) continue
      if (String(m.kind).toLowerCase() === 'user' && !m.runId) m.runId = runId
      if ((typeof m.turn !== 'number' || m.turn === 0) && String(m.runId || '') === runId) m.turn = turn
    }
  }
  
  function findColumnScrollable(el: HTMLElement | null, boundary: HTMLElement): HTMLElement | null {
    let node: HTMLElement | null = el
    while (node && node !== boundary) {
      const style = window.getComputedStyle(node)
      const oy = style.overflowY
      if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
        return node
      }
      node = node.parentElement
    }
    return null
  }
  
  function columnScrollCanMove(el: HTMLElement, deltaY: number): boolean {
    if (deltaY < 0) return el.scrollTop > 0
    return el.scrollTop + el.clientHeight < el.scrollHeight - 1
  }
  
  function applyChatLogScroll(deltaY: number) {
    const log = logEl.value
    if (!log || log.scrollHeight <= log.clientHeight + 1) return
    const maxTop = log.scrollHeight - log.clientHeight
    log.scrollTop = Math.max(0, Math.min(maxTop, log.scrollTop + deltaY))
  }
  
  function shouldKeepNativeWheelScroll(target: HTMLElement, host: HTMLElement, deltaY: number): boolean {
    const inner = findColumnScrollable(target, host)
    if (!inner) return false
    return columnScrollCanMove(inner, deltaY)
  }
  
  function onChatScrollHostWheel(e: WheelEvent) {
    const host = chatScrollHostEl.value
    const log = logEl.value
    if (!host || !log || log.scrollHeight <= log.clientHeight + 1) return
  
    const target = e.target instanceof HTMLElement ? e.target : null
    if (!target || !host.contains(target)) return
  
    if (shouldKeepNativeWheelScroll(target, host, e.deltaY)) return
  
    e.preventDefault()
    applyChatLogScroll(e.deltaY)
  }
  
  function bindChatColumnWheel() {
    chatColumnWheelCleanup?.()
    chatColumnWheelCleanup = null
    const host = chatScrollHostEl.value
    if (!host) return
    const handler = (e: WheelEvent) => onChatScrollHostWheel(e)
    host.addEventListener('wheel', handler, { passive: false })
    chatColumnWheelCleanup = () => host.removeEventListener('wheel', handler)
  }
  
  function add(
    kind: string,
    text: string,
    from?: string,
    turn = activeTurn,
    runId?: string,
    extra?: Pick<
      LogItem,
      | 'userMessageIndex'
      | 'attachmentPreview'
      | 'attachmentName'
      | 'attachmentMediaType'
      | 'searchSources'
      | 'ragEvidence'
      | 'guiScreenshot'
      | 'guiVncUrl'
      | 'adminUiCards'
      | 'routeCap'
      | 'routePlanCard'
      | 'planOutline'
      | 'collaborationPosture'
      | 'suggestedPosture'
      | 'postureBlocked'
      | 'postureReadOnly'
      | 'memoryCapture'
    >
  ) {
    const k = String(kind || '').toLowerCase()
    const formatted = formatLogText(k, text)
    if (k === 'error' && !String(formatted || '').trim()) return
    // DeepSeek 式：流式 delta / thought_delta 追加到同一条，禁止每 token 一张扁卡片
    if (k === 'delta' || k === 'thought_delta') {
      const last = logs.value.length ? logs.value[logs.value.length - 1] : null
      if (
        last &&
        last.turn === turn &&
        String(last.runId || '') === String(runId || '') &&
        String(last.kind || '').toLowerCase() === k &&
        String(last.from || '') === String(from || '')
      ) {
        last.text = String(last.text || '') + formatted
        last.ts = new Date().toLocaleTimeString()
      } else {
        logs.value.push({
          ts: new Date().toLocaleTimeString(),
          kind,
          text: formatted,
          from,
          turn,
          runId,
          logId: `log-${++nextLogId}`,
          ...extra
        })
      }
    } else {
      logs.value.push({
        ts: new Date().toLocaleTimeString(),
        kind,
        text: formatted,
        from,
        turn,
        runId,
        logId: `log-${++nextLogId}`,
        ...extra
      })
    }
    void nextTick(() => {
      if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
    })
    if ((typeof turn === 'number' ? turn : 0) > 0) persistChatLogs()
  }
  
  const wsInboundCtx: ManagerWsInboundCtx = {
    sessionId,
    withManagerWsAuth,
    sendCancel(runId) {
      try {
        ws?.send(JSON.stringify(withManagerWsAuth({ type: 'cancel', runId, sessionId: sessionId.value })))
      } catch {}
    },
    getActiveTurn: () => activeTurn,
    setActiveTurn: (turn) => {
      activeTurn = turn
    },
    getCurrentAssistant: () => currentAssistant,
    setCurrentAssistant: (text) => {
      currentAssistant = text
    },
    getUserMessageIndexCounter: () => userMessageIndexCounter,
    setUserMessageIndexCounter: (n) => {
      userMessageIndexCounter = n
    },
    currentRunId,
    cancelAfterRunId,
    clearingExperience,
    feedbackSendingRunId,
    feedbackByRunId,
    feedbackAckByRunId,
    routeFeedbackByUserIndex,
    pendingHumanConfirm,
    stepResultsByTurn,
    collabStates,
    currentPhase,
    routeCapLive,
    planStepsTodo,
    pendingPlanPreview,
    planPreviewSending,
    stepProgressMap,
    activeTraceId,
    toolHealthLive,
    humanConfirmSending,
    taskConstraintsLive,
    runObservabilityLive,
    conversationCompactLive,
    latestGuiScreenshot,
    latestGuiVncUrl,
    guiVncAutoOpenedRunId,
    streamingSynthText,
    streamingSynthProvisional,
    streamAgentLabel,
    lastFinalRunId,
    runArtifactsByRunId,
    add,
    resolveIncomingRunTurn,
    attachRunToTurnLogs,
    applyTurnFeedback,
    loadEvolutionDashboard,
    persistSessionFeedback,
    hydrateLogsFromServerHistory,
    sanitizeWithdrawnTurns,
    reconcileTurnFeedbackKeys,
    hydrateSessionFeedbackFromServer,
    touchCurrentSessionHistory,
    clearActiveRun,
    resetStepProgress,
    onHumanConfirmAck,
    setCollabStatus,
    applyPlanStepsPayload,
    planAgentLabel,
    parseRoutePlanCardPayload,
    setCollabPreview,
    updatePlanStepFromStatus,
    normalizeRagCitations,
    normalizeSearchHits,
    extractMultimodalFromTraceLogs,
    stripSynthPromptLeakage,
    pickRicherNarrativeWithAuxBlocks,
    absorbProactiveNudges,
    applyTaskStackFromServer,
    isPlanStepsJsonLog,
    thoughtViewMode,
    bogusFinalText: BOGUS_FINAL_TEXT,
    applyPostureHint,
    notePostureWriteFiltered(turn, runId) {
      const userLog = logs.value.find((m) => m.turn === turn && String(m.kind).toLowerCase() === 'user')
      if (userLog) userLog.postureReadOnly = true
      add(
        'status',
        'Ask/Debug 只读：已跳过写操作专才（admin/gui）',
        'manager',
        turn,
        runId,
        { postureReadOnly: true }
      )
      applyPostureHint({ reason: 'write_filtered', suggest: 'agent', text: 'Ask/Debug 为只读姿态：已跳过 admin/gui 等写操作专才。需要写操作请切到 Agent。' })
    }
  }
  
  function connect() {
    if (ws) return
    ensureSessionId()
    wsManualClose = false
    const socket = new WebSocket(buildManagerWsUrl())
    ws = socket
    socket.onopen = () => {
      if (ws !== socket) return
      connected.value = true
      add('status', 'connected', undefined, 0)
      try {
        socket.send(JSON.stringify(withManagerWsAuth({ type: 'resume', sessionId: sessionId.value, userId: ensureUserId() })))
      } catch {}
    }
    socket.onclose = () => {
      if (ws !== socket) return
      connected.value = false
      ws = null
      add('status', 'closed', undefined, 0)
      if (!wsManualClose) {
        setTimeout(() => {
          if (!ws && !wsManualClose) connect()
        }, wsReconnectDelayMs)
      }
    }
    socket.onerror = () => {
      if (ws !== socket) return
      add('error', 'websocket error')
    }
    socket.onmessage = (evt) => {
      if (ws !== socket) return
      handleManagerWsInboundMessage(evt, wsInboundCtx)
    }
  }
  
  Object.assign(sessionHost, {
    logs,
    getTurnGroups: () => turnGroups.value,
    turnRunId,
    isTurnRunning,
    isTurnLive,
    showAlert,
    showConfirm,
    showPrompt,
    withManagerWsAuth,
    getWs: () => ws,
    setWs: (s: WebSocket | null) => {
      ws = s
    },
    setWsManualClose: (v: boolean) => {
      wsManualClose = v
    },
    connected,
    currentRunId,
    isRunActive,
    cancelRun,
    connect,
    reconnectWs,
    resetChatUiState,
    resetTaskStackForSession,
    clearTaskStackForSwitch,
    hydrateTaskStack,
    closeHistoryPanel,
    add,
    getTurnSeq: () => turnSeq,
    setTurnSeq: (n: number) => {
      turnSeq = n
    },
    getActiveTurn: () => activeTurn,
    setActiveTurn: (n: number) => {
      activeTurn = n
    },
    getUserMessageIndexCounter: () => userMessageIndexCounter,
    setUserMessageIndexCounter: (n: number) => {
      userMessageIndexCounter = n
    },
    bumpNextLogId,
    runIdToTurn,
    expandedProcessKeys,
    isTurnLive,
    getWorkbenchMode: () => workbenchMode.value
  } satisfies ManagerSessionHost)
  
  function onInputKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && isRunActive.value) {
      e.preventDefault()
      cancelRun()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !isRunActive.value) {
      e.preventDefault()
      void send()
    }
  }
  
  function disconnect() {
    if (!ws) return
    wsManualClose = true
    try {
      ws.close()
    } catch {}
  }
  
  async function persistPreviewForLog(att: PendingAttachment | null): Promise<string | undefined> {
    if (!att?.previewUrl) return undefined
    if (att.previewUrl.startsWith('data:')) return att.previewUrl
    if (att.mediaType !== 'image' || !att.previewUrl.startsWith('blob:')) return att.previewUrl
    try {
      const res = await fetch(att.previewUrl)
      const blob = await res.blob()
      return await readFileAsDataUrl(
        new File([blob], att.filename || 'image.jpg', { type: blob.type || 'image/jpeg' })
      )
    } catch {
      return att.previewUrl
    }
  }
  
  async function send() {
    if (!ws || !connected.value) return
    ensureSessionId()
    cancelEditTurn()
    const text = input.value.trim()
    const att = pendingAttachment.value
    if (!text && !att) return
    turnSeq += 1
    activeTurn = turnSeq
    pendingTurns.push(activeTurn)
    resetCollabStates('pending')
    resetStepProgress()
    runObservabilityLive.value = null
    conversationCompactLive.value = null
    currentRunId.value = ''
    cosmicRunPending.value = true
    const uidx = userMessageIndexCounter++
    add('user', text || `[附件: ${att?.filename || 'file'}]`, undefined, activeTurn, undefined, {
      userMessageIndex: uidx,
      attachmentName: att?.filename,
      attachmentMediaType: att?.mediaType,
      collaborationPosture: collaborationPosture.value
    })
    const previewForLog = await persistPreviewForLog(att)
    if (previewForLog || att?.previewUrl) {
      const userLog = logs.value.find(
        (m) => m.turn === activeTurn && String(m.kind).toLowerCase() === 'user' && m.userMessageIndex === uidx
      )
      if (userLog) {
        userLog.attachmentPreview = previewForLog || att?.previewUrl
        persistChatLogs()
      }
    }
    const payload: Record<string, unknown> = {
      type: 'chat',
      text: text || '请分析附件并回答。',
      sessionId: sessionId.value,
      userId: ensureUserId(),
      mode: 'normal'
    }
    if (att?.filePath) {
      payload.attachment = {
        filePath: att.filePath,
        mediaType: att.mediaType,
        filename: att.filename
      }
    }
    const clientCtx = buildClientContextPayload()
    if (clientCtx) payload.clientContext = clientCtx
    ws.send(JSON.stringify(withManagerWsAuth(payload)))
    input.value = ''
    clearPendingInputOnly()
    touchCurrentSessionHistory({ bump: true })
    reconcileTurnFeedbackKeys()
  }
  
  function patchTurnActionCardStatus(confirmId: string, status: string) {
    const id = String(confirmId || '').trim()
    if (!id) return
    let changed = false
    for (const m of logs.value) {
      const uf = m.userFacing
      if (!uf?.actions?.length) continue
      let hit = false
      const nextActions = uf.actions.map((a) => {
        if (a.id !== id) return a
        hit = true
        return { ...a, status }
      })
      if (hit) {
        m.userFacing = { ...uf, actions: nextActions }
        changed = true
      }
    }
    if (changed) logs.value = [...logs.value]
  }

  function respondHumanConfirm(decision: 'confirm' | 'cancel', fromActionCardId?: string) {
    const p = pendingHumanConfirm.value
    if (!ws || !connected.value || !p || humanConfirmSending.value) return
    const cardId = String(fromActionCardId || p.confirmId || '').trim()
    if (fromActionCardId && p.confirmId && fromActionCardId !== p.confirmId) return
    ensureSessionId()
    humanConfirmSending.value = true
    if (cardId) patchTurnActionCardStatus(cardId, decision === 'confirm' ? 'running' : 'cancelled')
    try {
      const payload: Record<string, unknown> = {
        type: 'human_confirm',
        sessionId: sessionId.value,
        decision
      }
      if (p.runId && p.confirmId) {
        payload.runId = p.runId
        payload.confirmId = p.confirmId
      }
      lastHumanConfirmDecision = decision
      lastHumanConfirmId = cardId || String(p.confirmId || '')
      ws.send(JSON.stringify(withManagerWsAuth(payload)))
      pendingHumanConfirm.value = null
    } catch {
      humanConfirmSending.value = false
      if (cardId) patchTurnActionCardStatus(cardId, 'awaiting_confirm')
    }
  }

  function respondActionCardConfirm(cardId: string) {
    respondHumanConfirm('confirm', cardId)
  }

  function respondActionCardCancel(cardId: string) {
    respondHumanConfirm('cancel', cardId)
  }

  const memoryCaptureBusy = ref(false)

  function patchTurnMemoryCaptureUi(turnId: number, uiStatus: NonNullable<import('./managerChatTypes').MemoryCaptureProposal['uiStatus']>) {
    for (const m of logs.value) {
      if (m.turn !== turnId) continue
      if (String(m.kind || '').toLowerCase() !== 'memory_capture') continue
      if (m.memoryCapture && typeof m.memoryCapture === 'object') {
        m.memoryCapture = { ...m.memoryCapture, uiStatus }
      } else {
        try {
          const p = JSON.parse(String(m.text || ''))
          m.memoryCapture = { ...p, uiStatus }
          m.text = JSON.stringify(m.memoryCapture)
        } catch {
          /* ignore */
        }
      }
    }
  }

  function memoryCaptureKindLabel(kind: string): string {
    const map: Record<string, string> = {
      todo: '待办',
      save_answer: '保存答案',
      save_playbook: '保存打法',
      save_preference: '保存偏好',
      save_org_rule: '组织规则',
    }
    return map[kind] || kind
  }

  async function respondMemoryCapture(
    turnId: number,
    decision: 'ack' | 'confirm_prefs' | 'reject_prefs'
  ) {
    if (memoryCaptureBusy.value) return
    const g = turnGroups.value.find((t) => t.id === turnId)
    const proposal = g?.memoryCapture
    if (!proposal) return
    memoryCaptureBusy.value = true
    patchTurnMemoryCaptureUi(turnId, 'sending')
    try {
      const data = await $fetch<{ ok?: boolean; message?: string }>('/api/manager/memory-capture', {
        method: 'POST',
        body: {
          decision,
          kind: proposal.kind,
          userId: userId.value,
          sessionId: sessionId.value,
          runId: proposal.runId,
        },
      })
      if (!data?.ok) throw new Error(data?.message || 'memory-capture failed')
      const ui =
        decision === 'confirm_prefs' ? 'confirmed' : decision === 'reject_prefs' ? 'rejected' : 'acked'
      patchTurnMemoryCaptureUi(turnId, ui)
      add(
        'status',
        decision === 'confirm_prefs'
          ? '已确认偏好（将作为弱 hint，不改路由）'
          : decision === 'reject_prefs'
            ? '已拒绝偏好提案'
            : '已确认：草稿待管理员在控制面审核',
        'manager',
        turnId,
        proposal.runId
      )
    } catch (e) {
      patchTurnMemoryCaptureUi(turnId, 'open')
      add('error', `记忆提案操作失败：${e instanceof Error ? e.message : String(e)}`, undefined, turnId)
    } finally {
      memoryCaptureBusy.value = false
    }
  }

  function onHumanConfirmAck() {
    const id = lastHumanConfirmId
    const decision = lastHumanConfirmDecision
    if (id) {
      patchTurnActionCardStatus(id, decision === 'cancel' ? 'cancelled' : 'done')
    }
    lastHumanConfirmId = ''
    lastHumanConfirmDecision = null
  }
  
  function abortPendingSendTurn() {
    if (!pendingTurns.length) return
    const turn = pendingTurns.pop()
    if (typeof turn === 'number' && turn > 0) {
      logs.value = logs.value.filter((m) => m.turn !== turn)
      if (activeTurn === turn) activeTurn = logs.value.length ? Math.max(...logs.value.map((m) => m.turn || 0)) : 0
      if (turnSeq === turn) turnSeq = activeTurn
      rebuildTurnCountersFromLogs()
      persistChatLogs()
    }
    resetStepProgress()
    resetCollabStates('idle')
    currentPhase.value = ''
  }
  
  function onSendOrCancel() {
    if (isRunActive.value) {
      cancelRun()
      return
    }
    void send()
  }
  
  function cancelRun() {
    if (!ws || !connected.value) return
    if (!currentRunId.value && !cosmicRunPending.value) return
    ensureSessionId()
  
    if (!currentRunId.value) {
      cancelAfterRunId.value = true
      cosmicRunPending.value = false
      abortPendingSendTurn()
    }
  
    try {
      const payload: Record<string, unknown> = {
        type: 'cancel',
        sessionId: sessionId.value
      }
      if (currentRunId.value) payload.runId = currentRunId.value
      ws.send(JSON.stringify(withManagerWsAuth(payload)))
    } catch {}
  }
  
  function buildTurnFeedbackArtifact(turn: TurnGroup): Record<string, unknown> | undefined {
    const rid = turnRunId(turn)
    const stored = rid ? runArtifactsByRunId.value[rid] : undefined
    if (stored?.managerArtifact && typeof stored.managerArtifact === 'object') {
      return {
        kind: 'manager_plan',
        tool_chain: (stored.toolChain as string[]) ?? (stored.managerArtifact as Record<string, unknown>).tool_chain,
        ...(stored.subArtifacts && typeof stored.subArtifacts === 'object'
          ? { sub_artifacts: stored.subArtifacts }
          : {}),
        ...(stored.sql_hash ? { sql_hash: stored.sql_hash } : {})
      }
    }
    if (stored?.subArtifacts && typeof stored.subArtifacts === 'object') {
      const sub = stored.subArtifacts as Record<string, unknown>
      const first = sub.db ?? sub.rag ?? sub.admin
      if (first && typeof first === 'object') return first as Record<string, unknown>
    }
    return undefined
  }
  
  function sendRouteWrongFeedback(turn: TurnGroup) {
    if (routeFeedbackSubmitted(turn)) return
    const rid = turnRunId(turn)
    const uidx = turn.user?.userMessageIndex
    ensureSessionId()
    ensureUserId()
    const routeCard = turnRoutePlanCard(turn)
    const cap = turnRouteCap(turn)
    const body = {
      sessionId: sessionId.value,
      userId: userId.value,
      kind: 'route_wrong' as const,
      runId: rid || undefined,
      turnId: turn.id,
      userMessageIndex: uidx,
      userTask: turn.user?.text ? String(turn.user.text).slice(0, 2000) : undefined,
      cap: cap?.agents?.length ? cap.agents : routeCard?.agents,
      intent: cap?.intent || routeCard?.intent,
      orchestratorSource: routeCard?.orchestratorSource,
      lintIssues: routeCard?.lintIssues?.slice(0, 8)
    }

    const markLocal = () => {
      if (typeof uidx !== 'number') return
      routeFeedbackByUserIndex.value = {
        ...routeFeedbackByUserIndex.value,
        [uidx]: true
      }
      persistSessionFeedback()
    }

    void (async () => {
      try {
        await $fetch('/api/manager/session-feedback', { method: 'POST', body })
        markLocal()
        return
      } catch {
        /* HTTP 失败时回落 WS */
      }
      if (!ws || !connected.value) {
        markLocal()
        return
      }
      try {
        ws.send(
          JSON.stringify(
            withManagerWsAuth({
              type: 'route_feedback',
              sessionId: body.sessionId,
              userId: body.userId,
              runId: rid,
              turnId: body.turnId,
              userMessageIndex: uidx,
              userTask: body.userTask,
              cap: body.cap,
              intent: body.intent,
              orchestratorSource: body.orchestratorSource,
              lintIssues: body.lintIssues
            })
          )
        )
        markLocal()
      } catch {
        markLocal()
      }
    })()
  }

  async function sendFeedback(turn: TurnGroup, score: number) {
    if (turnFeedbackSubmitted(turn)) return
    const uidx = turn.user?.userMessageIndex
    const key = feedbackKeyForTurn(turn)
    const rid = turnRunId(turn)

    if (isFeedbackPendingForTurn(turn)) {
      feedbackSendingRunId.value = null
    } else if (feedbackSendingRunId.value === key) {
      return
    }

    ensureSessionId()
    ensureUserId()
    feedbackSendingRunId.value = key
    applyTurnFeedback(key, score as 0 | 1, FEEDBACK_PENDING_ACK, uidx)

    const artifact = buildTurnFeedbackArtifact(turn)
    const finalizeLocal = (ack: string) => {
      feedbackSendingRunId.value = null
      applyTurnFeedback(key, score as 0 | 1, ack, uidx)
    }
    const stillPending = () =>
      feedbackAckByRunId.value[key] === FEEDBACK_PENDING_ACK ||
      (typeof uidx === 'number' && feedbackAckByUserIndex.value[uidx] === FEEDBACK_PENDING_ACK)

    /** 落盘回包应很快；超时则先本地确认，避免按钮长期 disabled 像「没反应」 */
    const FEEDBACK_HTTP_TIMEOUT_MS = 8_000
    const optimisticTimer = window.setTimeout(() => {
      if (!stillPending()) return
      finalizeLocal(score === 1 ? '已标记为有用 · 感谢反馈' : '已标记为无用 · 感谢反馈')
    }, 1_500)

    const httpBody = {
      sessionId: sessionId.value,
      userId: userId.value,
      runId: rid || undefined,
      turnId: turn.id,
      userMessageIndex: uidx,
      score: score as 0 | 1,
      kind: 'score' as const,
      ...(artifact ? { artifact } : {})
    }

    try {
      const res = await $fetch<{
        ok?: boolean
        feedbackScore?: 0 | 1
        note?: string
      }>('/api/manager/session-feedback', {
        method: 'POST',
        body: httpBody,
        timeout: FEEDBACK_HTTP_TIMEOUT_MS
      })
      window.clearTimeout(optimisticTimer)
      const ackBase = res?.feedbackScore === 1 ? '已标记为有用' : '已标记为无用'
      finalizeLocal(`${ackBase} · 感谢反馈（已同步）`)
      return
    } catch {
      /* HTTP 失败 / 超时 → WS 回落 */
    }

    if (ws && connected.value && isValidServerRunId(rid)) {
      try {
        ws.send(
          JSON.stringify(
            withManagerWsAuth({
              type: 'feedback',
              sessionId: sessionId.value,
              userId: userId.value,
              runId: rid,
              turnId: turn.id,
              userMessageIndex: uidx,
              score,
              ...(artifact ? { artifact } : {})
            })
          )
        )
        window.setTimeout(() => {
          window.clearTimeout(optimisticTimer)
          if (!stillPending()) return
          finalizeLocal(score === 1 ? '已标记为有用 · 感谢反馈' : '已标记为无用 · 感谢反馈')
        }, 4_000)
        return
      } catch {
        /* fall through */
      }
    }

    window.clearTimeout(optimisticTimer)
    finalizeLocal(score === 1 ? '已标记为有用 · 感谢反馈' : '已标记为无用 · 感谢反馈')
  }
  
  function onClearExperience() {
    if (!ws || !connected.value) return
    ensureSessionId()
    void (async () => {
      const ok = await showConfirm('将清除 Manager_Agent 的「经验」（路由学习记录），并重置策略。继续？', '清除经验')
      if (!ok) return
      clearingExperience.value = true
      try {
        ws!.send(JSON.stringify(withManagerWsAuth({ type: 'clear_experience', sessionId: sessionId.value })))
      } catch {
        clearingExperience.value = false
      }
    })()
  }

  async function postManagerMemoryClear(scope: 'summaries' | 'evolution' | 'all', title: string, message: string) {
    const ok = await showConfirm(message, title)
    if (!ok) return
    const busy = scope === 'evolution' ? clearingEvolution : clearingMemory
    busy.value = true
    try {
      await $fetch('/api/manager/memory-clear', {
        method: 'POST',
        body: {
          scope,
          sessionId: sessionId.value || undefined,
          userId: userId.value || undefined,
          includeSubAgents: false
        }
      })
      await showAlert(`${title}完成（仅 Manager 本平面，未清专家）`, '已清除')
    } catch (e: any) {
      await showAlert(String(e?.data?.statusMessage || e?.message || e || '清除失败'), '失败')
    } finally {
      busy.value = false
    }
  }

  function onClearMemory() {
    void postManagerMemoryClear(
      'summaries',
      '清除会话摘要',
      '将清除本租户 Manager 会话摘要记忆。不影响 DB/RAG/Admin 独立记忆。继续？'
    )
  }

  function onClearEvolution() {
    void postManagerMemoryClear(
      'evolution',
      '重置自我进化',
      '将清除 Manager Prompt shadow/active、planner rules 等进化产物。不影响专家本地进化。继续？'
    )
  }
  
  
  async function waitForManagerReady(maxMs = 45000): Promise<boolean> {
    const t0 = Date.now()
    let delayMs = 800
    while (Date.now() - t0 < maxMs) {
      try {
        const res = await $fetch<{ ready?: boolean }>('/api/ready')
        if (res?.ready) return true
      } catch {
        /* PG / memory backend still warming after docker restart */
      }
      await new Promise((r) => setTimeout(r, delayMs))
      delayMs = Math.min(2_500, Math.round(delayMs * 1.4))
    }
    return false
  }

  function onQuickQuestion(q: string) {
    input.value = q
    void send()
  }

  provide(MANAGER_CHAT_THREAD_KEY, {
    editingTurnId,
    editDraft,
    currentRunId,
    connected,
    thoughtViewMode,
    streamingSynthText,
    streamingSynthProvisional,
    streamingSynthDisplayText,
    streamingMarkdownHtml,
    streamingReplyEl,
    copyAckTurnId,
    copyAckKey,
    feedbackSendingRunId,
    expandedProcessKeys,
    kindClass,
    kindLabel,
    userBubbleText,
    copyMessageText,
    isTurnRunning,
    isTurnLive,
    startEditTurn,
    cancelEditTurn,
    submitEditResend,
    withdrawTurn,
    regenerateTurn,
    hasAgentPipeline,
    hasTurnActivity,
    turnAgentPipelineSteps,
    turnAgentPipelineDoneCount,
    turnRouteCap,
    turnCollaborationPosture,
    turnPostureNote,
    turnSuggestedPosture,
    turnAwaitingPlanConfirm,
    turnHitlInfo,
    pendingPlanPreview,
    workbenchMode,
    planAgentLabel,
    agentPipelineStatusLabel,
    turnRoutePlanCard,
    previewText,
    turnPlanOutline,
    hasThoughtContent,
    thoughtPanelOpen,
    onThoughtPanelToggle,
    thoughtPanelLabel,
    stepResultsForTurn,
    executionStepCountForTurn,
    thoughtLogCountForTurn,
    userThoughtNarrative,
    userThoughtStreamText,
    turnThoughtStages,
    userCreatedPlanLabels,
    turnGuiVisuals,
    thoughtPanelPreview,
    processStepKey,
    isProcessStepClampable,
    phaseLabel,
    formatProcessText,
    toggleProcessStep,
    isSynthPhaseActive,
    turnRunStatusPill,
    onReplyMarkdownClick,
    renderAssistantMarkdown,
    cachedResultMarkdownHtml,
    turnRenderMemoKey,
    renderReportMarkdown,
    resultItemClasses,
    resultKindLabel,
    turnSearchSources,
    turnUnifiedCiteSources,
    citeSourcesForMarkdown,
    webSourceHost,
    mediaForReply,
    resolveMediaUrl,
    openMediaInNewTab,
    downloadMediaFile,
    mediaDownloadName,
    adminUiCardsFromTurn,
    replyMarkdownBody,
    replyExecutionSummaryMarkdown,
    replyUserOutcomeBanner,
    replyExecSummaryTone,
    turnExpertFailureCards,
    replyHasInlineAnalytics,
    shouldShowUserFacingMetrics,
    shouldShowUserFacingHeadline,
    applyFollowUpSuggestion,
    shouldShowArtifactLaunchBar,
    artifactPanelSlots,
    artifactTabLabel,
    openReplyArtifactDrawer,
    streamingArtifactHintForTurn,
    turnReportEditedBadge,
    buildTurnAgentResults,
    extractEchartsOption,
    chartTitleFromText,
    downloadEchartsPng,
    initChartEl,
    chartContainerClass,
    chartContainerStyle,
    extractTableData,
    renderTableDataHtml,
    userFacingChartOption,
    userFacingChartTitle,
    userFacingTableHtml,
    canConfirmActionCard,
    respondActionCardConfirm,
    respondActionCardCancel,
    memoryCaptureBusy,
    memoryCaptureKindLabel,
    respondMemoryCapture,
    humanConfirmSending,
    resolveReportBody,
    replyUserDetailAppendix,
    downloadMarkdown,
    replyHasCollapsibleSources,
    replySourceCount,
    replySourcesMarkdown,
    hasMediaContent,
    replyHasAnalytics,
    shouldShowTurnFeedback,
    turnFeedbackSubmitted,
    turnFeedbackKey,
    feedbackKeyForTurn,
    isFeedbackPendingForTurn,
    sendFeedback,
    routeFeedbackSubmitted,
    sendRouteWrongFeedback,
    turnFeedbackAckText,
    visibleTurnErrors,
    errorItemKey,
    dismissError,
    dismissAllTurnErrors
  })

  provide(MANAGER_WORKBENCH_SIDEBAR_KEY, {
    sidebarOpen,
    collaborationPosture,
    planStepsTodo,
    planStepsDoneCount,
    routeCapLive,
    agentDisplayLabel: (agent: string, professional = true) => formatAgentDisplayLabel(agent, professional),
    taskConstraintsLive,
    runObservabilityLive,
    formatObsMs,
    formatTokenCount,
    runPhaseBarMaxMs,
    obsPhaseColor,
    obsDisplayLabel,
    runTokenByAgentEntries,
    runTokenByTierEntries,
    obsAgentColor,
    runTokenBarMax,
    planAgentLabel,
    connected,
    clearingExperience,
    onClearExperience,
    clearingMemory,
    onClearMemory,
    clearingEvolution,
    onClearEvolution,
    evolutionLoading,
    loadEvolutionDashboard,
    evolutionSummary,
    healthChips,
    learningChartPoints,
    learningChartEl,
    learningRecent,
    opsToken,
    evolutionExperiments,
    previewText,
    opsBusy,
    promoteExperiment,
    rollbackExperiment,
    userGoalsActiveCount,
    userGoals,
    userId,
    userGoalOverdue,
    formatShortDate,
    taskPriorityLabel,
    setUserGoalStatus,
    removeUserGoal,
    userGoalDraft,
    userGoalsSaving,
    addUserGoal,
    taskStackActiveCount,
    taskStack,
    proactiveNudges,
    dismissProactiveNudge,
    taskStackSyncing,
    syncTaskStackInsights,
    taskOverdue,
    taskStatusLabel,
    setTaskStackItemStatus,
    removeTaskFromStack,
    taskStackDraft,
    taskStackSaving,
    addTaskToStack
  })

  provide(MANAGER_CHAT_RAIL_KEY, {
    pendingPlanPreview,
    enabledPlanPreviewCount,
    workbenchMode,
    collaborationPosture,
    previewText,
    planAgentLabel,
    planPreviewSending,
    respondPlanPreview,
    planStepsTodo,
    planStepsDoneCount,
    planStepStatusIcon,
    quickQuestions,
    quickCardTitle,
    onQuickQuestion,
    sessionSwitching,
    visibleTurnGroups,
    systemEvents,
    kindClass,
    kindLabel,
    dismissError,
    logEl,
    input,
    connected,
    isRunActive,
    sendCancelDisabled,
    uploadingAttachment,
    pendingAttachment,
    setCollaborationPosture,
    lastPostureHint,
    dismissPostureHint,
    onInputKeydown,
    onSendOrCancel,
    clearPendingAttachment,
    onFileSelected,
    onAttachmentFile,
    chatComposerRef,
    runObservabilityLive,
    formatObsMs,
    formatTokenCount
  })

  watch(
    turnGroups,
    () => {
      reconcileTurnFeedbackKeys()
    },
    { flush: 'post' }
  )

  /** 流式 Markdown：rAF 合并最新缓冲，禁止 timer 窗口丢 delta / 闭包旧 text */
  let streamingMarkdownRaf = 0
  let streamingMarkdownPending = ''
  const flushStreamingMarkdown = () => {
    streamingMarkdownRaf = 0
    const text = streamingMarkdownPending
    if (!text) {
      streamingMarkdownHtml.value = ''
      return
    }
    const liveId = findLatestOpenUserTurn()
    const liveTurn =
      liveId != null ? visibleTurnGroups.value.find((t) => t.id === liveId) : undefined
    const cleaned = stripStreamingAuxForPlan(text, liveTurn)
    streamingMarkdownHtml.value = renderAssistantMarkdown(cleaned)
    if (streamingMarkdownPending !== text) {
      streamingMarkdownRaf = requestAnimationFrame(flushStreamingMarkdown)
    }
  }
  watch(streamingSynthDisplayText, (text) => {
    if (!text) {
      streamingMarkdownPending = ''
      streamingMarkdownHtml.value = ''
      if (streamingMarkdownRaf) {
        cancelAnimationFrame(streamingMarkdownRaf)
        streamingMarkdownRaf = 0
      }
      return
    }
    streamingMarkdownPending = text
    if (streamingMarkdownRaf) return
    streamingMarkdownRaf = requestAnimationFrame(flushStreamingMarkdown)
  })

  watch(thoughtViewMode, () => {
    resultMarkdownHtmlCache.clear()
  })

  onMounted(() => {
    loadClawhiveAuth()
    loadWorkbenchMode()
    loadThoughtViewMode()
    loadCollaborationPosture()
    ensureSessionId()
    ensureUserId()
    updateHistoryBackdropVisible()
    loadSessionHistoryList()
    restoreChatLogs()
    restoreWithdrawnTurns()
    restoreSessionFeedback()
    sanitizeWithdrawnTurns()
    reconcileTurnFeedbackKeys()

    const authNeeded = Boolean((runtimeConfig.public as any)?.managerUserAuth)
    const canTalkToServer = () => !authNeeded || Boolean(String(clawhiveToken.value || '').trim())

    async function waitForClawhiveAuthReady(timeoutMs = 2500) {
      if (!authNeeded) return
      if (!clawhiveAuthReady.value) loadClawhiveAuth()
      const start = Date.now()
      while (!clawhiveAuthReady.value && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 25))
      }
      if (!String(clawhiveToken.value || '').trim()) loadClawhiveAuth()
    }

    async function hydrateFeedbackWithRetry(opts?: { expectFeedback?: boolean }) {
      const expectFeedback = Boolean(opts?.expectFeedback)
      // Docker 重建后 PG/鉴权常短暂失败：auth/error 必重试；有历史轮次时 empty 也重试（暖机假空）
      await retryFeedbackHydrate(
        () => hydrateSessionFeedbackFromServer(),
        expectFeedback ? FEEDBACK_HYDRATE_WARM_OPTS : FEEDBACK_HYDRATE_COLD_OPTS
      )
    }

    async function bootstrapServerSession() {
      await waitForClawhiveAuthReady()
      if (!canTalkToServer()) return
      const ready = await waitForManagerReady()
      if (!ready) {
        add('status', '记忆存储仍在初始化，历史同步可能稍后完成', undefined, 0)
      }
      void fetchServerSessionHistory()
      const sid = sessionId.value
      // 与 switchSession 一致：先灌历史与 umidx，再回显有用/无用，避免首屏竞态丢反馈
      if (sid) {
        await hydrateSessionFromServer(sid)
        reconcileTurnFeedbackKeys()
        const expectFeedback =
          userMessageIndexCounter > 0 ||
          turnGroups.value.some((t) => t.results.length > 0 || t.errors.length > 0)
        await hydrateFeedbackWithRetry({ expectFeedback })
      }
      connect()
      void hydrateTaskStack()
      void hydrateUserGoals()
    }

    void bootstrapServerSession()
    if (typeof window !== 'undefined') {
      const savedOps = window.localStorage.getItem(OPS_TOKEN_KEY)
      if (savedOps) opsToken.value = savedOps
    }
    const wide = typeof window !== 'undefined' && window.innerWidth >= 960
    historyPanelOpen.value = wide
    sidebarOpen.value = false
    const stopWatchLogin = watch(clawhiveToken, (t, prev) => {
      // 空→有 token，或换了新 token：强制再灌历史与反馈（总管登录即可，不依赖控制端）
      if (authNeeded && t && t !== prev) {
        ensureUserId()
        loadSessionHistoryList()
        void bootstrapServerSession()
      }
    })
    // Docker 重建后页签仍开着：token 不变不会触发上面的 watch；可见性恢复时补灌反馈
    const onVisibilityOrOnline = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (!canTalkToServer()) return
      const sid = sessionId.value
      if (!sid) return
      const hasTurns =
        userMessageIndexCounter > 0 ||
        turnGroups.value.some((t) => t.results.length > 0 || t.errors.length > 0)
      // 服务端为 SSOT：勿因本地已有 score 跳过；Docker 重建后须强制补灌
      if (!hasTurns) return
      void hydrateFeedbackWithRetry({ expectFeedback: true })
    }
    window.addEventListener('visibilitychange', onVisibilityOrOnline)
    window.addEventListener('online', onVisibilityOrOnline)
    window.addEventListener('pageshow', onVisibilityOrOnline)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeFloatingPanels()
    }
    const onResize = () => updateHistoryBackdropVisible()
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    ;(window as any).__mgrToolsKey = onKey
    ;(window as any).__mgrResizeKey = onResize
    ;(window as any).__mgrStopWatchLogin = stopWatchLogin
    ;(window as any).__mgrFeedbackVisibility = onVisibilityOrOnline
    requestBrowserLocation()
    import('echarts').then((m) => {
      echartsModule.value = m
    }).catch(() => {})
    nextTick(() => bindChatColumnWheel())
  })
  
  watch(chatScrollHostEl, () => {
    nextTick(() => bindChatColumnWheel())
  })
  
  watch(echartsModule, (ec) => {
    if (!ec) return
    nextTick(() => {
      document.querySelectorAll('.echarts-container').forEach((el) => {
        const raw = (el as HTMLElement).dataset.option
        if (!raw) return
        try {
          const option = JSON.parse(raw)
          const inst = (el as any).__chart_inst__
          if (inst && typeof inst.setOption === 'function') {
            inst.setOption(patchDarkTheme(option), true)
            requestAnimationFrame(() => inst.resize?.())
            return
          }
          initChartEl(el as HTMLElement, option)
        } catch {}
      })
    })
  })
  
  onBeforeUnmount(() => {
    chatColumnWheelCleanup?.()
    chatColumnWheelCleanup = null
    clearPendingAttachment()
    disconnect()
    const wTools = window as Window & {
      __mgrToolsKey?: (e: KeyboardEvent) => void
      __mgrResizeKey?: () => void
      __mgrStopWatchLogin?: () => void
      __mgrFeedbackVisibility?: () => void
    }
    if (wTools.__mgrToolsKey) {
      window.removeEventListener('keydown', wTools.__mgrToolsKey)
      delete wTools.__mgrToolsKey
    }
    if (wTools.__mgrResizeKey) {
      window.removeEventListener('resize', wTools.__mgrResizeKey)
      delete wTools.__mgrResizeKey
    }
    if (typeof wTools.__mgrStopWatchLogin === 'function') {
      wTools.__mgrStopWatchLogin()
      delete wTools.__mgrStopWatchLogin
    }
    if (wTools.__mgrFeedbackVisibility) {
      window.removeEventListener('visibilitychange', wTools.__mgrFeedbackVisibility)
      window.removeEventListener('online', wTools.__mgrFeedbackVisibility)
      window.removeEventListener('pageshow', wTools.__mgrFeedbackVisibility)
      delete wTools.__mgrFeedbackVisibility
    }
  })

  return {
    agentCosmicActive,
    workbenchMode,
    thoughtViewMode,
    collaborationPosture,
    debugObservationPanelOpen,
    connected,
    currentRunId,
    livePhaseText,
    routeCapLive,
    planStepsTodo,
    planStepsDoneCount,
    currentPhase,
    collabStatusItems,
    stepProgressLine,
    activeTraceId,
    conversationCompactLive,
    traceDrawerOpen,
    openTraceDrawer,
    closeTraceDrawer,
    artifactDrawerOpen,
    artifactDrawerTurn,
    artifactDrawerTab,
    artifactDrawerReportDraft,
    closeReplyArtifactDrawer,
    setArtifactDrawerTab,
    openReplyArtifactDrawer,
    applyArtifactReportEdit,
    exportArtifactBundle,
    buildTurnAgentResults,
    extractEchartsOption,
    userFacingChartOption,
    userFacingChartTitle,
    userFacingTableHtml,
    resolveReportBody,
    renderReportMarkdown,
    initChartEl,
    chartContainerClass,
    chartContainerStyle,
    downloadEchartsPng,
    downloadMarkdown,
    extractTableData,
    renderTableDataHtml,
    runObservabilityLive,
    formatObsMs,
    formatTokenCount,
    obsDisplayLabel,
    historyPanelOpen,
    sidebarOpen,
    toolsBadgeCount,
    planAgentLabel,
    collabStatusShort,
    setWorkbenchMode,
    switchWorkbenchMode,
    selectHistorySession,
    setThoughtViewMode,
    setCollaborationPosture,
    newSession,
    pendingHumanConfirm,
    latestGuiScreenshot,
    latestGuiVncUrl,
    humanConfirmSending,
    respondHumanConfirm,
    respondActionCardConfirm,
    respondActionCardCancel,
    memoryCaptureBusy,
    memoryCaptureKindLabel,
    respondMemoryCapture,
    chatScrollHostEl,
    historyBackdropVisible,
    sessionId,
    sessionHistoryItems,
    formatHistoryTime,
    closeHistoryPanel,
    switchSession,
    renameSessionHistory,
    deleteSessionHistory,
    chatMainEl,
    visibleTurnGroups,
    chatColumnEl,
    chatComposerRef,
    input,
    isRunActive,
    sendCancelDisabled,
    uploadingAttachment,
    pendingAttachment,
    onInputKeydown,
    onSendOrCancel,
    clearPendingAttachment,
    onFileSelected,
    onAttachmentFile,
    modalOpen,
    modalMode,
    modalTitle,
    modalMessage,
    modalConfirmText,
    modalCancelText,
    modalInputValue,
    modalInputPlaceholder,
    onModalConfirm,
    onModalCancel
  }
}
