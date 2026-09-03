/**
 * 贵路径 Top 报告（fixture，不调 LLM）。
 * 用法：node scripts/metrics-top-paths-report.mjs
 */
import { aggregateTopPathsFromMetricRows, formatTopPathsReport } from '../agent-repo-shared/metricsTopPaths.mjs'

const fixture = [
  { runId: 'r1', phase: 'route_authority', tokens: 100, extra: { orchestrationThickness: 'complex' } },
  { runId: 'r1', phase: 'db', agent: 'db', tokens: 500, ok: true },
  { runId: 'r2', phase: 'rag', agent: 'rag', tokens: 800, usd: 0.05 },
  { runId: 'r2', phase: 'synth', tokens: 300 }
]

const env = { MANAGER_COST_PER_1K_TOKENS_USD: '0.002' }
const buckets = aggregateTopPathsFromMetricRows(fixture, env)
if (!buckets.length) {
  console.error('metrics-top-paths: empty buckets')
  process.exit(1)
}
const report = formatTopPathsReport(buckets, 5)
console.log(report)
console.log('metrics-top-paths-report: OK')
