/**
 * Agent 连败熔断：核心 Agent 可 skip；可选 Agent degrade；streak 可配。
 */
import {
  createAgentRunTelemetry,
  precheckAgentStep,
  readAgentCircuitStreak,
  isCircuitSkipCoreEnabled
} from '../../../server/graph/core/agent/agentRunner'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

assert(readAgentCircuitStreak({} as NodeJS.ProcessEnv) === 2, 'default streak 2')
assert(readAgentCircuitStreak({ MANAGER_AGENT_CIRCUIT_STREAK: '4' } as NodeJS.ProcessEnv) === 4, 'env streak')
assert(readAgentCircuitStreak({ MANAGER_AGENT_CIRCUIT_STREAK: '99' } as NodeJS.ProcessEnv) === 5, 'streak clamp max')
assert(readAgentCircuitStreak({ MANAGER_AGENT_CIRCUIT_STREAK: '0' } as NodeJS.ProcessEnv) === 1, 'streak clamp min')
assert(isCircuitSkipCoreEnabled({} as NodeJS.ProcessEnv), 'skip core default on')
assert(!isCircuitSkipCoreEnabled({ MANAGER_CIRCUIT_SKIP_CORE: '0' } as NodeJS.ProcessEnv), 'skip core off')

const prevStreak = process.env.MANAGER_AGENT_CIRCUIT_STREAK
const prevSkip = process.env.MANAGER_CIRCUIT_SKIP_CORE
process.env.MANAGER_AGENT_CIRCUIT_STREAK = '2'
process.env.MANAGER_CIRCUIT_SKIP_CORE = '1'

try {
  const telemetry = createAgentRunTelemetry({
    globalTimeoutMs: 60_000,
    timeLeftMs: () => 60_000
  })
  assert(telemetry.circuitStreakThreshold === 2, 'telemetry threshold')

  telemetry.recordAgentFailure('db')
  assert(!telemetry.runtimeCircuitOpenAgents.has('db'), '1 soft fail no circuit')
  assert(telemetry.getAgentFailureStreak('db') === 1, 'streak 1')

  telemetry.recordAgentFailure('db')
  assert(telemetry.runtimeCircuitOpenAgents.has('db'), '2 soft fails open circuit')
  assert(telemetry.getAgentFailureStreak('db') === 2, 'streak 2')

  // 硬失败：一次即开路 + hard-down
  const telHard = createAgentRunTelemetry({ globalTimeoutMs: 60_000, timeLeftMs: () => 60_000 })
  telHard.recordAgentFailure('rag', { errorCode: 'network', error: new Error('ECONNREFUSED') })
  assert(telHard.isExpertHardDown('rag'), 'hard down immediate')
  assert(telHard.runtimeCircuitOpenAgents.has('rag'), 'hard opens circuit')
  const hardPre = precheckAgentStep({
    stepAgent: 'rag',
    stepId: 'h1',
    agent: 'rag',
    effQuery: 'q',
    plannedInTask: true,
    schedulerSkipAgents: [],
    schedulerDegradeOptionalAgents: [],
    telemetry: telHard
  })
  assert(hardPre.action === 'skip' && hardPre.policy === 'expert_hard_down', 'hard-down skip')

  const coreSkip = precheckAgentStep({
    stepAgent: 'db',
    stepId: 's1',
    agent: 'db',
    effQuery: 'q',
    plannedInTask: true,
    schedulerSkipAgents: [],
    schedulerDegradeOptionalAgents: [],
    telemetry
  })
  assert(coreSkip.action === 'skip' && coreSkip.policy === 'circuit_open_core', 'core circuit skip')

  telemetry.recordAgentFailure('report')
  telemetry.recordAgentFailure('report')
  const optSkip = precheckAgentStep({
    stepAgent: 'report',
    stepId: 's2',
    agent: 'report',
    effQuery: 'q',
    plannedInTask: false,
    schedulerSkipAgents: [],
    schedulerDegradeOptionalAgents: [],
    telemetry
  })
  assert(optSkip.action === 'skip' && optSkip.policy === 'circuit_degrade_optional', 'optional degrade')

  // planned optional 仍受保护（不因 circuit 直接 degrade）— 但 report 在 optional 集合且 plannedInTask 时 protect
  const optProtected = precheckAgentStep({
    stepAgent: 'report',
    stepId: 's3',
    agent: 'report',
    effQuery: 'q',
    plannedInTask: true,
    schedulerSkipAgents: [],
    schedulerDegradeOptionalAgents: [],
    telemetry
  })
  assert(optProtected.action === 'run', 'planned optional protected from degrade')

  telemetry.recordAgentSuccess('db')
  assert(telemetry.getAgentFailureStreak('db') === 0, 'success resets streak')
  // circuit set 不自动清除（同 run 内保持开路）；成功只清 streak 计数
  assert(telemetry.runtimeCircuitOpenAgents.has('db'), 'circuit stays open in run after success reset streak')
} finally {
  if (prevStreak === undefined) delete process.env.MANAGER_AGENT_CIRCUIT_STREAK
  else process.env.MANAGER_AGENT_CIRCUIT_STREAK = prevStreak
  if (prevSkip === undefined) delete process.env.MANAGER_CIRCUIT_SKIP_CORE
  else process.env.MANAGER_CIRCUIT_SKIP_CORE = prevSkip
}

// MANAGER_CIRCUIT_SKIP_CORE=0 → 核心不 skip
process.env.MANAGER_CIRCUIT_SKIP_CORE = '0'
process.env.MANAGER_AGENT_CIRCUIT_STREAK = '2'
try {
  const t2 = createAgentRunTelemetry({ globalTimeoutMs: 60_000, timeLeftMs: () => 60_000 })
  t2.recordAgentFailure('rag')
  t2.recordAgentFailure('rag')
  const r = precheckAgentStep({
    stepAgent: 'rag',
    stepId: 'x',
    agent: 'rag',
    effQuery: 'q',
    plannedInTask: true,
    schedulerSkipAgents: [],
    schedulerDegradeOptionalAgents: [],
    telemetry: t2
  })
  assert(r.action === 'run', 'skip core disabled → core still runs')
} finally {
  if (prevStreak === undefined) delete process.env.MANAGER_AGENT_CIRCUIT_STREAK
  else process.env.MANAGER_AGENT_CIRCUIT_STREAK = prevStreak
  if (prevSkip === undefined) delete process.env.MANAGER_CIRCUIT_SKIP_CORE
  else process.env.MANAGER_CIRCUIT_SKIP_CORE = prevSkip
}

console.log('smoke-agent-circuit: ok')
