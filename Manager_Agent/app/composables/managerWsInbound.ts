import type { Ref } from 'vue'
import {
  IN_FLIGHT_RUN_WS_EVENTS,
  type CollabAgent,
  type RoutePlanCardData,
  type StepResultItem
} from './managerChatTypes'
import { FEEDBACK_PENDING_ACK } from './useManagerSession'

function resolveFeedbackEventKey(
  payload: Record<string, unknown>,
  runId: string,
  pendingKey: string | null
): string {
  const rid = String(payload.runId || runId || '').trim()
  if (typeof payload.feedbackKey === 'string' && payload.feedbackKey.trim()) {
    return String(payload.feedbackKey).trim()
  }
  if (typeof payload.userMessageIndex === 'number') {
    return `umidx:${Math.floor(Number(payload.userMessageIndex))}`
  }
  return pendingKey || rid
}

function normalizeFeedbackEventScore(raw: unknown): 0 | 1 | null {
  if (raw === 0 || raw === 1) return raw
  const n = Number(raw)
  if (n === 0 || n === 1) return n as 0 | 1
  return null
}

export type RunPhaseItem = { phase: string; ms: number; agent?: string; tokens?: number }
export type RunTokenSummary = {
  totalTokens?: number
  totalUsd?: number
  byAgent?: Record<string, number>
  byPhase?: Record<string, number>
  byModelTier?: Record<string, number>
}

export type ManagerWsInboundCtx = {
  sessionId: Ref<string>
  withManagerWsAuth: (payload: Record<string, unknown>) => Record<string, unknown>
  sendCancel: (runId: string) => void
  getActiveTurn: () => number
  setActiveTurn: (turn: number) => void
  getCurrentAssistant: () => string
  setCurrentAssistant: (text: string) => void
  getUserMessageIndexCounter: () => number
  setUserMessageIndexCounter: (n: number) => void
  currentRunId: Ref<string>
  cancelAfterRunId: Ref<boolean>
  clearingExperience: Ref<boolean>
  feedbackSendingRunId: Ref<string | null>
  feedbackByRunId: Ref<Record<string, 0 | 1>>
  feedbackAckByRunId: Ref<Record<string, string>>
  routeFeedbackByUserIndex: Ref<Record<number, boolean>>
  pendingHumanConfirm: Ref<{
    runId?: string
    confirmId?: string
    title: string
    message: string
    agent: string
    screenshotDataUrl?: string
    pageUrl?: string
    failureType?: string
    lobsterRunId?: string
  } | null>
  stepResultsByTurn: Ref<Record<number, StepResultItem[]>>
  collabStates: Ref<Record<CollabAgent, string>>
  currentPhase: Ref<string>
  routeCapLive: Ref<{ intent: string; agents: string[]; capLabel?: string; dag?: string } | null>
  planStepsTodo: Ref<Array<{ id: string; agent: string; query: string; order: number; status: string }>>
  pendingPlanPreview: Ref<unknown>
  planPreviewSending: Ref<boolean>
  stepProgressMap: Ref<Record<string, unknown>>
  activeTraceId: Ref<string>
  toolHealthLive: Ref<Record<string, unknown> | null>
  humanConfirmSending: Ref<boolean>
  taskConstraintsLive: Ref<{
    timeHints?: string[]
    subjectHints?: string[]
    wantsVisualize?: boolean
    wantsReport?: boolean
  } | null>
  runObservabilityLive: Ref<{
    runId?: string
    phaseTimeline: RunPhaseItem[]
    tokenSummary: RunTokenSummary | null
    wallClockMs?: number
  } | null>
  conversationCompactLive: Ref<{
    compacted: boolean
    fullChars?: number
    compactChars?: number
    savedRatio?: number
    turns?: number
  } | null>
  latestGuiScreenshot: Ref<string>
  latestGuiVncUrl: Ref<string>
  /** 已为哪个 runId 自动打开过 noVNC（每 run 一次） */
  guiVncAutoOpenedRunId: Ref<string>
  streamingSynthText: Ref<string>
  streamAgentLabel: Ref<string>
  lastFinalRunId: Ref<string>
  runArtifactsByRunId: Ref<Record<string, Record<string, unknown>>>
  add: (
    kind: string,
    text: string,
    from?: string,
    turn?: number,
    runId?: string,
    extra?: Record<string, unknown>
  ) => void
  resolveIncomingRunTurn: (runId: string) => number
  attachRunToTurnLogs: (turn: number, runId: string) => void
  applyTurnFeedback: (key: string, fb: 0 | 1, ack?: string, userIndex?: number | null) => void
  loadEvolutionDashboard: () => void | Promise<void>
  persistSessionFeedback: () => void
  hydrateLogsFromServerHistory: (
    history: Array<{
      role?: string
      content?: string
      runId?: string
      uiMeta?: unknown
    }>
  ) => void
  sanitizeWithdrawnTurns: () => void
  reconcileTurnFeedbackKeys: () => void
  hydrateSessionFeedbackFromServer: () => void | Promise<void>
  touchCurrentSessionHistory: (opts?: { bump?: boolean }) => void
  clearActiveRun: (runId: string) => void
  resetStepProgress: () => void
  /** D3：卡内确认 ack 后回写 ActionCard 状态 */
  onHumanConfirmAck?: () => void
  setCollabStatus: (agent: string, status: string) => void
  applyPlanStepsPayload: (data: unknown) => void
  planAgentLabel: (agent: string) => string
  parseRoutePlanCardPayload: (p: Record<string, unknown>) => RoutePlanCardData
  setCollabPreview: (agent: string, summary: string) => void
  updatePlanStepFromStatus: (payload: Record<string, unknown>) => void
  normalizeRagCitations: (citations: unknown[]) => Array<{ source: string; title?: string; url?: string; excerpt?: string; score?: number }>
  normalizeSearchHits: (hits: unknown[]) => Array<{ title: string; url: string }>
  extractMultimodalFromTraceLogs: (turn: number, runId: string) => string | null
  stripSynthPromptLeakage: (text: string) => string
  pickRicherNarrativeWithAuxBlocks: (streamed: string, finalText: string) => string
  absorbProactiveNudges: (nudges: unknown[] | undefined) => void
  applyTaskStackFromServer: (items: unknown[]) => void
  isPlanStepsJsonLog: (text: string) => boolean
  bogusFinalText: RegExp
  applyPostureHint: (payload: unknown) => void
  notePostureWriteFiltered: (turn: number, runId?: string) => void
}

