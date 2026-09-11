import type { WsHandlerContext, ParsedWsMessage } from './types'
import {
  acquireRunSlotWithAdmission,
  releaseRunSlotForTenant,
  cancelAdmissionTicket
} from '../../../graph/core/runtime/backpressure'
import { tryAcquireRequestRate } from '../../../graph/core/runtime/requestRateLimit'
import { crypto, RunIdSchema, createManagerGraph, buildManagerGraphInvokeConfig, buildManagerTurnInvokeState, composeFinalBundleFromGraphResult, buildHumanConfirmCheckpoint, pickRicherFinalText, saveHumanConfirmCheckpoint, isSynthRejectingMedia, resolveManagerLlmConfig, resolveAgentEndpointsWithPlatform, buildCompactedHistoryWithStats, buildSummarizeWithLlmFn, graphAgentEndpoints, buildRagHistoryForRun, sanitizeHistoryText, detectClarifyFollowUp, clarifyReplanMetaPatch, ingestTaskStackFromUserMessage, withAgentTraceContext, emitRunObservability, emitAdminHumanConfirmRequest, shouldPauseForPostGraphAdminConfirm, pauseAdminConfirmMessage, loadTaskStack, path, runs, runMeta, sessionMeta, sessions, readSession, writeSession, buildUserContent, stripAttachmentSuffix, resolveUserMessageAnchor, pruneAutoUserTasksOnEditResend, policyDataDir, emitImplicitLearning, allowRate, nowMs, isRunAbortError, useRuntimeConfig } from './wsBarrel'
import { takeRunProcessUiMeta, clearRunProcess } from '../../../utils/session/runProcessAccumulator'
import { stripStructuredExecReport } from '#agent-shared/synthOutputSanitize'

