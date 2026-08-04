import type { WsHandlerContext, ParsedWsMessage } from './types'
import {
  HumanMessage,
  crypto,
  RunIdSchema,
  createManagerGraph,
  buildManagerGraphInvokeConfig,
  composeFinalBundleFromGraphResult,
  pickRicherFinalText,
  deleteHumanConfirmCheckpoint,
  loadHumanConfirmCheckpoint,
  isSynthRejectingMedia,
  resolveManagerLlmConfig,
  resolveAgentEndpointsWithPlatform,
  buildCompactedHistoryWithStats,
  buildSummarizeWithLlmFn,
  graphAgentEndpoints,
  buildRagHistoryForRun,
  sanitizeHistoryText,
  withAgentTraceContext,
  emitRunObservability,
  emitImplicitLearning,
  loadTaskStack,
  path,
  runs,
  runMeta,
  sessionMeta,
  sessions,
  readSession,
  writeSession,
  nowMs,
  isRunAbortError,
  useRuntimeConfig,
  resolveGuiConfirm
} from './wsBarrel'
import { takeRunProcessUiMeta, clearRunProcess } from '../../../utils/session/runProcessAccumulator'

export async function handleHumanConfirm(ctx: WsHandlerContext, payload: ParsedWsMessage) {
  const { peer, send, sessionId, boundUserId, tenantId, explicitUserId, platformTraceId } = ctx

  const decision = payload.decision
  const inlineRunId = String((payload as any).runId || '').trim()
  const confirmId = String((payload as any).confirmId || '').trim()
  if (inlineRunId && confirmId) {
    const approved = decision === 'confirm'
    const resolved = resolveGuiConfirm(inlineRunId, confirmId, approved)
    void import('#agent-shared/runTraceStore')
      .then(({ recordHitlDecision }) =>
        recordHitlDecision({
          runId: inlineRunId,
          sessionId,
          tenantId,
          confirmId,
          decision: approved ? 'confirm' : 'cancel',
          payload: { kind: 'gui_confirm', resolved }
        })
      )
      .catch(() => undefined)
    // 图内 waitGuiConfirm 命中则结束；未命中则落 checkpoint 续跑（post-graph admin 确认）
    if (resolved) {
      send(
        'human_confirm_ack',
        { ok: approved, resolved: true, confirmId, runId: inlineRunId },
        'manager',
        inlineRunId
      )
      return
    }
  }

  let session = sessions.get(sessionId)
  if (!session) {
    session = await readSession(sessionId)
    sessions.set(sessionId, session)
  }
  const checkpoint = decision === 'confirm' ? await loadHumanConfirmCheckpoint(sessionId) : undefined
  const runtimeConfig = useRuntimeConfig() as any
  const llm = await resolveManagerLlmConfig(runtimeConfig)
  const agents = runtimeConfig.agents || {}
  const defaultDbId = String(runtimeConfig.managerDefaultDbId || agents.dbId || process.env.MANAGER_DB_ID || '').trim()
  const effectiveDbId = defaultDbId || undefined
  if (!llm.openaiApiKey) return send('error', '缺少 OPENAI_API_KEY', 'manager')
  if (!llm.openaiBaseUrl) return send('error', '缺少 OPENAI_BASE_URL', 'manager')
  if (!llm.openaiModel) return send('error', '缺少 OPENAI_MODEL', 'manager')

  const runId = crypto.randomUUID()
  if (!RunIdSchema.safeParse(runId).success) {
    send('error', 'runId 生成失败', 'manager')
    return
  }

  // 无 Admin checkpoint 却点了确认：直接收束，禁止整图重跑 GUI
  if (decision === 'confirm' && !checkpoint) {
    send('human_confirm_ack', { ok: true, resolved: false, reason: 'no_admin_checkpoint' }, 'manager', runId)
    send('final', '已确认。当前无待执行的个人事务写操作。', 'manager', runId)
    return
  }

  const ctrl = new AbortController()
  runs.set(runId, ctrl)
  runMeta.set(runId, { startedAtMs: nowMs(), sessionId, tenantId })
  sessionMeta.set(sessionId, { lastActiveMs: nowMs(), activeRunId: runId })
  void import('#agent-shared/runTraceStore')
    .then(({ recordHitlDecision }) =>
      recordHitlDecision({
        runId,
        sessionId,
        tenantId,
        decision: decision === 'confirm' ? 'confirm' : decision === 'cancel' ? 'cancel' : 'reject',
        payload: { kind: 'admin_resume', hasCheckpoint: Boolean(checkpoint) }
      })
    )
    .catch(() => undefined)
  send('thinking', '总管 Agent：开始续执行（不写入确认文本到上下文）…', 'manager', runId)

  try {
    if (checkpoint && decision === 'confirm') {
      await deleteHumanConfirmCheckpoint(sessionId)
    }
    const [endpointResolved, historyPack] = await Promise.all([
      resolveAgentEndpointsWithPlatform(process.env),
      buildCompactedHistoryWithStats({
        messages: session.messages,
        sanitize: sanitizeHistoryText,
        summarizeWithLlm: buildSummarizeWithLlmFn({
          openaiApiKey: llm.openaiApiKey,
          openaiBaseUrl: llm.openaiBaseUrl,
          openaiModel: llm.openaiModel,
          sessionId
        })
      })
    ])
    const history = historyPack.messages
    if (historyPack.compacted) {
      send(
        'conversation_compact',
        {
          compacted: true,
          fullChars: historyPack.fullChars,
          compactChars: historyPack.compactChars,
          savedRatio: Math.round(historyPack.savedRatio * 1000) / 1000,
          turns: session.messages.length
        },
        'manager',
        runId
      )
    }
    const graph = createManagerGraph({
      openaiApiKey: llm.openaiApiKey,
      openaiBaseUrl: llm.openaiBaseUrl,
      openaiModel: llm.openaiModel,
      llmProfile: {
        modelRoute: llm.modelRoute,
        modelRouteMax: llm.modelRouteMax,
        modelPlan: llm.modelPlan,
        modelSynth: llm.modelSynth,
        modelCritic: llm.modelCritic,
        modelVerifier: llm.modelVerifier,
        modelLowCost: llm.modelLowCost
      },
      dbId: effectiveDbId,
      ...graphAgentEndpoints(agents, endpointResolved),
      sendEvent: ({ event, data, from }) => send(event, data, from, runId),
      threadId: `mgr-${peer.id}-${runId}`,
      runId,
      sessionId,
      userId: boundUserId || undefined,
      tenantId,
      platformTraceId,
      ragConversationId: sessionId,
      ragHistory: buildRagHistoryForRun(
        session,
        sanitizeHistoryText([...session.messages].reverse().find((m) => m.role === 'user')?.content || '')
      ),
      signal: ctrl.signal
    })

    const invokeState = (() => {
      if (decision === 'cancel') {
        return {
          messages: history,
          forceIntent: 'auto',
          humanDecision: decision,
          resumeAdminConfirm: false,
          resumeToSynth: false,
          meta: { platformOffline: endpointResolved.platformOffline }
        } as any
      }
      if (!checkpoint || decision !== 'confirm') {
        return {
          messages: history,
          forceIntent: 'auto',
          humanDecision: decision,
          resumeAdminConfirm: false,
          resumeToSynth: false,
          meta: { platformOffline: endpointResolved.platformOffline }
        } as any
      }
      const lastUser = [...(session?.messages || [])].reverse().find((m: any) => m?.role === 'user')?.content || ''
      const resumeQuery = String(checkpoint?.routedQuery || '').trim() || String(lastUser || '').trim()
      const resumeMessages = resumeQuery ? [new HumanMessage(resumeQuery)] : history
      const meta = {
        ...(checkpoint?.meta || {}),
        needsClarify: false,
        needsHumanConfirm: false,
        resumeAdminConfirm: true,
        lowCostMode: false,
        uncertainty: 'low',
        clarifyQuestions: [],
        allowRiskyWrites: true,
        blockAdminWrites: false,
        platformOffline: endpointResolved.platformOffline ?? checkpoint?.meta?.platformOffline
      }
      return {
        ...checkpoint,
        messages: resumeMessages,
        humanDecision: decision,
        resumeAdminConfirm: true,
        resumeToSynth: false,
        final: undefined,
        meta
      } as any
    })()

    const result = await withAgentTraceContext(
      { tenantId, userId: boundUserId || explicitUserId },
      () => graph.invoke(invokeState, buildManagerGraphInvokeConfig({ runId, sessionId }))
    )
    const outMessages = (result as any)?.messages
    const last = Array.isArray(outMessages) ? outMessages[outMessages.length - 1] : null
    const composedBundle = composeFinalBundleFromGraphResult(result)
    const composed = composedBundle.text
    const mmOut = String((result as any)?.results?.multimodal ?? '').trim()
    let fromMsg = String(last?.content ?? '').trim()
    const bogusFinal =
      /^(finalize|synth|critic|optimizer|verifier|monitor|planner|route|multi|clarify)$/i.test(fromMsg)
    if (bogusFinal) fromMsg = ''
    let finalText = pickRicherFinalText(composed, fromMsg)
    if (mmOut && isSynthRejectingMedia(finalText, mmOut)) {
      finalText = mmOut
    } else if (!finalText && mmOut) {
      finalText = mmOut
    }
    if (checkpoint && decision === 'confirm') {
      await deleteHumanConfirmCheckpoint(sessionId)
    }
    const uiMeta = takeRunProcessUiMeta(runId)
    session.messages.push({
      role: 'assistant',
      content: finalText,
      runId,
      ...(uiMeta ? { uiMeta } : {})
    })
    void writeSession(sessionId, session)
    const reportOut = String((result as any)?.results?.report || '').trim()
    const finalFrom =
      reportOut.length >= 40 || /<!--\s*REPORT\s*-->/i.test(finalText) ? 'report' : 'manager'
    await emitRunObservability(send, runId)
    send('user_facing', composedBundle.userFacing, 'manager', runId)
    send('final', finalText, finalFrom, runId)
    clearRunProcess(runId)
    try {
      const stack = await loadTaskStack(path.join(process.cwd(), '.data'), sessionId)
      send('task_stack', { stack }, 'manager', runId)
    } catch {}
    if (decision === 'cancel') {
      void emitImplicitLearning(runId, sessionId, 'human_reject')
    }
  } catch (e: any) {
    clearRunProcess(runId)
    if (isRunAbortError(ctrl, e)) {
      send('status', { status: 'canceled', runId, detail: '任务已取消' }, 'manager', runId)
    } else {
      send('error', String(e?.message || e || 'unknown error'), 'manager', runId)
    }
  } finally {
    runs.delete(runId)
    runMeta.delete(runId)
    const sMeta = sessionMeta.get(sessionId)
    if (sMeta?.activeRunId === runId)
      sessionMeta.set(sessionId, { lastActiveMs: sMeta?.lastActiveMs ?? nowMs(), activeRunId: undefined })
  }
}
