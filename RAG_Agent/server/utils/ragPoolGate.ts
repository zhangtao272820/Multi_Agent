/**
 * RAG chat / ingest / MinerU 分池 inflight 闸（共享 key 约定）。
 */
import {
  createMemoryCounterStore,
  tryAcquireInflightSlots,
  releaseInflightSlots,
  type InflightCounterStore
} from '#agent-shared/inflightSlotStore'
import type { ExpertPool } from '#agent-shared/jobQueueKeys'

let store: InflightCounterStore = createMemoryCounterStore()
let redisTried = false

function readMax(envKey: string, fallback: number): number {
  const n = Number(process.env[envKey])
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.floor(n)
}

async function ensureStore(): Promise<InflightCounterStore> {
  const url = String(process.env.REDIS_URL || process.env.RAG_REDIS_URL || '').trim()
  if (!url || redisTried) return store
  redisTried = true
  try {
    const { createClient } = await import('redis')
    const client = createClient({ url })
    client.on('error', () => {})
    await client.connect()
    store = {
      async get(key: string) {
        return Number((await client.get(key)) || 0) || 0
      },
      async incr(key: string) {
        return Number(await client.incr(key)) || 0
      },
      async decr(key: string) {
        const n = Number(await client.decr(key)) || 0
        if (n < 0) {
          await client.set(key, '0')
          return 0
        }
        return n
      }
    }
  } catch {
    /* keep memory */
  }
  return store
}

function limitsFor(pool: ExpertPool): { maxGlobal: number; maxPerTenant: number } {
  if (pool === 'rag_chat') {
    return {
      maxGlobal: readMax('RAG_CHAT_MAX_INFLIGHT', 0),
      maxPerTenant: readMax('RAG_CHAT_MAX_INFLIGHT_PER_TENANT', 0)
    }
  }
  if (pool === 'rag_ingest') {
    return {
      maxGlobal: readMax('RAG_INGEST_MAX_INFLIGHT', 0),
      maxPerTenant: readMax('RAG_INGEST_MAX_INFLIGHT_PER_TENANT', 0)
    }
  }
  if (pool === 'rag_mineru') {
    return {
      maxGlobal: readMax('RAG_MINERU_MAX_INFLIGHT', 0),
      maxPerTenant: 0
    }
  }
  return { maxGlobal: 0, maxPerTenant: 0 }
}

export async function acquireRagPoolSlot(
  pool: ExpertPool,
  tenantId: string
): Promise<{ ok: true; release: () => Promise<void> } | { ok: false; reason: string }> {
  const limits = limitsFor(pool)
  if (limits.maxGlobal <= 0 && limits.maxPerTenant <= 0) {
    return { ok: true, release: async () => {} }
  }
  const s = await ensureStore()
  const acq = await tryAcquireInflightSlots(s, pool, tenantId, limits)
  if (!acq.ok) return { ok: false, reason: acq.reason }
  let released = false
  return {
    ok: true,
    release: async () => {
      if (released) return
      released = true
      await releaseInflightSlots(s, pool, tenantId)
    }
  }
}

export async function withRagPoolSlot<T>(
  pool: ExpertPool,
  tenantId: string,
  fn: () => Promise<T>
): Promise<T> {
  const slot = await acquireRagPoolSlot(pool, tenantId)
  if (!slot.ok) {
    const err: any = new Error(slot.reason)
    err.statusCode = 429
    err.code = 'rag_pool_overloaded'
    throw err
  }
  try {
    return await fn()
  } finally {
    await slot.release()
  }
}

export function resetRagPoolGateForTests(): void {
  store = createMemoryCounterStore()
  redisTried = false
}