export async function handleChat(ctx: WsHandlerContext, payload: ParsedWsMessage) {
  const { peer, peerKey, send, sessionId, boundUserId, tenantId, explicitUserId, platformTraceId, payloadRaw } = ctx

if (!allowRate(`${peerKey}:chat`, 8, 30_000)) {
    send('error', '对话请求过于频繁，请稍后再试', 'manager')
    return
  }
   const text = String(payload.text ?? '').trim()
  const forceIntent = payload.forceIntent ?? 'auto'
  const mediaAttachment = payload.attachment ?? null
  const chatMode = 'mode' in payload && payload.mode ? payload.mode : 'normal'
  const userMessageIndex =
    'userMessageIndex' in payload && typeof payload.userMessageIndex === 'number' ? payload.userMessageIndex : undefined
  const anchorText =
    'anchorText' in payload && typeof (payload as { anchorText?: unknown }).anchorText === 'string'
      ? String((payload as { anchorText?: string }).anchorText || '').trim()
      : ''
   if (chatMode === 'normal' && !text && !mediaAttachment) {
    send('error', '请输入问题或上传附件', 'manager')
    return
  }
  if (chatMode === 'edit_resend' && !text) {
    send('error', '编辑后内容不能为空', 'manager')
    return
  }
  if (chatMode === 'regenerate' && typeof userMessageIndex !== 'number' && !text) {
    send('error', '重新生成需要 userMessageIndex 或原文', 'manager')
    return
  }
  if (chatMode === 'edit_resend' && typeof userMessageIndex !== 'number' && !anchorText) {
    send('error', '编辑重发需要 userMessageIndex 或原消息锚点', 'manager')
    return
  }
   const runtimeConfig = useRuntimeConfig() as any
  const llm = await resolveManagerLlmConfig(runtimeConfig)
  const agents = runtimeConfig.agents || {}
  const payloadDbId = 'dbId' in payload ? String(payload.dbId || '').trim() : ''
  const defaultDbId = String(runtimeConfig.managerDefaultDbId || agents.dbId || process.env.MANAGER_DB_ID || '').trim()
  const effectiveDbId = payloadDbId || defaultDbId || undefined
   if (!llm.openaiApiKey) {
    send('error', '缺少 OPENAI_API_KEY', 'manager')
    return
  }
  if (!llm.openaiBaseUrl) {
    send('error', '缺少 OPENAI_BASE_URL', 'manager')
    return
  }
  if (!llm.openaiModel) {
    send('error', '缺少 OPENAI_MODEL', 'manager')
    return
  }
   let session = sessions.get(sessionId)
  if (!session) {
    session = await readSession(sessionId)
    sessions.set(sessionId, session)
  }
   let effectiveText = text
  let effectiveAttachment = mediaAttachment
   if (chatMode === 'regenerate' || chatMode === 'edit_resend') {
    const hit = resolveUserMessageAnchor(session.messages, {
      userMessageIndex: typeof userMessageIndex === 'number' ? userMessageIndex : undefined,
      // regenerate：text 即原文；edit_resend：text 是新内容，用 anchorText 定位旧锚点
      text: chatMode === 'regenerate' ? text || undefined : anchorText || undefined
    })
    const idx = hit?.arrayIndex ?? -1
    const anchor = idx >= 0 ? session.messages[idx] : undefined
    if (!hit || !anchor || anchor.role !== 'user') {
      send(
        'error',
        chatMode === 'edit_resend' ? '找不到对应用户消息，无法编辑重发' : '找不到对应用户消息，无法重新生成',
        'manager'
      )
      return
    }
    const resolvedUserIndex = hit.userMessageIndex
    if (chatMode === 'regenerate') {
      session.messages = session.messages.slice(0, idx + 1)
      effectiveText = stripAttachmentSuffix(anchor.content)
      // 客户端若带了原文且与锚点一致，优先用客户端（已 strip）；否则用服务端锚点
      const clientText = stripAttachmentSuffix(text)
      if (clientText && clientText === effectiveText) effectiveText = clientText
      effectiveAttachment = null
      if (!effectiveText) {
        send('error', '该轮仅有附件，请使用编辑重发补充文字说明', 'manager')
        return
      }
      try {
        const { deleteSessionFeedbackAtUserMessageIndex } = await import(
          '#agent-shared/sessionFeedbackStore'
        )
        await deleteSessionFeedbackAtUserMessageIndex('manager', sessionId, resolvedUserIndex)
      } catch {
        /* optional PG */
      }
      try {
        const { resolveManagerPolicyDir } = await import('../../../utils/session/managerPolicyDir')
        const { supersedeLearningSignalsForRevision } = await import(
          '../../../graph/core/unifiedLearning'
        )
        const r = await supersedeLearningSignalsForRevision({
          policyDir: resolveManagerPolicyDir(tenantId),
          sessionId,
          userMessageIndex: resolvedUserIndex,
          userText: effectiveText,
          reason: 'regenerate'
        })
        if (r.superseded > 0) {
          send(
            'thinking',
            `学习信号：已作废同轮旧样本 ${r.superseded} 条（重新生成）`,
            'manager'
          )
        }
      } catch {
        /* optional */
      }
    } else {
      session.messages = session.messages.slice(0, idx)
      const userContent = buildUserContent(text, mediaAttachment)
      session.messages.push({ role: 'user', content: userContent })
      effectiveText = text
      await pruneAutoUserTasksOnEditResend(policyDataDir(), sessionId)
      try {
        const { resolveManagerPolicyDir } = await import('../../../utils/session/managerPolicyDir')
        const { supersedeLearningSignalsForRevision } = await import(
          '../../../graph/core/unifiedLearning'
        )
        await supersedeLearningSignalsForRevision({
          policyDir: resolveManagerPolicyDir(tenantId),
          sessionId,
          userMessageIndex: resolvedUserIndex,
          userText: stripAttachmentSuffix(anchorText || anchor.content),
          reason: 'edit_resend'
        })
      } catch {
        /* optional */
      }
    }
    sessions.set(sessionId, session)
    void writeSession(sessionId, session)
  } else {
    const userContent = buildUserContent(text, mediaAttachment)
    session.messages.push({ role: 'user', content: userContent })
    sessions.set(sessionId, session)
    void writeSession(sessionId, session)
  }
   const prevRunId = sessionMeta.get(sessionId)?.activeRunId
  if (prevRunId) {
    cancelAdmissionTicket(prevRunId)
    const prevCtrl = runs.get(prevRunId)
    prevCtrl?.abort()
    void emitImplicitLearning(prevRunId, sessionId, 'new_chat_interrupt')
    runs.delete(prevRunId)
    runMeta.delete(prevRunId)
    send('status', { status: 'canceled_by_new_chat', runId: prevRunId }, 'manager', prevRunId)
  }
  const runRate = tryAcquireRequestRate({
    key: String(tenantId || boundUserId || peerKey || 'anon'),
    nowMs: nowMs()
  })
  if (!runRate.ok) {
    send('error', { error_code: 'rate_limited', message: runRate.reason }, 'manager')
    return
  }
  const runId = crypto.randomUUID()
  if (!RunIdSchema.safeParse(runId).success) {
    send('error', 'runId 生成失败', 'manager')
    return
  }
  const ctrl = new AbortController()
  runs.set(runId, ctrl)
  sessionMeta.set(sessionId, { lastActiveMs: nowMs(), activeRunId: runId })
  runMeta.set(runId, { startedAtMs: nowMs(), sessionId, tenantId })
  const runSlot = await acquireRunSlotWithAdmission({
    tenantId: String(tenantId || 'default'),
    runId,
    signal: ctrl.signal,
    onQueued: (info) => {
      send(
        'status',
        {
          status: 'queued',
          runId,
          position: info.position,
          queueDepth: info.queueDepth,
          etaMs: info.etaMs
        },
        'manager',
        runId
      )
    }
  })
  if (!runSlot.ok) {
    runs.delete(runId)
    runMeta.delete(runId)
    const sMeta = sessionMeta.get(sessionId)
    if (sMeta?.activeRunId === runId) {
      sessionMeta.set(sessionId, { lastActiveMs: sMeta.lastActiveMs ?? nowMs(), activeRunId: undefined })
    }
    send(
      'error',
      { error_code: runSlot.error_code || 'overloaded', message: runSlot.reason },
      'manager',
      runId
    )
    return
  }
  const chatStartedAtMs = nowMs()
  runMeta.set(runId, { startedAtMs: chatStartedAtMs, sessionId, tenantId })
  if (runSlot.queued) {
    send(
      'status',
      { status: 'admitted', runId, waitedMs: runSlot.waitedMs },
      'manager',
      runId
    )
  }
  send('thinking', '总管 Agent：开始处理…', 'manager', runId)
  try {
    const ingestPromise = effectiveText
      ? ingestTaskStackFromUserMessage(sessionId, effectiveText, send, runId, {
          openaiApiKey: llm.openaiApiKey,
          openaiModel: llm.modelRoute || llm.openaiModel,
          openaiBaseUrl: llm.openaiBaseUrl
        })
      : Promise.resolve()
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
      }),
      ingestPromise
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
      ragHistory: buildRagHistoryForRun(session, effectiveText),
      signal: ctrl.signal
    })
     const clarifyFollowUp =
      chatMode === 'normal' ? detectClarifyFollowUp(session.messages, effectiveText) : null
    const clarifyMeta = clarifyFollowUp ? clarifyReplanMetaPatch(clarifyFollowUp) : {}
    if (clarifyFollowUp) {
      send('thinking', `clarify→replan：已合并补答「${clarifyFollowUp.reply.slice(0, 48)}」`, 'manager', runId)
    }
     const result = await withAgentTraceContext(
      { tenantId, userId: boundUserId || explicitUserId },
      () =>
        graph.invoke(
          buildManagerTurnInvokeState({
            messages: history,
            forceIntent,
            mediaAttachment: effectiveAttachment || null,
            meta: {
              platformOffline: endpointResolved.platformOffline,
              turnRunId: runId,
              userMessageIndex: (() => {
                let n = 0
                for (const m of session.messages) {
                  if (m?.role === 'user') n += 1
                }
                return Math.max(0, n - 1)
              })(),
              ...(chatMode === 'edit_resend' || chatMode === 'regenerate'
                ? { chatRevision: chatMode, revisionUserText: effectiveText }
                : {}),
              ...clarifyMeta,
              ...('clientContext' in payload &&
              payload.clientContext &&
              typeof payload.clientContext === 'object' &&
              !Array.isArray(payload.clientContext)
                ? (() => {
                    const cc = payload.clientContext as Record<string, unknown>
                    const mode = String(cc.interactionMode ?? cc.workbenchMode ?? '').trim()
                    const posture = String(cc.collaborationPosture ?? '').trim().toLowerCase()
                    const postureOk =
                      posture === 'ask' || posture === 'plan' || posture === 'agent' || posture === 'debug'
                    return {
                      clientContext: cc,
                      ...(mode ? { interactionMode: mode, workbenchMode: mode } : {}),
                      ...(postureOk ? { collaborationPosture: posture } : {})
                    }
                  })()
                : {})
            }
          }),
          buildManagerGraphInvokeConfig({
            signal: ctrl.signal,
            runId,
            sessionId,
            freshThread: true
          })
        )
    )
    const outMessages = (result as any)?.messages
    const last = Array.isArray(outMessages) ? outMessages[outMessages.length - 1] : null
    const composedBundle = composeFinalBundleFromGraphResult(result)
    const composed = composedBundle.text
    const mmOut = String((result as any)?.results?.multimodal ?? '').trim()
    let fromMsg = String(last?.content ?? '').trim()
    const bogusFinal = /^(finalize|synth|critic|optimizer|verifier|monitor|planner|route|multi|clarify)$/i.test(fromMsg)
    if (bogusFinal) fromMsg = ''
    let finalText = pickRicherFinalText(composed, fromMsg)
    if (mmOut && isSynthRejectingMedia(finalText, mmOut)) {
      finalText = mmOut
    } else if (!finalText && mmOut) {
      finalText = mmOut
    }
    if (!finalText) finalText = '任务已结束，但未生成可展示的回复文本；请查看思考过程或重试。'
    // WS final 面向用户气泡：剥离执行摘要审计块（完整审计仍在 composeBundle.text / run_report）
    finalText = stripStructuredExecReport(finalText) || finalText
     // 写操作待确认：仅结构化 Admin pending；GUI 成功不得弹「个人事务」卡后整图重跑
    try {
      const rawMeta = ((result as any)?.meta ?? {}) as Record<string, unknown>
      const resultsBag = (result as any)?.results
      const meta: Record<string, unknown> = {
        ...rawMeta,
        ...(resultsBag && typeof resultsBag === 'object' ? { results: resultsBag } : {})
      }
      const plan = Array.isArray((result as any)?.plan) ? (result as any).plan : []
      const intent = String((result as any)?.intent || meta.intent || '').trim()
      const evaluation = (result as any)?.evaluation
      if (
        shouldPauseForPostGraphAdminConfirm({
          meta,
          finalText,
          results: resultsBag,
          intent,
          plan,
          evaluation
        })
      ) {
        void saveHumanConfirmCheckpoint(sessionId, buildHumanConfirmCheckpoint(result))
        emitAdminHumanConfirmRequest(send, runId, pauseAdminConfirmMessage(result), {
          checkpointResume: true,
          agent: 'admin',
          adminPendingOps: Array.isArray(meta.adminPendingOps) ? meta.adminPendingOps : undefined
        })
        send('status', { status: 'awaiting_human_confirm', runId }, 'manager', runId)
        // 确认续跑会新开 runId；本轮过程暂不落库，避免 byRun 泄漏
        clearRunProcess(runId)
        return
      }
    } catch {}
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
  } catch (e: any) {
    clearRunProcess(runId)
    if (isRunAbortError(ctrl, e)) {
      send('status', { status: 'canceled', runId, detail: '任务已取消' }, 'manager', runId)
    } else {
      send('error', String(e?.message || e || 'unknown error'), 'manager', runId)
    }
  } finally {
    releaseRunSlotForTenant(String(tenantId || 'default'))
    runs.delete(runId)
    runMeta.delete(runId)
    const sMeta = sessionMeta.get(sessionId)
    if (sMeta?.activeRunId === runId)
      sessionMeta.set(sessionId, { lastActiveMs: sMeta?.lastActiveMs ?? nowMs(), activeRunId: undefined })
  }
}
