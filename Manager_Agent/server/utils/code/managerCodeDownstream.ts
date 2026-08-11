import type { ChatOpenAI } from '@langchain/openai'
import type { ExtractPayloadFn } from '#agent-shared/codeFirstAuthority'
import { buildCodeFirstBundle } from '#agent-shared/codeFirstAuthority'
import { isRenderableChartOption, isVisualizeOutputRenderable, readEchartsOptionJsonFromVisualizeText } from '#agent-shared/chartOption'
import {
  resolveCodeAuthorityPayload,
  hasEchartsOptionBlock,
  buildVisualizeFromEmbeddedChart,
  assembleVisualizeFromChartPlan,
  readChartPlanFromData,
  readEmbeddedChartOption,
  embeddedChartHasMixedScales,
  enrichChartPlanWithPayload,
  syncChartPlanWithAuthorityTriplet,
  buildChartPlanFromFactsStructural,
  chartPlanHasUserFacingLabels,
  type LlmChartPlan,
  type CodeAuthorityPayload
} from '#agent-shared/codeAuthorityPayload'
import {
  tryDeterministicDownstreamOutput,
  type DownstreamKind
} from '#agent-shared/codeDownstreamOutput'
import { generateDownstreamFromCodeByLlm, planChartFromCodeByLlm, planReportFromCodeByLlm, isCodeAuthorityLlmEnabled, isVisualizeStructuralFirstEnabled } from './managerCodeAuthorityLlm'
import { assembleReportFromPlan, validateReportPlanEvidence, readReportBlock, validateReportOutputAgainstCode } from '#agent-shared/reportPlan'
import { gateReportOutput } from '#agent-shared/reportGate'
import { isMultiSourceDataPipeline } from '#agent-shared/dbPipelineDeterministic'
import { shouldDeferReportToSynth, deferredReportEvidence } from '#agent-shared/reportSynthDefer'
import { wantsNarrativeReportSynth, type SynthShapeContext } from '#agent-shared/synthShapePolicy'

export type CodeAuthorityDownstreamResult = {
  output: string
  mode: 'code_authority_deterministic' | 'code_authority_llm'
  firstPass?: boolean
  evidenceCoverage?: number
}

export type { DownstreamKind }

export { isVisualizeOutputRenderable } from '#agent-shared/chartOption'

function assembleVisualizeFromPayload(
  plan: LlmChartPlan,
  payload: CodeAuthorityPayload,
  banner: string
): string {
  const synced = syncChartPlanWithAuthorityTriplet(plan, payload)
  const enriched = enrichChartPlanWithPayload(synced, payload, { chartOnly: true })
  return assembleVisualizeFromChartPlan(enriched, banner, undefined, { chartOnly: true })
}

function validateVisualizeOutput(text: string): { ok: boolean; reason?: string } {
  if (!hasEchartsOptionBlock(text)) return { ok: false, reason: 'missing_echarts_block' }
  const opt = readEchartsOptionJsonFromVisualizeText(text)
  if (!opt) return { ok: false, reason: 'invalid_echarts_json' }
  if (!isRenderableChartOption(opt)) return { ok: false, reason: 'empty_or_invalid_series' }
  return { ok: true }
}

