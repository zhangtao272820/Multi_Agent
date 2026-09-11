/**
 * 按租户公平出队（纯函数，可测）。
 * Worker / 准入调度：下一票给「当前 inflight 未满且等待最久」的租户，避免大户占满。
 */

import { normalizeQueueTenantId, type JobTicket } from './jobQueueKeys'

export type FairQueueTicket = JobTicket & {
  /** 稳定唯一 id（通常 = job_id / run_id） */
  id: string
}

export type TenantQueueState = {
  /** 租户 -> 等待中的票（FIFO） */
  waitingByTenant: Map<string, FairQueueTicket[]>
  /** 租户当前 inflight */
  inflightByTenant: Map<string, number>
  /** 全局 inflight */
  globalInflight: number
}

export type FairPickLimits = {
  /** 0 = 不限 */
  maxGlobal: number
  /** 0 = 不限 */
  maxPerTenant: number
}

export type FairPickResult =
  | { ok: true; ticket: FairQueueTicket; tenantId: string }
  | { ok: false; reason: 'empty' | 'capacity' }

/** 候选租户：有等待且未超租户上限 */
export function listEligibleTenants(state: TenantQueueState, limits: FairPickLimits): string[] {
  const out: string[] = []
  for (const [tenantId, q] of state.waitingByTenant.entries()) {
    if (!q.length) continue
    const inflight = state.inflightByTenant.get(tenantId) || 0
    if (limits.maxPerTenant > 0 && inflight >= limits.maxPerTenant) continue
    out.push(tenantId)
  }
  return out
}

/**
 * 加权公平：优先「等待最久的队首」；同刻按 tenant_id 字典序稳定。
 * 不修改 state；调用方 dequeue 后再更新 inflight。
 */
export function pickNextFairTenant(
  state: TenantQueueState,
  limits: FairPickLimits
): FairPickResult {
  if (limits.maxGlobal > 0 && state.globalInflight >= limits.maxGlobal) {
    return { ok: false, reason: 'capacity' }
  }
  const eligible = listEligibleTenants(state, limits)
  if (!eligible.length) {
    const anyWaiting = Array.from(state.waitingByTenant.values()).some((q) => q.length > 0)
    return { ok: false, reason: anyWaiting ? 'capacity' : 'empty' }
  }

  let bestTenant = eligible[0]
  let bestEnqueued = Number.POSITIVE_INFINITY
  for (const t of eligible) {
    const head = state.waitingByTenant.get(t)?.[0]
    if (!head) continue
    const ts = Number(head.enqueued_at) || 0
    if (ts < bestEnqueued || (ts === bestEnqueued && t < bestTenant)) {
      bestEnqueued = ts
      bestTenant = t
    }
  }
  const ticket = state.waitingByTenant.get(bestTenant)?.[0]
  if (!ticket) return { ok: false, reason: 'empty' }
  return { ok: true, ticket, tenantId: bestTenant }
}

/** 入队（按 tenant 分桶 FIFO） */
export function enqueueFairTicket(
  state: TenantQueueState,
  ticket: FairQueueTicket,
  opts?: { maxQueueSize?: number }
): { ok: true; position: number } | { ok: false; reason: string } {
  const tenantId = normalizeQueueTenantId(ticket.tenant_id)
  const maxQ = opts?.maxQueueSize ?? 0
  const depth = queueDepth(state)
  if (maxQ > 0 && depth >= maxQ) {
    return { ok: false, reason: `准入队列已满（${depth}/${maxQ}）` }
  }
  const q = state.waitingByTenant.get(tenantId) || []
  q.push({ ...ticket, tenant_id: tenantId, id: ticket.id || ticket.job_id })
  state.waitingByTenant.set(tenantId, q)
  return { ok: true, position: depth + 1 }
}

/** 弹出指定租户队首（在 pick 之后调用） */
export function dequeueFairTicket(state: TenantQueueState, tenantId: string): FairQueueTicket | null {
  const t = normalizeQueueTenantId(tenantId)
  const q = state.waitingByTenant.get(t)
  if (!q?.length) return null
  const ticket = q.shift()!
  if (!q.length) state.waitingByTenant.delete(t)
  else state.waitingByTenant.set(t, q)
  return ticket
}

/** 按 id 取消等待中的票 */
export function cancelFairTicket(state: TenantQueueState, ticketId: string): boolean {
  const id = String(ticketId || '').trim()
  if (!id) return false
  for (const [tenantId, q] of state.waitingByTenant.entries()) {
    const idx = q.findIndex((x) => x.id === id || x.job_id === id || x.run_id === id)
    if (idx < 0) continue
    q.splice(idx, 1)
    if (!q.length) state.waitingByTenant.delete(tenantId)
    else state.waitingByTenant.set(tenantId, q)
    return true
  }
  return false
}

export function queueDepth(state: TenantQueueState): number {
  let n = 0
  for (const q of state.waitingByTenant.values()) n += q.length
  return n
}

/** 估算某票在公平调度下的大致位置（1-based；找不到返回 0） */
export function estimateFairPosition(state: TenantQueueState, ticketId: string, limits: FairPickLimits): number {
  const id = String(ticketId || '').trim()
  if (!id) return 0
  const clone: TenantQueueState = {
    waitingByTenant: new Map(),
    inflightByTenant: new Map(state.inflightByTenant),
    globalInflight: state.globalInflight
  }
  for (const [t, q] of state.waitingByTenant.entries()) {
    clone.waitingByTenant.set(t, q.slice())
  }
  let pos = 0
  const maxSteps = queueDepth(clone) + 2
  for (let i = 0; i < maxSteps; i++) {
    const pick = pickNextFairTenant(clone, limits)
    if (!pick.ok) break
    const ticket = dequeueFairTicket(clone, pick.tenantId)
    if (!ticket) break
    pos += 1
    if (ticket.id === id || ticket.job_id === id || ticket.run_id === id) return pos
  }
  return 0
}

export function createEmptyFairQueueState(): TenantQueueState {
  return {
    waitingByTenant: new Map(),
    inflightByTenant: new Map(),
    globalInflight: 0
  }
}

export function noteInflightAcquire(state: TenantQueueState, tenantId: string): void {
  const t = normalizeQueueTenantId(tenantId)
  state.globalInflight += 1
  state.inflightByTenant.set(t, (state.inflightByTenant.get(t) || 0) + 1)
}

export function noteInflightRelease(state: TenantQueueState, tenantId: string): void {
  const t = normalizeQueueTenantId(tenantId)
  state.globalInflight = Math.max(0, state.globalInflight - 1)
  const next = Math.max(0, (state.inflightByTenant.get(t) || 0) - 1)
  if (next <= 0) state.inflightByTenant.delete(t)
  else state.inflightByTenant.set(t, next)
}
