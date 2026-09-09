/**
 * Specialist Brief：总管 → 子专家的结果导向侧车（Phase D）。
 * 仅编排态 multi/hub 使用；单源 db/rag 仍原文透传（见 managerSubAgentProtocol）。
 * 预算字段默认偏紧，防专家内无限环烧 token。
 */

export type SpecialistBriefBudget = {
  /** 专家内 tool / investigate / replan 轮次上限（含首次执行） */
  max_tool_rounds: number
  /** 墙钟 ms；缺省由总管 step timeout 覆盖 */
  timeout_ms?: number
  /** 模型档提示；子专家可忽略若本地无分层 */
  model_tier_hint?: 'flash' | 'plus' | 'max'
}

export type SpecialistBriefConstraints = {
  read_only?: boolean
  /** 禁止扩 blast / 跳 HITL */
  no_hitl_bypass?: boolean
  /** 覆盖度关键（RAG 弱证据须再检索） */
  coverage_critical?: boolean
}

export type SpecialistBrief = {
  version: '1'
  goal: string
  /** 可核对验收句（结构信号优先，非用户原话 regex） */
  acceptance: string[]
  budget: SpecialistBriefBudget
  constraints?: SpecialistBriefConstraints
  /** Field Guide 截断副本 */
  field_guide_digest?: string
}

const DEFAULT_MAX_TOOL_ROUNDS = 2
const HARD_CAP_TOOL_ROUNDS = 4

export function specialistBriefMaxToolRounds(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MANAGER_SPECIALIST_MAX_TOOL_ROUNDS ?? DEFAULT_MAX_TOOL_ROUNDS)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_TOOL_ROUNDS
  return Math.min(HARD_CAP_TOOL_ROUNDS, Math.floor(n))
}

export function fieldGuideMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MANAGER_FIELD_GUIDE_MAX_CHARS ?? 1200)
  if (!Number.isFinite(n) || n < 200) return 1200
  return Math.min(4000, Math.floor(n))
}

/** Race 竞速：默认关，控 token */
export function isManagerRaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_RACE_ENABLED ?? '0').trim() === '1'
}

export function clampSpecialistBriefBudget(
  budget: Partial<SpecialistBriefBudget> | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): SpecialistBriefBudget {
  const maxDefault = specialistBriefMaxToolRounds(env)
  const raw = Number(budget?.max_tool_rounds)
  const max_tool_rounds =
    Number.isFinite(raw) && raw >= 1
      ? Math.min(HARD_CAP_TOOL_ROUNDS, Math.floor(raw))
      : maxDefault
  const timeoutRaw = Number(budget?.timeout_ms)
  const timeout_ms =
    Number.isFinite(timeoutRaw) && timeoutRaw >= 1000 ? Math.floor(timeoutRaw) : undefined
  const tier = budget?.model_tier_hint
  const model_tier_hint =
    tier === 'flash' || tier === 'plus' || tier === 'max' ? tier : undefined
  return {
    max_tool_rounds,
    ...(timeout_ms != null ? { timeout_ms } : {}),
    ...(model_tier_hint ? { model_tier_hint } : {})
  }
}

export function buildSpecialistBrief(input: {
  goal: string
  acceptance?: string[]
  budget?: Partial<SpecialistBriefBudget> | null
  constraints?: SpecialistBriefConstraints | null
  field_guide_digest?: string | null
  env?: NodeJS.ProcessEnv
}): SpecialistBrief | null {
  const goal = String(input.goal || '').trim().slice(0, 500)
  if (!goal) return null
  const acceptance = (Array.isArray(input.acceptance) ? input.acceptance : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 6)
  const digest = String(input.field_guide_digest || '').trim()
  const maxChars = fieldGuideMaxChars(input.env)
  return {
    version: '1',
    goal,
    acceptance: acceptance.length ? acceptance : [`完成目标：${goal.slice(0, 120)}`],
    budget: clampSpecialistBriefBudget(input.budget, input.env),
    ...(input.constraints && typeof input.constraints === 'object'
      ? { constraints: input.constraints }
      : {}),
    ...(digest ? { field_guide_digest: digest.slice(0, maxChars) } : {})
  }
}

export function parseSpecialistBrief(raw: unknown): SpecialistBrief | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (String(o.version ?? '') !== '1') return null
  return buildSpecialistBrief({
    goal: String(o.goal ?? ''),
    acceptance: Array.isArray(o.acceptance) ? (o.acceptance as string[]) : [],
    budget: o.budget && typeof o.budget === 'object' ? (o.budget as SpecialistBriefBudget) : null,
    constraints:
      o.constraints && typeof o.constraints === 'object'
        ? (o.constraints as SpecialistBriefConstraints)
        : null,
    field_guide_digest: String(o.field_guide_digest ?? '')
  })
}

/** 是否应附带 Brief：编排态 multi/hub；单源透传路径禁止 */
export function shouldAttachSpecialistBrief(input: {
  managerOrchestrated?: boolean
  executionTopology?: string | null
  stepCount?: number
}): boolean {
  if (!input.managerOrchestrated) return false
  const topo = String(input.executionTopology || '').trim().toLowerCase()
  if (topo === 'hub' || topo === 'parallel') return true
  const n = Number(input.stepCount)
  return Number.isFinite(n) && n >= 2
}