async function tryAssembleValidatedVisualize(
  plan: LlmChartPlan,
  payload: CodeAuthorityPayload,
  banner: string,
  model: ChatOpenAI | null,
  question: string,
  allowRetry: boolean
): Promise<{ output: string; mode: 'code_authority_deterministic' | 'code_authority_llm'; firstPass?: boolean } | null> {
  // 结构 plan 含机器字段名时不得上屏，直接交由 LLM 补用户可见 label
  if (!chartPlanHasUserFacingLabels(plan)) {
    if (!allowRetry || !model || !isCodeAuthorityLlmEnabled()) return null
    const retryPlan = await planChartFromCodeByLlm(model, payload, question, {
      retryReason: 'machine_identifier_labels'
    })
    if (!retryPlan?.panels.length || !chartPlanHasUserFacingLabels(retryPlan)) return null
    const fromRetry = assembleVisualizeFromPayload(retryPlan, payload, banner)
    const retryCheck = validateVisualizeOutput(fromRetry)
    if (!retryCheck.ok) return null
    return { output: fromRetry, mode: 'code_authority_llm', firstPass: false }
  }

  let fromPlan = assembleVisualizeFromPayload(plan, payload, banner)
  let check = validateVisualizeOutput(fromPlan)
  if (check.ok) {
    return {
      output: fromPlan,
      mode: model ? 'code_authority_llm' : 'code_authority_deterministic',
      firstPass: true
    }
  }
  if (!allowRetry || !model || !isCodeAuthorityLlmEnabled()) return null

  const retryPlan = await planChartFromCodeByLlm(model, payload, question, {
    retryReason: check.reason ?? 'chart_not_renderable'
  })
  if (!retryPlan?.panels.length || !chartPlanHasUserFacingLabels(retryPlan)) return null
  fromPlan = assembleVisualizeFromPayload(retryPlan, payload, banner)
  check = validateVisualizeOutput(fromPlan)
  if (!check.ok) return null
  return { output: fromPlan, mode: 'code_authority_llm', firstPass: false }
}

/** 有 Code：结构层 chart_plan 优先；LLM 仅规划语义，禁止直写 ECharts */
export async function tryCodeAuthorityDownstreamOutput(
  kind: DownstreamKind,
  results: Record<string, unknown>,
  extractPayload: ExtractPayloadFn | undefined,
  question: string,
  model: ChatOpenAI | null,
  shapeCtx: SynthShapeContext = {}
): Promise<CodeAuthorityDownstreamResult | null> {
  const q = String(question ?? '').trim()
  const payload = resolveCodeAuthorityPayload(results, extractPayload)
  if (!payload) return null

  const banner = buildCodeFirstBundle({ results, extractPayload, maxCodeChars: 400, maxRefChars: 0 }).authorityBanner

  if (kind === 'report') {
    if (shouldDeferReportToSynth(results, shapeCtx)) return null

    const narrative = wantsNarrativeReportSynth(shapeCtx)
    const multiSource = isMultiSourceDataPipeline(results)
    const preferLlm = narrative || multiSource

    if (model && isCodeAuthorityLlmEnabled()) {
      const reportPlan = await planReportFromCodeByLlm(model, payload, q)
      if (reportPlan) {
        const evidence = validateReportPlanEvidence(reportPlan, payload)
        if (evidence.ok) {
          const assembled = assembleReportFromPlan(reportPlan, banner)
          if (readReportBlock(assembled)) {
            const gated = gateReportOutput(payload, assembled, banner, q)
            if (gated.ok) {
              return {
                output: gated.output,
                mode: 'code_authority_llm',
                evidenceCoverage: gated.coverage ?? 1
              }
            }
          }
        }
      }
    }

    if (!preferLlm) {
      const det = tryDeterministicDownstreamOutput('report', results, extractPayload, shapeCtx)
      if (det) {
        const gated = gateReportOutput(payload, det, banner, q)
        if (!gated.ok) return null
        return {
          output: gated.output,
          mode: 'code_authority_deterministic',
          evidenceCoverage: gated.coverage
        }
      }
    }

    if (model && isCodeAuthorityLlmEnabled()) {
      const llm = await generateDownstreamFromCodeByLlm(model, 'report', payload, q, banner)
      if (llm) {
        const gated = gateReportOutput(payload, llm, banner, q)
        if (!gated.ok) return null
        return {
          output: gated.output,
          mode: 'code_authority_llm',
          evidenceCoverage: gated.coverage
        }
      }
    }
    return null
  }

  // ② Code 内嵌 chart_plan
  const embeddedPlan = readChartPlanFromData(payload.data)
  if (embeddedPlan) {
    const validated = await tryAssembleValidatedVisualize(embeddedPlan, payload, banner, null, q, false)
    if (validated) return { ...validated, firstPass: validated.firstPass ?? true }
  }

  // ③ 确定性结构 fallback（chartable facts；与 clean 结构层对齐，默认先于 LLM）
  if (isVisualizeStructuralFirstEnabled()) {
    const structuralPlan = buildChartPlanFromFactsStructural(payload)
    // 可渲染且标签可面向用户，才算结构层成功；否则回退 LLM 补 label
    if (structuralPlan?.panels.length && chartPlanHasUserFacingLabels(structuralPlan)) {
      const validated = await tryAssembleValidatedVisualize(structuralPlan, payload, banner, null, q, false)
      if (validated) return { ...validated, firstPass: validated.firstPass ?? true }
    }

    const embeddedOption = readEmbeddedChartOption(payload.data)
    if (embeddedOption && !embeddedChartHasMixedScales(embeddedOption)) {
      const embedded = buildVisualizeFromEmbeddedChart(payload, banner)
      if (embedded && isVisualizeOutputRenderable(embedded)) {
        return { output: embedded, mode: 'code_authority_deterministic', firstPass: true }
      }
    }
  }

  // ④ LLM 规划（结构层无法渲染时，启发模型选组/标签/数值）
  if (model && isCodeAuthorityLlmEnabled()) {
    const llmPlan = await planChartFromCodeByLlm(model, payload, q)
    if (llmPlan?.panels.length) {
      const validated = await tryAssembleValidatedVisualize(llmPlan, payload, banner, model, q, true)
      if (validated) return validated
    }
  }

  // ⑤ 结构层兜底（未开 structural-first 或 LLM 失败）
  if (!isVisualizeStructuralFirstEnabled()) {
    const structuralPlan = buildChartPlanFromFactsStructural(payload)
    if (structuralPlan?.panels.length && chartPlanHasUserFacingLabels(structuralPlan)) {
      const validated = await tryAssembleValidatedVisualize(structuralPlan, payload, banner, model, q, Boolean(model))
      if (validated) return { ...validated, firstPass: validated.firstPass ?? !model }
    }

    const embeddedOption = readEmbeddedChartOption(payload.data)
    if (embeddedOption && !embeddedChartHasMixedScales(embeddedOption)) {
      const embedded = buildVisualizeFromEmbeddedChart(payload, banner)
      if (embedded && isVisualizeOutputRenderable(embedded)) {
        return { output: embedded, mode: 'code_authority_deterministic', firstPass: true }
      }
    }
  }

  return null
}

