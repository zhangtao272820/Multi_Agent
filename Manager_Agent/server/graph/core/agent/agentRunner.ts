import type { Step } from '../../../utils/shared/taskPlan'
import {
  buildExpertDegradeMessage,
  classifyAndDetectHard,
  classifyExpertFailure,
  isHardExpertFailureCode,
  isHardExpertFailureRaw
} from '../runtime/expertFailure'
import { checkRunBudget, type RunBudgetCheck } from '../runtime/runBudget'
import { checkExpertInflight } from '../runtime/backpressure'
import {
  isExpertAllowedAtDegradeLevel,
  resolveServiceDegradeLevel,
  type ServiceDegradeLevel
} from '#agent-shared/expertCircuitPolicy'

export type StepRunStatus = 'ok' | 'error' | 'skipped'

export type StepRunRecord = {
  id: string
  agent: Step['agent']
  query: string
  output: string
  status: StepRunStatus
  error?: string
  parsed?: unknown
  /** code 等 Agent 附带的结构化 meta */
  meta?: unknown
  /** A2：专才结构化交接（父上下文优先用 summary） */
  handoff?: import('../../../utils/agents/types').SpecialistHandoff
}

export type AgentRunTelemetry = {
  scaledTimeoutForAgent: (agent: string, baseMs: number) => number
  recordAgentSuccess: (agent: string) => void
  /** soft 失败仍按 streak；hard 失败立即 hard-down + 熔断 */
  recordAgentFailure: (agent: string, opts?: { errorCode?: string; error?: unknown; hard?: boolean }) => void
  markExpertHardDown: (agent: string, errorCode?: string) => void
  isExpertHardDown: (agent: string) => boolean
  getExpertHardDownCode: (agent: string) => string | undefined
  getHardDownAgents: () => string[]
  getAgentFailureStreak: (agent: string) => number
  optionalAgents: Set<string>
  runtimeCircuitOpenAgents: Set<string>
  circuitStreakThreshold: number
  /** E3：累计本 run tokens/usd，供预算闸 */
  addSpend: (delta: { tokens?: number; usd?: number }) => void
  getSpend: () => { tokens: number; usd: number }
  checkBudget: () => import('../runtime/runBudget').RunBudgetCheck
  timeLeftMs: () => number
}

export type CreateAgentRunTelemetryInput = {
  globalTimeoutMs: number
  timeLeftMs: () => number
  schedulerTimeoutScale?: number
  schedulerAgentTimeoutScale?: Record<string, number>
  toolHealthP95ByAgent?: Map<string, number>
  schedulerCircuitOpenAgents?: string[]
}

const DEFAULT_OPTIONAL_AGENTS = new Set(['clean', 'visualize', 'report'])

/** 截止将近：跳过非关键剩余步（ms） */
export function readNearDeadlineSkipMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MANAGER_NEAR_DEADLINE_SKIP_MS ?? 10_000)
  if (!Number.isFinite(n)) return 10_000
  return Math.max(3_000, Math.min(30_000, Math.floor(n)))
}

/** 同 Agent 连续失败达阈后开路（clamp 1–5，默认 2；硬失败另走 streak=1） */
export function readAgentCircuitStreak(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MANAGER_AGENT_CIRCUIT_STREAK ?? 2)
  if (!Number.isFinite(n)) return 2
  return Math.max(1, Math.min(5, Math.floor(n)))
}

/** 熔断后是否跳过核心 Agent（默认开） */
export function isCircuitSkipCoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_CIRCUIT_SKIP_CORE ?? '1').trim() !== '0'
}

/**
 * 服务降级档。
 * - 仅当显式设置 MANAGER_SERVICE_DEGRADE_LEVEL 时用于跳过专家（默认不拦，避免影响 LAN）
 * - 未设显式档时仍可按本 run 开路专家做观测推断（返回值供看板；precheck 不据此 skip）
 */
