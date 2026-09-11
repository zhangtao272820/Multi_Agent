/**
 * G2：背压 / inflight + 准入排队 smoke（无 Redis / 无 LLM）。
 */
import {
  tryAcquireRunSlot,
  releaseRunSlot,
  releaseRunSlotForTenant,
  checkExpertInflight,
  acquireExpertInflight,
  releaseExpertInflight,
  getBackpressureSnapshot,
  resetBackpressureForTests,
  readMaxInflightRuns,
  readMaxInflightPerExpert,
  readMaxInflightPerTenant,
  acquireRunSlotWithAdmission,
  cancelAdmissionTicket
} from '../../../server/graph/core/runtime/backpressure'
import { classifyExpertFailure, normalizeErrorCode } from '../../../server/graph/core/runtime/expertFailure'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

resetBackpressureForTests()

{
  const prevRuns = process.env.MANAGER_MAX_INFLIGHT_RUNS
  const prevExp = process.env.MANAGER_MAX_INFLIGHT_PER_EXPERT
  const prevTenant = process.env.MANAGER_MAX_INFLIGHT_PER_TENANT
  const prevWait = process.env.MANAGER_ADMISSION_WAIT_MS
  process.env.MANAGER_MAX_INFLIGHT_RUNS = '2'
  process.env.MANAGER_MAX_INFLIGHT_PER_EXPERT = '1'
  process.env.MANAGER_MAX_INFLIGHT_PER_TENANT = '1'
  process.env.MANAGER_ADMISSION_WAIT_MS = '0'

  assert(readMaxInflightRuns() === 2, 'max runs parsed')
  assert(readMaxInflightPerExpert() === 1, 'max per expert parsed')
  assert(readMaxInflightPerTenant() === 1, 'max per tenant parsed')

  assert(tryAcquireRunSlot(process.env, 'tA').ok, 'run slot 1')
  assert(tryAcquireRunSlot(process.env, 'tB').ok, 'run slot 2')
  const blocked = tryAcquireRunSlot(process.env, 'tC')
  assert(!blocked.ok, 'run slot 3 blocked')
  assert(String(blocked.ok === false && blocked.reason).includes('上限'), 'blocked reason')

  releaseRunSlotForTenant('tA')
  releaseRunSlotForTenant('tB')
  releaseRunSlot()
  assert(getBackpressureSnapshot().inflightRuns === 0, 'runs cleared')
  assert(getBackpressureSnapshot().queueDepth === 0, 'queue empty')

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
  if (prevTenant === undefined) delete process.env.MANAGER_MAX_INFLIGHT_PER_TENANT
  else process.env.MANAGER_MAX_INFLIGHT_PER_TENANT = prevTenant
  if (prevWait === undefined) delete process.env.MANAGER_ADMISSION_WAIT_MS
  else process.env.MANAGER_ADMISSION_WAIT_MS = prevWait
}

resetBackpressureForTests()

await (async () => {
  process.env.MANAGER_MAX_INFLIGHT_RUNS = '1'
  process.env.MANAGER_MAX_INFLIGHT_PER_TENANT = '1'
  process.env.MANAGER_ADMISSION_WAIT_MS = '3000'
  process.env.MANAGER_ADMISSION_QUEUE_MAX = '10'

  assert((await acquireRunSlotWithAdmission({ runId: 'r1', tenantId: 't1' })).ok, 'admit r1')
  let sawQueued = false
  const p2 = acquireRunSlotWithAdmission({
    runId: 'r2',
    tenantId: 't2',
    onQueued: () => {
      sawQueued = true
    }
  })
  await new Promise((r) => setTimeout(r, 80))
  assert(getBackpressureSnapshot().queueDepth >= 1, 'r2 queued')
  releaseRunSlotForTenant('t1')
  const r2 = await p2
  assert(r2.ok && r2.queued, 'r2 admitted after wait')
  assert(sawQueued, 'queued callback')
  releaseRunSlotForTenant('t2')

  assert((await acquireRunSlotWithAdmission({ runId: 'r3', tenantId: 't1' })).ok, 'r3')
  const ctrl = new AbortController()
  const p4 = acquireRunSlotWithAdmission({ runId: 'r4', tenantId: 't2', signal: ctrl.signal })
  await new Promise((r) => setTimeout(r, 40))
  cancelAdmissionTicket('r4')
  ctrl.abort()
  const r4 = await p4
  assert(!r4.ok, 'r4 canceled')
  releaseRunSlotForTenant('t1')

  delete process.env.MANAGER_MAX_INFLIGHT_RUNS
  delete process.env.MANAGER_MAX_INFLIGHT_PER_TENANT
  delete process.env.MANAGER_ADMISSION_WAIT_MS
  delete process.env.MANAGER_ADMISSION_QUEUE_MAX
})()

resetBackpressureForTests()
console.log('smoke-backpressure: ok')
