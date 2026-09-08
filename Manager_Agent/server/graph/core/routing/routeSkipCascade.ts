/**
 * 路由审查 LLM skip 级联 SSOT（结构信号，禁用户原话 regex）。
 * 供 orchestratorPipeline 统一决定是否跳过 align / planeCoverage。
 * ambiguous / trueMulti 禁止为省 token 跳过。
 */
import { sourceCommitmentFromRaw } from '../../orchestrate/sourceCommitment'
import { isClearSolePlaneNoWeb } from '../../orchestrate/stripUnboundCrawler'
import { isTrueMultiTask } from './subAgentPassthrough'

export type RouteReviewSkipDecision = {
  /** 跳过 userIntentAlign LLM */
  skipAlign: boolean
  /** 跳过 planeCoverageRejudge LLM */
  skipPlane: boolean
  /** 跳过 web-align LLM（与 shouldSkipWebAlignLlm 对齐时由调用方另算；此处仅记录意图） */
  skipWebAlign: boolean
  reasons: string[]
}

export type RouteSkipProbeHint = {
  db?: {
    matched?: boolean
    executable?: boolean
    schemaMatched?: boolean
    tables?: string[]
  } | null
  rag?: { hits?: number } | null
}

function metaRecord(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {}
}

function isTrueMultiFromInput(meta: unknown, allowedAgents?: readonly string[] | null): boolean {
  if (isTrueMultiTask(meta)) return true
  const agents = (allowedAgents ?? []).map(String)
  const data = agents.filter((a) => a === 'db' || a === 'rag' || a === 'crawler')
  return data.length >= 2
}

/** probe 强单源：仅一端可执行/命中，另一端明显空 */
export function probeStrongSolePlane(probe?: RouteSkipProbeHint | null): 'db' | 'rag' | null {
  if (!probe) return null
  const dbOk =
    probe.db?.executable === true ||
    probe.db?.matched === true ||
    (probe.db?.schemaMatched === true && Array.isArray(probe.db?.tables) && probe.db!.tables!.length > 0)
  const ragHits = Number(probe.rag?.hits ?? 0) || 0
  if (dbOk && ragHits <= 0) return 'db'
  if (!dbOk && ragHits >= 2) return 'rag'
  return null
}

