import type { ChatOpenAI } from '@langchain/openai'
import type { ExtractPayloadFn } from '#agent-shared/codeFirstAuthority'
import {
  assessCodeDownstreamConsistencyStructural,
  normalizeCodeOutputStructural,
  resolveCodeAuthorityPayload,
  type CodeDownstreamConsistencyResult
} from '#agent-shared/codeAuthorityPayload'
import { isMultiSourceDataPipeline } from '#agent-shared/dbPipelineDeterministic'
import { mergeFactsWithCodePriority, formatFactsMarkdown, collectAgentAnswerSummariesForAudit } from '#agent-shared/codeFirstAuthority'
import {
  assessCodeDownstreamConsistencyByLlm,
  enrichCodeOutputByLlm,
  isCodeAuthorityLlmEnabled,
  isCodePrefillChartPlanEnabled
} from './managerCodeAuthorityLlm'

function hasViableEmbeddedChartPlan(data: Record<string, unknown> | undefined): boolean {
  if (!data || typeof data !== 'object') return false
  const plan = data.chart_plan ?? data.chartPlan
  if (!plan || typeof plan !== 'object') return false
  const panels = (plan as { panels?: unknown[] }).panels
  if (Array.isArray(panels) && panels.length) {
    return panels.some(
      (p) =>
        Array.isArray((p as { series?: unknown[] }).series) &&
        ((p as { series?: unknown[] }).series?.length ?? 0) >= 1
    )
  }
  const series = (plan as { series?: unknown[] }).series
  return Array.isArray(series) && series.length >= 2
}

export function shouldEnrichCodeByLlm(codeRaw: string): boolean {
  if (String(process.env.MANAGER_CODE_SKIP_ENRICH ?? '1').trim() === '1') return false
  if (!isCodeAuthorityLlmEnabled() || !isCodePrefillChartPlanEnabled()) return false
  const txt = String(codeRaw ?? '').trim()
  if (!txt.startsWith('{')) return false
  try {
    const obj = JSON.parse(txt) as { facts?: unknown[]; data?: Record<string, unknown> }
    const facts = Array.isArray(obj.facts) ? obj.facts : []
    if (facts.length >= 2 && hasViableEmbeddedChartPlan(obj.data)) return false
    return facts.length >= 2
  } catch {
    /* ignore */
  }
  return false
}

/** Code 步骤后：结构归一化 + 启发模型补全（通用计算） */
export async function normalizeCodeOutputAsync(
  model: ChatOpenAI | null,
  codeRaw: string,
  extractPayload?: ExtractPayloadFn
): Promise<string> {
  const structural = normalizeCodeOutputStructural(codeRaw, extractPayload)
  if (!shouldEnrichCodeByLlm(structural)) return structural
  const enriched = await enrichCodeOutputByLlm(model, structural)
  if (!enriched) return structural
  return normalizeCodeOutputStructural(enriched, extractPayload)
}

/** Critic：结构校验 + 启发模型审计 */
export async function assessCodeDownstreamConsistencyAsync(
  model: ChatOpenAI | null,
  params: {
    final?: string
    results?: Record<string, unknown>
    extractPayload?: ExtractPayloadFn
    evidence?: Array<{ kind?: string; mode?: string }>
  }
): Promise<CodeDownstreamConsistencyResult> {
  const structural = assessCodeDownstreamConsistencyStructural({
    final: params.final,
    results: params.results,
    extractPayload: params.extractPayload,
    evidence: params.evidence
  })
  if (!structural.pass) return structural

  const evidence = Array.isArray(params.evidence) ? params.evidence : []
  const deterministicOnlyModes = new Set(['code_authority_deterministic', 'code_authority_repair'])
  const downstreamEvidence = evidence.filter((e) => {
    const kind = String(e?.kind ?? '')
    return kind === 'visualize' || kind === 'report'
  })
  const skipLlmAudit =
    downstreamEvidence.length > 0 &&
    downstreamEvidence.every((e) => deterministicOnlyModes.has(String(e?.mode ?? '')))
  if (skipLlmAudit) return structural

  const results = params.results && typeof params.results === 'object' ? params.results : {}
  const reportDeferred = evidence.some(
    (e) =>
      String((e as { kind?: string })?.kind ?? '') === 'report' &&
      String((e as { mode?: string })?.mode ?? '') === 'deferred_to_synth'
  )
  const hasCodeAuthorityViz = evidence.some(
    (e) =>
      String((e as { kind?: string })?.kind ?? '') === 'visualize' &&
      /code_authority/i.test(String((e as { mode?: string })?.mode ?? ''))
  )
  if (
    reportDeferred &&
    !String(results.report ?? '').trim() &&
    !String(results.visualize ?? '').includes('ECHARTS_OPTION') &&
    !hasCodeAuthorityViz
  ) {
    return structural
  }

  const payload = resolveCodeAuthorityPayload(results, params.extractPayload)
  if (!payload || !model || !isCodeAuthorityLlmEnabled()) return structural

  const multiSource = isMultiSourceDataPipeline(results)
  const mergedFacts = mergeFactsWithCodePriority(results, params.extractPayload)
  const upstreamSummary = formatFactsMarkdown(mergedFacts, '上游合并事实')
  const agentSummaries = collectAgentAnswerSummariesForAudit(results, params.extractPayload)

  const llm = await assessCodeDownstreamConsistencyByLlm(model, {
    payload,
    final: params.final,
    visualize: String(results.visualize ?? ''),
    report: String(results.report ?? ''),
    upstreamSummary,
    agentSummaries,
    multiSource
  })
  return llm ?? structural
}