/** 结构层重组装 visualize（不调用 LLM）；仅当存在 visualize 步骤证据时启用 */
export function repairCodeAuthorityVisualize(
  results: Record<string, unknown>,
  extractPayload?: ExtractPayloadFn,
  banner = '',
  opts?: { evidence?: Array<{ kind?: string }> }
): string | null {
  const evidence = Array.isArray(opts?.evidence) ? opts.evidence : []
  const hasVisualizeEvidence = evidence.some((e) => String(e?.kind ?? '') === 'visualize')
  if (!hasVisualizeEvidence) return null
  const payload = resolveCodeAuthorityPayload(results, extractPayload)
  if (!payload) return null

  const structuralPlan = buildChartPlanFromFactsStructural(payload)
  if (structuralPlan?.panels.length && chartPlanHasUserFacingLabels(structuralPlan)) {
    const out = assembleVisualizeFromPayload(structuralPlan, payload, banner)
    if (isVisualizeOutputRenderable(out)) return out
  }

  const embeddedPlan = readChartPlanFromData(payload.data)
  if (embeddedPlan) {
    const out = assembleVisualizeFromPayload(embeddedPlan, payload, banner)
    if (isVisualizeOutputRenderable(out)) return out
  }

  const embeddedOption = readEmbeddedChartOption(payload.data)
  if (embeddedOption && !embeddedChartHasMixedScales(embeddedOption)) {
    const embedded = buildVisualizeFromEmbeddedChart(payload, banner)
    if (embedded && isVisualizeOutputRenderable(embedded)) return embedded
  }
  return null
}
