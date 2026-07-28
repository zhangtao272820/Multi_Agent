import { z } from 'zod'
import { ChatOpenAI } from '@langchain/openai'
import { safeJsonParse } from '../core/shared/llmJson'
import { hasTaggedBlock } from '../../utils/shared/outputMarkers'
import { textWantsVisualizeStructural } from '../../utils/shared/visualizeMarkers'

const EvaluatorSchema = z.object({
  wants_visualize: z.boolean(),
  timeout_error: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
})

const TIMEOUT_MARKERS = ['timeout', 'timed out', 'socket hang up'] as const

export function isEvaluatorLlmEnabled(): boolean {
  return String(process.env.MANAGER_EVALUATOR_LLM ?? '1').trim() !== '0'
}

export function wantsVisualizeStructural(text: string): boolean {
  return textWantsVisualizeStructural(text)
}

export function isTimeoutErrorStructural(error: string): boolean {
  const e = String(error ?? '').toLowerCase()
  return TIMEOUT_MARKERS.some((m) => e.includes(m))
}

export function hasChartJsonStructural(visualizeText: string): boolean {
  const v = String(visualizeText ?? '')
  return v.includes('"series"') && v.includes('[') || v.includes('"xAxis"')
}

export async function resolveEvaluatorSignalsByLlm(
  model: ChatOpenAI | null,
  input: {
    routedQuery?: string
    userInput?: string
    plannedVisualize?: boolean
    intent?: string
  },
): Promise<{ wantsVisualize: boolean } | null> {
  if (!model) return null
  const text = [input.userInput, input.routedQuery].filter(Boolean).join('\n').slice(0, 800)
  if (!text.trim()) return null
  try {
    const res = await model.invoke([
      [
        'system',
        [
          '你是任务评估信号解析器。判断用户是否要求图表/可视化输出，只输出 JSON。',
          'schema: {"wants_visualize":boolean,"confidence":number}',
        ].join('\n'),
      ],
      [
        'human',
        [
          `intent=${input.intent ?? ''}`,
          `plannedVisualize=${Boolean(input.plannedVisualize)}`,
          text,
        ].join('\n'),
      ],
    ])
    const parsed = EvaluatorSchema.safeParse(safeJsonParse(String(res.content ?? '').trim()))
    if (!parsed.success || Number(parsed.data.confidence ?? 0) < 0.5) return null
    return { wantsVisualize: parsed.data.wants_visualize }
  } catch {
    return null
  }
}

export async function resolveWantsVisualize(
  model: ChatOpenAI | null,
  input: {
    routedQuery?: string
    userInput?: string
    plannedVisualize?: boolean
    intent?: string
  },
): Promise<boolean> {
  if (input.plannedVisualize || input.intent === 'visualize') return true
  const structural = wantsVisualizeStructural(String(input.routedQuery ?? '') + String(input.userInput ?? ''))
  if (!isEvaluatorLlmEnabled()) return structural
  const llm = await resolveEvaluatorSignalsByLlm(model, input)
  return llm?.wantsVisualize ?? structural
}

export function assessVisualizeIntegrity(input: {
  wantsVisualize: boolean
  visualizeText: string
  finalText: string
}): boolean {
  const hasVisualizeOutput = String(input.visualizeText ?? '').trim().length > 0
  const hasRenderableChartInFinal = hasTaggedBlock(String(input.finalText ?? ''), 'ECHARTS_OPTION')
  const hasChartJsonInVisualize = hasChartJsonStructural(input.visualizeText)
  return !input.wantsVisualize || !hasVisualizeOutput || hasRenderableChartInFinal || hasChartJsonInVisualize
}

export function countTimeoutErrors(evidence: Array<Record<string, unknown>>): number {
  return evidence.filter((e) => {
    if (String(e?.kind ?? '') !== 'error') return false
    return isTimeoutErrorStructural(String(e?.error ?? ''))
  }).length
}
