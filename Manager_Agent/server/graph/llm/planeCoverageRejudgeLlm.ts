/**
 * 平面库存覆盖再判：编排/对齐之后、冻结 cap 之前。
 * 仅用 runtime catalog（表库存/文档库存）判断「当前单源平面能否答」；
 * 禁止用户原话正则、禁止凭库存扩成 multi / 加 crawler/admin。
 */
import { z } from 'zod'
import { safeJsonParse } from '../core/shared/llmJson'
import type { LlmInvokeFn } from './taskConstraintsLlm'
import type { TaskOrchestratorBundle, TaskOrchestratorRaw } from './taskOrchestrator'
import { bundleFromOrchestratorRaw } from './taskOrchestrator'
import { routingDecisionLlmTier } from '../core/shared/modelTier'
import { resolveManagerEnvBool } from '../../utils/platform/managerEnvModes'
import { isLlmFirstRouteEnabled } from '../orchestrate/unifiedRouting'
import {
  formatRuntimeCatalogsForOrchestrator,
  type ProbeDbSlice,
  type ProbeRagSlice
} from '../core/probe/probeInterpretation'
import { buildTopologyBlueprintFromCap } from './planBlueprintLlm'
import type { TaskClause } from '../core/routing/clauses'
import {
  shouldClarifyForNoInventoryCoverage,
  shouldLockPlaneCoverageFlip,
  sourceCommitmentFromRaw
} from '../orchestrate/sourceCommitment'

const DATA_PLANES = new Set(['db', 'rag'])

const CoverageSchema = z.object({
  dbCanAnswer: z.boolean(),
  ragCanAnswer: z.boolean(),
  preferredPlane: z.enum(['db', 'rag', 'keep']).default('keep'),
  confidence: z.number().min(0).max(1).default(0),
  rationale: z.string().max(400).default('')
})

export type PlaneCoverageDecision = z.infer<typeof CoverageSchema>

export function isPlaneCoverageRejudgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isLlmFirstRouteEnabled(env)) return false
  return resolveManagerEnvBool('MANAGER_PLANE_COVERAGE_REJUDGE', env)
}

/** cap 中数据面：仅当恰好一个 db|rag（无 crawler）才允许翻面 */
export function singleDataPlaneFromCap(allowedAgents: readonly string[]): 'db' | 'rag' | null {
  const planes = [...new Set(allowedAgents.map(String).filter((a) => DATA_PLANES.has(a)))]
  if (planes.length !== 1) return null
  if (allowedAgents.map(String).includes('crawler')) return null
  return planes[0] as 'db' | 'rag'
}

export function catalogsHaveInventory(probe?: {
  db?: ProbeDbSlice | null
  rag?: ProbeRagSlice | null
} | null): boolean {
  const tables = (probe?.db?.tableInventory ?? []).map((t) => String(t || '').trim()).filter(Boolean)
  const docs = (probe?.rag?.docInventory ?? []).map((s) => String(s || '').trim()).filter(Boolean)
  return tables.length > 0 || docs.length > 0
}

const MIN_CONFIDENCE = 0.7

/**
 * 门禁：仅单源 db xor rag；高置信；且「当前不能答 + 另一面能答」才允许翻面。
 */
export function gatePlaneCoverageFlip(
  proposedPlane: 'db' | 'rag',
  decision: PlaneCoverageDecision
): 'db' | 'rag' | null {
  if (decision.preferredPlane === 'keep') return null
  if (decision.confidence < MIN_CONFIDENCE) return null
  if (decision.preferredPlane === proposedPlane) return null

  if (proposedPlane === 'db' && decision.preferredPlane === 'rag') {
    if (decision.dbCanAnswer) return null
    if (!decision.ragCanAnswer) return null
    return 'rag'
  }
  if (proposedPlane === 'rag' && decision.preferredPlane === 'db') {
    if (decision.ragCanAnswer) return null
    if (!decision.dbCanAnswer) return null
    return 'db'
  }
  return null
}

