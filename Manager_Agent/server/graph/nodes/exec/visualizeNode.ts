import { tryDeterministicDownstreamOutput } from '#agent-shared/codeDownstreamOutput'
import { hasCodeInResults } from '#agent-shared/codeFirstAuthority'
import { tryDeterministicVisualizeFromDbTabular } from '#agent-shared/dbPipelineDeterministic'
import { createCodeAuthorityLlmModel } from '../../../utils/code/managerCodeAuthorityLlm'
import { tryCodeAuthorityDownstreamOutput } from '../../../utils/code/managerCodeDownstream'
import { resolveExecutionQuery } from '../../core/routing/clauses'
import { emitCollabPreview } from '../../core/plan/collabPreview'
import { buildVisualizeAgentContext } from '../../core/output/downstreamContext'
import { recordDownstreamMetric } from '../../core/output/downstreamMetrics'
import { emitSingleStepPlanEvent } from '../../core/plan/planStepsEvent'
import { extractStructuredPayload } from '../../core/shared'
import { createExecContext } from './context'
import { compactStepInput } from './helpers'
import type { CreateExecutionNodesDeps } from './types'


export function buildVisualizeNode(deps: CreateExecutionNodesDeps) {
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
    opts.sendEvent({ event: 'phase', data: 'execute:visualize', from: 'manager' })
    const question = resolveExecutionQuery('visualize', state, lastUserText(state.messages))
    emitSingleStepPlanEvent(opts, 'visualize', question)
    const t0 = Date.now()
    emitTrace({ type: 'step_start', agent: 'visualize', input: compactStepInput(question), at: new Date().toISOString() })
    const mergedResults = (state.results || {}) as Record<string, unknown>
    const shapeCtx = { meta: state.meta, planSteps: state.plan }
    const fromDbTabular = tryDeterministicVisualizeFromDbTabular(mergedResults, extractStructuredPayload)
    if (fromDbTabular) {
      await appendMetrics({ runId: opts.runId, phase: 'visualize', ms: Date.now() - t0 })
      const mode = mergedResults.db_vanna_chart ? 'vanna_chart_deterministic' : 'db_tabular_deterministic'
      const visualizeEvidence = { kind: 'visualize' as const, query: question, mode }
      emitTrace({ type: 'step_end', agent: 'visualize', ms: Date.now() - t0, status: 'ok', evidence: visualizeEvidence, outputSummary: summarize(fromDbTabular), at: new Date().toISOString() })
      opts.sendEvent({
        event: 'thinking',
        data: mode === 'vanna_chart_deterministic'
          ? 'Visualize：Vanna chart 确定性出图（跳过 LLM）'
          : 'Visualize：DB tabular 数据确定性出图（跳过 LLM）',
        from: 'manager'
      })
      emitCollabPreview(opts.sendEvent, 'visualize', fromDbTabular, mode)
      return { results: { visualize: fromDbTabular }, evidence: [visualizeEvidence], resources: state.resources, meta: state.meta }
    }
    if (hasCodeInResults(mergedResults)) {
      const codeModel = createCodeAuthorityLlmModel({
        openaiApiKey: opts.openaiApiKey,
        openaiBaseUrl: opts.openaiBaseUrl,
        modelName: String(state.resources?.modelLowCost ?? opts.openaiModel ?? '')
      })
      const auth = await tryCodeAuthorityDownstreamOutput(
        'visualize',
        mergedResults,
        extractStructuredPayload,
        question,
        codeModel,
        shapeCtx
      )
      if (auth) {
        void recordDownstreamMetric({
          runId: opts.runId,
          kind: 'chart',
          ok: true,
          mode: auth.mode,
          firstPass: auth.firstPass ?? true,
          ms: Date.now() - t0
        })
        await appendMetrics({ runId: opts.runId, phase: 'visualize', ms: Date.now() - t0 })
        const visualizeEvidence = { kind: 'visualize' as const, query: question, mode: auth.mode }
        emitTrace({ type: 'step_end', agent: 'visualize', ms: Date.now() - t0, status: 'ok', evidence: visualizeEvidence, outputSummary: summarize(auth.output), at: new Date().toISOString() })
        emitCollabPreview(opts.sendEvent, 'visualize', auth.output, auth.mode)
        return { results: { visualize: auth.output }, evidence: [visualizeEvidence], resources: state.resources, meta: state.meta }
      }
    }
    const det = tryDeterministicDownstreamOutput('visualize', mergedResults, extractStructuredPayload, shapeCtx)
    if (det) {
      await appendMetrics({ runId: opts.runId, phase: 'visualize', ms: Date.now() - t0 })
      const visualizeEvidence = { kind: 'visualize' as const, query: question, mode: 'code_authority_deterministic' }
      emitTrace({ type: 'step_end', agent: 'visualize', ms: Date.now() - t0, status: 'ok', evidence: visualizeEvidence, outputSummary: summarize(det), at: new Date().toISOString() })
      emitCollabPreview(opts.sendEvent, 'visualize', det, 'code_authority_deterministic')
      return { results: { visualize: det }, evidence: [visualizeEvidence], resources: state.resources, meta: state.meta }
    }
    const context = buildVisualizeAgentContext(mergedResults, extractStructuredPayload)
    const out = await runInternalAgent('visualize', question, state, context)
    const answer = typeof out === 'string' ? out : out.answer
    await appendMetrics({ runId: opts.runId, phase: 'visualize', ms: Date.now() - t0 })
    const visualizeEvidence = { kind: 'visualize' as const, query: question }
    emitTrace({ type: 'step_end', agent: 'visualize', ms: Date.now() - t0, status: 'ok', evidence: visualizeEvidence, outputSummary: summarize(answer), at: new Date().toISOString() })
    emitCollabPreview(opts.sendEvent, 'visualize', answer)
    return { results: { visualize: answer }, evidence: [visualizeEvidence], resources: typeof out === 'string' ? state.resources : out.resources, meta: typeof out === 'string' ? state.meta : out.meta }
  }

}
