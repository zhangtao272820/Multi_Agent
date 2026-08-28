import { createCleanAlignLlmModel } from '../../../utils/chat/managerCleanLlm'
import { tryCleanPipeline } from '../../../utils/chat/managerCleanPipeline'
import { createCodeAuthorityLlmModel } from '../../../utils/code/managerCodeAuthorityLlm'
import { tryCodeAuthorityDownstreamOutput, repairCodeAuthorityVisualize } from '../../../utils/code/managerCodeDownstream'
import type { ManagerGraphState } from '../../state/state'
import { recordDownstreamMetric } from '../output/downstreamMetrics'
import { getEffectivePlanSteps } from '../plan'
import { extractStructuredPayload } from '../shared'
import { resolveCodeAuthorityPayload } from '#agent-shared/codeAuthorityPayload'
import { tryDeterministicDownstreamOutput } from '#agent-shared/codeDownstreamOutput'
import { buildCodeFirstBundle, hasCodeInResults } from '#agent-shared/codeFirstAuthority'
import { gateReportOutput } from '#agent-shared/reportGate'
import { shouldDeferReportToSynth, deferredReportEvidence } from '#agent-shared/reportSynthDefer'
import type { AgentExecutorDeps, AgentStepOutcome, VoteScore } from './types'

export async function executeInternalStep(
  deps: AgentExecutorDeps,
  input: {
    agent: 'clean' | 'visualize' | 'report'
    internalQuery: string
    payload: unknown
    state: ManagerGraphState
    out: Record<string, string>
    vote?: {
      enabled: boolean
      score: (text: string) => VoteScore
      onDecision?: (d: {
        selected: 'A' | 'B'
        scoreA: VoteScore
        scoreB: VoteScore
        winnerReason: string
      }) => void
    }
    rewriteVisualize?: (text: string) => string
    llm?: { openaiApiKey?: string; openaiModel?: string; openaiBaseUrl?: string } | null
    runId?: string
  }
): Promise<AgentStepOutcome> {
  const runId = String(input.runId ?? input.state.meta?.runId ?? '').trim()
  const t0 = Date.now()
  const run = deps.runInternalAgent
  if (!run) {
    return {
      ok: false,
      agent: input.agent,
      output: '',
      query: input.internalQuery,
      error: 'runInternalAgent not configured'
    }
  }
  try {
    const mergedResults = { ...(input.state.results || {}), ...input.out } as Record<string, unknown>
    const planSteps = getEffectivePlanSteps(input.state)
    const codePlanned = planSteps.some((s) => s.agent === 'code')
    if (
      (input.agent === 'visualize' || input.agent === 'report') &&
      codePlanned &&
      !hasCodeInResults(mergedResults)
    ) {
      return {
        ok: false,
        agent: input.agent,
        output: '',
        query: input.internalQuery,
        error: 'code_step_not_complete: 图表/报告须等待 Code 步骤完成后再生成'
      }
    }
    if (input.agent === 'clean') {
      const cleanModel = createCleanAlignLlmModel({
        openaiApiKey: input.llm?.openaiApiKey,
        openaiBaseUrl: input.llm?.openaiBaseUrl,
        modelName: input.llm?.openaiModel
      })
      const piped = await tryCleanPipeline(
        mergedResults,
        extractStructuredPayload,
        input.internalQuery,
        cleanModel,
        {
          openaiApiKey: input.llm?.openaiApiKey,
          openaiBaseUrl: input.llm?.openaiBaseUrl,
          modelName: input.llm?.openaiModel,
          codePlanned
        }
      )
      if (piped) {
        void recordDownstreamMetric({
          runId,
          kind: 'clean',
          ok: true,
          mode: piped.mode,
          ms: Date.now() - t0
        })
        return {
          ok: true,
          agent: input.agent,
          output: piped.output,
          query: input.internalQuery,
          parsed: extractStructuredPayload(piped.output),
          evidence: { kind: input.agent, query: input.internalQuery, mode: piped.mode }
        }
      }
    }
    if (input.agent === 'report' && shouldDeferReportToSynth(mergedResults, { meta: input.state.meta, planSteps: input.state.plan })) {
      void recordDownstreamMetric({
        runId,
        kind: 'report',
        ok: true,
        mode: 'deferred_to_synth',
        ms: Date.now() - t0
      })
      return {
        ok: true,
        agent: input.agent,
        output: '',
        query: input.internalQuery,
        parsed: extractStructuredPayload(''),
        evidence: deferredReportEvidence(input.internalQuery)
      }
    }
    if (
      (input.agent === 'visualize' || input.agent === 'report') &&
      hasCodeInResults(mergedResults)
    ) {
      const codeModel = createCodeAuthorityLlmModel({
        openaiApiKey: input.llm?.openaiApiKey,
        openaiBaseUrl: input.llm?.openaiBaseUrl,
        modelName: input.llm?.openaiModel
      })
      const shapeCtx = { meta: input.state.meta, planSteps: input.state.plan }
      const auth = await tryCodeAuthorityDownstreamOutput(
        input.agent,
        mergedResults,
        extractStructuredPayload,
        input.internalQuery,
        codeModel,
        shapeCtx
      )
      if (auth) {
        if (input.agent === 'visualize') {
          void recordDownstreamMetric({
            runId,
            kind: 'chart',
            ok: true,
            mode: auth.mode,
            firstPass: auth.firstPass ?? true,
            ms: Date.now() - t0
          })
        } else {
          void recordDownstreamMetric({
            runId,
            kind: 'report',
            ok: true,
            mode: auth.mode,
            evidenceCoverage: auth.evidenceCoverage,
            ms: Date.now() - t0
          })
        }
        return {
          ok: true,
          agent: input.agent,
          output: auth.output,
          query: input.internalQuery,
          parsed: extractStructuredPayload(auth.output),
          evidence: { kind: input.agent, query: input.internalQuery, mode: auth.mode }
        }
      }
      if (hasCodeInResults(mergedResults)) {
        const banner = buildCodeFirstBundle({
          results: mergedResults,
          extractPayload: extractStructuredPayload,
          maxCodeChars: 400,
          maxRefChars: 0
        }).authorityBanner
        const payload = resolveCodeAuthorityPayload(mergedResults, extractStructuredPayload)
        if (input.agent === 'visualize') {
          const repaired = repairCodeAuthorityVisualize(mergedResults, extractStructuredPayload, banner, {
            evidence: [{ kind: 'visualize' }]
          })
          if (repaired) {
            void recordDownstreamMetric({
              runId,
              kind: 'chart',
              ok: true,
              mode: 'code_authority_repair',
              firstPass: false,
              ms: Date.now() - t0
            })
            return {
              ok: true,
              agent: input.agent,
              output: repaired,
              query: input.internalQuery,
              parsed: extractStructuredPayload(repaired),
              evidence: { kind: input.agent, query: input.internalQuery, mode: 'code_authority_repair' }
            }
          }
        } else if (payload) {
          const det = tryDeterministicDownstreamOutput(
            'report',
            mergedResults,
            extractStructuredPayload,
            { meta: input.state.meta, planSteps: input.state.plan }
          )
          if (det) {
            const gated = gateReportOutput(payload, det, banner, input.internalQuery)
            if (gated.ok) {
              void recordDownstreamMetric({
                runId,
                kind: 'report',
                ok: true,
                mode: 'code_authority_deterministic',
                evidenceCoverage: gated.coverage,
                ms: Date.now() - t0
              })
              return {
                ok: true,
                agent: input.agent,
                output: gated.output,
                query: input.internalQuery,
                parsed: extractStructuredPayload(gated.output),
                evidence: { kind: input.agent, query: input.internalQuery, mode: 'code_authority_deterministic' }
              }
            }
          }
        }
        void recordDownstreamMetric({
          runId,
          kind: input.agent === 'visualize' ? 'chart' : 'report',
          ok: false,
          reason: 'code_authority_required',
          ms: Date.now() - t0
        })
        return {
          ok: false,
          agent: input.agent,
          output: '',
          query: input.internalQuery,
          error: 'code_authority_required: 计划含 Code 步骤，禁止图表/报告回退通用 LLM 以免沿用 RAG/DB 裸数'
        }
      }
    }
    let res = ''
    let resObj: string | { answer: string } = ''
    if (input.vote?.enabled) {
      const c1Obj = await run(input.agent, `${input.internalQuery}\n\n候选版本：A（偏精炼）`, input.state, input.payload)
      const c2Obj = await run(input.agent, `${input.internalQuery}\n\n候选版本：B（偏完整）`, input.state, input.payload)
      const c1 = typeof c1Obj === 'string' ? c1Obj : c1Obj.answer
      const c2 = typeof c2Obj === 'string' ? c2Obj : c2Obj.answer
      const score1 = input.vote.score(c1)
      const score2 = input.vote.score(c2)
      const pickA = score1.total >= score2.total
      const winner = pickA ? score1 : score2
      const loser = pickA ? score2 : score1
      const winnerReason = [
        `total=${winner.total.toFixed(2)}`,
        `evidenceSupport=${winner.supportRate.toFixed(2)}`,
        `conflict=${winner.conflictCount}`,
        `base=${winner.base.toFixed(2)}`
      ].join(', ')
      res = pickA ? c1 : c2
      resObj = pickA ? c1Obj : c2Obj
      input.vote.onDecision?.({ selected: pickA ? 'A' : 'B', scoreA: score1, scoreB: score2, winnerReason })
    } else {
      resObj = await run(input.agent, input.internalQuery, input.state, input.payload)
      res = typeof resObj === 'string' ? resObj : resObj.answer
    }
    if (input.agent === 'visualize' && res && input.rewriteVisualize) {
      res = input.rewriteVisualize(res)
    }
    return {
      ok: true,
      agent: input.agent,
      output: res,
      query: input.internalQuery,
      parsed: extractStructuredPayload(res),
      evidence: { kind: input.agent, query: input.internalQuery }
    }
  } catch (e: unknown) {
    const err = String((e as Error)?.message || e || 'unknown error')
    return { ok: false, agent: input.agent, output: '', query: input.internalQuery, error: err }
  }
}