function rewriteClauseAgents(clauses: TaskClause[], from: 'db' | 'rag', to: 'db' | 'rag'): TaskClause[] {
  return clauses.map((c) => {
    const agents = (c.agents || []).map((a) => (String(a) === from ? to : a))
    return { ...c, agents: agents as TaskClause['agents'] }
  })
}

/** 纯函数：将单源数据面从 from 翻到 to，并重建蓝图 */
export function applyPlaneCoverageRewrite(
  bundle: TaskOrchestratorBundle,
  from: 'db' | 'rag',
  to: 'db' | 'rag',
  userTask: string,
  rationale?: string
): TaskOrchestratorBundle {
  const allowed = bundle.allowedAgents.map((a) => (String(a) === from ? to : String(a)))
  const clauses = rewriteClauseAgents(bundle.clauses, from, to)
  const dataSources = [
    ...new Set(
      (bundle.intentClassify.dataSources || [])
        .map(String)
        .map((d) => (d === from ? to : d))
        .filter((d) => d === 'db' || d === 'rag' || d === 'crawler')
    )
  ] as Array<'db' | 'rag' | 'crawler'>
  if (!dataSources.includes(to)) dataSources.unshift(to)
  const filteredDs = dataSources.filter((d) => d !== from || from === to)

  const planShortcut = to === 'db' ? 'db_only' : 'rag_only'
  const taskIntent = to === 'db' ? 'structured_query' : 'document_retrieval'
  const isDbAnchored = to === 'db'

  const bp = buildTopologyBlueprintFromCap({
    allowedAgents: allowed,
    clauses,
    userTask: userTask || bundle.routedQuery
  })

  const raw: TaskOrchestratorRaw = {
    ...bundle.raw,
    allowedAgents: allowed as TaskOrchestratorRaw['allowedAgents'],
    suggestedAgents: allowed.filter((a) => !['clean', 'code', 'visualize', 'report'].includes(a)) as TaskOrchestratorRaw['suggestedAgents'],
    clauses: clauses.map((c) => ({
      id: c.id,
      text: c.text,
      agents: c.agents,
      layer: c.layer,
      taskForm: c.taskForm
    })),
    dataSources: filteredDs.length ? filteredDs : [to],
    isDbAnchored,
    planShortcut: planShortcut as TaskOrchestratorRaw['planShortcut'],
    taskIntent: taskIntent as TaskOrchestratorRaw['taskIntent'],
    intent: allowed.length === 1 ? to : bundle.raw.intent,
    primaryIntent: allowed.length === 1 ? to : bundle.raw.primaryIntent,
    planBlueprint: bp ?? undefined,
    rationale: rationale
      ? `plane_cover:${rationale}`.slice(0, 520)
      : bundle.raw.rationale
  }

  const merged = bundleFromOrchestratorRaw(raw)
  return {
    ...merged,
    stepDispatchDraft: bundle.stepDispatchDraft
  }
}

