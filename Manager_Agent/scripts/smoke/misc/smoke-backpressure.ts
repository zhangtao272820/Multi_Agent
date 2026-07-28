/**
 * G2：背压 / inflight smoke（仅 backpressure 模块；不拉 agentRunner 以免 tsx 卡顿）。
 */
import {
  tryAcquireRunSlot,
  releaseRunSlot,
  checkExpertInflight,
  acquireExpertInflight,
  releaseExpertInflight,
  getBackpressureSnapshot,
  resetBackpressureForTests,
  readMaxInflightRuns,
  readMaxInflightPerExpert
} from '../../../server/graph/core/runtime/backpressure'
import { classifyExpertFailure, normalizeErrorCode } from '../../../server/graph/core/runtime/expertFailure'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

resetBackpressureForTests()

{
  const prevRuns = process.env.MANAGER_MAX_INFLIGHT_RUNS
  const prevExp = process.env.MANAGER_MAX_INFLIGHT_PER_EXPERT
  process.env.MANAGER_MAX_INFLIGHT_RUNS = '2'
  process.env.MANAGER_MAX_INFLIGHT_PER_EXPERT = '1'

  assert(readMaxInflightRuns() === 2, 'max runs parsed')
  assert(readMaxInflightPerExpert() === 1, 'max per expert parsed')

  assert(tryAcquireRunSlot().ok, 'run slot 1')
  assert(tryAcquireRunSlot().ok, 'run slot 2')
  const blocked = tryAcquireRunSlot()
  assert(!blocked.ok, 'run slot 3 blocked')
  assert(String(blocked.ok === false && blocked.reason).includes('上限'), 'blocked reason')

  releaseRunSlot()
  releaseRunSlot()
  // extra release must not go negative
  releaseRunSlot()
  assert(getBackpressureSnapshot().inflightRuns === 0, 'runs cleared')

  acquireExpertInflight('rag')
  assert(getBackpressureSnapshot().inflightByExpert.rag === 1, 'expert inflight counted')
  const bp = checkExpertInflight('rag')
  assert(!bp.ok, 'expert rag at limit')
  releaseExpertInflight('rag')
  assert(checkExpertInflight('rag').ok, 'expert rag free after release')

  const classified = classifyExpertFailure({ policy: 'overloaded' })
  assert(classified.code === 'overloaded', 'overloaded policy maps')
  assert(normalizeErrorCode('overloaded') === 'overloaded', 'normalize overloaded')

  if (prevRuns === undefined) delete process.env.MANAGER_MAX_INFLIGHT_RUNS
  else process.env.MANAGER_MAX_INFLIGHT_RUNS = prevRuns
  if (prevExp === undefined) delete process.env.MANAGER_MAX_INFLIGHT_PER_EXPERT
  else process.env.MANAGER_MAX_INFLIGHT_PER_EXPERT = prevExp
}

resetBackpressureForTests()
console.log('smoke-backpressure: ok')
