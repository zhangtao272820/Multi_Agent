import { z } from 'zod'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { safeJsonParse } from '../core/shared/llmJson'
import type { LlmInvokeFn } from './taskConstraintsLlm'
import { routingDecisionLlmTier } from '../core/shared/modelTier'
import { resolveManagerEnvBool } from '../../utils/platform/managerEnvModes'
import {
  PresentationPlanSchema,
  type AvailableArtifact,
  type OrchestrationThicknessHint,
  type PresentationPlan,
  formatArtifactsForPresentationLlm,
  assembleStructuralPresentationFallback
} from '#agent-shared/presentationPlan'

export { PresentationPlanSchema }
export type { PresentationPlan }

export function isPresentationPlanLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveManagerEnvBool('MANAGER_PRESENTATION_PLAN_LLM', env)
}

const PresentationPlanLlmSchema = PresentationPlanSchema.extend({
  source: z.literal('llm').optional()
})

/**
 * Cursor 式展示决策：模型根据用户任务 + 可用 artifacts 选择 replyTier 与 UI 模块。
 * 禁止用户原话 regex；失败时返回 null，由 structural fallback 接管。
 */
export async function classifyPresentationPlanByLlm(input: {
  question: string
  thickness: OrchestrationThicknessHint
  turnKind?: string
  artifacts: AvailableArtifact[]
  llmInvoke: LlmInvokeFn
  state: unknown
}): Promise<PresentationPlan | null> {
  if (!isPresentationPlanLlmEnabled()) return null
  const question = String(input.question || '').trim()
  if (!question) return null

  const artifactBlock = formatArtifactsForPresentationLlm(input.artifacts)
  const turnKind = String(input.turnKind || 'new_task').trim()

  try {
    const r = await input.llmInvoke(
      'route',
      input.state,
      [
        new SystemMessage(
          [
            '你是总管 Agent 的「展示编排」节点（对齐 Cursor Generative UI）。',
            '根据用户任务与可用专家产物，决定：replyTier、要渲染的 UI 模块、follow-up suggestions。',
            '你只输出 JSON，不写面向用户的正文。',
            '',
            'replyTier：',
            '- lite：寒暄/确认/单条写操作回执（1～3 句，无图表无大表）',
            '- standard：单源问答/知识讲解（对话体，按需表或来源，通常无 chart）',
            '- report：多源分析/对照/趋势/报告（完整结构 + 可选 chart/table/附录）',
            '',
            'modules（至少含 prose；按需追加）：',
            'prose, headline, metrics, chart, table, report_appendix, sources, suggestions, actions',
            '- prose 几乎始终需要；headline 仅 standard/report 且需要顶栏结论时',
            '- chart 仅当 visualize_chart artifact 且用户需要趋势/对比/分布',
            '- table 仅当用户要明细/清单/对照表，或 db/visualize_table 且行数合理；单源 count 题可省略',
            '- report_appendix 仅 report 档且有 report_draft',
            '- sources 有 rag/crawler 且用户需要可追溯',
            '- suggestions 1～3 条用户可接着问的方向（与本轮主题相关，禁止空泛）',
            '- actions 仅当 meta 含待确认写操作（通常由系统注入，你可省略）',
            '',
            '消重：选了 chart 则正文少重复数字；选了 table 则正文不铺宽表。',
            'memory_capture / 寒暄：lite + prose only。',
            '单源简单 fact：standard + prose (+ sources/table 二选一，倾向 prose 为主)。',
            '复杂多源：report + prose + headline + 按需 chart/table/report_appendix + sources + suggestions。',
            '禁止输出 pipeline/agent 名称列表。'
          ].join('\n')
        ),
        new HumanMessage(
          [
            `编排厚度：${input.thickness}`,
            `轮次类型：${turnKind}`,
            `【用户任务】\n${question.slice(0, 1200)}`,
            `【可用 artifacts】\n${artifactBlock}`,
            'schema: {"replyTier":"lite|standard|report","modules":[{"type":"prose|headline|..."}],"suggestions":["..."],"proseStyle":"conversational|analytical|confirm","confidence":0-1,"rationale":"..."}'
          ].join('\n\n')
        )
      ],
      { tier: routingDecisionLlmTier(input.state), quiet: true }
    )
    const parsed = PresentationPlanLlmSchema.safeParse(safeJsonParse(String(r.text ?? '').trim()))
    if (!parsed.success) return null
    if (Number(parsed.data.confidence) < 0.42) return null
    const modules = parsed.data.modules.filter((m) => m.type !== 'actions')
    if (!modules.some((m) => m.type === 'prose')) {
      modules.unshift({ type: 'prose' })
    }
    return {
      ...parsed.data,
      modules,
      source: 'llm'
    }
  } catch {
    return null
  }
}

export async function resolvePresentationPlan(input: {
  question: string
  thickness: OrchestrationThicknessHint
  turnKind?: string
  artifacts: AvailableArtifact[]
  llmInvoke: LlmInvokeFn
  state: unknown
}): Promise<PresentationPlan> {
  const fromLlm = await classifyPresentationPlanByLlm(input)
  if (fromLlm) return fromLlm
  return assembleStructuralPresentationFallback({
    thickness: input.thickness,
    artifacts: input.artifacts
  })
}
