import { isHeavySynthTask } from '#agent-shared/synthShapePolicy'
import { resolveManagerEnvBool } from '../../../utils/platform/managerEnvModes'
import { isLlmFirstRouteEnabled } from '../../orchestrate/unifiedRouting'
import { shouldEscalateRouteDecisionToMax } from '../routing/routeDecisionEscalate'

export type LlmInvokeTier = 'light' | 'standard' | 'max'

export type LlmInvokeOptions = {
  tier?: LlmInvokeTier
  /** synth 阶段 token 流式回调（U3-1） */
  onDelta?: (chunk: string) => void
  /** 为 true 时不推送「路由决策」thinking（辅助 LLM：轮次范围/对齐/repair 等） */
  quiet?: boolean
  /** 非 quiet 时自定义 thinking 文案前缀（如「编排决策」） */
  thinkingLabel?: string
}

export type LlmStage = 'route' | 'plan' | 'synth' | 'critic' | 'verifier'

export type RouteDecisionModelKind = 'plus' | 'max'

/** P2：质检双模型 — critic/verifier 不走 auto-light 降级 */
export function isDualModelQaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_DUAL_MODEL_QA ?? '1').trim() !== '0'
}

const SINGLE_INTENTS = new Set(['rag', 'db', 'code', 'admin', 'crawler', 'gui', 'multimodal', 'music', 'video'])

/** 默认开启：简单任务自动走 MANAGER_MODEL_LOW_COST（flash）；LLM-First 下由 preset 关闭 */
export function isAutoModelTierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveManagerEnvBool('MANAGER_AUTO_MODEL_TIER', env)
}

export function isSimpleIntent(intent: unknown): boolean {
  const i = String(intent || '').trim()
  return i.length > 0 && i !== 'multi' && SINGLE_INTENTS.has(i)
}

/** 环境强制 max；否则由 state 结构信号决定是否升档（见 shouldEscalateRouteDecisionToMax） */
export function resolveRouteDecisionModelKind(
  env: NodeJS.ProcessEnv = process.env,
  state?: unknown
): RouteDecisionModelKind {
  const raw = String(env.MANAGER_ROUTE_DECISION_TIER ?? 'plus').trim().toLowerCase()
  if (raw === 'max' || raw.startsWith('qwen-max')) return 'max'
  if (state !== undefined && shouldEscalateRouteDecisionToMax(state, env)) return 'max'
  return 'plus'
}

/** 当前 turn 是否处于「单层路由决策」上下文（禁止 flash / 规则 cap 覆盖） */
export function isRoutingDecisionContext(state?: unknown, stage?: LlmStage): boolean {
  if (isLlmFirstRouteEnabled()) {
    return stage === 'route' || stage === 'plan'
  }
  const meta = (state as { meta?: Record<string, unknown> } | null)?.meta
  if (meta?.unifiedOrchestrator === true || meta?.llmFirstRoute === true) {
    return stage === 'route' || stage === 'plan'
  }
  if (resolveManagerEnvBool('MANAGER_ORCHESTRATOR_STANDARD_MODEL')) {
    return stage === 'route'
  }
  return false
}

/**
 * 编排 / 路由 / Planner 决策 LLM 档位 SSOT。
 * 默认 standard→CAP_ROUTE；仅 ambiguous/high/secondPass 升 max→CAP_REASON（集中模型，不养独立 max）。
 */
export function routingDecisionLlmTier(state?: unknown, env: NodeJS.ProcessEnv = process.env): LlmInvokeTier {
  if (!isRoutingDecisionContext(state, 'route') && !isRoutingDecisionContext(state, 'plan')) {
    if (resolveManagerEnvBool('MANAGER_ORCHESTRATOR_STANDARD_MODEL', env)) return 'standard'
    return 'light'
  }
  return resolveRouteDecisionModelKind(env, state) === 'max' ? 'max' : 'standard'
}

/** runtime 入口：统一解析有效 tier（显式 light 在决策上下文中会被抬升） */
export function resolveEffectiveLlmTier(
  stage: LlmStage,
  state: unknown,
  requested?: LlmInvokeTier
): LlmInvokeTier | undefined {
  const decisionTier = routingDecisionLlmTier(state)
  if (isRoutingDecisionContext(state, stage)) {
    if (!requested || requested === 'light') return decisionTier
    if (requested === 'standard' && decisionTier === 'max') return 'max'
    return requested
  }
  return requested
}

function taskText(state: any): string {
  return String(
    state?.routedQuery ||
      state?.meta?.nlHeuristicTask ||
      state?.meta?.taskConstraints?.subjectHints?.[0] ||
      ''
  ).trim()
}

function looksMultiTask(state: any): boolean {
  const text = taskText(state)
  return isHeavySynthTask({
    meta: state?.meta,
    planSteps: Array.isArray(state?.plan) ? state.plan : undefined,
    questionLength: text.length,
  })
}

