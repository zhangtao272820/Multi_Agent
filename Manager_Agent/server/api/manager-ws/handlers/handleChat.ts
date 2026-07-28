import type { WsHandlerContext, ParsedWsMessage } from './types'
import { tryAcquireRunSlot, releaseRunSlot } from '../../../graph/core/runtime/backpressure'
import { crypto, RunIdSchema, createManagerGraph, buildManagerGraphInvokeConfig, buildManagerTurnInvokeState, composeFinalBundleFromGraphResult, buildHumanConfirmCheckpoint, pickRicherFinalText, saveHumanConfirmCheckpoint, isSynthRejectingMedia, resolveManagerLlmConfig, resolveAgentEndpointsWithPlatform, buildCompactedHistoryWithStats, buildSummarizeWithLlmFn, graphAgentEndpoints, buildRagHistoryForRun, sanitizeHistoryText, detectClarifyFollowUp, clarifyReplanMetaPatch, ingestTaskStackFromUserMessage, withAgentTraceContext, emitRunObservability, emitAdminHumanConfirmRequest, isHumanConfirmClarification, pauseAdminConfirmMessage, loadTaskStack, path, runs, runMeta, sessionMeta, sessions, readSession, writeSession, buildUserContent, stripAttachmentSuffix, resolveUserMessageSessionIndex, pruneAutoUserTasksOnEditResend, policyDataDir, emitImplicitLearning, allowRate, nowMs, isRunAbortError, useRuntimeConfig } from './wsBarrel'

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
   if (chatMode === 'normal' && !text && !mediaAttachment) {
    send('error', '请输入问题或上传附件', 'manager')
    return
  }
  if ((chatMode === 'regenerate' || chatMode === 'edit_resend') && typeof userMessageIndex !== 'number') {
    send('error', '重新生成/编辑重发需要 userMessageIndex', 'manager')
    return
  }
  if (chatMode === 'edit_resend' && !text) {
    send('error', '编辑后内容不能为空', 'manager')
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
    const idx = resolveUserMessageSessionIndex(session.messages, userMessageIndex as number)
    const anchor = idx >= 0 ? session.messages[idx] : undefined
    if (!anchor || anchor.role !== 'user') {
      send('error', '找不到对应用户消息，无法重新生成', 'manager')
      return
    }
    if (chatMode === 'regenerate') {
      session.messages = session.messages.slice(0, idx + 1)
      effectiveText = stripAttachmentSuffix(anchor.content)
      effectiveAttachment = null
      if (!effectiveText) {
        send('error', '该轮仅有附件，请使用编辑重发补充文字说明', 'manager')
        return
      }
      try {
        const { deleteSessionFeedbackAtUserMessageIndex } = await import(
          '#agent-shared/sessionFeedbackStore'
        )
        await deleteSessionFeedbackAtUserMessageIndex('manager', sessionId, userMessageIndex as number)
      } catch {
        /* optional PG */
      }
    } else {
      session.messages = session.messages.slice(0, idx)
      const userContent = buildUserContent(text, mediaAttachment)
      session.messages.push({ role: 'user', content: userContent })
      effectiveText = text
      await pruneAutoUserTasksOnEditResend(policyDataDir(), sessionId)
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
  if (prevRunId && runs.has(prevRunId)) {
    const prevCtrl = runs.get(prevRunId)
    prevCtrl?.abort()
    void emitImplicitLearning(prevRunId, sessionId, 'new_chat_interrupt')
    runs.delete(prevRunId)
    runMeta.delete(prevRunId)
    send('status', { status: 'canceled_by_new_chat', runId: prevRunId }, 'manager', prevRunId)
  }
  const runSlot = tryAcquireRunSlot()
  if (!runSlot.ok) {
    send('error', { error_code: 'overloaded', message: runSlot.reason }, 'manager')
    return
  }
   const runId = crypto.randomUUID()
  if (!RunIdSchema.safeParse(runId).success) {
    send('error', 'runId 生成失败', 'manager')
    return
  }
  send('thinking', '总管 Agent：开始处理…', 'manager', runId)
  const ctrl = new AbortController()
  runs.set(runId, ctrl)
  runMeta.set(runId, { startedAtMs: nowMs(), sessionId, tenantId })
  sessionMeta.set(sessionId, { lastActiveMs: nowMs(), activeRunId: runId })
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
     // 写操作待确认：图已结束，发确认条（带 confirmId）+ checkpoint；不发 final，避免确认前后两条回复
    try {
      const rawMeta = ((result as any)?.meta ?? {}) as Record<string, unknown>
      const resultsBag = (result as any)?.results
      const meta: Record<string, unknown> = {
        ...rawMeta,
        ...(resultsBag && typeof resultsBag === 'object' ? { results: resultsBag } : {})
      }
      const adminBlob = String((resultsBag as { admin?: string } | undefined)?.admin || '')
      const confirmProbe = [finalText, adminBlob].filter(Boolean).join('\n')
      if (Boolean(meta.needsHumanConfirm) || isHumanConfirmClarification(meta, confirmProbe)) {
        void saveHumanConfirmCheckpoint(sessionId, buildHumanConfirmCheckpoint(result))
        emitAdminHumanConfirmRequest(send, runId, pauseAdminConfirmMessage(result), {
          checkpointResume: true,
          agent: 'admin',
          adminPendingOps: Array.isArray(meta.adminPendingOps) ? meta.adminPendingOps : undefined
        })
        send('status', { status: 'awaiting_human_confirm', runId }, 'manager', runId)
        return
      }
    } catch {}
     session.messages.push({ role: 'assistant', content: finalText })
    void writeSession(sessionId, session)
    const reportOut = String((result as any)?.results?.report || '').trim()
    const finalFrom =
      reportOut.length >= 40 || /<!--\s*REPORT\s*-->/i.test(finalText) ? 'report' : 'manager'
    await emitRunObservability(send, runId)
    send('user_facing', composedBundle.userFacing, 'manager', runId)
    send('final', finalText, finalFrom, runId)
    try {
      const stack = await loadTaskStack(path.join(process.cwd(), '.data'), sessionId)
      send('task_stack', { stack }, 'manager', runId)
    } catch {}
  } catch (e: any) {
    if (isRunAbortError(ctrl, e)) {
      send('status', { status: 'canceled', runId, detail: '任务已取消' }, 'manager', runId)
    } else {
      send('error', String(e?.message || e || 'unknown error'), 'manager', runId)
    }
  } finally {
    releaseRunSlot()
    runs.delete(runId)
    runMeta.delete(runId)
    const sMeta = sessionMeta.get(sessionId)
    if (sMeta?.activeRunId === runId)
      sessionMeta.set(sessionId, { lastActiveMs: sMeta?.lastActiveMs ?? nowMs(), activeRunId: undefined })
  }
}
