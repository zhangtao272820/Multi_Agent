/**
 * G2：Manager run / 专家 inflight 背压（非 K8s HPA；LAN 过载可拒）。
 */

let inflightRuns = 0
const inflightByExpert = new Map<string, number>()

function readPositiveInt(envVal: string | undefined, fallback: number): number {
  const n = Number(envVal)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

/** 0 = 不限 */
export function readMaxInflightRuns(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env.MANAGER_MAX_INFLIGHT_RUNS, 0)
}

export function readMaxInflightPerExpert(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env.MANAGER_MAX_INFLIGHT_PER_EXPERT, 0)
}

export type BackpressureSnapshot = {
  inflightRuns: number
  queueDepth: number
  inflightByExpert: Record<string, number>
}

export function getBackpressureSnapshot(): BackpressureSnapshot {
  const byExpert: Record<string, number> = {}
  for (const [k, v] of inflightByExpert.entries()) {
    if (v > 0) byExpert[k] = v
  }
  return {
    inflightRuns,
    queueDepth: inflightRuns,
    inflightByExpert: byExpert
  }
}

export type AcquireResult = { ok: true } | { ok: false; reason: string }

export function tryAcquireRunSlot(env: NodeJS.ProcessEnv = process.env): AcquireResult {
  const max = readMaxInflightRuns(env)
  if (max <= 0) {
    inflightRuns += 1
    return { ok: true }
  }
  if (inflightRuns >= max) {
    return {
      ok: false,
      reason: `并发 run 已达上限（${inflightRuns}/${max}），请稍后重试`
    }
  }
  inflightRuns += 1
  return { ok: true }
}

export function releaseRunSlot(): void {
  inflightRuns = Math.max(0, inflightRuns - 1)
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

/** smoke：重置计数（仅测试） */
export function resetBackpressureForTests(): void {
  inflightRuns = 0
  inflightByExpert.clear()
}
