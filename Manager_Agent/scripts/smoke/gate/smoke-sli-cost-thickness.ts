/**
 * P1-2：厚度分桶 + 估算 USD → Prometheus 契约（不打真服务 / 不调 LLM）。
 */
import { aggregateManagerSli } from '../../../server/graph/core/runtime/sliAggregate'
import { appendSliCostThicknessPrometheusLines } from '../../../server/graph/core/runtime/sliPrometheus'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-sli-cost-thickness] ${msg}`)
}

function line(name: string, value: number, labels?: Record<string, string>) {
  const parts = labels
    ? Object.entries(labels)
        .map(([k, val]) => `${k}="${val}"`)
        .join(',')
    : ''
  const suffix = parts ? `{${parts}}` : ''
  return `${name}${suffix} ${value}`
}

console.log('smoke-sli-cost-thickness: start')

const sli = aggregateManagerSli([
  {
    runId: 'r1',
    phase: 'route_authority',
    ms: 100,
    tokens: 10,
    usd: 0.02,
    extra: { orchestrationThickness: 'single_source', sourceCommitment: 'clear', routeLlmCalls: 1 }
  },
  {
    runId: 'r2',
    phase: 'route_authority',
    ms: 200,
    tokens: 20,
    usd: 0.03,
    extra: { orchestrationThickness: 'complex', sourceCommitment: 'clear', routeLlmCalls: 3 }
  },
  {
    runId: 'r2',
    phase: 'db',
    ms: 50,
    ok: true,
    tokens: 5,
    usd: 0.01
  }
])

assert(sli.routeByThickness.single_source === 1, 'thickness single_source')
assert(sli.routeByThickness.complex === 1, 'thickness complex')
assert(sli.totalEstimatedUsd === 0.06, `usd sum got ${sli.totalEstimatedUsd}`)

const out: string[] = []
appendSliCostThicknessPrometheusLines(out, sli as unknown as Record<string, unknown>, line)
const text = out.join('\n')
assert(text.includes('manager_sli_route_by_thickness{thickness="single_source"} 1'), 'prom thickness')
assert(text.includes('manager_sli_estimated_usd 0.06'), 'prom usd')

const empty: string[] = []
appendSliCostThicknessPrometheusLines(empty, { routeByThickness: {}, totalEstimatedUsd: 0 }, line)
assert(!empty.some((l) => l.includes('manager_sli_estimated_usd ')), 'zero usd not exported')

const sliFallback = aggregateManagerSli(
  [{ runId: 'r3', phase: 'synth', tokens: 1000 }],
  [],
  [],
  { MANAGER_COST_PER_1K_TOKENS_USD: '0.002' } as NodeJS.ProcessEnv
)
assert(sliFallback.totalEstimatedUsd === 0.002, `token fallback usd got ${sliFallback.totalEstimatedUsd}`)

console.log('smoke-sli-cost-thickness: OK')
