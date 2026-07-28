import { hasCodeInResults } from '#agent-shared/codeFirstAuthority'
import { assessEvidenceGate, hasDbEvidenceInRun, taskNeedsExternalSources } from '../db/evidenceGate'
import { isMediaOnlyPlanAgents } from '../shared'

const FAST_PATH_BLOCK_AGENTS = new Set(['code', 'crawler', 'admin', 'visualize', 'report'])

export function criticFastPathBlocked(input: {
  intent: string
  planAgents: string[]
  results?: Record<string, unknown>
  evidence?: Array<Record<string, unknown>>
  meta?: Record<string, unknown> | null
}): boolean {
  for (const agent of input.planAgents) {
    if (FAST_PATH_BLOCK_AGENTS.has(agent)) return true
  }
  if (Boolean(input.meta?.needsWebSearch)) return true
  if (hasCodeInResults(input.results)) return true
  if (
    taskNeedsExternalSources({
      intent: input.intent,
      meta: input.meta,
      plan: input.planAgents.map((agent) => ({ agent }))
    })
  ) {
    return true
  }
  const evidence = Array.isArray(input.evidence) ? input.evidence : []
  if (evidence.some((row) => ['crawler', 'code', 'admin'].includes(String(row?.kind ?? '')))) return true
  if (Boolean(input.meta?.codeAuthorityGate) || Boolean(input.meta?.synthOnlyRepair)) return true
  if (String(input.results?.visualize ?? '').includes('ECHARTS_OPTION') || String(input.results?.report ?? '').includes('<!--REPORT-->')) {
    return true
  }
  return false
}

/** P2-9：高置信快速路径跳过 Critic LLM；有 code/联网/证据门禁风险时不跳过 */
export function shouldSkipCriticLlm(input: {
  routeConfidence: number
  intent: string
  planStepCount: number
  planAgents: string[]
  lowCostMode?: boolean
  timeLeftMs: number
  results?: Record<string, unknown>
  evidence?: Array<Record<string, unknown>>
  meta?: Record<string, unknown> | null
  multimodalOutLen?: number
}): { skip: boolean; reason?: string } {
  if (Boolean(input.lowCostMode) || input.timeLeftMs < 8000) {
    return { skip: true, reason: 'low_cost_or_timeout' }
  }

  // 专家本轮已硬失败：勿再开 critic 烧 token 去改道重调
  const hard = input.meta?.expertHardDown
  if (hard && typeof hard === 'object' && Object.keys(hard as object).length > 0) {
    return { skip: true, reason: 'expert_hard_down' }
  }

  const planAgents = input.planAgents.filter(Boolean)
  const mmLen = Number(input.multimodalOutLen ?? 0)
  if (mmLen >= 20 && isMediaOnlyPlanAgents(planAgents)) {
    return { skip: true, reason: 'media_only' }
  }

  if (
    (Boolean(input.meta?.dbOnlyRoute) || Boolean(input.meta?.dbOnlyShortcut) || input.intent === 'db') &&
    hasDbEvidenceInRun({ results: input.results, evidence: input.evidence })
  ) {
    return { skip: true, reason: 'db_only_success' }
  }

  const isHighConf = (input.routeConfidence ?? 0) > 0.9
  const isSimple = input.intent !== 'multi' && input.planStepCount <= 1
  if (!isHighConf || !isSimple) return { skip: false }

  if (criticFastPathBlocked(input)) {
    return { skip: false, reason: 'fast_path_blocked' }
  }

  return { skip: true, reason: 'high_conf_simple' }
}

/** critic/fix 改道意图若指向本轮 hard-down 专家 → 应拦截 */
export function isFixIntentBlockedByHardDown(intent: string | undefined | null, meta: unknown): boolean {
  const hard = (meta as { expertHardDown?: Record<string, string> } | null)?.expertHardDown
  if (!hard || typeof hard !== 'object') return false
  const i = String(intent || '').trim()
  if (!i) return false
  if (hard[i]) return true
  return false
}
