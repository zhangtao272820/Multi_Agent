import { z } from 'zod'
import { safeJsonParse } from '../../graph/core/shared/llmJson'
import type { LlmInvokeFn } from '../../graph/llm/taskConstraintsLlm'
import type { ExecutableAgent } from '../../graph/core/routing/routeFinalize'
import type { IntentClassifyResult } from '../../graph/llm/intentClassifyLlm'
import { inferDataSourcesFromClassify } from '../../graph/orchestrate/routeOrchestration'
import type { WebExecutionModeDecision } from '../search/managerWebExecutionModeLlm'

const CompositeRouteSchema = z.object({
  isCompositeDataWeb: z.boolean(),
  dataAgents: z.array(z.enum(['db', 'rag'])).max(2).default([]),
  webExecution: z.enum(['serp_summary', 'crawl', 'none']).default('none'),
  suggestedAgents: z
    .array(
      z.enum([
        'db',
        'rag',
        'code',
        'crawler',
        'gui',
        'admin',
        'clean',
        'visualize',
        'report',
        'multimodal',
        'music',
        'video'
      ])
    )
    .max(8)
    .default([]),
  forbidGui: z.boolean().default(true),
  needsWebSearch: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(480).default('')
})

export type CompositeRouteGuard = z.infer<typeof CompositeRouteSchema>

/** 复合守卫与意图识别 dataSources 对齐：知识库任务不得塞 db */
export function reconcileCompositeGuardWithClassify(
  guard: CompositeRouteGuard,
  ic: IntentClassifyResult | null | undefined
): CompositeRouteGuard {
  if (!ic) return guard
  const sources = inferDataSourcesFromClassify(ic)
  const ragOnly = sources.includes('rag') && !sources.includes('db') && !ic.isDbAnchored
  if (!ragOnly) return guard

  const agents = new Set(guard.suggestedAgents || [])
  agents.delete('db')
  agents.add('rag')
  agents.add('crawler')

  return {
    ...guard,
    dataAgents: ['rag'],
    suggestedAgents: [...agents],
    rationale: guard.rationale || ic.rationale || '知识库取数与公网参考对照'
  }
}

export function isCompositeRouteGuardLlmEnabled(): boolean {
  return String(process.env.MANAGER_COMPOSITE_ROUTE_GUARD_LLM ?? '1').trim() !== '0'
}

/** 意图识别：库内/知识库取数 + 公网参考/对比 → 复合 multi，禁止整轮 gui */
export function inferCompositeRouteStructural(input: {
  intentClassify?: IntentClassifyResult | null
  allowedAgents?: ExecutableAgent[]
}): CompositeRouteGuard | null {
  const ic = input.intentClassify
  if (!ic) return null
  if (Number(ic.confidence ?? 0) < 0.52) return null

  const needsWeb = ic.needsWeb === true
  const ragKb =
    (ic.primaryIntent === 'rag' || ic.planShortcut === 'rag_only') && !ic.isDbAnchored
  const dbAnchored = ic.isDbAnchored || ic.primaryIntent === 'db'
  const wantsChart = ic.explicitWantsVisualize || ic.explicitWantsReport

  if (ragKb && needsWeb) {
    const agents = new Set<ExecutableAgent>(input.allowedAgents || [])
    for (const a of ic.suggestedAgents || []) agents.add(a as ExecutableAgent)
    agents.add('rag')
    agents.add('crawler')
    if (ic.explicitWantsVisualize) {
      agents.add('visualize')
      agents.add('code')
    }
    if (ic.explicitWantsReport) agents.add('report')
    agents.delete('gui')
    agents.delete('db')

    return {
      isCompositeDataWeb: true,
      dataAgents: ['rag'],
      webExecution: wantsChart ? 'crawl' : 'serp_summary',
      suggestedAgents: [...agents],
      forbidGui: true,
      needsWebSearch: true,
      confidence: Number(ic.confidence),
      rationale: ic.rationale || '知识库取数与公网参考对照'
    }
  }

  if (!dbAnchored || !needsWeb) return null

  const agents = new Set<ExecutableAgent>(input.allowedAgents || [])
  for (const a of ic.suggestedAgents || []) agents.add(a as ExecutableAgent)
  agents.add('db')
  agents.add('crawler')
  if (ic.explicitWantsReport) agents.add('report')
  if (ic.explicitWantsVisualize) agents.add('visualize')
  agents.delete('gui')

  return {
    isCompositeDataWeb: true,
    dataAgents: ['db'],
    webExecution: 'serp_summary',
    suggestedAgents: [...agents],
    forbidGui: true,
    needsWebSearch: true,
    confidence: Number(ic.confidence),
    rationale: ic.rationale || '库内记录与公网参考对照'
  }
}

