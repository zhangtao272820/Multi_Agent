import { createCleanAlignLlmModel } from '../../../utils/chat/managerCleanLlm'
import { tryCleanPipeline } from '../../../utils/chat/managerCleanPipeline'
import { resolveExecutionQuery } from '../../core/routing/clauses'
import { emitCollabPreview } from '../../core/plan/collabPreview'
import { recordDownstreamMetric } from '../../core/output/downstreamMetrics'
import { emitSingleStepPlanEvent } from '../../core/plan/planStepsEvent'
import { extractStructuredPayload } from '../../core/shared'
import { createExecContext } from './context'
import { compactStepInput } from './helpers'
import type { CreateExecutionNodesDeps } from './types'


export function buildCleanNode(deps: CreateExecutionNodesDeps) {
  const {
    ensureNotAborted,
    opts,
    lastUserText,
    appendMetrics,
    emitTrace,
    summarize,
    runInternalAgent
  } = createExecContext(deps)

  return async (state: any) => {
    ensureNotAborted()
    opts.sendEvent({ event: 'phase', data: 'execute:clean', from: 'manager' })
    const question = resolveExecutionQuery('clean', state, lastUserText(state.messages))
    emitSingleStepPlanEvent(opts, 'clean', question)
    const t0 = Date.now()
    emitTrace({ type: 'step_start', agent: 'clean', input: compactStepInput(question), at: new Date().toISOString() })
    const mergedForClean = (state.results || {}) as Record<string, unknown>
    const planSteps = Array.isArray(state.plan) ? state.plan : Array.isArray(state.taskPlan?.steps) ? state.taskPlan.steps : []
    const codePlanned = planSteps.some((s: { agent?: string }) => String(s?.agent || '') === 'code')
    const cleanModel = createCleanAlignLlmModel({
      openaiApiKey: opts.openaiApiKey,
      openaiBaseUrl: opts.openaiBaseUrl,
      modelName: String(state.resources?.modelLowCost ?? opts.openaiModel ?? '')
    })
    const piped = await tryCleanPipeline(
      mergedForClean,
      extractStructuredPayload,
      question,
      cleanModel,
      {
        openaiApiKey: opts.openaiApiKey,
        openaiBaseUrl: opts.openaiBaseUrl,
        modelName: String(state.resources?.modelLowCost ?? opts.openaiModel ?? ''),
        codePlanned
      }
    )
    if (piped) {
      void recordDownstreamMetric({
        runId: opts.runId,
        kind: 'clean',
        ok: true,
        mode: piped.mode,
        ms: Date.now() - t0
      })
      await appendMetrics({ runId: opts.runId, phase: 'clean', ms: Date.now() - t0 })
      const cleanEvidence = { kind: 'clean' as const, query: question, mode: piped.mode }
      emitTrace({ type: 'step_end', agent: 'clean', ms: Date.now() - t0, status: 'ok', evidence: cleanEvidence, outputSummary: summarize(piped.output), at: new Date().toISOString() })
      opts.sendEvent({ event: 'thinking', data: `Clean：${piped.mode}（跳过通用 LLM 回退）`, from: 'manager' })
      emitCollabPreview(opts.sendEvent, 'clean', piped.output, piped.mode)
      return { results: { clean: piped.output }, evidence: [cleanEvidence], resources: state.resources, meta: state.meta }
    }
    const context = [state.results?.db ? `db:\n${String(state.results.db).slice(0, 4000)}` : '', state.results?.rag ? `rag:\n${String(state.results.rag).slice(0, 2000)}` : '', state.results?.crawler ? `crawler:\n${String(state.results.crawler).slice(0, 2000)}` : '']
      .filter(Boolean)
      .join('\n\n')
    const out = await runInternalAgent('clean', question, state, context)
    const answer = typeof out === 'string' ? out : out.answer
    await appendMetrics({ runId: opts.runId, phase: 'clean', ms: Date.now() - t0 })
    const cleanEvidence = { kind: 'clean' as const, query: question }
    emitTrace({ type: 'step_end', agent: 'clean', ms: Date.now() - t0, status: 'ok', evidence: cleanEvidence, outputSummary: summarize(answer), at: new Date().toISOString() })
    emitCollabPreview(opts.sendEvent, 'clean', answer)
    return { results: { clean: answer }, evidence: [cleanEvidence], resources: typeof out === 'string' ? state.resources : out.resources, meta: typeof out === 'string' ? state.meta : out.meta }
  }

}