export function isRouteCascadeEnabled(): boolean {
  const v = String(process.env.MANAGER_ROUTE_CASCADE ?? '0').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

/** 编排 selfCheck.needsSecondPass：仅 flag 开启且显式 false 才扩 skip */
export function applyCascadeSelfCheckSkip(
  base: RouteReviewSkipDecision,
  sourceCommitmentRaw?: Record<string, unknown> | null
): RouteReviewSkipDecision {
  if (!isRouteCascadeEnabled()) return base
  if (base.reasons.includes('ambiguous') || base.reasons.includes('true_multi') || base.reasons.includes('needs_web')) {
    return base
  }
  const raw = sourceCommitmentRaw && typeof sourceCommitmentRaw === 'object' ? sourceCommitmentRaw : {}
  const selfCheck =
    (raw.selfCheck as { needsSecondPass?: boolean; reason?: string } | undefined) ||
    (raw.self_check as { needsSecondPass?: boolean; reason?: string } | undefined)
  if (!selfCheck || typeof selfCheck !== 'object') return base
  if (selfCheck.needsSecondPass === true) {
    return {
      skipAlign: true,
      skipPlane: false,
      skipWebAlign: base.skipWebAlign,
      reasons: [...base.reasons, 'cascade_needs_second_pass']
    }
  }
  if (selfCheck.needsSecondPass === false) {
    return {
      skipAlign: true,
      skipPlane: true,
      skipWebAlign: true,
      reasons: [...base.reasons, 'cascade_no_second_pass']
    }
  }
  return base
}

/**
 * 是否跳过路由审查 LLM（align / plane）。
 * 条件均为结构信号：sourceCommitment、planShortcut、allowedAgents、probe 强弱。
 */
export function shouldSkipRouteReviewLlm(input: {
  allowedAgents?: readonly string[] | null
  planShortcut?: string | null
  needsWeb?: boolean | null
  needsWebSearch?: boolean | null
  sourceCommitmentRaw?: Record<string, unknown> | null
  meta?: unknown
  probe?: RouteSkipProbeHint | null
}): RouteReviewSkipDecision {
  const reasons: string[] = []
  const agents = (input.allowedAgents ?? []).map(String)
  const slice = sourceCommitmentFromRaw(input.sourceCommitmentRaw)
  const shortcut = String(input.planShortcut || '').trim()

  // 硬红线：ambiguous / 真 multi / 公网信号 → 不跳审查
  if (slice.sourceCommitment === 'ambiguous') {
    return { skipAlign: false, skipPlane: false, skipWebAlign: false, reasons: ['ambiguous'] }
  }
  if (isTrueMultiFromInput(input.meta, agents)) {
    return { skipAlign: false, skipPlane: false, skipWebAlign: false, reasons: ['true_multi'] }
  }
  if (agents.includes('crawler') || agents.includes('gui')) {
    return { skipAlign: false, skipPlane: false, skipWebAlign: false, reasons: ['web_or_gui'] }
  }
  if (input.needsWeb === true || input.needsWebSearch === true) {
    return { skipAlign: false, skipPlane: false, skipWebAlign: false, reasons: ['needs_web'] }
  }

  let decision: RouteReviewSkipDecision | null = null

  // 基线：清晰单数据面
  if (
    isClearSolePlaneNoWeb({
      allowedAgents: agents,
      planShortcut: shortcut,
      needsWeb: input.needsWeb,
      needsWebSearch: input.needsWebSearch,
      sourceCommitmentRaw: input.sourceCommitmentRaw
    })
  ) {
    reasons.push('clear_sole_plane')
    decision = { skipAlign: true, skipPlane: true, skipWebAlign: true, reasons: [...reasons] }
  }

  // admin_only + clear：无 db/rag 混面，审查价值低
  if (!decision && shortcut === 'admin_only' && slice.sourceCommitment === 'clear') {
    const data = agents.filter((a) => a === 'db' || a === 'rag')
    if (data.length === 0) {
      reasons.push('admin_only_clear')
      decision = { skipAlign: true, skipPlane: true, skipWebAlign: true, reasons: [...reasons] }
    }
  }

  // probe 强单源与 orchestrator shortcut / 单 agent 一致 → 跳过 plane
  const strong = probeStrongSolePlane(input.probe)
  if (
    !decision &&
    strong === 'db' &&
    (shortcut === 'db_only' ||
      (agents.filter((a) => a === 'db' || a === 'rag').length === 1 && agents.includes('db')))
  ) {
    reasons.push('probe_strong_db')
    const clearEnough = slice.sourceCommitment === 'clear' || shortcut === 'db_only'
    decision = {
      skipAlign: clearEnough,
      skipPlane: true,
      skipWebAlign: true,
      reasons: [...reasons]
    }
  }
  if (
    !decision &&
    strong === 'rag' &&
    (shortcut === 'rag_only' ||
      (agents.filter((a) => a === 'db' || a === 'rag').length === 1 && agents.includes('rag')))
  ) {
    reasons.push('probe_strong_rag')
    const clearEnough = slice.sourceCommitment === 'clear' || shortcut === 'rag_only'
    decision = {
      skipAlign: clearEnough,
      skipPlane: true,
      skipWebAlign: true,
      reasons: [...reasons]
    }
  }

  if (!decision) {
    decision = { skipAlign: false, skipPlane: false, skipWebAlign: false, reasons: reasons.length ? reasons : ['default_review'] }
  }

  return applyCascadeSelfCheckSkip(decision, input.sourceCommitmentRaw)
}

/** 从 meta / pipeline 结果组装 routeSkips 埋点 */
export function buildRouteSkipsSnapshot(input: {
  skipAlign?: boolean
  skipPlane?: boolean
  skipWebAlign?: boolean
  plannerBypassed?: boolean
  skipAudit?: boolean
}): Record<string, boolean> {
  return {
    align: Boolean(input.skipAlign),
    plane: Boolean(input.skipPlane),
    webAlign: Boolean(input.skipWebAlign),
    planner: Boolean(input.plannerBypassed),
    audit: Boolean(input.skipAudit)
  }
}

/**
 * 估算本轮路由阶段 LLM 调用次数（结构估算，供 SLI；非精确计费）。
 * base：编排主调用 1；turn_scope / memory_gate 由调用方传入已发生次数。
 */
export function estimateRouteLlmCalls(input: {
  priorAuxCalls?: number
  ranOrchestratorLlm?: boolean
  skipAlign?: boolean
  skipPlane?: boolean
  skipWebAlign?: boolean
}): number {
  let n = Math.max(0, Number(input.priorAuxCalls ?? 0) || 0)
  if (input.ranOrchestratorLlm !== false) n += 1
  if (!input.skipAlign) n += 1
  if (!input.skipPlane) n += 1
  if (!input.skipWebAlign) n += 1
  return n
}

/** continuation 主路径：注入 sessionAnchor.coalescedTask（零额外 LLM，修缺口 A） */
export function formatSessionAnchorCoalesceHint(input: {
  turnKind?: string | null
  turnScopeMode?: string | null
  coalescedTask?: string | null
  lastExecutedAgents?: string[] | null
}): string {
  const kind = String(input.turnKind || '').trim()
  const mode = String(input.turnScopeMode || '').trim()
  const coalesced = String(input.coalescedTask || '').trim()
  if (!coalesced) return ''
  const isCont =
    mode === 'continuation' ||
    kind === 'continuation' ||
    kind === 'output_followup' ||
    kind === 'slot_answer'
  if (!isCont) return ''
  const agents = (input.lastExecutedAgents ?? []).map(String).filter(Boolean)
  const agentLine = agents.length ? `；上轮数据面=${agents.join('+')}` : ''
  return `【多轮合并锚点·零额外 LLM】承接任务：${coalesced.slice(0, 400)}${agentLine}。allowedAgents 优先承接上轮数据面，不得无故扩 multi。`
}

export function sessionAnchorFieldsFromMeta(meta: unknown): {
  coalescedTask: string
  lastExecutedAgents: string[]
} {
  const m = metaRecord(meta)
  const anchor = m.sessionIntentAnchor
  if (!anchor || typeof anchor !== 'object') {
    return { coalescedTask: '', lastExecutedAgents: [] }
  }
  const a = anchor as Record<string, unknown>
  const coalescedTask = String(a.coalescedTask || '').trim()
  const lastExecutedAgents = Array.isArray(a.lastExecutedAgents)
    ? a.lastExecutedAgents.map(String).filter(Boolean)
    : []
  return { coalescedTask, lastExecutedAgents }
}
