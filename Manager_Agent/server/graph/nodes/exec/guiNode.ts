import { buildAgentExecutorBundle, executeGuiStep } from '../../core/executors'
import { resolveExecutionQuery } from '../../core/routing/clauses'
import { emitSingleStepPlanEvent } from '../../core/plan/planStepsEvent'
import type { ManagerGraphState } from '../../state/state'
import { createExecContext } from './context'
import { compactStepInput } from './helpers'
import type { CreateExecutionNodesDeps } from './types'
import { detectGuiSemanticBlockFromState, isGuiHumanHandoffFailure } from '../../../utils/gui/guiHumanConfirm'


export function buildGuiNode(deps: CreateExecutionNodesDeps) {
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
    notifyAgentFailure,
    mergeMeta
  } = createExecContext(deps)

  return async (state: any) => {
    ensureNotAborted()
    opts.sendEvent({ event: 'phase', data: 'execute:gui', from: 'manager' })
    const { assertToolCallAllowed } = await import('#agent-shared/toolCallPolicyEngine')
    const policyGate = await assertToolCallAllowed({
      agent: 'gui',
      sessionId: opts.sessionId,
      tenantId: opts.tenantId,
      risk: 'high',
      ok: true
    })
    if (!policyGate.ok) {
      const reason = policyGate.decision.reasons.join('; ') || 'policy_denied'
      opts.sendEvent({ event: 'thinking', data: `策略门禁：gui 被拒绝（${reason}）`, from: 'manager' })
      return { results: { gui: '' }, evidence: [{ kind: 'gui', query: '', error: reason }] }
    }
    const question = resolveExecutionQuery('gui', state, lastUserText(state.messages))
    emitSingleStepPlanEvent(opts, 'gui', question)
    const t0 = Date.now()
    emitTrace({ type: 'step_start', agent: 'gui', input: compactStepInput(question), at: new Date().toISOString() })
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
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        crawlerAgentWsUrl: opts.crawlerAgentWsUrl,
        lobsterAgentWsUrl: opts.lobsterAgentWsUrl,
        dbAgentWsUrl: opts.dbAgentWsUrl,
        dbAgentHttpUrl: opts.dbAgentHttpUrl,
        ragAgentHttpUrl: opts.ragAgentHttpUrl,
        codeAgentWsUrl: opts.codeAgentWsUrl,
        aiAdminAgentWsUrl: opts.aiAdminAgentWsUrl,
        multimodalAgentHttpUrl: opts.multimodalAgentHttpUrl,
        musicAgentWsUrl: opts.musicAgentWsUrl,
        videoAgentWsUrl: opts.videoAgentWsUrl,
        sendEvent: opts.sendEvent
      }
    )
    const outcome = await executeGuiStep(execDeps, execOpts, {
      state: state as ManagerGraphState,
      effQuery: question,
      timeoutMs: opts.timeoutMs,
      sendThinking: (t: string) => opts.sendEvent({ event: 'thinking', data: t, from: 'gui' })
    })
    await appendMetrics({ runId: opts.runId, phase: 'gui', ms: Date.now() - t0 })
    const answer = outcome.output
    const guiEvidence = {
      ...(outcome.ok && outcome.evidence ? outcome.evidence : { kind: 'gui' as const, query: question }),
      agent: 'gui' as const,
      ...(outcome.ok ? {} : { failed: true }),
      ...(outcome.meta?.agentResult ? { agentResult: outcome.meta.agentResult } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(!outcome.ok && outcome.evidence && typeof outcome.evidence === 'object'
        ? { verifyReason: String((outcome.evidence as Record<string, unknown>).verifyReason || '') }
        : {})
    }
    emitTrace({
      type: 'step_end',
      agent: 'gui',
      ms: Date.now() - t0,
      status: outcome.ok ? 'ok' : 'error',
      evidence: guiEvidence,
      outputSummary: summarize(answer),
      error: outcome.ok ? undefined : outcome.error,
      at: new Date().toISOString()
    })
    const outcomeMeta =
      outcome.meta && typeof outcome.meta === 'object' ? (outcome.meta as Record<string, unknown>) : {}
    const agentResult =
      outcomeMeta.agentResult && typeof outcomeMeta.agentResult === 'object'
        ? (outcomeMeta.agentResult as Record<string, unknown>)
        : null
    const semanticBlock = detectGuiSemanticBlockFromState({
      evidence: [guiEvidence],
      results: { gui: answer },
      meta: outcomeMeta,
    })
    const failureCode = String(
      outcome.error || agentResult?.error_code || semanticBlock.failureType || '',
    )
      .trim()
      .toLowerCase()
    const handoffBlocked =
      semanticBlock.blocked ||
      isGuiHumanHandoffFailure(failureCode) ||
      failureCode === 'task_blocked'
    // 缺槽澄清 ≠ GUI handoff；后者不得写 needsClarify
    const needsClarify =
      !handoffBlocked && Boolean(outcomeMeta.needsClarify || agentResult?.needs_clarify)
    const metaPatch: Record<string, unknown> = {}
    if (needsClarify) metaPatch.needsClarify = true
    if (outcomeMeta.guiSemanticBlocked) {
      metaPatch.guiSemanticBlocked = outcomeMeta.guiSemanticBlocked
    } else if (semanticBlock.failureType) {
      metaPatch.guiSemanticBlocked = semanticBlock.failureType
    }
    if (outcomeMeta.guiHandoffAttempted) metaPatch.guiHandoffAttempted = true
    if (!outcome.ok) {
      const toastCode =
        failureCode === 'empty_result' || !failureCode
          ? handoffBlocked
            ? String(semanticBlock.failureType || 'task_blocked')
            : 'task_blocked'
          : String(outcome.error || agentResult?.error_code || 'gui step failed')
      notifyAgentFailure('gui', toastCode)
    }
    return {
      results: { gui: answer },
      evidence: [guiEvidence],
      ...(Object.keys(metaPatch).length ? { meta: mergeMeta(state, metaPatch) } : {})
    }
  }

}
