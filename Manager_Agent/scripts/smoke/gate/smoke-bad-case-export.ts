/**
 * 在线坏例 → eval fixture 导出（纯函数 smoke，不写盘）。
 * 用法：npx tsx scripts/smoke/gate/smoke-bad-case-export.ts
 */
import { exportBadCasesToEvalFixture } from '../../../agent-repo-shared/badCaseFixtureExport'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-bad-case-export] ${msg}`)
}

console.log('smoke-bad-case-export: start')

const rows = [
  { runId: 'run_a', question: '老人怎么样', score: 0.2, reason: 'ambiguous_miss', expectClarify: true },
  { runId: 'run_b', question: '查张三血压', score: 0.3, reason: 'wrong_cap', expectCap: ['db'] },
  { runId: 'run_c', question: '今天天气', score: 0.9, reason: 'ok' }
]

const fixture = exportBadCasesToEvalFixture(rows, { topN: 5, maxScore: 0.5 })
assert(fixture.pendingReview === true, 'pendingReview')
assert(fixture.cases.length === 2, `expect 2 bad cases got ${fixture.cases.length}`)
assert(fixture.cases[0]?.meta?.pendingReview === true, 'case meta pendingReview')
assert(fixture.cases.some((c) => c.expectClarify === true), 'clarify case')
assert(fixture.cases.some((c) => Array.isArray(c.expectCap)), 'cap case')

console.log('smoke-bad-case-export: OK')
