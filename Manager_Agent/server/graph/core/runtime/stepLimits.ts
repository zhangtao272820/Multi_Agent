/** N2：多步/图执行上限单一配置源（供 smoke 与文档对齐） */

import { readAgentCircuitStreak } from '../agent/agentRunner'
import { phaseStepBudget, maxRunPhases } from '../plan/phaseContinue'
import { readManagerMaxRetryEnv, readManagerRecursionLimit } from './retryBudget'

export function readManagerStepLimits(env: NodeJS.ProcessEnv = process.env) {
  const autonomousRaw = Number(env.MANAGER_AUTONOMOUS_MAX_STEPS ?? 8)
  const autonomousMaxSteps =
    Number.isFinite(autonomousRaw) && autonomousRaw >= 1 ? Math.min(16, Math.floor(autonomousRaw)) : 8

  return {
    phaseStepBudget: phaseStepBudget(env),
    maxRunPhases: maxRunPhases(env),
    autonomousMaxSteps,
    graphRecursionLimit: readManagerRecursionLimit(),
    maxRetry: readManagerMaxRetryEnv(),
    circuitStreakThreshold: readAgentCircuitStreak(env),
    expertTransportMaxRetries: (() => {
      const n = Number(env.MANAGER_EXPERT_TRANSPORT_RETRIES ?? 1)
      return Number.isFinite(n) ? Math.max(0, Math.min(2, Math.floor(n))) : 1
    })()
  }
}
