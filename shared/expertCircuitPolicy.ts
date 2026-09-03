/**
 * P0-2：跨专家熔断状态机 + 分级降级 + 滑动窗口限流（纯函数 / 可测契约）。
 * 语义判断不在此；仅策略状态转移与闸门。
 */

export type CircuitState = 'closed' | 'open' | 'half_open'

export type CircuitSnapshot = {
  state: CircuitState
  failures: number
  successes: number
  openedAtMs: number
  halfOpenProbes: number
  /** 窗口起点（closed 计数） */
  windowStartedAtMs: number
}

export type CircuitConfig = {
  /** 失败率统计窗口 */
  windowMs: number
  /** 开路失败率阈值 0..1 */
  failureRateThreshold: number
  /** 窗口内最少样本 */
  minSamples: number
  /** OPEN 冷却后进入 HALF_OPEN */
  openMs: number
  halfOpenMaxProbes: number
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitConfig = {
  windowMs: 60_000,
  failureRateThreshold: 0.5,
  minSamples: 4,
  openMs: 30_000,
  halfOpenMaxProbes: 1
}

export function createCircuitSnapshot(nowMs = Date.now()): CircuitSnapshot {
  return {
    state: 'closed',
    failures: 0,
    successes: 0,
    openedAtMs: 0,
    halfOpenProbes: 0,
    windowStartedAtMs: nowMs
  }
}

function resetWindow(s: CircuitSnapshot, nowMs: number): CircuitSnapshot {
  return {
    ...s,
    failures: 0,
    successes: 0,
    windowStartedAtMs: nowMs,
    halfOpenProbes: 0
  }
}

function failureRate(s: CircuitSnapshot): number {
  const n = s.failures + s.successes
  if (n <= 0) return 0
  return s.failures / n
}

/** 是否允许发起调用（OPEN 拒绝；HALF_OPEN 限探活） */
export function circuitAllowsCall(s: CircuitSnapshot, nowMs: number, cfg: CircuitConfig = DEFAULT_CIRCUIT_CONFIG): boolean {
  if (s.state === 'closed') return true
  if (s.state === 'open') {
    if (nowMs - s.openedAtMs >= cfg.openMs) return true // 调用方应先 transition 到 half_open
    return false
  }
  return s.halfOpenProbes < cfg.halfOpenMaxProbes
}

/**
 * 状态转移。调用方在允许探活时应先记一次 probe（half_open）。
 */
export function nextCircuitState(
  prev: CircuitSnapshot,
  event: 'success' | 'failure' | 'tick',
  nowMs: number,
  cfg: CircuitConfig = DEFAULT_CIRCUIT_CONFIG
): CircuitSnapshot {
  let s = { ...prev }

  if (s.state === 'open') {
    if (nowMs - s.openedAtMs >= cfg.openMs) {
      s = {
        ...resetWindow(s, nowMs),
        state: 'half_open',
        openedAtMs: s.openedAtMs,
        halfOpenProbes: 0
      }
    } else if (event === 'tick') {
      return s
    } else {
      return s
    }
  }

  if (s.state === 'half_open') {
    if (event === 'tick') return s
    if (event === 'success') {
      return { ...resetWindow(s, nowMs), state: 'closed', openedAtMs: 0 }
    }
    if (event === 'failure') {
      return {
        ...s,
        state: 'open',
        openedAtMs: nowMs,
        failures: s.failures + 1,
        halfOpenProbes: s.halfOpenProbes + 1
      }
    }
  }

  // closed
  if (nowMs - s.windowStartedAtMs > cfg.windowMs) {
    s = resetWindow(s, nowMs)
  }
  if (event === 'success') {
    s = { ...s, successes: s.successes + 1 }
  } else if (event === 'failure') {
    s = { ...s, failures: s.failures + 1 }
  } else {
    return s
  }

  const samples = s.failures + s.successes
  if (samples >= cfg.minSamples && failureRate(s) >= cfg.failureRateThreshold) {
    return {
      ...s,
      state: 'open',
      openedAtMs: nowMs,
      halfOpenProbes: 0
    }
  }
  return s
}

/** 探活前占用 HALF_OPEN probe 配额 */
export function beginHalfOpenProbe(s: CircuitSnapshot, nowMs: number, cfg: CircuitConfig = DEFAULT_CIRCUIT_CONFIG): CircuitSnapshot {
  let cur = s
  if (cur.state === 'open' && nowMs - cur.openedAtMs >= cfg.openMs) {
    cur = { ...resetWindow(cur, nowMs), state: 'half_open', openedAtMs: cur.openedAtMs, halfOpenProbes: 0 }
  }
  if (cur.state !== 'half_open') return cur
  return { ...cur, halfOpenProbes: cur.halfOpenProbes + 1 }
}

/** L0 正常 … L3 仅澄清/排队（禁全部专家） */
export type ServiceDegradeLevel = 0 | 1 | 2 | 3

const WRITEISH_AGENTS = new Set(['admin', 'gui'])
const HEAVY_AGENTS = new Set(['crawler', 'gui', 'music', 'video', 'multimodal'])
const CORE_AGENTS = new Set(['db', 'rag', 'code', 'admin'])

export function clampDegradeLevel(raw: unknown): ServiceDegradeLevel {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(3, Math.floor(n))) as ServiceDegradeLevel
}