export function readServiceDegradeLevel(
  telemetry: Pick<AgentRunTelemetry, 'runtimeCircuitOpenAgents'>,
  env: NodeJS.ProcessEnv = process.env
): ServiceDegradeLevel {
  const explicit = env.MANAGER_SERVICE_DEGRADE_LEVEL
  return resolveServiceDegradeLevel({
    explicitLevel: explicit !== undefined && String(explicit).trim() !== '' ? explicit : undefined,
    openAgents: telemetry.runtimeCircuitOpenAgents
  })
}

export function hasExplicitServiceDegradeLevel(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_SERVICE_DEGRADE_LEVEL ?? '').trim() !== ''
}

/** 多步执行共享：超时缩放、熔断计数、可选 Agent 集合 */
export function createAgentRunTelemetry(input: CreateAgentRunTelemetryInput): AgentRunTelemetry {
  const globalTimeoutMs = Math.max(60_000, Number(input.globalTimeoutMs) || 60_000)
  const maxStepTimeoutMs = Math.min(300_000, Math.max(120_000, globalTimeoutMs * 2))
  const timeoutScale = Number.isFinite(input.schedulerTimeoutScale)
    ? Math.max(0.8, Math.min(1.8, input.schedulerTimeoutScale!))
    : 1
  const circuitStreakThreshold = readAgentCircuitStreak()
  const agentFailureStreak = new Map<string, number>()
  const runtimeCircuitOpenAgents = new Set<string>(input.schedulerCircuitOpenAgents ?? [])
  const expertHardDown = new Map<string, string>()

  const scaledTimeoutForAgent = (agent: string, baseMs: number) => {
    const perAgent = Number(input.schedulerAgentTimeoutScale?.[agent] ?? 1)
    const per = Number.isFinite(perAgent) ? Math.max(0.8, Math.min(1.9, perAgent)) : 1
    const scaled = Math.round(baseMs * timeoutScale * per)
    const p95 = input.toolHealthP95ByAgent?.get(agent) || 0
    const p95Floor = p95 >= 8_000 ? Math.round(p95 * 1.2 + 5_000) : 0
    const leftMs = input.timeLeftMs()
    const budgetCap = leftMs > 8_000 ? leftMs - 4_000 : maxStepTimeoutMs
    return Math.max(12_000, Math.min(maxStepTimeoutMs, budgetCap, Math.max(scaled, p95Floor)))
  }

  const markExpertHardDown = (agent: string, errorCode?: string) => {
    const a = String(agent || '').trim()
    if (!a) return
    const code = String(errorCode || 'network').trim() || 'network'
    if (!expertHardDown.has(a)) expertHardDown.set(a, code)
    runtimeCircuitOpenAgents.add(a)
    agentFailureStreak.set(a, Math.max(circuitStreakThreshold, Number(agentFailureStreak.get(a) || 0)))
  }

  const isExpertHardDown = (agent: string) => expertHardDown.has(String(agent || '').trim())
  const getExpertHardDownCode = (agent: string) => expertHardDown.get(String(agent || '').trim())
  const getHardDownAgents = () => [...expertHardDown.keys()]

  const recordAgentSuccess = (agent: string) => {
    if (!agent) return
    // 硬失败本 run 不因偶发成功清除 unavailable（避免半挂服务来回打）
    if (expertHardDown.has(agent)) return
    agentFailureStreak.set(agent, 0)
  }

  const recordAgentFailure = (
    agent: string,
    opts?: { errorCode?: string; error?: unknown; hard?: boolean }
  ) => {
    if (!agent) return
    const detected = classifyAndDetectHard({
      error: opts?.error,
      agentResult: opts?.errorCode ? { ok: false, error_code: opts.errorCode } : undefined
    })
    const hard =
      opts?.hard === true ||
      detected.hard ||
      isHardExpertFailureCode(opts?.errorCode) ||
      isHardExpertFailureRaw(opts?.errorCode)
    if (hard) {
      markExpertHardDown(agent, opts?.errorCode || detected.code)
      return
    }
    const next = Number(agentFailureStreak.get(agent) || 0) + 1
    agentFailureStreak.set(agent, next)
    if (next >= circuitStreakThreshold) runtimeCircuitOpenAgents.add(agent)
  }

  const getAgentFailureStreak = (agent: string) => Number(agentFailureStreak.get(agent) || 0) || 0

  let spendTokens = 0
  let spendUsd = 0
  const addSpend = (delta: { tokens?: number; usd?: number }) => {
    const t = Number(delta.tokens || 0)
    const u = Number(delta.usd || 0)
    if (Number.isFinite(t) && t > 0) spendTokens += t
    if (Number.isFinite(u) && u > 0) spendUsd += u
  }
  const getSpend = () => ({ tokens: spendTokens, usd: spendUsd })
  const checkBudgetFn = (): RunBudgetCheck => checkRunBudget(getSpend())

  return {
    scaledTimeoutForAgent,
    recordAgentSuccess,
    recordAgentFailure,
    markExpertHardDown,
    isExpertHardDown,
    getExpertHardDownCode,
    getHardDownAgents,
    getAgentFailureStreak,
    optionalAgents: DEFAULT_OPTIONAL_AGENTS,
    runtimeCircuitOpenAgents,
    circuitStreakThreshold,
    addSpend,
    getSpend,
    checkBudget: checkBudgetFn,
    timeLeftMs: () => input.timeLeftMs()
  }
}

