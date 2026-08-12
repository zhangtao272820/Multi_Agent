/**
 * Wave6 K3：进化 shadow 对照采样 — 镜像记录 candidate 决策，不改用户可见结果、不 auto promote。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export type EvolutionShadowSample = {
  ts: string
  runId?: string
  sessionId?: string
  bundleId?: string | null
  inCanary?: boolean
  activeDecision: Record<string, unknown>
  candidateDecision: Record<string, unknown>
  note?: string
}

export function isEvolutionShadowSampleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_EVOLUTION_SHADOW_SAMPLE ?? '1').trim() !== '0'
}

export function evolutionShadowSamplePercent(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MANAGER_EVOLUTION_SHADOW_SAMPLE_PERCENT ?? 5)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(100, Math.floor(n))
}

/** 确定性抽样：runId/session 哈希进桶 */
export function shouldSampleEvolutionShadow(
  key: string | undefined,
  percent: number,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!isEvolutionShadowSampleEnabled(env)) return false
  const pct = percent > 0 ? percent : evolutionShadowSamplePercent(env)
  if (pct <= 0) return false
  if (pct >= 100) return true
  const s = String(key || 'anon')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % 100 < pct
}

export async function appendEvolutionShadowSample(
  policyDir: string,
  sample: EvolutionShadowSample
): Promise<{ ok: boolean; path?: string }> {
  const dir = String(policyDir || '').trim()
  if (!dir) return { ok: false }
  const fp = path.join(dir, 'manager-evolution-shadow-samples.jsonl')
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
  const line = JSON.stringify({ ...sample, ts: sample.ts || new Date().toISOString() }) + '\n'
  await fs.appendFile(fp, line, 'utf8')
  return { ok: true, path: fp }
}

export async function listEvolutionShadowSamples(
  policyDir: string,
  limit = 20
): Promise<EvolutionShadowSample[]> {
  const fp = path.join(policyDir, 'manager-evolution-shadow-samples.jsonl')
  const raw = await fs.readFile(fp, 'utf8').catch(() => '')
  if (!raw.trim()) return []
  const lim = Math.max(1, Math.min(200, limit))
  const out: EvolutionShadowSample[] = []
  for (const line of raw.split('\n').filter(Boolean).slice(-lim)) {
    try {
      out.push(JSON.parse(line) as EvolutionShadowSample)
    } catch {
      /* skip */
    }
  }
  return out
}

/**
 * 记录一次对照：active = 用户可见；candidate = shadow 假设决策（不应用）。
 */
export async function recordEvolutionShadowSampleIfNeeded(input: {
  policyDir: string
  runId?: string
  sessionId?: string
  bundleId?: string | null
  inCanary?: boolean
  activeDecision: Record<string, unknown>
  candidateDecision: Record<string, unknown>
  env?: NodeJS.ProcessEnv
}): Promise<{ sampled: boolean }> {
  const env = input.env ?? process.env
  const key = input.runId || input.sessionId
  if (!shouldSampleEvolutionShadow(key, evolutionShadowSamplePercent(env), env)) {
    return { sampled: false }
  }
  await appendEvolutionShadowSample(input.policyDir, {
    ts: new Date().toISOString(),
    runId: input.runId,
    sessionId: input.sessionId,
    bundleId: input.bundleId,
    inCanary: input.inCanary,
    activeDecision: input.activeDecision,
    candidateDecision: input.candidateDecision,
    note: 'mirror_only_no_user_impact_no_auto_promote'
  })
  return { sampled: true }
}