function planStepCount(state: any): number {
  const plan = Array.isArray(state?.plan) ? state.plan : []
  return plan.length
}

/** 辅助 LLM（约束解析、拆解、hint）一律走 light — 非路由决策上下文时 */
export function isAuxiliaryLlmCall(options?: LlmInvokeOptions): boolean {
  return options?.tier === 'light'
}

export function shouldAutoLightTier(stage: LlmStage, state: any): boolean {
  if (!isAutoModelTierEnabled()) return false
  if (isRoutingDecisionContext(state, stage)) return false
  if (Boolean(state?.meta?.lowCostMode)) return true

  const intent = String(state?.intent || '').trim()
  const force = String(state?.forceIntent || '').trim()
  const needsWeb = Boolean(state?.meta?.needsWebSearch)
  const hasAttachment = Boolean(state?.mediaAttachment?.filePath)
  const clauseCount = Number(state?.meta?.clauseCount ?? 0)
  const steps = planStepCount(state)
  const text = taskText(state)

  if (needsWeb || hasAttachment) return false
  if (intent === 'multi' || clauseCount > 1 || steps > 2) return false
  if (looksMultiTask(state)) return false

  if (force && force !== 'auto' && force !== 'multi') {
    return stage === 'route' || stage === 'plan' || stage === 'critic' || stage === 'synth'
  }

  if (stage === 'route') {
    if (Boolean(state?.meta?.unifiedOrchestrator)) return false
    if (text.length > 0 && text.length <= 220 && clauseCount <= 1) return true
    return false
  }

  if (!isSimpleIntent(intent) && steps > 1) return false

  if (stage === 'plan') return isSimpleIntent(intent) || steps <= 1
  if (stage === 'critic' || stage === 'verifier') {
    if (isDualModelQaEnabled()) return false
    return isSimpleIntent(intent) && steps <= 2
  }
  if (stage === 'synth') return isSimpleIntent(intent) && steps <= 1

  return false
}

export function resolveStageModel(
  stage: LlmStage,
  resources: Record<string, unknown>,
  opts: {
    lowCost: boolean
    tier?: LlmInvokeTier
    state?: any
    openaiModel: string
  }
): { model: string; autoLight: boolean } {
  const modelLowCost = String(resources.modelLowCost || resources.modelRoute || opts.openaiModel).trim()
  const modelRoute = String(resources.modelRoute || modelLowCost || opts.openaiModel).trim()
  const modelRouteMax = String(resources.modelRouteMax || modelRoute || opts.openaiModel).trim()

  const pickStandard = () => {
    const key =
      stage === 'route'
        ? 'modelRoute'
        : stage === 'plan'
          ? 'modelPlan'
          : stage === 'critic'
            ? 'modelCritic'
            : stage === 'verifier'
              ? 'modelVerifier'
              : 'modelSynth'
    const fromStage = String(resources[key] || '').trim()
    if (fromStage) return fromStage
    return modelRoute || modelLowCost || opts.openaiModel
  }

  const effectiveTier = resolveEffectiveLlmTier(stage, opts.state, opts.tier)

  if (effectiveTier === 'max') {
    return { model: modelRouteMax, autoLight: false }
  }

  if (effectiveTier === 'standard') {
    return { model: pickStandard(), autoLight: false }
  }

  const useLight =
    opts.lowCost ||
    (isAuxiliaryLlmCall({ tier: effectiveTier }) && stage !== 'verifier') ||
    (effectiveTier !== 'standard' && opts.state && shouldAutoLightTier(stage, opts.state))

  if (useLight) {
    return { model: modelLowCost, autoLight: !opts.lowCost && !isAuxiliaryLlmCall({ tier: effectiveTier }) }
  }
  return { model: pickStandard(), autoLight: false }
}

export function resolveInternalCollaboratorModel(
  kind: 'clean' | 'visualize' | 'report',
  state: any,
  resources: Record<string, unknown>,
  openaiModel: string
): string {
  const dedicatedKey =
    kind === 'clean' ? 'modelClean' : kind === 'visualize' ? 'modelVisualize' : 'modelReport'
  const modelLowCost = String(resources.modelLowCost || resources.modelRoute || openaiModel).trim()
  const dedicated = String(resources[dedicatedKey] || modelLowCost || openaiModel).trim()
  if (String(process.env.MANAGER_INTERNAL_USE_SYNTH_MODEL ?? '0').trim() === '1') {
    const synth = String(resources.modelSynth || dedicated).trim()
    const steps = planStepCount(state)
    const heavy =
      String(state?.intent || '') === 'multi' ||
      steps > 2 ||
      Boolean(state?.meta?.needsWebSearch) ||
      looksMultiTask(taskText(state))
    if (heavy && synth) return synth
  }
  return dedicated
}
