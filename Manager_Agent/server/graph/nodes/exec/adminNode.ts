import { adminScopedQueryFromMeta } from '../../../utils/admin/managerAdminTaskPayload'
import { stripAdminManagerGuards } from '../../../utils/route/managerSubAgentHelpers'
import { buildAgentExecutorBundle, executeAdminStep } from '../../core/executors'
import { resolveExecutionQuery } from '../../core/routing/clauses'
import { emitSingleStepPlanEvent } from '../../core/plan/planStepsEvent'
import { emitStepResultEvent } from '../../core/output/stepResultEvent'
import type { ManagerGraphState } from '../../state/state'
import { createExecContext } from './context'
import { compactStepInput } from './helpers'
import type { CreateExecutionNodesDeps } from './types'


export function buildAdminNode(deps: CreateExecutionNodesDeps) {
  const {
    ensureNotAborted,
    opts,
    lastUserText,
    callDbAgent,
    appendMetrics,
    isDbNoData,
    emitTrace,
    summarize,
    callRagAgent,
    probeRagEvidence,
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
    notifyAgentFailure
  } = createExecContext(deps)

  return async (state: any) => {
    ensureNotAborted()
    opts.sendEvent({ event: 'phase', data: 'execute:admin', from: 'manager' })
    const { assertToolCallAllowed } = await import('#agent-shared/toolCallPolicyEngine')
    const policyGate = await assertToolCallAllowed({
      agent: 'admin',
      sessionId: opts.sessionId,
      tenantId: opts.tenantId,
      risk: 'high',
      ok: true
    })
    if (!policyGate.ok) {
      const reason = policyGate.decision.reasons.join('; ') || 'policy_denied'
      opts.sendEvent({ event: 'thinking', data: `策略门禁：admin 被拒绝（${reason}）`, from: 'manager' })
      return { results: { admin: '' }, evidence: [{ kind: 'admin', query: '', error: reason }] }
    }
    const raw = resolveExecutionQuery('admin', state, lastUserText(state.messages))
    const scoped = stripAdminManagerGuards(adminScopedQueryFromMeta(state.meta, raw) || raw) || raw
    const adminQuery = scoped.length >= 4 ? scoped : raw
    emitSingleStepPlanEvent(opts, 'admin', adminQuery)
    const t0 = Date.now()
    emitTrace({ type: 'step_start', agent: 'admin', input: compactStepInput(adminQuery), at: new Date().toISOString() })
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
        lastUserText
      },
      {
        runId: opts.runId,
        sessionId: opts.sessionId,
        userId: opts.userId,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        aiAdminAgentWsUrl: opts.aiAdminAgentWsUrl,
        dbAgentWsUrl: opts.dbAgentWsUrl,
        dbAgentHttpUrl: opts.dbAgentHttpUrl,
        ragAgentHttpUrl: opts.ragAgentHttpUrl,
        codeAgentWsUrl: opts.codeAgentWsUrl,
        crawlerAgentWsUrl: opts.crawlerAgentWsUrl,
        lobsterAgentWsUrl: opts.lobsterAgentWsUrl,
        multimodalAgentHttpUrl: opts.multimodalAgentHttpUrl,
        musicAgentWsUrl: opts.musicAgentWsUrl,
        videoAgentWsUrl: opts.videoAgentWsUrl,
        sendEvent: opts.sendEvent
      }
    )
    const outcome = await executeAdminStep(execDeps, execOpts, {
      state: state as ManagerGraphState,
      effQuery: adminQuery,
      timeoutMs: opts.timeoutMs,
      sendThinking: (t: string) => opts.sendEvent({ event: 'thinking', data: t, from: 'admin' })
    })
    await appendMetrics({ runId: opts.runId, phase: 'admin', ms: Date.now() - t0 })
    emitStepResultEvent(opts, { stepId: 'step_admin', agent: 'admin', outcome, ms: Date.now() - t0 })
    const adminEvidence = outcome.ok && outcome.evidence
      ? outcome.evidence
      : { kind: 'admin' as const, query: adminQuery }
    emitTrace({
      type: 'step_end',
      agent: 'admin',
      ms: Date.now() - t0,
      status: outcome.ok ? 'ok' : 'error',
      evidence: adminEvidence,
      outputSummary: summarize(outcome.output),
      error: outcome.ok ? undefined : outcome.error,
      at: new Date().toISOString()
    })
    if (!outcome.ok) {
      notifyAgentFailure('admin', String(outcome.error || 'admin step failed'))
    }
    return { results: { admin: outcome.output }, evidence: [adminEvidence] }
  }

}