export function resolveServiceDegradeLevel(input: {
  openAgents?: Iterable<string>
  explicitLevel?: unknown
  overload?: boolean
}): ServiceDegradeLevel {
  if (input.explicitLevel !== undefined && input.explicitLevel !== null && String(input.explicitLevel).trim() !== '') {
    return clampDegradeLevel(input.explicitLevel)
  }
  if (input.overload) return 3
  const open = [...(input.openAgents || [])].map((a) => String(a || '').trim()).filter(Boolean)
  const coreOpen = open.filter((a) => CORE_AGENTS.has(a)).length
  const heavyOpen = open.filter((a) => HEAVY_AGENTS.has(a)).length
  if (coreOpen >= 2) return 2
  if (coreOpen >= 1) return 1
  if (heavyOpen >= 2) return 1
  return 0
}

export function isExpertAllowedAtDegradeLevel(agent: string, level: ServiceDegradeLevel): boolean {
  const a = String(agent || '').trim()
  if (!a) return true
  if (level <= 0) return true
  if (level >= 3) return false
  if (level >= 2 && HEAVY_AGENTS.has(a)) return false
  if (level >= 1 && WRITEISH_AGENTS.has(a)) return false
  return true
}

export type RateLimitBucket = {
  windowStartMs: number
  count: number
}

export type RateLimitResult = { ok: true; bucket: RateLimitBucket } | { ok: false; bucket: RateLimitBucket; reason: string }

/** 固定窗口计数限流；limit<=0 表示不限 */
export function tryConsumeRateLimit(
  bucket: RateLimitBucket | null | undefined,
  nowMs: number,
  limitPerWindow: number,
  windowMs: number
): RateLimitResult {
  if (!Number.isFinite(limitPerWindow) || limitPerWindow <= 0) {
    return { ok: true, bucket: { windowStartMs: nowMs, count: 0 } }
  }
  const win = Math.max(1_000, Math.floor(windowMs) || 60_000)
  let b = bucket && Number.isFinite(bucket.windowStartMs) ? { ...bucket } : { windowStartMs: nowMs, count: 0 }
  if (nowMs - b.windowStartMs >= win) {
    b = { windowStartMs: nowMs, count: 0 }
  }
  if (b.count >= limitPerWindow) {
    return {
      ok: false,
      bucket: b,
      reason: `请求过于频繁（${b.count}/${limitPerWindow}/${Math.round(win / 1000)}s），请稍后重试`
    }
  }
  return { ok: true, bucket: { ...b, count: b.count + 1 } }
}
