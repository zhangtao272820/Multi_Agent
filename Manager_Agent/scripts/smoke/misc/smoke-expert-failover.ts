/**
 * N2 smoke：错误分类 / 降级话术 / 传输重试策略 / 步数上限 / 熔断 / 硬失败即时截断 / 依赖剪枝
 */
import {
  classifyExpertFailure,
  classifyAndDetectHard,
  buildExpertDegradeMessage,
  errorCodeFromStepOutcome,
  readExpertTransportMaxRetries,
  normalizeErrorCode,
  isHardExpertFailureCode,
  isHardExpertFailureRaw
} from '../../../server/graph/core/runtime/expertFailure'
import { readManagerStepLimits } from '../../../server/graph/core/runtime/stepLimits'
import {
  createAgentRunTelemetry,
  precheckAgentStep
} from '../../../server/graph/core/agent/agentRunner'
import {
  getUpstreamFailureSkipReason,
  enforceSemanticDependsOn
} from '../../../server/graph/core/plan/planParallel'
import { shouldConsiderLocalReplan } from '../../../server/graph/core/plan/localReplan'
import { isFixIntentBlockedByHardDown, shouldSkipCriticLlm } from '../../../server/graph/core/output/criticPolicy'
import type { Step } from '../../../server/utils/shared/taskPlan'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

assert(classifyExpertFailure({ error: new Error('ragAgent timeout after 12ms') }).code === 'timeout', 'timeout')
// 可达性/超时：硬失败，不传输重试
assert(classifyExpertFailure({ error: new Error('ragAgent timeout after 12ms') }).retryable === false, 'timeout not retryable')
assert(classifyExpertFailure({ httpStatus: 503 }).code === 'http_5xx', '5xx')
assert(classifyExpertFailure({ httpStatus: 503 }).retryable === true, '5xx retryable')
assert(classifyExpertFailure({ httpStatus: 400 }).code === 'business', '4xx business')
assert(classifyExpertFailure({ httpStatus: 400 }).retryable === false, '4xx no retry')
assert(classifyExpertFailure({ error: new Error('ECONNREFUSED') }).code === 'network', 'network')
assert(classifyExpertFailure({ error: new Error('ECONNREFUSED') }).retryable === false, 'network not retryable')
assert(classifyAndDetectHard({ error: new Error('fetch failed') }).hard === true, 'fetch failed hard')
assert(isHardExpertFailureCode('network'), 'network hard code')
assert(isHardExpertFailureRaw('vector_not_ready'), 'vector_not_ready hard')
assert(
  classifyExpertFailure({ agentResult: { ok: false, error_code: 'needs_clarify' } }).code === 'business',
  'needs_clarify → business'
)
assert(classifyExpertFailure({ policy: 'circuit_open_core' }).code === 'circuit_open', 'circuit')
assert(classifyExpertFailure({ policy: 'upstream_failed' }).code === 'skipped', 'upstream policy')
assert(normalizeErrorCode('empty_result') === 'business', 'empty_result')

const msg = buildExpertDegradeMessage('rag', 'network', 'ECONNREFUSED')
assert(msg.includes('知识库') || msg.includes('RAG'), `degrade msg: ${msg}`)
assert(msg.includes('不可用') || msg.includes('跳过'), 'degrade actionable')

assert(
  errorCodeFromStepOutcome({ ok: false, error: 'dbAgent(http) timeout after 1000ms' }) === 'timeout',
  'outcome timeout'
)
assert(errorCodeFromStepOutcome({ ok: true }) === undefined, 'ok no code')

assert(readExpertTransportMaxRetries({} as NodeJS.ProcessEnv) === 1, 'default transport retries')
assert(readExpertTransportMaxRetries({ MANAGER_EXPERT_TRANSPORT_RETRIES: '2' } as NodeJS.ProcessEnv) === 2, 'retries 2')
assert(readExpertTransportMaxRetries({ MANAGER_EXPERT_TRANSPORT_RETRIES: '9' } as NodeJS.ProcessEnv) === 2, 'retries clamp')

const limits = readManagerStepLimits({
  MANAGER_PHASE_STEP_BUDGET: '8',
  MANAGER_MAX_RUN_PHASES: '3',
  MANAGER_AUTONOMOUS_MAX_STEPS: '8',
  MANAGER_GRAPH_RECURSION_LIMIT: '48',
  MANAGER_MAX_RETRY: '1',
  MANAGER_AGENT_CIRCUIT_STREAK: '2',
  MANAGER_EXPERT_TRANSPORT_RETRIES: '1'
} as NodeJS.ProcessEnv)
assert(limits.phaseStepBudget === 8, 'phase step budget')
assert(limits.maxRunPhases === 3, 'max phases')
assert(limits.autonomousMaxSteps === 8, 'autonomous max')
assert(limits.graphRecursionLimit === 48, 'recursion')
assert(limits.circuitStreakThreshold === 2, 'circuit streak')
assert(limits.expertTransportMaxRetries === 1, 'transport in limits')

