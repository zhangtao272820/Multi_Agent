import { createHash } from 'node:crypto'
import type { ManagerPolicy } from '../shared'
import { loadManagerPolicy, loadManagerPolicyShadow } from '../shared'
import { isStickyCanaryBundleEnabled, resolveBundleCanaryDecision } from './releaseBundleCanary'

export function policyCanaryPercent(): number {
  const n = Number(process.env.MANAGER_POLICY_CANARY_PERCENT ?? 5)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(100, Math.floor(n))
}

export function isPolicyCanaryEnabled() {
  return policyCanaryPercent() > 0
}

/** 按 sessionId 稳定分桶，决定本请求是否使用 shadow 策略（非 sticky 时） */
export function sessionUsesPolicyCanary(sessionId: string | undefined, percent = policyCanaryPercent()): boolean {
  const sid = String(sessionId || '').trim()
  if (!sid || percent <= 0) return false
  if (percent >= 100) return true
  const h = createHash('sha256').update(`policy-canary|${sid}`).digest()
  const bucket = h.readUInt32BE(0) % 100
  return bucket < percent
}

export type ResolvedPolicy = {
  policy: ManagerPolicy
  source: 'active' | 'shadow_canary'
  canary: boolean
  bundleId?: string | null
  bundleCanary?: boolean
}

/**
 * 加载生效策略：默认 active；开启金丝雀且 session 命中时使用 shadow（不存在则回退 active）。
 * sticky bundle 开启时与 prompt/planner 共用抽桶。
 */
export async function resolveEffectiveManagerPolicy(
  dir: string,
  sessionId?: string,
  opts?: { suppressCanary?: boolean }
): Promise<ResolvedPolicy> {
  const active = await loadManagerPolicy(dir)
  const sticky = isStickyCanaryBundleEnabled()
  let inBucket = false
  let bundleId: string | null = null
  let bundleCanary = false
  if (sticky) {
    const d = await resolveBundleCanaryDecision(dir, sessionId, { suppressCanary: opts?.suppressCanary })
    bundleId = d.bundleId
    bundleCanary = d.inCanary
    inBucket = d.inCanary
  } else {
    inBucket = !opts?.suppressCanary && sessionUsesPolicyCanary(sessionId)
  }
  if (opts?.suppressCanary || !inBucket) {
    return { policy: active, source: 'active', canary: false, bundleId, bundleCanary: false }
  }
  const shadow = await loadManagerPolicyShadow(dir)
  if (!shadow) {
    return { policy: active, source: 'active', canary: false, bundleId, bundleCanary: false }
  }
  return { policy: shadow, source: 'shadow_canary', canary: true, bundleId, bundleCanary }
}
