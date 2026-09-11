/**
 * 租户公平队列 + inflight 槽契约 smoke（无 Redis / 无 LLM）。
 */
import {
  createEmptyFairQueueState,
  enqueueFairTicket,
  pickNextFairTenant,
  dequeueFairTicket,
  cancelFairTicket,
  queueDepth,
  noteInflightAcquire,
  noteInflightRelease,
  estimateFairPosition,
  type FairQueueTicket
} from '#agent-shared/tenantFairQueue'
import {
  createMemoryCounterStore,
  tryAcquireInflightSlots,
  releaseInflightSlots
} from '#agent-shared/inflightSlotStore'
import { QUEUE_NAMES, globalInflightKey, normalizeQueueTenantId } from '#agent-shared/jobQueueKeys'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function ticket(partial: Partial<FairQueueTicket> & { id: string; tenant_id: string }): FairQueueTicket {
  return {
    job_id: partial.id,
    kind: 'manager_admission',
    enqueued_at: partial.enqueued_at ?? Date.now(),
    ...partial
  }
}

{
  assert(QUEUE_NAMES.ragIngest.includes('rag_ingest'), 'queue name')
  assert(globalInflightKey('manager').includes('inflight:global:manager'), 'global key')
  assert(normalizeQueueTenantId('') === 'default', 'tenant normalize')
}

{
  const state = createEmptyFairQueueState()
  const limits = { maxGlobal: 2, maxPerTenant: 1 }
  assert(
    enqueueFairTicket(state, ticket({ id: 'a1', tenant_id: 'tA', enqueued_at: 1 })).ok,
    'enq a1'
  )
  assert(
    enqueueFairTicket(state, ticket({ id: 'b1', tenant_id: 'tB', enqueued_at: 2 })).ok,
    'enq b1'
  )
  assert(
    enqueueFairTicket(state, ticket({ id: 'a2', tenant_id: 'tA', enqueued_at: 3 })).ok,
    'enq a2'
  )
  assert(queueDepth(state) === 3, 'depth 3')

  const p1 = pickNextFairTenant(state, limits)
  assert(p1.ok && p1.tenantId === 'tA' && p1.ticket.id === 'a1', 'oldest eligible tA')
  dequeueFairTicket(state, 'tA')
  noteInflightAcquire(state, 'tA')

  // tA at tenant cap → next should be tB
  const p2 = pickNextFairTenant(state, limits)
  assert(p2.ok && p2.tenantId === 'tB', 'fair to tB while tA inflight')
  dequeueFairTicket(state, 'tB')
  noteInflightAcquire(state, 'tB')

  // global full
  const p3 = pickNextFairTenant(state, limits)
  assert(!p3.ok && p3.reason === 'capacity', 'global capacity')

  noteInflightRelease(state, 'tA')
  const p4 = pickNextFairTenant(state, limits)
  assert(p4.ok && p4.ticket.id === 'a2', 'a2 after release')
}

{
  const state = createEmptyFairQueueState()
  enqueueFairTicket(state, ticket({ id: 'x1', tenant_id: 't1', enqueued_at: 10 }), { maxQueueSize: 1 })
  const full = enqueueFairTicket(state, ticket({ id: 'x2', tenant_id: 't2', enqueued_at: 11 }), {
    maxQueueSize: 1
  })
  assert(!full.ok, 'queue max reject')
  assert(cancelFairTicket(state, 'x1'), 'cancel waiting')
  assert(queueDepth(state) === 0, 'empty after cancel')
}

{
  const state = createEmptyFairQueueState()
  enqueueFairTicket(state, ticket({ id: 'p1', tenant_id: 't1', enqueued_at: 1 }))
  enqueueFairTicket(state, ticket({ id: 'p2', tenant_id: 't2', enqueued_at: 2 }))
  const pos = estimateFairPosition(state, 'p2', { maxGlobal: 10, maxPerTenant: 10 })
  assert(pos === 2, `position p2 got ${pos}`)
}

async function slotSmoke() {
  const store = createMemoryCounterStore()
  const limits = { maxGlobal: 2, maxPerTenant: 1 }
  const a1 = await tryAcquireInflightSlots(store, 'manager', 'tA', limits)
  assert(a1.ok, 'slot a1')
  const a2 = await tryAcquireInflightSlots(store, 'manager', 'tA', limits)
  assert(!a2.ok, 'tenant cap')
  const b1 = await tryAcquireInflightSlots(store, 'manager', 'tB', limits)
  assert(b1.ok, 'slot b1')
  const b2 = await tryAcquireInflightSlots(store, 'manager', 'tC', limits)
  assert(!b2.ok, 'global cap')
  await releaseInflightSlots(store, 'manager', 'tA')
  const c1 = await tryAcquireInflightSlots(store, 'manager', 'tC', limits)
  assert(c1.ok, 'after release')
  await releaseInflightSlots(store, 'manager', 'tB')
  await releaseInflightSlots(store, 'manager', 'tC')
}

await slotSmoke()
console.log('smoke-tenant-fair-queue: ok')
