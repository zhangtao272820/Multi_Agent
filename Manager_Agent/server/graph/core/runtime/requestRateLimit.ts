/**
 * Manager 入口请求限流（固定窗口，按 tenant/peer key）。
 * MANAGER_REQUEST_RATE_PER_MIN<=0 时不限（LAN 默认）。
 */

import { tryConsumeRateLimit, type RateLimitBucket } from '#agent-shared/expertCircuitPolicy'

const buckets = new Map<string, RateLimitBucket>()
let rejectedTotal = 0

export function readRequestRatePerMin(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MANAGER_REQUEST_RATE_PER_MIN ?? 0)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(10_000, Math.floor(n))
}

export function tryAcquireRequestRate(input: {
  key: string
  nowMs?: number
  env?: NodeJS.ProcessEnv
}): { ok: true } | { ok: false; reason: string } {
  const env = input.env || process.env
  const limit = readRequestRatePerMin(env)
  if (limit <= 0) return { ok: true }
  const key = String(input.key || 'anon').trim().slice(0, 128) || 'anon'
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now()
  const prev = buckets.get(key)
  const result = tryConsumeRateLimit(prev, nowMs, limit, 60_000)
  buckets.set(key, result.bucket)
  if (!result.ok) {
    rejectedTotal += 1
    return { ok: false, reason: result.reason }
  }
  return { ok: true }
}

export function getRequestRateLimitSnapshot(): { rejectedTotal: number; activeKeys: number } {
  return { rejectedTotal, activeKeys: buckets.size }
}

/** smoke / 测试重置 */
export function resetRequestRateForTests(): void {
  buckets.clear()
  rejectedTotal = 0
}
