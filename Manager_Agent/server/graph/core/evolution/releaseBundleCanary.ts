/**
 * W2：制品 sticky canary — policy/prompt/planner 共用同一会话抽桶。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { sessionInCanaryBucket } from './artifactCanary'

export function isStickyCanaryBundleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_STICKY_CANARY_BUNDLE ?? '1').trim() !== '0'
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(100, Math.floor(n))
}

export function releaseBundleCanaryPercent(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = env.MANAGER_RELEASE_BUNDLE_CANARY_PERCENT
  if (explicit != null && String(explicit).trim() !== '') {
    return clampPercent(Number(explicit))
  }
  return clampPercent(Number(env.MANAGER_POLICY_CANARY_PERCENT ?? 5))
}

async function fileFingerprint(fp: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(fp, 'utf8')
    if (!raw.trim()) return null
    return createHash('sha256').update(raw).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

/** 当前待测 shadow 集合指纹；无任何 shadow 时返回 null（不进 canary） */
export async function computeReleaseBundleId(policyDir: string): Promise<string | null> {
  const dir = String(policyDir || '').trim()
  if (!dir) return null
  const parts = await Promise.all([
    fileFingerprint(path.join(dir, 'manager-policy.shadow.json')),
    fileFingerprint(path.join(dir, 'manager-prompt-patches.shadow.json')),
    fileFingerprint(path.join(dir, 'manager-planner-rules.shadow.json')),
  ])
  const present = parts.filter(Boolean) as string[]
  if (!present.length) return null
  return createHash('sha256').update(present.join('|')).digest('hex').slice(0, 24)
}

export type BundleCanaryDecision = {
  bundleId: string | null
  inCanary: boolean
  percent: number
  sticky: boolean
}

/**
 * 一次抽桶：同 session + 同 bundleId → policy/prompt/planner 一致。
 */
export async function resolveBundleCanaryDecision(
  policyDir: string,
  sessionId: string | undefined,
  opts?: { suppressCanary?: boolean; env?: NodeJS.ProcessEnv }
): Promise<BundleCanaryDecision> {
  const env = opts?.env ?? process.env
  const sticky = isStickyCanaryBundleEnabled(env)
  const percent = releaseBundleCanaryPercent(env)
  const bundleId = await computeReleaseBundleId(policyDir)
  if (opts?.suppressCanary || !bundleId || percent <= 0) {
    return { bundleId, inCanary: false, percent, sticky }
  }
  if (!sticky) {
    // 非 sticky：调用方回退到分盐逻辑；此处仍给出 bundle 决策供对齐测试
    const inCanary = sessionInCanaryBucket(sessionId, `release-bundle-canary|${bundleId}`, percent)
    return { bundleId, inCanary, percent, sticky }
  }
  const inCanary = sessionInCanaryBucket(sessionId, `release-bundle-canary|${bundleId}`, percent)
  return { bundleId, inCanary, percent, sticky }
}

/** 导出供 smoke：同 salt 三次结果一致 */
export function stickyBucketForSession(sessionId: string, bundleId: string, percent: number): boolean {
  return sessionInCanaryBucket(sessionId, `release-bundle-canary|${bundleId}`, percent)
}
