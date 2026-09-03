/**
 * P0-2：熔断状态机 / 分级降级 / 限流契约（纯函数；默认不拦主路径）。
 * 运行：cd Manager_Agent && npm run smoke:expert-circuit-policy
 */
import {
  beginHalfOpenProbe,
  circuitAllowsCall,
  createCircuitSnapshot,
  DEFAULT_CIRCUIT_CONFIG,
  isExpertAllowedAtDegradeLevel,
  nextCircuitState,
  resolveServiceDegradeLevel,
  tryConsumeRateLimit
} from '#agent-shared/expertCircuitPolicy'
import {
  createAgentRunTelemetry,
  hasExplicitServiceDegradeLevel,
  precheckAgentStep,
  readServiceDegradeLevel
} from '../../../server/graph/core/agent/agentRunner'
import {
  readRequestRatePerMin,
  resetRequestRateForTests,
  tryAcquireRequestRate,
  getRequestRateLimitSnapshot
} from '../../../server/graph/core/runtime/requestRateLimit'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-expert-circuit-policy] ${msg}`)
}

console.log('smoke-expert-circuit-policy: start')

const cfg = { ...DEFAULT_CIRCUIT_CONFIG, minSamples: 4, failureRateThreshold: 0.5, openMs: 1_000 }
let s = createCircuitSnapshot(0)
assert(s.state === 'closed', 'start closed')
assert(circuitAllowsCall(s, 0, cfg), 'closed allows')

s = nextCircuitState(s, 'failure', 10, cfg)
s = nextCircuitState(s, 'failure', 20, cfg)
s = nextCircuitState(s, 'success', 30, cfg)
s = nextCircuitState(s, 'failure', 40, cfg)
assert(s.state === 'open', '4 samples 75% fail → open')
assert(!circuitAllowsCall(s, 40, cfg), 'open blocks')

s = nextCircuitState(s, 'tick', 40 + cfg.openMs + 1, cfg)
assert(s.state === 'half_open', 'cooldown → half_open')
s = beginHalfOpenProbe(s, 40 + cfg.openMs + 2, cfg)
assert(s.halfOpenProbes === 1, 'probe counted')
s = nextCircuitState(s, 'success', 40 + cfg.openMs + 3, cfg)
assert(s.state === 'closed', 'half_open success → closed')

assert(resolveServiceDegradeLevel({}) === 0, 'degrade L0')
assert(resolveServiceDegradeLevel({ openAgents: ['db'] }) === 1, 'one core → L1')
assert(resolveServiceDegradeLevel({ openAgents: ['db', 'rag'] }) === 2, 'two core → L2')
assert(resolveServiceDegradeLevel({ overload: true }) === 3, 'overload → L3')
assert(resolveServiceDegradeLevel({ explicitLevel: 2, openAgents: [] }) === 2, 'explicit wins')

assert(isExpertAllowedAtDegradeLevel('rag', 0), 'L0 rag')
assert(!isExpertAllowedAtDegradeLevel('admin', 1), 'L1 blocks admin')
assert(isExpertAllowedAtDegradeLevel('db', 1), 'L1 allows db')
assert(!isExpertAllowedAtDegradeLevel('crawler', 2), 'L2 blocks crawler')
assert(!isExpertAllowedAtDegradeLevel('rag', 3), 'L3 blocks all')

const r1 = tryConsumeRateLimit(null, 1000, 2, 60_000)
assert(r1.ok && r1.bucket.count === 1, 'rate 1')
const r2 = tryConsumeRateLimit(r1.bucket, 1001, 2, 60_000)
assert(r2.ok && r2.bucket.count === 2, 'rate 2')
const r3 = tryConsumeRateLimit(r2.bucket, 1002, 2, 60_000)
assert(!r3.ok, 'rate blocked')

resetRequestRateForTests()
const prevRate = process.env.MANAGER_REQUEST_RATE_PER_MIN
process.env.MANAGER_REQUEST_RATE_PER_MIN = '2'
assert(readRequestRatePerMin() === 2, 'rate env')
assert(tryAcquireRequestRate({ key: 't1', nowMs: 1 }).ok, 'acq 1')
assert(tryAcquireRequestRate({ key: 't1', nowMs: 2 }).ok, 'acq 2')
assert(!tryAcquireRequestRate({ key: 't1', nowMs: 3 }).ok, 'acq 3 blocked')
assert(getRequestRateLimitSnapshot().rejectedTotal === 1, 'rejected counted')
if (prevRate === undefined) delete process.env.MANAGER_REQUEST_RATE_PER_MIN
else process.env.MANAGER_REQUEST_RATE_PER_MIN = prevRate
resetRequestRateForTests()
assert(readRequestRatePerMin({} as NodeJS.ProcessEnv) === 0, 'default rate off')
assert(getRequestRateLimitSnapshot().rejectedTotal === 0, 'reset clears rejected')

const prevDeg = process.env.MANAGER_SERVICE_DEGRADE_LEVEL
delete process.env.MANAGER_SERVICE_DEGRADE_LEVEL
assert(!hasExplicitServiceDegradeLevel(), 'no explicit degrade by default')
const telOpen = createAgentRunTelemetry({ globalTimeoutMs: 60_000, timeLeftMs: () => 60_000 })
telOpen.recordAgentFailure('db')
telOpen.recordAgentFailure('db')
assert(telOpen.runtimeCircuitOpenAgents.has('db'), 'db circuit open')
const noBleed = precheckAgentStep({
  stepAgent: 'admin',
  stepId: 'a0',
  agent: 'admin',
  effQuery: 'q',
  plannedInTask: true,
  schedulerSkipAgents: [],
  schedulerDegradeOptionalAgents: [],
  telemetry: telOpen
})
assert(noBleed.action === 'run', 'open circuit must not auto-block other experts')

process.env.MANAGER_SERVICE_DEGRADE_LEVEL = '2'
assert(hasExplicitServiceDegradeLevel(), 'explicit degrade on')
const tel = createAgentRunTelemetry({ globalTimeoutMs: 60_000, timeLeftMs: () => 60_000 })
assert(readServiceDegradeLevel(tel) === 2, 'read degrade from env')
const skipCrawler = precheckAgentStep({
  stepAgent: 'crawler',
  stepId: 'c1',
  agent: 'crawler',
  effQuery: 'q',
  plannedInTask: true,
  schedulerSkipAgents: [],
  schedulerDegradeOptionalAgents: [],
  telemetry: tel
})
assert(skipCrawler.action === 'skip' && skipCrawler.policy === 'service_degrade', 'precheck service_degrade')
const allowDb = precheckAgentStep({
  stepAgent: 'db',
  stepId: 'd1',
  agent: 'db',
  effQuery: 'q',
  plannedInTask: true,
  schedulerSkipAgents: [],
  schedulerDegradeOptionalAgents: [],
  telemetry: tel
})
assert(allowDb.action === 'run', 'L2 still allows db')
if (prevDeg === undefined) delete process.env.MANAGER_SERVICE_DEGRADE_LEVEL
else process.env.MANAGER_SERVICE_DEGRADE_LEVEL = prevDeg

console.log('smoke-expert-circuit-policy: OK')