export function handleManagerWsInboundMessage(evt: MessageEvent, ctx: ManagerWsInboundCtx): void {
    const data = JSON.parse(String(evt.data || '{}')) as any
    const event = String(data.event || '')
    const runId = String(data.runId || '').trim()
    /** 仅「进行中」事件同步 active runId；避免 feedback/status 把已结束 runId 写回导致误点「取消」报错 */
    const inFlightRunEvents = IN_FLIGHT_RUN_WS_EVENTS
    if (runId && inFlightRunEvents.has(event)) {
      ctx.currentRunId.value = runId
      if (ctx.cancelAfterRunId.value) {
        ctx.cancelAfterRunId.value = false
        try {
          ctx.sendCancel(runId)
        } catch {}
      }
    }
    let turn = ctx.getActiveTurn() || 0
    if (runId) {
      turn = ctx.resolveIncomingRunTurn(runId)
      ctx.setActiveTurn(turn)
      ctx.attachRunToTurnLogs(turn, runId)
    }
    if (event === 'status') {
      const st = data?.data && typeof data.data === 'object' ? String(data.data.status || '') : ''
      if (st === 'experience_cleared' || st === 'experience_clear_failed') ctx.clearingExperience.value = false
      if (st === 'feedback_saved') {
        const pendingKey = ctx.feedbackSendingRunId.value
        ctx.feedbackSendingRunId.value = null
        const payload = data.data as Record<string, unknown>
        const rid = String(payload.runId || runId || '')
        const fbKey = resolveFeedbackEventKey(payload, runId, pendingKey)
        const fb = normalizeFeedbackEventScore(payload.feedbackScore)
        const pendingScore =
          pendingKey && (ctx.feedbackByRunId.value[pendingKey] === 0 || ctx.feedbackByRunId.value[pendingKey] === 1)
            ? ctx.feedbackByRunId.value[pendingKey]!
            : null
        const finalScore = fb ?? pendingScore
        const patched = payload.learningPatched
        const comp = payload.compositeScore
        const tuned = payload.weightsTuned
        const ack = [
          finalScore === 1 ? '已标记为有用' : finalScore === 0 ? '已标记为无用' : '感谢反馈',
          patched ? '学习信号已更新' : '',
          comp != null ? `综合分 ${comp}` : '',
          String(payload.note || '').trim() || '将用于路由策略离线学习',
          tuned ? '权重已微调' : ''
        ]
          .filter(Boolean)
          .join(' · ')
        if (fbKey && (finalScore === 0 || finalScore === 1)) {
          const uidx =
            typeof payload.userMessageIndex === 'number' ? Math.floor(Number(payload.userMessageIndex)) : null
          ctx.applyTurnFeedback(fbKey, finalScore, ack, uidx)
        } else if (fbKey && ctx.feedbackAckByRunId.value[fbKey] === FEEDBACK_PENDING_ACK) {
          const scores = { ...ctx.feedbackByRunId.value }
          const acks = { ...ctx.feedbackAckByRunId.value }
          delete scores[fbKey]
          delete acks[fbKey]
          ctx.feedbackByRunId.value = scores
          ctx.feedbackAckByRunId.value = acks
          ctx.persistSessionFeedback()
        }
        void ctx.loadEvolutionDashboard()
        ctx.add('status', ack, data.from, 0, runId)
        return
      }
      if (st === 'feedback_save_failed') {
        const pendingKey = ctx.feedbackSendingRunId.value
        ctx.feedbackSendingRunId.value = null
        const payload = (data.data || {}) as Record<string, unknown>
        const fbKey = resolveFeedbackEventKey(payload, runId, pendingKey)
        const errDetail = String(payload.error || '').trim()
        if (fbKey) {
          const scores = { ...ctx.feedbackByRunId.value }
          const acks = { ...ctx.feedbackAckByRunId.value }
          delete scores[fbKey]
          delete acks[fbKey]
          ctx.feedbackByRunId.value = scores
          ctx.feedbackAckByRunId.value = acks
          ctx.persistSessionFeedback()
        }
        ctx.add(
          'status',
          errDetail ? `反馈保存失败：${errDetail}` : '反馈保存失败，请重试',
          data.from,
          ctx.getActiveTurn() || 0,
          runId
        )
        return
      }
      if (st === 'route_feedback_saved') {
        const payload = data.data as Record<string, unknown>
        const uidx =
          typeof payload.userMessageIndex === 'number' ? Math.floor(Number(payload.userMessageIndex)) : null
        if (uidx != null && uidx >= 0) {
          ctx.routeFeedbackByUserIndex.value = { ...ctx.routeFeedbackByUserIndex.value, [uidx]: true }
          ctx.persistSessionFeedback()
        }
        ctx.add('status', String(payload.note || '已记录路由纠错反馈'), data.from, ctx.getActiveTurn() || 0, runId)
        return
      }
      if (st === 'route_feedback_failed') {
        ctx.add('status', '路由反馈保存失败，请重试', data.from, ctx.getActiveTurn() || 0, runId)
        return
      }
      if (st === 'resumed') {
        const payload = data.data as Record<string, unknown>
        const count = Number(payload.userMessageCount)
        if (Number.isFinite(count) && count >= 0) ctx.setUserMessageIndexCounter(Math.max(ctx.getUserMessageIndexCounter(), count))
        const history = payload.chatHistory
        if (Array.isArray(history) && history.length) {
          ctx.hydrateLogsFromServerHistory(
            history as Array<{ role?: string; content?: string; runId?: string; uiMeta?: unknown }>
          )
        }
        ctx.sanitizeWithdrawnTurns()
        ctx.reconcileTurnFeedbackKeys()
        void ctx.hydrateSessionFeedbackFromServer()
        ctx.touchCurrentSessionHistory({ bump: false })
      }
      if (st === 'turn_withdrawn') {
        const payload = data.data as Record<string, unknown>
        const count = Number(payload.userMessageCount)
        if (Number.isFinite(count) && count >= 0) ctx.setUserMessageIndexCounter(count)
        ctx.touchCurrentSessionHistory({ bump: false })
        ctx.add('status', '已同步撤回服务端会话', data.from, 0, runId)
        return
      }
      if (st === 'cancel_noop') {
        ctx.add('status', '取消：当前没有正在执行的任务（或已结束）。', data.from, 0, runId)
        // 无参强制清本地 active，避免 runId 不匹配时永久卡在「取消」
        ctx.clearActiveRun()
        ctx.resetStepProgress()
        ctx.pendingHumanConfirm.value = null
        return
      }
      if (st === 'awaiting_human_confirm') {
        // 图已结束、等待确认条：清 active run，保留 pendingHumanConfirm
        ctx.clearActiveRun()
        ctx.resetStepProgress()
        return
      }
      if (st === 'canceled' || st === 'canceled_by_new_chat') {
        ctx.add('status', st === 'canceled_by_new_chat' ? '已取消上一任务并开始新对话。' : '任务已取消。', data.from, 0, runId)
        ctx.clearActiveRun()
        ctx.resetStepProgress()
        ctx.stepResultsByTurn.value = {}
        ctx.pendingHumanConfirm.value = null
        for (const key of ['clean', 'visualize', 'report']) {
          const s = ctx.collabStates.value[key as CollabAgent]
          if (s === 'running' || s === 'pending') ctx.setCollabStatus(key, 'failed')
        }
        return
      }
      const payload = typeof data.data === 'string' ? data.data : JSON.stringify(data.data ?? {})
      ctx.add('status', payload, data.from, 0, runId)
      return
    }
    if (event === 'phase') {
      const raw = data.data
      let phase = ''
      if (typeof raw === 'string') {
        phase = raw
      } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const o = raw as { name?: unknown; runPhase?: unknown; phase?: unknown }
        const name = String(o.name ?? o.phase ?? '').trim()
        const runPhase = Number(o.runPhase)
        if (name && Number.isFinite(runPhase) && runPhase > 0) {
          phase = `${name}:phase${runPhase}`
        } else {
          phase = name
        }
      } else {
        phase = String(raw || '')
      }
      ctx.currentPhase.value = phase
      const agent = phase.startsWith('execute:') ? phase.slice('execute:'.length) : ''
      if (agent) ctx.setCollabStatus(agent, 'running')
      // synth_stream 仅驱动流式 UI，避免与 synth 重复写入过程日志
      if (phase && phase !== 'synth_stream') {
        ctx.add('phase', phase, data.from, turn, runId)
      }
      return
    }
    if (event === 'plan_steps') {
      ctx.applyPlanStepsPayload(data.data)
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : null
      const dag = ctx.routeCapLive.value?.dag || ''
      const steps = ctx.planStepsTodo.value.length ? [...ctx.planStepsTodo.value] : []
      if (steps.length) {
        ctx.add(
          'plan_outline',
          dag || `${steps.length} 步`,
          data.from,
          turn,
          runId,
          { planOutline: { dag, steps } }
        )
      }
      return
    }
    if (event === 'route_plan_card') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : null
      if (p) {
        const card = ctx.parseRoutePlanCardPayload(p)
        const agents = card.agents || []
        const capLabel = card.capLabel || agents.map((a) => ctx.planAgentLabel(a)).join(' → ')
        ctx.add(
          'route_plan_card',
          card.blueprintDag || capLabel,
          data.from,
          turn,
          runId,
          { routePlanCard: card }
        )
      }
      return
    }
    if (event === 'route_cap') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : null
      if (p) {
        const agents = Array.isArray(p.agents) ? (p.agents as string[]).map((a) => String(a).trim()).filter(Boolean) : []
        const capLabel = String(p.capLabel || agents.join('、'))
        ctx.routeCapLive.value = {
          intent: String(p.intent || ''),
          agents,
          capLabel,
          dag: ctx.routeCapLive.value?.dag
        }
        ctx.add(
          'route_cap',
          agents.length ? agents.map((a) => ctx.planAgentLabel(a)).join(' → ') : capLabel,
          data.from,
          turn,
          runId,
          {
            routeCap: {
              intent: String(p.intent || ''),
              agents,
              capLabel,
              needsWebSearch: p.needsWebSearch === true
            }
          }
        )
      }
      return
    }
    if (event === 'plan_dag') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : null
      const dag = String(p?.dag || '').trim()
      if (dag) {
        ctx.routeCapLive.value = {
          intent: ctx.routeCapLive.value?.intent || '',
          agents: ctx.routeCapLive.value?.agents?.length
            ? ctx.routeCapLive.value.agents
            : Array.isArray(p?.agents)
              ? (p!.agents as string[]).map((a) => String(a))
              : [],
          capLabel: ctx.routeCapLive.value?.capLabel || '',
          dag
        }
        const steps = ctx.planStepsTodo.value.length
          ? [...ctx.planStepsTodo.value]
          : []
        ctx.add(
          'plan_outline',
          dag,
          data.from,
          turn,
          runId,
          { planOutline: { dag, steps } }
        )
      }
      return
    }
    if (event === 'plan_preview') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : null
      if (p && Array.isArray(p.steps)) {
        const rid = runId || String(p.runId || '')
        const suggestedRaw = String(p.suggestedPosture || '').trim().toLowerCase()
        const suggestedPosture =
          suggestedRaw === 'ask' || suggestedRaw === 'plan' || suggestedRaw === 'agent' || suggestedRaw === 'debug'
            ? suggestedRaw
            : undefined
        ctx.pendingPlanPreview.value = {
          runId: rid,
          previewId: String(p.previewId || ''),
          hint: String(p.hint || ''),
          constraints: String(p.constraints || ''),
          approveTier: (['auto', 'plan', 'strict'].includes(String(p.approveTier || ''))
            ? String(p.approveTier)
            : 'plan') as 'auto' | 'plan' | 'strict',
          riskScore: Number(p.riskScore || 0) || 0,
          ...(suggestedPosture ? { suggestedPosture } : {}),
          routePlan:
            p.routePlan && typeof p.routePlan === 'object'
              ? ctx.parseRoutePlanCardPayload(p.routePlan as Record<string, unknown>)
              : null,
          steps: (p.steps as Array<Record<string, unknown>>).map((s) => ({
            id: String(s.id || ''),
            agent: String(s.agent || ''),
            agentLabel: String(s.agentLabel || ctx.planAgentLabel(String(s.agent || ''))),
            query: String(s.query || ''),
            enabled: s.enabled !== false,
            optional: Boolean(s.optional),
            confirmMode: (['hitl', 'auto_confirm', 'none'].includes(String(s.confirmMode || ''))
              ? String(s.confirmMode)
              : 'none') as 'hitl' | 'auto_confirm' | 'none',
            confirmReason: String(s.confirmReason || '') || undefined
          }))
        }
        if (suggestedPosture) {
          ctx.add(
            'status',
            `编排建议：切换到 ${suggestedPosture === 'plan' ? 'Plan' : suggestedPosture === 'ask' ? 'Ask' : suggestedPosture === 'debug' ? 'Debug' : 'Agent'}`,
            data.from,
            turn,
            rid,
            { suggestedPosture }
          )
        }
        ctx.applyPlanStepsPayload(p)
        ctx.planPreviewSending.value = false
      }
      return
    }
    if (event === 'plan_confirm_ack') {
      ctx.planPreviewSending.value = false
      ctx.pendingPlanPreview.value = null
      return
    }
    if (event === 'collab_preview') {
      const payload = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {}
      const agent = String(payload.agent || '').toLowerCase()
      const summary = String(payload.summary || '').trim()
      if (agent && summary) ctx.setCollabPreview(agent, summary)
      return
    }
    if (event === 'step_status') {
      const payload = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {}
      const agent = String(payload.agent || '').toLowerCase()
      const status = String(payload.status || '').toLowerCase()
      const stepId = String(payload.stepId || agent || '_step')
      if (payload.trace_id) ctx.activeTraceId.value = String(payload.trace_id)
      else if (runId) ctx.activeTraceId.value = runId
      ctx.stepProgressMap.value = {
        ...ctx.stepProgressMap.value,
        [stepId]: {
          stepId,
          agent,
          status,
          pct: typeof payload.pct === 'number' ? payload.pct : undefined,
          eta_ms: typeof payload.eta_ms === 'number' ? payload.eta_ms : undefined,
          stage: typeof payload.stage === 'string' ? payload.stage : undefined,
          trace_id: payload.trace_id ? String(payload.trace_id) : runId || undefined
        }
      }
      ctx.updatePlanStepFromStatus(payload)
      if (status === 'pending') ctx.setCollabStatus(agent, 'pending')
      else if (status === 'running') ctx.setCollabStatus(agent, 'running')
      else if (status === 'success') ctx.setCollabStatus(agent, 'success')
      else if (status === 'failed') ctx.setCollabStatus(agent, 'failed')
      return
    }
    if (event === 'step_result') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as StepResultItem) : null
      if (p?.stepId) {
        const list = ctx.stepResultsByTurn.value[turn] || []
        ctx.stepResultsByTurn.value = {
          ...ctx.stepResultsByTurn.value,
          [turn]: [...list.filter((x) => x.stepId !== p.stepId), p]
        }
        const st = String(p.status || '').trim()
        if (st === 'success' || st === 'failed') {
          ctx.updatePlanStepFromStatus({
            stepId: p.stepId,
            agent: p.agent,
            status: st,
            pct: st === 'success' ? 100 : undefined,
            error: p.error,
            query: p.query
          })
          if (st === 'success') ctx.setCollabStatus(String(p.agent || ''), 'success')
          else ctx.setCollabStatus(String(p.agent || ''), 'failed')
        }
      }
      return
    }
    if (event === 'health') {
      if (data?.data && typeof data.data === 'object') {
        ctx.toolHealthLive.value = data.data as Record<string, unknown>
      }
      const summary =
        data?.data && typeof data.data === 'object' ? String((data.data as { summary?: string }).summary || '') : ''
      ctx.add('status', summary ? `工具健康：${summary}` : '工具健康已更新', data.from, turn, runId)
      return
    }
    if (event === 'thinking') {
      const thinkingText = String(data.data || '')
      ctx.add('thinking', thinkingText, data.from, turn, runId)
      if (/已剔除写副作用专才/.test(thinkingText)) {
        ctx.notePostureWriteFiltered(turn, runId)
      }
      return
    }
    if (event === 'posture_hint') {
      ctx.applyPostureHint(data.data)
      const payload = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {}
      const reason = String(payload.reason || 'posture_blocked')
      ctx.add(
        'status',
        reason === 'debug_needs_observation' || reason === 'debug_no_observation'
          ? 'Debug 门禁：缺少 Step Observation，请先用 Agent 跑一轮'
          : `协作姿态提示：${reason}`,
        data.from,
        turn,
        runId,
        {
          postureBlocked: reason === 'debug_needs_observation' ? 'debug_no_observation' : reason,
          collaborationPosture: 'debug'
        }
      )
      return
    }
    if (event === 'thought_delta') {
      const payload = data?.data
      const text =
        typeof payload === 'string'
          ? payload
          : payload && typeof payload === 'object'
            ? String((payload as { text?: string }).text || '')
            : ''
      const line = text.trim()
      if (line) ctx.add('thought_delta', line, data.from, turn, runId)
      return
    }
    if (event === 'run_report') {
      const payload = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : null
      if (payload) {
        ctx.add(
          'run_report',
          JSON.stringify(payload),
          data.from,
          turn,
          runId
        )
      }
      return
    }
    if (event === 'dry_run_result') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {}
      const badge = String(p.badge || '试跑，未写入').trim()
      const message = String(p.message || '').trim()
      const agent = String(p.agent || '').trim()
      ctx.add(
        'status',
        `[dry-run] ${badge}${agent ? ` · ${agent}` : ''}${message ? `：${message.slice(0, 240)}` : ''}`,
        data.from,
        turn,
        runId
      )
      return
    }
    if (event === 'human_confirm_request') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {}
      const confirmId = String(p.confirmId || '').trim()
      const agent = String(p.agent || 'gui').trim()
      const screenshotDataUrl = String(p.screenshotDataUrl || p.screenshot || '').trim()
      const checkpointResume = p.checkpointResume === true
      if (runId && confirmId) {
        ctx.pendingHumanConfirm.value = {
          runId,
          confirmId,
          title: String(p.title || '需要确认').trim(),
          message: String(p.message || '').trim(),
          agent,
          screenshotDataUrl: screenshotDataUrl || undefined,
          pageUrl: String(p.pageUrl || '').trim() || undefined,
          failureType: String(p.failureType || '').trim() || undefined,
          lobsterRunId: String(p.lobsterRunId || '').trim() || undefined,
        }
        if (screenshotDataUrl && agent === 'gui') {
          ctx.latestGuiScreenshot.value = screenshotDataUrl
        }
        ctx.humanConfirmSending.value = false
        ctx.add('status', `等待确认：${String(p.title || (agent === 'admin' ? '个人事务写操作' : 'GUI 操作'))}`, data.from, turn, runId)
        // checkpoint 续跑：图已结束，清 Cancel 态；图内 GUI 确认仍保持 isRunActive
        if (checkpointResume) {
          ctx.clearActiveRun(runId)
        }
      }
      return
    }
    if (event === 'task_constraints') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : null
      if (p) {
        ctx.taskConstraintsLive.value = {
          timeHints: Array.isArray(p.timeHints) ? p.timeHints.map((x) => String(x ?? '').trim()).filter(Boolean) : [],
          subjectHints: Array.isArray(p.subjectHints)
            ? p.subjectHints.map((x) => String(x ?? '').trim()).filter(Boolean)
            : [],
          wantsVisualize: Boolean(p.wantsVisualize),
          wantsReport: Boolean(p.wantsReport)
        }
      }
      return
    }
    if (event === 'conversation_compact') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : null
      if (p && p.compacted === true) {
        ctx.conversationCompactLive.value = {
          compacted: true,
          fullChars: Number(p.fullChars || 0) || undefined,
          compactChars: Number(p.compactChars || 0) || undefined,
          savedRatio: Number(p.savedRatio || 0) || undefined,
          turns: Number(p.turns || 0) || undefined
        }
      }
      return
    }
    if (event === 'phase_timeline') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : null
      if (p) {
        ctx.runObservabilityLive.value = {
          runId: runId || String(p.runId || ''),
          phaseTimeline: Array.isArray(p.phaseTimeline) ? (p.phaseTimeline as RunPhaseItem[]) : [],
          tokenSummary: (p.tokenSummary as RunTokenSummary) || null,
          wallClockMs: Number(p.wallClockMs || 0)
        }
      }
      return
    }
    if (event === 'run_metrics') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : null
      if (p) {
        ctx.runObservabilityLive.value = {
          runId: runId || ctx.runObservabilityLive.value?.runId || String(p.runId || ''),
          phaseTimeline: ctx.runObservabilityLive.value?.phaseTimeline || [],
          tokenSummary: (p.tokenSummary as RunTokenSummary) || ctx.runObservabilityLive.value?.tokenSummary || null,
          wallClockMs: Number(p.wallClockMs || ctx.runObservabilityLive.value?.wallClockMs || 0)
        }
      }
      return
    }
    if (event === 'human_confirm_ack') {
      ctx.pendingHumanConfirm.value = null
      ctx.latestGuiScreenshot.value = ''
      ctx.latestGuiVncUrl.value = ''
      ctx.humanConfirmSending.value = false
      ctx.onHumanConfirmAck?.()
      return
    }
    if (event === 'gui_screenshot') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {}
      const dataUrl = String(p.dataUrl || p.screenshot || '').trim()
      const pageUrl = String(p.pageUrl || p.url || '').trim()
      if (dataUrl) ctx.latestGuiScreenshot.value = dataUrl
      const label = pageUrl ? `GUI 截图（${pageUrl}）` : 'GUI 截图'
      ctx.add('gui_screenshot', label, data.from || 'gui', turn, runId, {
        guiScreenshot: dataUrl || undefined
      })
      return
    }
    if (event === 'gui_live_view') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {}
      let vncUrl = String(p.vncUrl || p.vnc_url || '').trim()
      const hint = String(p.hint || '').trim()
      // 浏览器无法解析 Docker 服务名：改写为 localhost（端口映射场景）
      if (vncUrl && typeof window !== 'undefined') {
        try {
          const u = new URL(vncUrl)
          if (/^(lobster_agent|lobster-agent)$/i.test(u.hostname)) {
            u.hostname = 'localhost'
            vncUrl = u.toString()
          }
        } catch {
          /* keep */
        }
      }
      if (vncUrl) ctx.latestGuiVncUrl.value = vncUrl
      const label = vncUrl
        ? '打开浏览器画面（noVNC）'
        : hint
          ? `浏览器画面：${hint}`
          : '浏览器画面'
      ctx.add('gui_live_view', label, data.from || 'gui', turn, runId, {
        guiVncUrl: vncUrl || undefined,
      })
      // 每轮任务自动打开一次实时画面（与 Lobster 工作台 autoOpenVnc 对齐）
      const runKey = String(runId || turn || '')
      if (
        vncUrl &&
        typeof window !== 'undefined' &&
        runKey &&
        ctx.guiVncAutoOpenedRunId.value !== runKey
      ) {
        ctx.guiVncAutoOpenedRunId.value = runKey
        try {
          window.open(vncUrl, 'manager_gui_novnc', 'noopener,noreferrer,width=1280,height=800')
        } catch {
          /* popup blocked */
        }
      }
      return
    }
    if (event === 'db_explain') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {}
      const insights = Array.isArray(p.insights)
        ? p.insights.map((x) => String(x ?? '').trim()).filter(Boolean)
        : []
      if (insights.length) {
        ctx.add('db_explain', insights.map((x, i) => `${i + 1}. ${x}`).join('\n'), data.from || 'db', turn, runId)
      }
      return
    }
    if (event === 'agent_evidence') {
      const payload = data?.data && typeof data.data === 'object' ? data.data : {}
      const citations = ctx.normalizeRagCitations(
        Array.isArray((payload as { citations?: unknown[] }).citations) ? (payload as { citations: unknown[] }).citations : []
      )
      if (citations.length) {
        const agent = String((payload as { agent?: string }).agent || data.from || 'rag')
        ctx.add('agent_evidence', `知识库 ${citations.length} 条引用`, agent, turn, runId, { ragEvidence: citations })
      }
      return
    }
    if (event === 'admin_ui_cards') {
      const payload = data?.data && typeof data.data === 'object' ? data.data : {}
      const cards = Array.isArray((payload as { cards?: unknown[] }).cards)
        ? (payload as { cards: unknown[] }).cards
        : []
      if (cards.length) {
        ctx.add('admin_ui_cards', `个人助手：${cards.length} 张地图结果卡片`, 'admin', turn, runId, { adminUiCards: cards })
      }
      return
    }
    if (event === 'user_facing') {
      const payload = data?.data && typeof data.data === 'object' ? data.data : null
      if (payload) {
        ctx.add('user_facing', String((payload as { summary?: string }).summary || '用户态结论'), data.from, turn, runId, {
          userFacing: payload
        })
      }
      return
    }
    if (event === 'agent_error') {
      const payload = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {}
      const agent = String(payload.agent || data.from || 'manager')
      const msg = String(payload.message || payload.code || 'agent error')
      const retryable = Boolean(payload.retryable)
      ctx.add('error', `[${agent}] ${msg}${retryable ? '（可重试）' : ''}`, agent, turn, runId)
      return
    }
    if (event === 'search_sources') {
      const payload = data?.data && typeof data.data === 'object' ? data.data : {}
      const hits = Array.isArray((payload as { hits?: unknown[] }).hits) ? (payload as { hits: unknown[] }).hits : []
      const sources = ctx.normalizeSearchHits(hits)
      if (sources.length) {
        const label =
          String((payload as { source?: string }).source || '') === 'crawler'
            ? `爬虫 ${sources.length} 条`
            : `SERP ${sources.length} 条`
        ctx.add('search_sources', label, data.from, turn, runId, { searchSources: sources })
      }
      return
    }
    if (event === 'delta') {
      const from = String(data.from || 'assistant').toLowerCase()
      if (from === 'synth') {
        ctx.streamingSynthText.value += String(data.data || '')
        return
      }
      if (from === 'rag' || from === 'code') ctx.streamAgentLabel.value = from
      ctx.setCurrentAssistant(ctx.getCurrentAssistant() + String(data.data || ''))
      ctx.add('delta', String(data.data || ''), data.from, turn, runId)
      return
    }
    if (event === 'message') {
      ctx.setCurrentAssistant('')
      const messageText = String(data.data || '')
      ctx.add('assistant', messageText, data.from, turn, runId)
      return
    }
    if (event === 'final') {
      ctx.setCurrentAssistant('')
      let finalText = String(data.data || '').trim()
      if (!finalText || ctx.bogusFinalText.test(finalText)) {
        const mm = ctx.extractMultimodalFromTraceLogs(turn, runId)
        if (mm) finalText = mm
        else if (ctx.bogusFinalText.test(finalText)) finalText = ''
      }
      if (!finalText) {
        finalText = '宇宙背景已切换完成：星河、黑洞、白洞与可拖动视角已启用。'
      }
      const streamed = ctx.stripSynthPromptLeakage(String(ctx.streamingSynthText.value || '').trim())
      if (streamed) {
        finalText = ctx.pickRicherNarrativeWithAuxBlocks(streamed, finalText)
      }
      for (const key of ['clean', 'visualize', 'report']) {
        const s = ctx.collabStates.value[key as CollabAgent]
        if (s === 'running' || s === 'pending') ctx.setCollabStatus(key, 'success')
      }
      ctx.add(
        'final',
        finalText || '（未收到可展示的回复正文，请展开上方思考过程查看 multimodal 步骤）',
        data.from,
        turn,
        runId
      )
      if (runId) ctx.clearActiveRun(runId)
      if (runId) ctx.lastFinalRunId.value = runId
      ctx.streamingSynthText.value = ''
      ctx.resetStepProgress()
      ctx.touchCurrentSessionHistory({ bump: true })
      return
    }
    if (event === 'proactive_nudge') {
      const payload = data?.data && typeof data.data === 'object' ? data.data : {}
      ctx.absorbProactiveNudges((payload as { nudges?: unknown[] }).nudges)
      return
    }
    if (event === 'autonomous_result') {
      const p = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {}
      const title = String(p.title || '自治推进')
      const ok = p.ok !== false
      const body = ok
        ? String(p.finalText || '（无正文）')
        : `自治推进失败：${String(p.error || 'unknown')}`
      ctx.add('status', `[自治推进] ${title} · ${ok ? '已完成' : '失败'}`, data.from, 0, runId)
      ctx.add('assistant', body, 'manager', 0, runId)
      return
    }
    if (event === 'task_stack') {
      const payload = data?.data && typeof data.data === 'object' ? data.data : {}
      const items = (payload as { stack?: { items?: unknown[] } }).stack?.items
      if (Array.isArray(items)) ctx.applyTaskStackFromServer(items)
      return
    }
    if (event === 'error') {
      for (const key of ['clean', 'visualize', 'report']) {
        const s = ctx.collabStates.value[key as CollabAgent]
        if (s === 'running') ctx.setCollabStatus(key, 'failed')
      }
      const errText = String(data.data || 'unknown error')
      if (/runId\s*不存在或已结束/i.test(errText) || /abort(ed)?/i.test(errText)) {
        ctx.add('status', /abort(ed)?/i.test(errText) ? '任务已取消。' : '取消：该任务已结束，无需操作。', data.from, turn, runId)
        if (runId) ctx.clearActiveRun(runId)
        ctx.resetStepProgress()
        ctx.pendingHumanConfirm.value = null
        return
      }
      ctx.add('error', errText, data.from, turn, runId)
      if (runId) ctx.clearActiveRun(runId)
      return
    }
    if (event === 'run_artifacts') {
      const payload = data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {}
      const rid = String(payload.runId || runId || '').trim()
      if (rid) {
        ctx.runArtifactsByRunId.value = { ...ctx.runArtifactsByRunId.value, [rid]: payload }
      }
      return
    }
    if (event === 'trace') {
      if (runId) ctx.activeTraceId.value = runId
      ctx.add('trace', JSON.stringify(data.data ?? {}), data.from, turn, runId)
      return
    }
    if (ctx.isPlanStepsJsonLog(JSON.stringify(data))) return
    ctx.add('event', JSON.stringify(data), data.from, turn, runId)
}
