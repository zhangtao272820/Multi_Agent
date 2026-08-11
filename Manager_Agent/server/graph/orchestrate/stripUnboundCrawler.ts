/**
 * 硬剥幽灵 crawler：cap/蓝图/draft 含 crawler 但无真实公网绑定时剔除。
 * 与 sourceCommitment / compositeDataWebRoute 同契约，禁止与 composite 互拆。
 * lint 仅告警不够（Judge 默认关）；须在 invariants 与 web-align 之后各跑一次。
 */
import type { TaskClause } from '../core/routing/clauses'
import type { StepDispatchDraft } from '../core/proPuStack'
import type { PlanBlueprint } from '../llm/planBlueprintLlm'
import type { IntentClassifyResult } from '../llm/intentClassifyLlm'
import type { ExecutableAgent } from '../core/routing/routeFinalize'
import {
  shouldSkipAdminApiCrawlerRematerialize,
  sourceCommitmentFromRaw
} from './sourceCommitment'

export function clauseBindsCrawler(clause: TaskClause): boolean {
  return (clause.agents ?? []).map(String).includes('crawler')
}

/** 是否存在真实公网绑定（子句或 draft 挂 crawler；蓝图 alone 不算——E2 幽灵步常见） */
export function hasBoundCrawlerPlane(input: {
  clauses?: TaskClause[] | null
  stepDispatchDraft?: Array<{ agent?: string }> | null
}): boolean {
  if ((input.clauses ?? []).some(clauseBindsCrawler)) return true
  if ((input.stepDispatchDraft ?? []).some((d) => String(d.agent || '') === 'crawler')) return true
  return false
}

/**
 * 用户清晰要公网（sourceCommitment/webFetchKind）或复合库内+公网守卫已确认时，
 * 即使子句漏绑也保留 crawler。
 */
export function shouldKeepCrawlerWithoutBoundClause(input: {
  sourceCommitmentRaw?: Record<string, unknown> | null
  compositeDataWebRoute?: boolean | null
}): boolean {
  if (input.compositeDataWebRoute === true) return true
  return shouldSkipAdminApiCrawlerRematerialize(sourceCommitmentFromRaw(input.sourceCommitmentRaw))
}

export type StripUnboundCrawlerInput = {
  allowedAgents: ExecutableAgent[]
  clauses: TaskClause[]
  classify: IntentClassifyResult
  planBlueprint: PlanBlueprint | null
  stepDispatchDraft?: StepDispatchDraft[] | null
  needsWebSearch?: boolean
  sourceCommitmentRaw?: Record<string, unknown> | null
  /** web-align composite 已确认库内+公网 → 与 strip 同契约保留 crawler */
  compositeDataWebRoute?: boolean | null
}

export type StripUnboundCrawlerResult = StripUnboundCrawlerInput & {
  changed: boolean
}

/** 从 cap / 蓝图 / draft / dataSources 硬剥无绑定 crawler */
export function stripUnboundCrawlerArtifacts(input: StripUnboundCrawlerInput): StripUnboundCrawlerResult {
  const keepByCommit = shouldKeepCrawlerWithoutBoundClause({
    sourceCommitmentRaw: input.sourceCommitmentRaw,
    compositeDataWebRoute: input.compositeDataWebRoute
  })
  const bound = hasBoundCrawlerPlane({
    clauses: input.clauses,
    stepDispatchDraft: input.stepDispatchDraft
  })
  if (bound || keepByCommit) {
    return { ...input, changed: false }
  }

  let changed = false
  let allowedAgents = [...input.allowedAgents]
  if (allowedAgents.map(String).includes('crawler')) {
    allowedAgents = allowedAgents.filter((a) => String(a) !== 'crawler') as ExecutableAgent[]
    changed = true
  }

  let planBlueprint = input.planBlueprint
  if (planBlueprint?.steps?.some((s) => String(s.agent) === 'crawler')) {
    const steps = planBlueprint.steps.filter((s) => String(s.agent) !== 'crawler')
    planBlueprint = steps.length ? { ...planBlueprint, steps } : null
    changed = true
  }

  let stepDispatchDraft = input.stepDispatchDraft
  if (Array.isArray(stepDispatchDraft) && stepDispatchDraft.some((d) => String(d.agent) === 'crawler')) {
    stepDispatchDraft = stepDispatchDraft.filter((d) => String(d.agent) !== 'crawler')
    changed = true
  }

  let classify = input.classify
  const dsHas = (classify.dataSources ?? []).includes('crawler')
  if (dsHas || classify.needsWeb) {
    classify = {
      ...classify,
      dataSources: (classify.dataSources ?? []).filter((d) => d !== 'crawler') as IntentClassifyResult['dataSources'],
      needsWeb: false,
      suggestedAgents: (classify.suggestedAgents ?? []).filter((a) => a !== 'crawler')
    }
    changed = true
  }

  const needsWebSearch = changed ? false : input.needsWebSearch

  return {
    allowedAgents,
    clauses: input.clauses,
    classify,
    planBlueprint,
    stepDispatchDraft,
    needsWebSearch,
    sourceCommitmentRaw: input.sourceCommitmentRaw,
    compositeDataWebRoute: input.compositeDataWebRoute,
    changed
  }
}

/** 结构门禁：清晰单数据面、无公网/浏览器 → 可跳过 align / planeCoverage / web-align LLM */
export function isClearSolePlaneNoWeb(input: {
  allowedAgents?: readonly string[] | null
  planShortcut?: string | null
  needsWeb?: boolean | null
  needsWebSearch?: boolean | null
  sourceCommitmentRaw?: Record<string, unknown> | null
}): boolean {
  const agents = (input.allowedAgents ?? []).map(String)
  if (agents.includes('crawler') || agents.includes('gui')) return false
  if (input.needsWeb === true || input.needsWebSearch === true) return false
  const slice = sourceCommitmentFromRaw(input.sourceCommitmentRaw)
  // ambiguous 必须走 align/planeCoverage，禁止为省 token 跳过纠错
  if (slice.sourceCommitment === 'ambiguous') return false

  const data = agents.filter((a) => a === 'db' || a === 'rag')
  if (data.length !== 1) return false
  const shortcut = String(input.planShortcut || '').trim()
  if (shortcut === 'db_only' || shortcut === 'rag_only' || shortcut === 'admin_only') return true
  if (slice.sourceCommitment === 'clear') {
    const committedData = slice.committedPlanes.filter((p) => p === 'db' || p === 'rag')
    if (committedData.length === 1 && committedData[0] === data[0]) return true
    // clear 且仅单数据面（加工链忽略）
    const nonProc = agents.filter((a) => !['clean', 'code', 'visualize', 'report'].includes(a))
    return nonProc.length === 1 && (nonProc[0] === 'db' || nonProc[0] === 'rag')
  }
  // none：仅 planShortcut 可 skip；禁止宽泛 nonProc 误跳过模糊单源
  return false
}

/** 无公网信号时跳过 web/composite LLM（避免「理解问题」空转加 crawler） */
export function shouldSkipWebAlignLlm(input: {
  allowedAgents?: readonly string[] | null
  needsWeb?: boolean | null
  needsWebSearch?: boolean | null
  sourceCommitmentRaw?: Record<string, unknown> | null
}): boolean {
  const agents = (input.allowedAgents ?? []).map(String)
  if (agents.includes('crawler') || agents.includes('gui')) return false
  if (input.needsWeb === true || input.needsWebSearch === true) return false
  const slice = sourceCommitmentFromRaw(input.sourceCommitmentRaw)
  if (shouldSkipAdminApiCrawlerRematerialize(slice)) return false
  return true
}