// 软失败：连败 2 次才 circuit
const telemetry = createAgentRunTelemetry({ globalTimeoutMs: 60_000, timeLeftMs: () => 60_000 })
telemetry.recordAgentFailure('rag')
telemetry.recordAgentFailure('rag')
const skip = precheckAgentStep({
  stepAgent: 'rag',
  stepId: 's1',
  agent: 'rag',
  effQuery: 'q',
  plannedInTask: true,
  schedulerSkipAgents: [],
  schedulerDegradeOptionalAgents: [],
  telemetry
})
assert(skip.action === 'skip' && skip.policy === 'circuit_open_core', 'rag circuit skip')
const degrade = buildExpertDegradeMessage('rag', 'circuit_open')
assert(degrade.includes('熔断') || degrade.includes('跳过'), `circuit msg ${degrade}`)

// 硬失败：一次即 hard-down
const tel2 = createAgentRunTelemetry({ globalTimeoutMs: 60_000, timeLeftMs: () => 60_000 })
tel2.recordAgentFailure('rag', { error: new Error('ECONNREFUSED 127.0.0.1') })
assert(tel2.isExpertHardDown('rag'), 'hard down after 1 network fail')
const hardSkip = precheckAgentStep({
  stepAgent: 'rag',
  stepId: 's2',
  agent: 'rag',
  effQuery: 'q',
  plannedInTask: true,
  schedulerSkipAgents: [],
  schedulerDegradeOptionalAgents: [],
  telemetry: tel2
})
assert(hardSkip.action === 'skip' && hardSkip.policy === 'expert_hard_down', 'hard-down precheck')

// 预算超限 → 跳过
const tel3 = createAgentRunTelemetry({ globalTimeoutMs: 60_000, timeLeftMs: () => 60_000 })
const prevTok = process.env.MANAGER_RUN_MAX_TOKENS
process.env.MANAGER_RUN_MAX_TOKENS = '100'
tel3.addSpend({ tokens: 200 })
const bud = precheckAgentStep({
  stepAgent: 'db',
  stepId: 'b1',
  agent: 'db',
  effQuery: 'q',
  plannedInTask: true,
  schedulerSkipAgents: [],
  schedulerDegradeOptionalAgents: [],
  telemetry: tel3
})
assert(bud.action === 'skip' && bud.policy === 'budget_exceeded', 'budget skip')
if (prevTok === undefined) delete process.env.MANAGER_RUN_MAX_TOKENS
else process.env.MANAGER_RUN_MAX_TOKENS = prevTok

// 截止将近 → 跳过 optional
const tel4 = createAgentRunTelemetry({ globalTimeoutMs: 60_000, timeLeftMs: () => 2_000 })
const near = precheckAgentStep({
  stepAgent: 'clean',
  stepId: 'c1',
  agent: 'clean',
  effQuery: 'q',
  plannedInTask: true,
  schedulerSkipAgents: [],
  schedulerDegradeOptionalAgents: [],
  telemetry: tel4,
  optionalStep: true
})
assert(near.action === 'skip' && near.policy === 'deadline_exceeded', 'deadline skip optional')

// 依赖剪枝：rag error → clean/code skip reason
const plan = enforceSemanticDependsOn([
  { id: 'r1', agent: 'rag', query: '制度' },
  { id: 'c1', agent: 'clean', query: '清洗' },
  { id: 'k1', agent: 'code', query: '计算' }
] as Step[])
const reason = getUpstreamFailureSkipReason(plan.find((s) => s.id === 'c1')!, plan, {
  r1: { status: 'error' }
})
assert(reason && reason.includes('rag'), `upstream skip reason: ${reason}`)
assert(
  getUpstreamFailureSkipReason(plan.find((s) => s.id === 'c1')!, plan, { r1: { status: 'ok' } }) === null,
  'ok upstream no skip'
)

// hard-down 禁止 LLM replan / critic 改道
assert(
  shouldConsiderLocalReplan({ status: 'failed', expertHardDown: true }) === false,
  'no replan when hard-down'
)
assert(isFixIntentBlockedByHardDown('rag', { expertHardDown: { rag: 'network' } }), 'block fix rag')
assert(
  shouldSkipCriticLlm({
    routeConfidence: 0.5,
    intent: 'multi',
    planStepCount: 3,
    planAgents: ['rag', 'code'],
    timeLeftMs: 60_000,
    meta: { expertHardDown: { rag: 'network' } }
  }).skip === true,
  'skip critic when hard-down'
)

console.log('smoke-expert-failover: OK')
