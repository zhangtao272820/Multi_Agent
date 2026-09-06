import { unwrapAgentCall } from '../../../utils/agents/agentResult'
import { pickRichestDbQuestion } from '../../../utils/db/managerDbQuestionLlm'
import type { Intent } from '../../../utils/shared/taskPlan'
import { buildAgentError, emitAgentError, emitAgentEvidence } from '../../core/agent/agentErrors'
import { buildAgentExecutorBundle, computePolicyDbTimeoutMs, executeDbStep, resolveRagRetrievalBundle } from '../../core/executors'
import { resolveSubAgentStepSessionId } from '../../core/routing/subAgentPassthrough'
import { resolveExecutionQuery } from '../../core/routing/clauses'
import { hasOrchestratedDbScope, resolveDbStepQuestionSync } from '../../core/db/dbStepQuestion'
import { emitSingleStepPlanEvent } from '../../core/plan/planStepsEvent'
import { emitStepResultEvent } from '../../core/output/stepResultEvent'
import type { ManagerGraphState } from '../../state/state'
import { createExecContext } from './context'
import { compactStepInput } from './helpers'
import type { CreateExecutionNodesDeps } from './types'


export function buildDbNode(deps: CreateExecutionNodesDeps) {
  const {
    ensureNotAborted,
    opts,
    policyPromise,
    defaultPolicy,
    lastUserText,
    callDbAgent,
    appendMetrics,
    isDbNoData,
    emitTrace,
    summarize,
    callRagAgent,
    ragEvidenceFromProbe,
    probeRagEvidence,
    parseRagClarifyPayload,
    mergeTaskPlan,
    getEffectivePlanSteps,
    mergeMeta,
    callCodeAgent,
    callAiAdminAgent,
    callCrawlerAgent,
    callLobsterAgent,
    filterCrawlerResultDomestic,
    callMultimodalAgent,
    callMusicAgent,
    callVideoAgent,
    ragRelevanceJudge,
    ragEvidenceMatchJudge,
    ragScopeHintJudge,
    llmInvoke
  } = createExecContext(deps)

  return async (state: any) => {
    ensureNotAborted()
    opts.sendEvent({ event: 'phase', data: 'execute:db', from: 'manager' })
    const lastOnly = lastUserText(state.messages)
    const question = resolveExecutionQuery('db', state, lastOnly)
    const questionForDb = pickRichestDbQuestion(
      String(state.intent || '').trim() === 'db' && lastOnly.length >= 4
        ? lastOnly
        : resolveDbStepQuestionSync(question, lastOnly, state.meta),
      lastOnly,
      undefined,
      hasOrchestratedDbScope(state.meta) ? { meta: state.meta } : undefined
    )
    emitSingleStepPlanEvent(opts, 'db', questionForDb)
    const policy = await policyPromise.catch(() => defaultPolicy())
    try {
      const t0 = Date.now()
      emitTrace({ type: 'step_start', agent: 'db', input: compactStepInput(questionForDb), at: new Date().toISOString() })
      const effectiveTimeout = computePolicyDbTimeoutMs({
        state: state as ManagerGraphState,
        policy,
        optsTimeoutMs: opts.timeoutMs,
        question,
        questionForDb
      })
      const { deps: execDeps, opts: execOpts } = buildAgentExecutorBundle(
        {
          callDbAgent,
          callRagAgent,
          callCrawlerAgent,
          callLobsterAgent,
          callCodeAgent,
          callAiAdminAgent,
          callMultimodalAgent,
          callMusicAgent,
          callVideoAgent,
          probeRagEvidence,
          filterCrawlerResultDomestic,
          isDbNoData,
          ragRelevanceJudge,
          ragEvidenceMatchJudge,
          lastUserText,
          ragEvidenceFromProbe
        },
        {
          runId: opts.runId,
          sessionId: opts.sessionId,
          timeoutMs: opts.timeoutMs,
          signal: opts.signal,
          dbAgentWsUrl: opts.dbAgentWsUrl,
          dbAgentHttpUrl: opts.dbAgentHttpUrl,
          dbId: opts.dbId,
          ragAgentHttpUrl: opts.ragAgentHttpUrl,
          ragHistory: opts.ragHistory,
          ragConversationId: opts.ragConversationId,
          userId: opts.userId,
          codeAgentWsUrl: opts.codeAgentWsUrl,
          crawlerAgentWsUrl: opts.crawlerAgentWsUrl,
          lobsterAgentWsUrl: opts.lobsterAgentWsUrl,
          aiAdminAgentWsUrl: opts.aiAdminAgentWsUrl,
          multimodalAgentHttpUrl: opts.multimodalAgentHttpUrl,
          musicAgentWsUrl: opts.musicAgentWsUrl,
          videoAgentWsUrl: opts.videoAgentWsUrl,
          sendEvent: opts.sendEvent
        }
      )
      const outcome = await executeDbStep(execDeps, execOpts, {
          state: state as ManagerGraphState,
          effQuery: questionForDb,
          timeoutMs: effectiveTimeout,
          sendThinking: (t: string) => opts.sendEvent({ event: 'thinking', data: t, from: 'db' }),
          llmInvoke,
          llm: {
            openaiApiKey: opts.openaiApiKey,
            openaiModel: opts.openaiModel,
            openaiBaseUrl: opts.openaiBaseUrl
          }
        }
      )
      await appendMetrics({ runId: opts.runId, phase: 'db', ms: Date.now() - t0 })
      emitStepResultEvent(opts, { stepId: 'step_db', agent: 'db', outcome, ms: Date.now() - t0 })
      if (!outcome.ok) {
        throw new Error(outcome.error)
      }
      const answer = outcome.output
      const isEmpty = Boolean((outcome.evidence as { empty?: boolean })?.empty)
      const dbEvidence = outcome.evidence ?? { kind: 'db', query: questionForDb, empty: isEmpty }
      emitTrace({ type: 'step_end', agent: 'db', ms: Date.now() - t0, status: 'ok', empty: isEmpty, evidence: dbEvidence, outputSummary: summarize(answer), at: new Date().toISOString() })
      emitAgentEvidence(opts.sendEvent, 'db', dbEvidence as Record<string, unknown>)
      const shouldAlsoRag =
        String(state.intent || '').trim() === 'rag' ||
        (Array.isArray(state.allowedAgents) && state.allowedAgents.includes('rag'))
      const ragHits = Number(state.probe?.rag?.hits ?? 0) > 0
      const allowRagSupplement = shouldAlsoRag && ragHits && !isEmpty
      if (isEmpty) {
        opts.sendEvent({ event: 'thinking', data: '数据库暂未查到结果，将结合其他信息汇总报告。', from: 'manager' })
        const emptyText = String(answer || '').trim() || '数据库中未找到相关记录。'
        return {
          results: { db: emptyText },
          evidence: [{ ...dbEvidence, empty: true, reason: (dbEvidence as { reason?: string }).reason || 'No data' }]
        }
      }
      if (!allowRagSupplement) return { results: { db: answer }, evidence: [dbEvidence] }
      try {
        const t1 = Date.now()
        let ragEvidence: any = null
        emitTrace({ type: 'step_start', agent: 'rag', input: compactStepInput(question), at: new Date().toISOString() })
        const ragBundle = await resolveRagRetrievalBundle(
          { ragScopeHintJudge, ragEvidenceMatchJudge },
          {
            userTask: question,
            baseQuery: question,
            probeRag: state.probe?.rag,
            turnScopeMode: String(state.meta?.turnScopeMode || '').trim() || null,
            turnKind: String(state.meta?.turnKind || '').trim() || null
          }
        )
        const ragStepConversationId = resolveSubAgentStepSessionId({
          runId: opts.runId,
          agent: 'rag',
          stepId: 'db_supplement'
        })
        const ragCall = await callRagAgent({
          ragAgentHttpUrl: opts.ragAgentHttpUrl,
          timeoutMs: Math.min(opts.timeoutMs, 45000),
          message: ragBundle.message || ragBundle.leanQuery,
          retrievalQuery: ragBundle.leanQuery,
          history: [],
          conversationId: ragStepConversationId,
          userId: opts.userId,
          traceId: opts.runId,
          sendThinking: (t: string) => opts.sendEvent({ event: 'thinking', data: t, from: 'rag' }),
          sendDelta: (d: string) => opts.sendEvent({ event: 'delta', data: d, from: 'rag' }),
          signal: opts.signal,
          onEvidence: (e: any) => (ragEvidence = e)
        })
        const { answer: ragAnswerText } = unwrapAgentCall(ragCall)
        if (!ragEvidence) ragEvidence = ragEvidenceFromProbe(question, state.probe?.rag) ?? (await probeRagEvidence(question))
        const ragClarify = parseRagClarifyPayload(ragAnswerText)
        await appendMetrics({ runId: opts.runId, phase: 'rag', ms: Date.now() - t1 })
        emitTrace({ type: 'step_end', agent: 'rag', ms: Date.now() - t1, status: 'ok', evidence: ragEvidence, outputSummary: summarize(ragAnswerText), at: new Date().toISOString() })
        emitAgentEvidence(opts.sendEvent, 'rag', ragEvidence as Record<string, unknown>)
        const nextIntent: Intent = shouldAlsoRag ? 'rag' : isEmpty ? 'rag' : 'db'
        const nextTaskPlan = ragClarify.needsClarify
          ? mergeTaskPlan(state.taskPlan ?? null, { needsClarification: true, clarificationQuestions: ragClarify.questions }, nextIntent, getEffectivePlanSteps(state as any))
          : (state.taskPlan ?? null)
        return {
          results: { db: answer, rag: ragAnswerText },
          intent: nextIntent,
          evidence: [dbEvidence, ...(ragEvidence ? [ragEvidence] : [])],
          meta: ragClarify.needsClarify ? mergeMeta(state, { needsClarify: true, clarifyQuestions: ragClarify.questions, uncertainty: 'high' }) : undefined,
          taskPlan: nextTaskPlan
        }
      } catch (e: any) {
        emitTrace({ type: 'step_end', agent: 'rag', status: 'error', error: String(e?.message || e), at: new Date().toISOString() })
        opts.sendEvent({ event: 'thinking', data: `RAG 回退失败：${String(e?.message || e)}`, from: 'manager' })
        return { results: { db: answer }, evidence: [dbEvidence] }
      }
    } catch (e: any) {
      emitTrace({ type: 'step_end', agent: 'db', status: 'error', error: String(e?.message || e), at: new Date().toISOString() })
      emitAgentError(
        opts.sendEvent,
        buildAgentError({ agent: 'db', message: String(e?.message || e), phase: 'execute', runId: opts.runId })
      )
      opts.sendEvent({ event: 'thinking', data: `数据库 Agent 不可用，尝试改用 RAG：${String(e?.message || e)}`, from: 'manager' })
      const t0 = Date.now()
      let ragEvidence: any = null
      emitTrace({ type: 'step_start', agent: 'rag', input: question, at: new Date().toISOString() })
      const ragBundle = await resolveRagRetrievalBundle(
        { ragScopeHintJudge, ragEvidenceMatchJudge },
        {
          userTask: question,
          baseQuery: question,
          probeRag: state.probe?.rag,
          turnScopeMode: String(state.meta?.turnScopeMode || '').trim() || null,
          turnKind: String(state.meta?.turnKind || '').trim() || null
        }
      )
      const ragStepConversationId = resolveSubAgentStepSessionId({
        runId: opts.runId,
        agent: 'rag',
        stepId: 'db_fallback'
      })
      const ragCall = await callRagAgent({
        ragAgentHttpUrl: opts.ragAgentHttpUrl,
        timeoutMs: opts.timeoutMs,
        message: ragBundle.message || ragBundle.leanQuery,
        retrievalQuery: ragBundle.leanQuery,
        history: [],
        conversationId: ragStepConversationId,
        userId: opts.userId,
        traceId: opts.runId,
        sendThinking: (t: string) => opts.sendEvent({ event: 'thinking', data: t, from: 'rag' }),
        sendDelta: (d: string) => opts.sendEvent({ event: 'delta', data: d, from: 'rag' }),
        signal: opts.signal,
        onEvidence: (e: any) => (ragEvidence = e)
      })
      const { answer: ragAnswerText } = unwrapAgentCall(ragCall)
      if (!ragEvidence) ragEvidence = ragEvidenceFromProbe(question, state.probe?.rag) ?? (await probeRagEvidence(question))
      const ragClarify = parseRagClarifyPayload(ragAnswerText)
      await appendMetrics({ runId: opts.runId, phase: 'rag', ms: Date.now() - t0 })
      emitTrace({ type: 'step_end', agent: 'rag', ms: Date.now() - t0, status: 'ok', evidence: ragEvidence, outputSummary: summarize(ragAnswerText), at: new Date().toISOString() })
      emitAgentEvidence(opts.sendEvent, 'rag', ragEvidence as Record<string, unknown>)
      return {
        results: { rag: ragAnswerText },
        intent: 'rag' as Intent,
        evidence: ragEvidence ? [ragEvidence] : [],
        meta: ragClarify.needsClarify ? mergeMeta(state, { needsClarify: true, clarifyQuestions: ragClarify.questions, uncertainty: 'high' }) : undefined,
        taskPlan: ragClarify.needsClarify
          ? mergeTaskPlan(state.taskPlan ?? null, { needsClarification: true, clarificationQuestions: ragClarify.questions }, 'rag', getEffectivePlanSteps(state as any))
          : (state.taskPlan ?? null)
      }
    }
  }

}
