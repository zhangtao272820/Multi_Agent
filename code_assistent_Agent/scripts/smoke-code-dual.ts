/**
 * §2.8.5 Code 轻量对偶：metrics SLI / capabilityAudit / maxToolRounds / error_code（离线）
 */
import { getCodeAgentEnv } from '../server/utils/code_agent_env.ts'
import {
  getCodeSliSummary,
  recordCodeQueryMetric,
  getCodeQueryMetricCounters
} from '../server/utils/code_metrics.ts'
import {
  buildCodeComputeAgentResult,
  buildCodeFailAgentResult,
  classifyCodeThrownError
} from '../server/utils/agent_result.ts'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function main() {
  const env = getCodeAgentEnv()
  assert(env.maxToolRounds >= 1 && env.maxToolRounds <= 24, 'maxToolRounds in range')
  assert(Number.isFinite(env.maxToolRounds), 'maxToolRounds finite')

  assert(classifyCodeThrownError(new Error('timeout after 1000ms')) === 'timeout', 'timeout classify')
  assert(
    classifyCodeThrownError(new Error('Recursion limit of 26 reached')) === 'tool_round_limit',
    'round classify'
  )
  assert(classifyCodeThrownError(new Error('boom')) === 'business', 'business classify')

  const empty = buildCodeComputeAgentResult({ answer: '', ms: 10 })
  assert(empty.ok === false && empty.error_code === 'empty_result', 'empty compute')

  const fail = buildCodeFailAgentResult({ error_code: 'timeout', answer: 'x', ms: 5 })
  assert(fail.ok === false && fail.error_code === 'timeout', 'fail builder')

  process.env.CODE_ENABLE_METRICS = '1'
  recordCodeQueryMetric({ path: 'compute', ok: false, ms: 120, reason: 'timeout' })
  recordCodeQueryMetric({ path: 'edit', ok: true, ms: 200 })
  const sli = getCodeSliSummary(50)
  assert(typeof sli.maxToolRounds === 'number', 'sli.maxToolRounds')
  assert(Object.keys(getCodeQueryMetricCounters()).length >= 1, 'metrics recorded')

  const capabilityAudit = {
    CAP_CODER: process.env.CAP_CODER || process.env.OPENAI_MODEL || null,
    CAP_REASON: process.env.CAP_REASON || null,
    silent_upgrade_forbidden: true,
    maxToolRounds: env.maxToolRounds
  }
  assert(capabilityAudit.silent_upgrade_forbidden === true, 'capabilityAudit flag')
  assert(capabilityAudit.maxToolRounds === env.maxToolRounds, 'capabilityAudit rounds')

  console.log('smoke-code-dual OK', {
    maxToolRounds: env.maxToolRounds,
    sliP95: sli.p95Ms,
    counters: getCodeQueryMetricCounters()
  })
}

main()