export type StepPrecheckInput = {
  stepAgent: string
  stepId: string
  agent: Step['agent']
  effQuery: string
  /** 该 agent 是否在本轮任务计划 steps 中显式出现 */
  plannedInTask?: boolean
  schedulerSkipAgents: string[]
  schedulerDegradeOptionalAgents: string[]
  telemetry: AgentRunTelemetry
  /** 是否为可选/非关键步（截止将近时可跳过） */
  optionalStep?: boolean
}

export type StepPrecheckPolicy =
  | 'circuit_degrade_optional'
  | 'circuit_open_core'
  | 'tool_health_down'
  | 'budget_exceeded'
  | 'expert_hard_down'
  | 'deadline_exceeded'
  | 'upstream_failed'
  | 'clean_dedupe'
  | 'overloaded'
  | 'service_degrade'

export type StepPrecheckResult =
  | { action: 'run' }
  | { action: 'skip'; reason: string; policy: StepPrecheckPolicy }

/** 执行前检查：预算 / hard-down / 截止 / 熔断降级 / 核心熔断跳过 / toolHealth 跳过 */
export function precheckAgentStep(input: StepPrecheckInput): StepPrecheckResult {
  const { stepAgent, telemetry, schedulerSkipAgents, schedulerDegradeOptionalAgents, plannedInTask } = input

  const budget = telemetry.checkBudget()
  if (!budget.ok) {
    return {
      action: 'skip',
      reason: budget.reason || 'run budget exceeded',
      policy: 'budget_exceeded'
    }
  }

  if (telemetry.isExpertHardDown(stepAgent)) {
    const code = telemetry.getExpertHardDownCode(stepAgent) || 'network'
    return {
      action: 'skip',
      reason: `agent ${stepAgent} 本轮已硬失败（${code}），截断后续调用以免空转耗 token`,
      policy: 'expert_hard_down'
    }
  }

  if (hasExplicitServiceDegradeLevel()) {
    const degradeLevel = readServiceDegradeLevel(telemetry)
    if (!isExpertAllowedAtDegradeLevel(stepAgent, degradeLevel)) {
      return {
        action: 'skip',
        reason: `服务降级 L${degradeLevel}：暂跳过专家 ${stepAgent} 以保只读/核心路径`,
        policy: 'service_degrade'
      }
    }
  }

  const bp = checkExpertInflight(stepAgent)
  if (!bp.ok) {
    return { action: 'skip', reason: bp.reason, policy: 'overloaded' }
  }

  const left = telemetry.timeLeftMs()
  const nearMs = readNearDeadlineSkipMs()
  const isOptional =
    Boolean(input.optionalStep) || telemetry.optionalAgents.has(stepAgent)
  if (left < nearMs && isOptional) {
    return {
      action: 'skip',
      reason: `截止将近（剩余 ${Math.round(left)}ms < ${nearMs}ms），跳过非关键步骤 ${stepAgent}`,
      policy: 'deadline_exceeded'
    }
  }

  const protectPlannedOptional = Boolean(plannedInTask) && telemetry.optionalAgents.has(stepAgent)
  const circuitOpen = telemetry.runtimeCircuitOpenAgents.has(stepAgent)

  const shouldDegradeOptional =
    !protectPlannedOptional &&
    telemetry.optionalAgents.has(stepAgent) &&
    (circuitOpen || schedulerDegradeOptionalAgents.includes(stepAgent))
  if (shouldDegradeOptional) {
    return {
      action: 'skip',
      reason: `agent ${stepAgent} 熔断降级：当前跳过可选步骤以保核心链路`,
      policy: 'circuit_degrade_optional'
    }
  }

  // 核心 Agent 连败熔断：跳过同 run 后续调用，避免 local replan 反复加回空转
  if (circuitOpen && !telemetry.optionalAgents.has(stepAgent) && isCircuitSkipCoreEnabled()) {
    return {
      action: 'skip',
      reason: `agent ${stepAgent} 已熔断（连续失败≥${telemetry.circuitStreakThreshold}）：跳过以免空转耗 token`,
      policy: 'circuit_open_core'
    }
  }

  if (schedulerSkipAgents.includes(stepAgent)) {
    return {
      action: 'skip',
      reason: `agent ${stepAgent} 当前不可用（toolHealth=down），已跳过执行`,
      policy: 'tool_health_down'
    }
  }
  return { action: 'run' }
}