export async function rejudgePlaneCoverageByInventory(input: {
  lastUser: string
  bundle: TaskOrchestratorBundle
  probe?: { db?: ProbeDbSlice | null; rag?: ProbeRagSlice | null } | null
  llmInvoke: LlmInvokeFn
  state: unknown
}): Promise<{
  bundle: TaskOrchestratorBundle
  rewritten: boolean
  from?: 'db' | 'rag'
  to?: 'db' | 'rag'
  decision?: PlaneCoverageDecision
  /** clear 锁定面但库存盖不住 → 调用方应 clarify */
  noCoverageClarify?: boolean
}> {
  const last = String(input.lastUser || '').trim()
  if (!isPlaneCoverageRejudgeEnabled() || last.length < 4) {
    return { bundle: input.bundle, rewritten: false }
  }

  const proposed = singleDataPlaneFromCap(input.bundle.allowedAgents)
  if (!proposed) return { bundle: input.bundle, rewritten: false }
  if (!catalogsHaveInventory(input.probe)) return { bundle: input.bundle, rewritten: false }

  const commitSlice = sourceCommitmentFromRaw(input.bundle.raw as Record<string, unknown>)
  const lockFlip = shouldLockPlaneCoverageFlip(commitSlice)

  const catalogBlock = formatRuntimeCatalogsForOrchestrator(input.probe)
  const proposedCap = {
    allowedAgents: input.bundle.allowedAgents,
    dataSources: input.bundle.intentClassify.dataSources ?? [],
    taskIntent: (input.bundle.raw as { taskIntent?: string }).taskIntent ?? null,
    planShortcut: input.bundle.intentClassify.planShortcut ?? null,
    sourceCommitment: commitSlice.sourceCommitment,
    committedPlanes: commitSlice.committedPlanes
  }

  try {
    const r = await input.llmInvoke(
      'route',
      input.state,
      [
        [
          'system',
          [
            '你是「数据面库存覆盖审查器」。只根据【运行时目录】判断当前编排选的 db/rag 能否答【用户末轮】。',
            '禁止凭领域词/示例问句路由；禁止把库存扩成 multi；禁止加 crawler/admin。',
            'structured_query：答案须来自可查询库表行/聚合 → 对照 db_catalog 库存表名能否覆盖。',
            'document_retrieval：答案须来自文档/手册/报告原文段落 → 对照 rag_catalog 库存文档名能否覆盖。',
            '听起来像「个人情况/怎么样/统计」≠ 默认 db；库存表盖不住且文档库存能盖 → preferredPlane=rag。',
            '库存文档盖不住且库表能盖 → preferredPlane=db。两边都能或都不能 → preferredPlane=keep。',
            '若 sourceCommitment=clear 且 committedPlanes 已锁数据面：只评估该面能否答，preferredPlane 须 keep（禁止翻面；盖不住由上层 clarify）。',
            '只输出 JSON，无 markdown。'
          ].join('\n')
        ],
        [
          'human',
          [
            `【用户末轮】\n${last.slice(0, 1200)}`,
            `【当前编排·待审查】\n${JSON.stringify(proposedCap).slice(0, 800)}`,
            `【运行时目录·存在性依据】\n${catalogBlock.slice(0, 1000)}`,
            'schema: {"dbCanAnswer":bool,"ragCanAnswer":bool,"preferredPlane":"db"|"rag"|"keep","confidence":0-1,"rationale":"..."}'
          ].join('\n\n')
        ]
      ],
      { tier: routingDecisionLlmTier(input.state), quiet: true }
    )

    const parsed = CoverageSchema.safeParse(safeJsonParse(String(r.text ?? '').trim()))
    if (!parsed.success) return { bundle: input.bundle, rewritten: false }

    if (lockFlip) {
      const noCoverageClarify = shouldClarifyForNoInventoryCoverage({
        slice: commitSlice,
        proposedPlane: proposed,
        dbCanAnswer: parsed.data.dbCanAnswer,
        ragCanAnswer: parsed.data.ragCanAnswer
      })
      return {
        bundle: input.bundle,
        rewritten: false,
        decision: parsed.data,
        noCoverageClarify
      }
    }

    const flipTo = gatePlaneCoverageFlip(proposed, parsed.data)
    if (!flipTo) {
      const noCoverageClarify = shouldClarifyForNoInventoryCoverage({
        slice: commitSlice,
        proposedPlane: proposed,
        dbCanAnswer: parsed.data.dbCanAnswer,
        ragCanAnswer: parsed.data.ragCanAnswer
      })
      return { bundle: input.bundle, rewritten: false, decision: parsed.data, noCoverageClarify }
    }

    const next = applyPlaneCoverageRewrite(
      input.bundle,
      proposed,
      flipTo,
      last,
      parsed.data.rationale
    )
    return {
      bundle: next,
      rewritten: true,
      from: proposed,
      to: flipTo,
      decision: parsed.data
    }
  } catch {
    return { bundle: input.bundle, rewritten: false }
  }
}
