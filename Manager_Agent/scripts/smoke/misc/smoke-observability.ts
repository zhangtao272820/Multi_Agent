/**
 * N3 smoke：观测字段契约 + SLI 聚合（P95 / 错误率 / 拒答）
 */
import {
  normalizeManagerMetricEntry,
  validateManagerMetricEntry,
  resolveMetricAgentFromEntry
} from '../../../server/graph/core/runtime/observabilitySchema'
import { aggregateManagerSli } from '../../../server/graph/core/runtime/sliAggregate'
import { buildWorkerStepMetricEntry } from '../../../server/graph/core/runtime/expertFailure'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const okRow = normalizeManagerMetricEntry({
  runId: 'run-obs-1',
  phase: 'rag',
  ms: 120,
  ok: true,
  tokens: 50
})
assert(okRow.trace_id === 'run-obs-1', 'trace_id defaults to runId')
assert(okRow.agent === 'rag', 'agent inferred from worker phase')
assert(validateManagerMetricEntry(okRow).length === 0, 'ok row valid')

const failRow = normalizeManagerMetricEntry(
  buildWorkerStepMetricEntry({
    runId: 'run-obs-2',
    agent: 'rag',
    ms: 8000,
    ok: false,
    error: 'ragAgent timeout after 8000ms'
  })
)
assert(failRow.ok === false, 'fail ok=false')
assert(failRow.error_code === 'timeout', `error_code timeout got ${failRow.error_code}`)
assert(failRow.trace_id === 'run-obs-2', 'fail trace_id')
assert(validateManagerMetricEntry(failRow).length === 0, 'fail row with error_code valid')

const missingCode = normalizeManagerMetricEntry({
  runId: 'run-obs-3',
  phase: 'db',
  ms: 10,
  ok: false
})
assert(validateManagerMetricEntry(missingCode).includes('failed step missing error_code'), 'missing error_code flagged')

assert(resolveMetricAgentFromEntry({ phase: 'execute:code' }) === 'code', 'execute: prefix')

const sli = aggregateManagerSli(
  [
    { runId: 'r1', phase: 'rag', ms: 100, ok: true, agent: 'rag', tokens: 10 },
    { runId: 'r1', phase: 'rag', ms: 200, ok: false, agent: 'rag', error_code: 'timeout' },
    { runId: 'r2', phase: 'db', ms: 50, ok: true, agent: 'db', tokens: 5 },
    { runId: 'r2', phase: 'evidence_gate', ms: 0, ok: false, error_code: 'business' }
  ],
  [{ needsClarify: true }, { needsClarify: false }],
  [{ payload: { waitMs: 1500 } }, { payload: { wait_ms: 3000 } }]
)

assert(sli.runs === 2, `runs ${sli.runs}`)
assert(sli.totalTokens === 15, `tokens ${sli.totalTokens}`)
assert(sli.expertErrorRate === 0.333, `expertErrorRate ${sli.expertErrorRate}`)
assert(sli.expertErrorsByCode.timeout === 1, 'timeout count')
assert(sli.evidenceGateFailures === 1, 'evidence gate failures')
assert(sli.hitlWaitMsP95 === 3000, `hitl p95 ${sli.hitlWaitMsP95}`)
assert(sli.p95LatencyMs > 0, 'p95 latency')
assert(sli.p95ByPhase.rag > 0, 'p95 by phase')
assert(sli.evidenceRejectionRate != null, 'rejection rate present')

{
  const { buildTraceDeepLinks } = await import('../../../server/graph/core/runtime/traceDeepLinks')
  const links = buildTraceDeepLinks('run-obs-deeplink', {
    LANGFUSE_PUBLIC_URL: 'http://langfuse.test:3000',
    TEMPO_UI_URL: 'http://grafana.test/explore',
    MANAGER_OTEL_EXPORT: '1'
  } as NodeJS.ProcessEnv)
  assert(links.langfuseUrl?.includes('/trace/run-obs-deeplink'), 'langfuse deep link')
  assert(links.tempoUrl?.includes('traceId=run-obs-deeplink'), 'tempo deep link')
}

console.log('smoke-observability: OK')
