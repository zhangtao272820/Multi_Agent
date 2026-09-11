/**
 * Inflight 槽位存储：内存默认；可选 Redis 原子计数（跨进程）。
 * Key 约定见 jobQueueKeys.ts。
 */

import {
  globalInflightKey,
  tenantInflightKey,
  type ExpertPool,
  normalizeQueueTenantId
} from './jobQueueKeys'

export type SlotAcquireResult =
  | { ok: true; global: number; tenant: number }
  | { ok: false; reason: string; global: number; tenant: number }

export type InflightSlotLimits = {
  /** 0 = 不限 */
  maxGlobal: number
  /** 0 = 不限 */
  maxPerTenant: number
}

export type InflightCounterStore = {
  get(key: string): Promise<number>
  incr(key: string): Promise<number>
  decr(key: string): Promise<number>
}

/** 进程内计数（smoke / LAN 无 Redis） */
export function createMemoryCounterStore(seed?: Map<string, number>): InflightCounterStore {
  const m = seed ?? new Map<string, number>()
  return {
    async get(key: string) {
      return m.get(key) || 0
    },
    async incr(key: string) {
      const n = (m.get(key) || 0) + 1
      m.set(key, n)
      return n
    },
    async decr(key: string) {
      const n = Math.max(0, (m.get(key) || 0) - 1)
      if (n <= 0) m.delete(key)
      else m.set(key, n)
      return n
    }
  }
}

/**
 * 尝试占用全局 + 租户槽。任一层超限则回滚已占用的计数。
 */
export async function tryAcquireInflightSlots(
  store: InflightCounterStore,
  pool: ExpertPool,
  tenantId: string,
  limits: InflightSlotLimits
): Promise<SlotAcquireResult> {
  const t = normalizeQueueTenantId(tenantId)
  const gKey = globalInflightKey(pool)
  const tKey = tenantInflightKey(pool, t)

  const globalNext = await store.incr(gKey)
  if (limits.maxGlobal > 0 && globalNext > limits.maxGlobal) {
    await store.decr(gKey)
    const g = await store.get(gKey)
    const tn = await store.get(tKey)
    return {
      ok: false,
      reason: `并发已达全局上限（${g}/${limits.maxGlobal}）`,
      global: g,
      tenant: tn
    }
  }

  const tenantNext = await store.incr(tKey)
  if (limits.maxPerTenant > 0 && tenantNext > limits.maxPerTenant) {
    await store.decr(tKey)
    await store.decr(gKey)
    const g = await store.get(gKey)
    const tn = await store.get(tKey)
    return {
      ok: false,
      reason: `租户并发已达上限（${tn}/${limits.maxPerTenant}）`,
      global: g,
      tenant: tn
    }
  }

  return { ok: true, global: globalNext, tenant: tenantNext }
}

export async function releaseInflightSlots(
  store: InflightCounterStore,
  pool: ExpertPool,
  tenantId: string
): Promise<void> {
  const t = normalizeQueueTenantId(tenantId)
  await store.decr(tenantInflightKey(pool, t))
  await store.decr(globalInflightKey(pool))
}

export async function readInflightSnapshot(
  store: InflightCounterStore,
  pool: ExpertPool,
  tenantId?: string
): Promise<{ global: number; tenant: number }> {
  const g = await store.get(globalInflightKey(pool))
  const tn = tenantId
    ? await store.get(tenantInflightKey(pool, normalizeQueueTenantId(tenantId)))
    : 0
  return { global: g, tenant: tn }
}
