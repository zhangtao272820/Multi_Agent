/**
 * G2：Manager run / 专家 inflight 背压 + 按租户公平准入排队。
 * 默认内存槽；REDIS_URL 可用时用 Redis 原子计数（跨进程）。
 * 执行仍粘在持有 WS 的进程；排队只做准入租约。
 */

import {
  createEmptyFairQueueState,
  enqueueFairTicket,
  cancelFairTicket,
  queueDepth as fairQueueDepth,
  pickNextFairTenant,
  dequeueFairTicket,
  noteInflightAcquire,
  noteInflightRelease,
  estimateFairPosition,
  type TenantQueueState,
  type FairQueueTicket
} from '#agent-shared/tenantFairQueue'
import {
  createMemoryCounterStore,
  tryAcquireInflightSlots,
  releaseInflightSlots,
  type InflightCounterStore
} from '#agent-shared/inflightSlotStore'
import { normalizeQueueTenantId } from '#agent-shared/jobQueueKeys'

let inflightRuns = 0
const inflightByExpert = new Map<string, number>()
const inflightByTenant = new Map<string, number>()
let admissionState: TenantQueueState = createEmptyFairQueueState()
let slotStore: InflightCounterStore = createMemoryCounterStore()
let useRedisSlots = false
let redisStorePromise: Promise<InflightCounterStore | null> | null = null

/** 等待中的准入唤醒器 */
type Waiter = {
  ticketId: string
  tenantId: string
  resolve: (ok: boolean) => void
  onQueued?: (info: { position: number; queueDepth: number }) => void
}
const waiters = new Map<string, Waiter>()
let drainTimer: ReturnType<typeof setInterval> | null = null

function readPositiveInt(envVal: string | undefined, fallback: number): number {
  const n = Number(envVal)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

function readNonNegInt(envVal: string | undefined, fallback: number): number {
  const n = Number(envVal)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.floor(n)
}

/** 0 = 不限 */
export function readMaxInflightRuns(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env.MANAGER_MAX_INFLIGHT_RUNS, 0)
}

export function readMaxInflightPerExpert(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env.MANAGER_MAX_INFLIGHT_PER_EXPERT, 0)
}

export function readMaxInflightPerTenant(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env.MANAGER_MAX_INFLIGHT_PER_TENANT, 0)
}

export function readAdmissionQueueMax(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env.MANAGER_ADMISSION_QUEUE_MAX, 0)
}

export function readAdmissionWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegInt(env.MANAGER_ADMISSION_WAIT_MS, 120_000)
}

export type BackpressureSnapshot = {
  inflightRuns: number
  /** 等待准入的票数（与 inflight 分开） */
  queueDepth: number
  inflightByExpert: Record<string, number>
  inflightByTenant: Record<string, number>
}

export function getBackpressureSnapshot(): BackpressureSnapshot {
  const byExpert: Record<string, number> = {}
  for (const [k, v] of inflightByExpert.entries()) {
    if (v > 0) byExpert[k] = v
  }
  const byTenant: Record<string, number> = {}
  for (const [k, v] of inflightByTenant.entries()) {
    if (v > 0) byTenant[k] = v
  }
  return {
    inflightRuns,
    queueDepth: fairQueueDepth(admissionState),
    inflightByExpert: byExpert,
    inflightByTenant: byTenant
  }
}

export type AcquireResult = { ok: true } | { ok: false; reason: string }

function limitsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    maxGlobal: readMaxInflightRuns(env),
    maxPerTenant: readMaxInflightPerTenant(env)
  }
}

function noteLocalAcquire(tenantId: string) {
  const t = normalizeQueueTenantId(tenantId)
  inflightRuns += 1
  inflightByTenant.set(t, (inflightByTenant.get(t) || 0) + 1)
  noteInflightAcquire(admissionState, t)
}

function noteLocalRelease(tenantId: string) {
  const t = normalizeQueueTenantId(tenantId)
  inflightRuns = Math.max(0, inflightRuns - 1)
  const next = Math.max(0, (inflightByTenant.get(t) || 0) - 1)
  if (next <= 0) inflightByTenant.delete(t)
  else inflightByTenant.set(t, next)
  noteInflightRelease(admissionState, t)
}