export type RecordSkippedStepInput = {
  stepId: string
  agent: Step['agent']
  effQuery: string
  reason: string
  policy: StepPrecheckPolicy | string
  t0: number
  runId: string
  byId: Record<string, StepRunRecord>
  evidences: Array<Record<string, unknown>>
  relayThinking: (agent: string, text: string) => void
  emitTrace: (entry: Record<string, unknown>) => void
  appendMetrics: (entry: Record<string, unknown>) => Promise<unknown>
}

/** 写入 skipped 步骤记录并打点 */
export async function recordSkippedAgentStep(input: RecordSkippedStepInput) {
  const { stepId, agent, effQuery, reason, policy, t0, runId, byId, evidences, relayThinking, emitTrace, appendMetrics } =
    input
  const classified = classifyExpertFailure({ error: reason, policy: String(policy) })
  const degradeMsg =
    policy === 'budget_exceeded'
      ? `成本预算已超限，后续专家步骤已跳过（${reason}）`
      : policy === 'upstream_failed'
        ? buildExpertDegradeMessage(String(agent), 'skipped', reason)
        : policy === 'deadline_exceeded'
          ? `截止将近，已截断非关键步骤（${reason}）`
          : buildExpertDegradeMessage(String(agent), classified.code, reason)
  byId[stepId] = {
    id: stepId,
    agent,
    query: effQuery,
    output: degradeMsg,
    status: 'skipped',
    error: degradeMsg,
    meta: { skipPolicy: policy, skipReason: reason }
  }
  evidences.push({ kind: 'skipped', stepId, agent, query: effQuery, reason: degradeMsg, policy })
  const skipLabel =
    policy === 'budget_exceeded'
      ? '预算跳过'
      : policy === 'upstream_failed'
        ? '上游失败跳过'
        : policy === 'deadline_exceeded'
          ? '截止截断'
          : policy === 'tool_health_down' ||
              policy === 'circuit_open_core' ||
              policy === 'expert_hard_down'
            ? '跳过'
            : '降级跳过'
  relayThinking('manager', `步骤 ${stepId} ${skipLabel}：${degradeMsg}`)
  emitTrace({ type: 'step_skip', agent, stepId, reason: degradeMsg, policy, at: new Date().toISOString() })
  await appendMetrics({
    runId,
    phase: String(agent),
    ms: Date.now() - t0,
    ok: false,
    agent: String(agent),
    error_code:
      policy === 'budget_exceeded'
        ? 'budget_exceeded'
        : policy === 'overloaded'
          ? 'overloaded'
        : policy === 'upstream_failed'
          ? 'upstream_failed'
          : classified.code === 'unknown'
            ? 'skipped'
            : classified.code,
    extra: { stepId, reason, policy, step_skip: true }
  })
}