/**
 * 复合守卫 webExecution → 路由 webExecutionMode。
 * 根因：pipelineRequired（multi/report）不得绑架公网腿必须深抓；
 * serp_summary 固定 search_serp_only，仅 crawl 才 search_then_crawl。
 */
export function webExecutionModeFromCompositeGuard(
  webExecution: CompositeRouteGuard['webExecution'] | null | undefined,
  rationale?: string
): WebExecutionModeDecision | null {
  if (!webExecution || webExecution === 'none') return null
  if (webExecution === 'serp_summary') {
    return {
      mode: 'search_serp_only',
      primaryAgent: 'crawler',
      needsWebSearch: true,
      serpSummaryEnough: true,
      confidence: 0.88,
      rationale: rationale || '复合任务：公网腿仅需 SERP 摘要'
    }
  }
  return {
    mode: 'search_then_crawl',
    primaryAgent: 'crawler',
    needsWebSearch: true,
    serpSummaryEnough: false,
    confidence: 0.88,
    rationale: rationale || '复合任务：公网腿需页面精抓'
  }
}

/**
 * LLM：判定「库内/知识库取数 + 公网检索参考」类复合任务。
 * 此类任务应走 multi（db + crawler/SERP），禁止整轮 gui。
 */
export async function resolveCompositeRouteGuardByLlm(input: {
  userText: string
  routeIntent?: string
  allowedAgents?: ExecutableAgent[]
  intentClassify?: IntentClassifyResult | null
  llmInvoke?: LlmInvokeFn | null
  state?: unknown
}): Promise<CompositeRouteGuard | null> {
  const ic = input.intentClassify
  const agents = (input.allowedAgents ?? []).map(String)
  // 无公网信号：禁止再打复合守卫 LLM（避免 rag∥db→report 被误扩 crawler）
  const hasWebSignal =
    ic?.needsWeb === true ||
    agents.includes('crawler') ||
    agents.includes('gui') ||
    (ic?.dataSources ?? []).includes('crawler')
  if (!hasWebSignal) {
    return null
  }

  const structural = inferCompositeRouteStructural({
    intentClassify: ic,
    allowedAgents: input.allowedAgents
  })
  if (structural && Number(structural.confidence) >= 0.62) {
    return reconcileCompositeGuardWithClassify(structural, ic)
  }

  if (!isCompositeRouteGuardLlmEnabled()) {
    return structural ? reconcileCompositeGuardWithClassify(structural, ic) : structural
  }

  const task = String(input.userText || '').trim()
  if (task.length < 8) return structural

  const hint = ic
    ? [
        `primaryIntent=${ic.primaryIntent}`,
        `dataSources=${(ic.dataSources || []).join(',') || '?'}`,
        `isDbAnchored=${ic.isDbAnchored}`,
        `needsWeb=${ic.needsWeb}`,
        `isMulti=${ic.isMulti}`,
        `suggestedAgents=${(ic.suggestedAgents || []).join(',')}`
      ].join(' ')
    : ''

  try {
    if (!input.llmInvoke || !input.state) return structural
    const r = await input.llmInvoke(
      'route',
      input.state,
      [
        [
          'system',
          [
            '你是总管复合路由守卫。判断用户是否同时需要：',
            '1) 从业务数据库/表（db）或知识库文档（rag）取事实；',
            '2) 从公开网站检索参考区间/指南/政策摘要等（crawler + 联网检索，非浏览器点击）；',
            '3) 可选：对照后生成报告/图表（report/visualize/code）。',
            'isCompositeDataWeb=true 时：forbidGui=true，needsWebSearch=true；',
            '知识库+公网+图表/对比 → dataAgents 含 rag、webExecution=crawl、须 code/visualize；',
            '业务库+公网 → dataAgents 含 db；仅摘要对照可用 serp_summary。',
            '禁止把「公开网站检索/参考区间/指南摘要」判为 gui（gui 仅用于打开页面并点击/填表）。',
            'suggestedAgents 须含 crawler 与 rag 或 db；若用户要图表则含 code+visualize；勿含 gui。',
            '只输出 JSON，无 markdown。',
            'schema: {"isCompositeDataWeb":bool,"dataAgents":["db"|"rag"],"webExecution":"serp_summary|crawl|none","suggestedAgents":[],"forbidGui":bool,"needsWebSearch":bool,"confidence":0-1,"rationale":"..."}'
          ].join('\n')
        ],
        [
          'human',
          [
            `【用户任务】\n${task.slice(0, 1200)}`,
            `【路由 intent】${String(input.routeIntent || '')}`,
            `【当前 allowed】${(input.allowedAgents || []).join(', ') || '（空）'}`,
            hint ? `【意图识别】${hint}` : ''
          ]
            .filter(Boolean)
            .join('\n\n')
        ]
      ],
      { tier: 'light', thinkingLabel: '复合路由：是否库内+公网对照' }
    )
    const parsed = CompositeRouteSchema.safeParse(safeJsonParse(String(r.text ?? '').trim()))
    if (!parsed.success || Number(parsed.data.confidence) < 0.5) return structural
    if (!parsed.data.isCompositeDataWeb) return null
    return reconcileCompositeGuardWithClassify(parsed.data, ic)
  } catch {
    return structural ? reconcileCompositeGuardWithClassify(structural, ic) : structural
  }
}