async function ensureSlotStore(env: NodeJS.ProcessEnv = process.env): Promise<InflightCounterStore> {
  const url = String(env.REDIS_URL || env.MANAGER_REDIS_URL || '').trim()
  if (!url) {
    useRedisSlots = false
    return slotStore
  }
  if (!redisStorePromise) {
    redisStorePromise = (async () => {
      try {
        const { createClient } = (await import('redis')) as typeof import('redis')
        const client = createClient({ url })
        client.on('error', () => {})
        await client.connect()
        useRedisSlots = true
        return {
          async get(key: string) {
            const v = await client.get(key)
            return Number(v || 0) || 0
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
        } satisfies InflightCounterStore
      } catch {
        useRedisSlots = false
        return null
      }
    })()
  }
  const redis = await redisStorePromise
  if (redis) {
    slotStore = redis
    return redis
  }
  return slotStore
}

/**
 * 立即占用（无排队）。兼容旧 smoke / 同步调用。
 * 未传 tenantId 时按 default 计租户槽。
 */
export function tryAcquireRunSlot(
  env: NodeJS.ProcessEnv = process.env,
  tenantId = 'default'
): AcquireResult {
  const max = readMaxInflightRuns(env)
  const maxTenant = readMaxInflightPerTenant(env)
  const t = normalizeQueueTenantId(tenantId)
  if (max > 0 && inflightRuns >= max) {
    return {
      ok: false,
      reason: `并发 run 已达上限（${inflightRuns}/${max}），请稍后重试`
    }
  }
  const curT = inflightByTenant.get(t) || 0
  if (maxTenant > 0 && curT >= maxTenant) {
    return {
      ok: false,
      reason: `租户并发已达上限（${curT}/${maxTenant}）`
    }
  }
  noteLocalAcquire(t)
  return { ok: true }
}

/**
 * 异步占用：优先 Redis 分布式槽；失败回落内存（单副本 / 无 REDIS_URL）。
 */
export async function tryAcquireRunSlotAsync(
  env: NodeJS.ProcessEnv = process.env,
  tenantId = 'default'
): Promise<AcquireResult> {
  const t = normalizeQueueTenantId(tenantId)
  const store = await ensureSlotStore(env)
  if (useRedisSlots) {
    const r = await tryAcquireInflightSlots(store, 'manager', t, limitsFromEnv(env))
    if (!r.ok) return { ok: false, reason: r.reason }
    noteLocalAcquire(t)
    return { ok: true }
  }
  return tryAcquireRunSlot(env, t)
}

/** @deprecated 用 releaseRunSlotForTenant；保留无参以兼容 finally */
export function releaseRunSlot(): void {
  releaseRunSlotForTenant('default')
}

export function releaseRunSlotForTenant(tenantId: string): void {
  const t = normalizeQueueTenantId(tenantId)
  if (inflightRuns <= 0 && !inflightByTenant.has(t)) {
    wakeAdmissionDrain()
    return
  }
  noteLocalRelease(t)
  void ensureSlotStore().then(async (store) => {
    if (useRedisSlots) await releaseInflightSlots(store, 'manager', t)
  })
  wakeAdmissionDrain()
}

export function checkExpertInflight(agent: string, env: NodeJS.ProcessEnv = process.env): AcquireResult {
  const a = String(agent || '').trim()
  if (!a) return { ok: true }
  const max = readMaxInflightPerExpert(env)
  if (max <= 0) return { ok: true }
  const cur = inflightByExpert.get(a) || 0
  if (cur >= max) {
    return {
      ok: false,
      reason: `专家 ${a} 并发已达上限（${cur}/${max}）`
    }
  }
  return { ok: true }
}

export function acquireExpertInflight(agent: string): void {
  const a = String(agent || '').trim()
  if (!a) return
  inflightByExpert.set(a, (inflightByExpert.get(a) || 0) + 1)
}

export function releaseExpertInflight(agent: string): void {
  const a = String(agent || '').trim()
  if (!a) return
  const next = Math.max(0, (inflightByExpert.get(a) || 0) - 1)
  if (next <= 0) inflightByExpert.delete(a)
  else inflightByExpert.set(a, next)
}

/**
 * 专家槽：短等后仍满则失败（rag 优先排队而非立刻 skip）。
 */
export async function acquireExpertInflightWithWait(
  agent: string,
  opts?: { waitMs?: number; pollMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
): Promise<AcquireResult> {
  const env = opts?.env || process.env
  const a = String(agent || '').trim()
  if (!a) return { ok: true }
  const waitMs = Math.max(0, opts?.waitMs ?? (a === 'rag' || a === 'gui' ? 15_000 : 0))
  const pollMs = Math.max(50, opts?.pollMs ?? 200)
  const deadline = Date.now() + waitMs
  for (;;) {
    if (opts?.signal?.aborted) return { ok: false, reason: 'canceled' }
    const check = checkExpertInflight(a, env)
    if (check.ok) {
      acquireExpertInflight(a)
      return { ok: true }
    }
    if (Date.now() >= deadline) return check
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

export type AdmissionAcquireOk = {
  ok: true
  ticketId: string
  waitedMs: number
  queued: boolean
}

export type AdmissionAcquireFail = {
  ok: false
  reason: string
  error_code: 'overloaded' | 'queue_full' | 'admission_timeout' | 'canceled'
}

/**
 * 准入：有槽立即占用；否则按租户公平排队，直到超时 / 取消。
 */
export async function acquireRunSlotWithAdmission(input: {
  tenantId?: string
  runId: string
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  onQueued?: (info: { position: number; queueDepth: number; etaMs?: number }) => void
}): Promise<AdmissionAcquireOk | AdmissionAcquireFail> {
  const env = input.env || process.env
  const tenantId = normalizeQueueTenantId(input.tenantId)
  const started = Date.now()
  const waitMs = readAdmissionWaitMs(env)
  const maxQ = readAdmissionQueueMax(env)

  // 快速路径（Redis 优先）
  const immediate = await tryAcquireRunSlotAsync(env, tenantId)
  if (immediate.ok) {
    return { ok: true, ticketId: input.runId, waitedMs: 0, queued: false }
  }

  if (waitMs <= 0) {
    return { ok: false, reason: immediate.reason, error_code: 'overloaded' }
  }

  const ticket: FairQueueTicket = {
    id: input.runId,
    job_id: input.runId,
    run_id: input.runId,
    tenant_id: tenantId,
    kind: 'manager_admission',
    enqueued_at: Date.now()
  }
  const enq = enqueueFairTicket(admissionState, ticket, { maxQueueSize: maxQ || 0 })
  if (!enq.ok) {
    return { ok: false, reason: enq.reason, error_code: 'queue_full' }
  }

  const limits = limitsFromEnv(env)
  const position = estimateFairPosition(admissionState, input.runId, limits) || enq.position
  input.onQueued?.({
    position,
    queueDepth: fairQueueDepth(admissionState),
    etaMs: position * 5_000
  })

  return await new Promise<AdmissionAcquireOk | AdmissionAcquireFail>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (result: AdmissionAcquireOk | AdmissionAcquireFail) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      waiters.delete(input.runId)
      if (input.signal) input.signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const waiter: Waiter = {
      ticketId: input.runId,
      tenantId,
      onQueued: input.onQueued,
      resolve: (ok) => {
        if (!ok) {
          cancelFairTicket(admissionState, input.runId)
          finish({
            ok: false,
            reason: input.signal?.aborted ? '任务已取消' : `准入等待超时（${waitMs}ms）`,
            error_code: input.signal?.aborted ? 'canceled' : 'admission_timeout'
          })
          return
        }
        finish({
          ok: true,
          ticketId: input.runId,
          waitedMs: Date.now() - started,
          queued: true
        })
      }
    }
    waiters.set(input.runId, waiter)

    const onAbort = () => {
      cancelFairTicket(admissionState, input.runId)
      waiters.delete(input.runId)
      finish({ ok: false, reason: '任务已取消', error_code: 'canceled' })
    }
    if (input.signal) {
      if (input.signal.aborted) {
        onAbort()
        return
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      cancelFairTicket(admissionState, input.runId)
      const w = waiters.get(input.runId)
      if (w) w.resolve(false)
      else
        finish({
          ok: false,
          reason: `准入等待超时（${waitMs}ms）`,
          error_code: 'admission_timeout'
        })
    }, waitMs)

    ensureDrainLoop()
    void tryPromoteWaiters(env)
  })
}

function ensureDrainLoop() {
  if (drainTimer) return
  drainTimer = setInterval(() => {
    void tryPromoteWaiters(process.env)
  }, 150)
}

function wakeAdmissionDrain() {
  void tryPromoteWaiters(process.env)
}

async function tryPromoteWaiters(env: NodeJS.ProcessEnv) {
  const limits = limitsFromEnv(env)
  // 同步 admissionState.inflight 与本地 inflight（内存路径）
  admissionState.globalInflight = inflightRuns
  admissionState.inflightByTenant = new Map(inflightByTenant)

  for (;;) {
    const pick = pickNextFairTenant(admissionState, limits)
    if (!pick.ok) break
    const waiter = waiters.get(pick.ticket.id)
    if (!waiter) {
      dequeueFairTicket(admissionState, pick.tenantId)
      continue
    }
    const got = await tryAcquireRunSlotAsync(env, pick.tenantId)
    if (!got.ok) break
    dequeueFairTicket(admissionState, pick.tenantId)
    waiters.delete(pick.ticket.id)
    waiter.resolve(true)
  }

  // 更新仍在排队的 position
  for (const w of waiters.values()) {
    const pos = estimateFairPosition(admissionState, w.ticketId, limits)
    if (pos > 0) w.onQueued?.({ position: pos, queueDepth: fairQueueDepth(admissionState) })
  }

  if (!waiters.size && drainTimer) {
    clearInterval(drainTimer)
    drainTimer = null
  }
}

/** 取消排队中的票（新 chat / cancel） */
export function cancelAdmissionTicket(ticketId: string): boolean {
  const w = waiters.get(ticketId)
  if (w) {
    waiters.delete(ticketId)
    cancelFairTicket(admissionState, ticketId)
    w.resolve(false)
    return true
  }
  return cancelFairTicket(admissionState, ticketId)
}

/** smoke：重置计数（仅测试） */
export function resetBackpressureForTests(): void {
  inflightRuns = 0
  inflightByExpert.clear()
  inflightByTenant.clear()
  admissionState = createEmptyFairQueueState()
  slotStore = createMemoryCounterStore()
  useRedisSlots = false
  redisStorePromise = null
  for (const w of waiters.values()) w.resolve(false)
  waiters.clear()
  if (drainTimer) {
    clearInterval(drainTimer)
    drainTimer = null
  }
}
