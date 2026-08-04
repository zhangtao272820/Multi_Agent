/**
 * smoke: 图级重试步复用 — admin ok + rag fail → hydrate 跳过 admin；副作用守卫转 synth-only
 * run: npx tsx scripts/smoke/plan/smoke-step-reuse-retry.ts
 */
import assert from 'node:assert/strict'
import {
  classifyStepReuseStatus,
  hydrateCompletedById,
  shouldPreferSynthOnlyAfterSideEffect,
  collectFailedStepIds,
  isStepTerminalForReuse
} from '../../../server/graph/core/runtime/stepReuse'
import { stepUpstreamTerminal } from '../../../server/graph/core/plan/planParallel'

assert.equal(classifyStepReuseStatus('ok'), 'reusable_ok')
assert.equal(classifyStepReuseStatus('error'), 'failed')
assert.equal(classifyStepReuseStatus('skipped'), 'skipped')
assert.equal(isStepTerminalForReuse('ok'), true)
assert.equal(isStepTerminalForReuse('error'), false)
assert.equal(stepUpstreamTerminal({ status: 'ok' }), true)

const plan = [
  { id: 's1', agent: 'rag', query: '查制度' },
  { id: 's2', agent: 'admin', query: '添加日程：项目周会' },
  { id: 's3', agent: 'clean', query: '清洗' },
  { id: 's4', agent: 'code', query: '计算' },
  { id: 's5', agent: 'visualize', query: '出图' }
]

const lastStepRecords = [
  { id: 's1', agent: 'rag', status: 'error', error: 'empty_retrieval', output: '没有 retrieval 结果' },
  {
    id: 's2',
    agent: 'admin',
    status: 'ok',
    output: '已添加日程并设置提醒：项目周会 (2026年8月5日 10:00)'
  },
  { id: 's3', agent: 'clean', status: 'ok', output: '无事实可清洗' },
  { id: 's4', agent: 'code', status: 'ok', output: '无财务数据' },
  { id: 's5', agent: 'visualize', status: 'ok', output: 'deferred_to_internal_collab' }
]

const results = {
  admin: lastStepRecords[1]!.output,
  clean: lastStepRecords[2]!.output,
  code: lastStepRecords[3]!.output,
  visualize: lastStepRecords[4]!.output
}
const evidence = [
  {
    kind: 'admin',
    agentResult: { ok: true, agent: 'admin', answer: results.admin }
  }
]

const hydrated = hydrateCompletedById({
  plan,
  lastStepRecords,
  results,
  evidence,
  forceRerunStepIds: []
})

assert.ok(!hydrated.byId.s1, 'rag error 不得 hydrate，应可重跑')
assert.ok(hydrated.byId.s2, 'admin ok 必须 hydrate')
assert.equal(hydrated.byId.s2!.status, 'ok')
assert.equal(hydrated.reasons.s2, 'side_effect_done')
assert.ok(hydrated.byId.s3, 'clean ok hydrate')
assert.ok(hydrated.byId.s4, 'code ok hydrate')
assert.ok(hydrated.byId.s5, 'visualize ok hydrate')
assert.equal(hydrated.reusedIds.includes('s2'), true)

// forceRerun 可点名重跑 admin（显式例外）
const forced = hydrateCompletedById({
  plan,
  lastStepRecords,
  results,
  evidence,
  forceRerunStepIds: ['s2']
})
assert.ok(!forced.byId.s2, 'forceRerunStepIds 含 admin 时不得 hydrate')

const failedIds = collectFailedStepIds(lastStepRecords)
assert.deepEqual(failedIds, ['s1'])

const synthOnly = shouldPreferSynthOnlyAfterSideEffect({
  results,
  evidence,
  lastStepRecords: lastStepRecords.filter((r) => r.status !== 'error')
})
assert.equal(synthOnly.synthOnly, true, '无失败步 + admin 写成功 → synth only')
assert.equal(synthOnly.failedStepIds.length, 0)

const withFail = shouldPreferSynthOnlyAfterSideEffect({
  results,
  evidence,
  lastStepRecords
})
assert.equal(withFail.synthOnly, false, '有失败步时不 synth-only')
assert.deepEqual(withFail.failedStepIds, ['s1'])

// 模拟 taskFetcher：completedById hydrate 后 pending 不应含 terminal 步
const completedById = hydrated.byId
const pendingIds = plan
  .map((s) => String(s.id))
  .filter((id) => !stepUpstreamTerminal(completedById[id]))
assert.deepEqual(pendingIds, ['s1'], '仅 rag 进 pending，admin/clean/code/visualize 跳过')

console.log('smoke-step-reuse-retry: ok')