/** 将复合守卫结果落到 intent / allowed / needsWebSearch / webExecution */
export function applyCompositeRouteGuard(input: {
  intent: string
  allowedAgents: ExecutableAgent[]
  llmNeedsWebSearch?: boolean
  guard: CompositeRouteGuard | null
  intentClassify?: IntentClassifyResult | null
}): {
  intent: string
  allowedAgents: ExecutableAgent[]
  llmNeedsWebSearch: boolean
  compositeDataWebRoute: boolean
  webExecution: CompositeRouteGuard['webExecution']
} {
  const guard = reconcileCompositeGuardWithClassify(input.guard, input.intentClassify)
  if (!guard?.isCompositeDataWeb) {
    return {
      intent: input.intent,
      allowedAgents: input.allowedAgents,
      llmNeedsWebSearch: input.llmNeedsWebSearch === true,
      compositeDataWebRoute: false,
      webExecution: 'none'
    }
  }

  const merged = new Set<ExecutableAgent>(input.allowedAgents)
  for (const a of guard.suggestedAgents || []) merged.add(a as ExecutableAgent)
  for (const a of guard.dataAgents || []) merged.add(a as ExecutableAgent)
  merged.add('crawler')
  if (guard.forbidGui) merged.delete('gui')
  if (guard.dataAgents?.length === 1 && guard.dataAgents[0] === 'rag') merged.delete('db')

  const allowed = [...merged]
  let intent = allowed.length > 1 ? 'multi' : String(input.intent || 'multi')
  if (intent === 'gui' || intent === 'crawler') intent = 'multi'

  const webExecution =
    guard.webExecution === 'crawl' || guard.webExecution === 'serp_summary' ? guard.webExecution : 'serp_summary'

  return {
    intent,
    allowedAgents: allowed,
    llmNeedsWebSearch: guard.needsWebSearch === true || input.llmNeedsWebSearch === true,
    compositeDataWebRoute: true,
    webExecution
  }
}
