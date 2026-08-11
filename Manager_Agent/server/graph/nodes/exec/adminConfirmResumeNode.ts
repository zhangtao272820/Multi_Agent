import { adminScopedQueryFromMeta } from '../../../utils/admin/managerAdminTaskPayload'
import { stripAdminManagerGuards } from '../../../utils/route/managerSubAgentHelpers'
import { buildAgentExecutorBundle, executeAdminStep } from '../../core/executors'
import { resolveExecutionQuery } from '../../core/routing/clauses'
import type { ManagerGraphState } from '../../state/state'
import { createExecContext } from './context'
import type { CreateExecutionNodesDeps } from './types'


export function buildAdminConfirmResumeNode(deps: CreateExecutionNodesDeps) {
  const {
    ensureNotAborted,
    opts,
    lastUserText,
    callDbAgent,
    appendMetrics,
    isDbNoData,
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
    ragEvidenceMatchJudge
  } = createExecContext(deps)

  return async (state: any) => {
    ensureNotAborted()
    opts.sendEvent({ event: 'phase', data: 'admin_confirm_resume', from: 'manager' })
    opts.sendEvent({
      event: 'thinking',
      data: '已确认写操作：仅续跑个人助手步骤，不重复查数/图表。',
      from: 'manager'
    })
    const raw = resolveExecutionQuery('admin', state, lastUserText(state.messages))
    const scoped = stripAdminManagerGuards(adminScopedQueryFromMeta(state.meta, raw) || raw) || raw
    const adminQuery = scoped.length >= 4 ? scoped : raw
    const resumeState = {
      ...state,
      meta: {
        ...(state.meta && typeof state.meta === 'object' ? state.meta : {}),
        allowRiskyWrites: true,
        needsHumanConfirm: false,
        needsClarify: false,
        clarifyQuestions: []
      }
    } as ManagerGraphState
    const t0 = Date.now()
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
      state: resumeState,
      effQuery: adminQuery,
      timeoutMs: opts.timeoutMs,
      sendThinking: (t: string) => opts.sendEvent({ event: 'thinking', data: t, from: 'admin' })
    })
    await appendMetrics({ runId: opts.runId, phase: 'admin_confirm_resume', ms: Date.now() - t0 })
    const adminEvidence = outcome.ok && outcome.evidence
      ? outcome.evidence
      : { kind: 'admin' as const, query: adminQuery }
    return {
      results: { ...(state.results || {}), admin: outcome.output },
      evidence: [adminEvidence],
      meta: {
        ...(state.meta && typeof state.meta === 'object' ? state.meta : {}),
        allowRiskyWrites: true,
        needsHumanConfirm: false,
        needsClarify: false,
        clarifyQuestions: []
      },
      final: undefined
    }
  }
}
