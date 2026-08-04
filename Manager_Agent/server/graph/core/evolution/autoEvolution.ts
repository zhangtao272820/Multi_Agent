import fs from 'node:fs/promises'
import path from 'node:path'
import { backupManagerPolicyFile, loadManagerPolicy, type ManagerPolicy, clampNumber } from '../shared'
import type { FailureInsightBundle } from './failureInsights'
import { syncEvoPolicyPromote, syncEvoPolicyShadowWrite } from './evoPolicySync'

export type EvolutionCandidate = {
  version: number
  rationale: string
  changes: Array<{ path: string; from: unknown; to: unknown; reason: string }>
  confidence: number
  source: 'shadow' | 'promoted'
}

export type ShadowEvaluation = {
  eligible: boolean
  confidence: number
  reasons: string[]
  requiredSamples: number
  recentSamples: number
}

function clonePolicy(p: ManagerPolicy): ManagerPolicy {
  return JSON.parse(JSON.stringify(p)) as ManagerPolicy
}

function apply(candidate: ManagerPolicy, pathKey: string, value: any) {
  const parts = pathKey.split('.')
  let cur: any = candidate
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]]
  cur[parts[parts.length - 1]] = value
}

function countActions(insights: FailureInsightBundle) {
  const out = new Map<string, number>()
  for (const b of insights.fixSuggestions || []) {
    for (const s of b.suggestions || []) {
      out.set(s.scope, (out.get(s.scope) || 0) + 1)
    }
  }
  return out
}

export function buildEvolutionCandidate(active: ManagerPolicy, insights: FailureInsightBundle): EvolutionCandidate | null {
  if (!insights?.fixSuggestions?.length) return null
  const next = clonePolicy(active)
  const changes: EvolutionCandidate['changes'] = []
  const top = insights.fixSuggestions.slice(0, 6).flatMap((b) => b.suggestions.slice(0, 2).map((s) => ({ bundle: b, suggestion: s })))

  for (const row of top) {
    const { category, severity, suggestion } = row.bundle
    const scope = suggestion.scope
    const priority = suggestion.priority
    const reason = `${category}/${severity}: ${suggestion.title}`
    if (scope === 'router') {
      const cur = next.routing.clarifyThresholdBase
      const delta = priority === 'high' ? 0.03 : 0.015
      const to = clampNumber(cur + delta, 0.5, 0.72)
      if (to !== cur) {
        changes.push({ path: 'routing.clarifyThresholdBase', from: cur, to, reason })
        apply(next, 'routing.clarifyThresholdBase', to)
      }
    }
    if (scope === 'planner') {
      const cur = next.routing.clarifyThresholdHinted
      const delta = priority === 'high' ? 0.02 : 0.01
      const to = clampNumber(cur + delta, 0.5, 0.72)
      if (to !== cur) {
        changes.push({ path: 'routing.clarifyThresholdHinted', from: cur, to, reason })
        apply(next, 'routing.clarifyThresholdHinted', to)
      }
      const mp = next.multi.maxParallel
      const toMp = priority === 'high' ? Math.max(2, mp - 1) : mp
      if (toMp !== mp) {
        changes.push({ path: 'multi.maxParallel', from: mp, to: toMp, reason })
        apply(next, 'multi.maxParallel', toMp)
      }
    }
    if (scope === 'execution') {
      const cur = next.multi.maxParallel
      const to = priority === 'high' ? Math.max(2, cur - 1) : cur
      if (to !== cur) {
        changes.push({ path: 'multi.maxParallel', from: cur, to, reason })
        apply(next, 'multi.maxParallel', to)
      }
      const c = next.critic.maxRetriesMulti
      const toRetries = priority === 'high' ? Math.min(2, c + 1) : c
      if (toRetries !== c) {
        changes.push({ path: 'critic.maxRetriesMulti', from: c, to: toRetries, reason })
        apply(next, 'critic.maxRetriesMulti', toRetries)
      }
    }
    if (scope === 'synthesizer') {
      const c = next.critic.maxRetriesSingle
      const to = priority === 'high' ? Math.min(2, c + 1) : c
      if (to !== c) {
        changes.push({ path: 'critic.maxRetriesSingle', from: c, to, reason })
        apply(next, 'critic.maxRetriesSingle', to)
      }
    }
    if (scope === 'verifier') {
      const cur = next.db.timeoutMsUnmatched
      const to = priority === 'high' ? Math.max(1500, Math.floor(cur * 0.85)) : cur
      if (to !== cur) {
        changes.push({ path: 'db.timeoutMsUnmatched', from: cur, to, reason })
        apply(next, 'db.timeoutMsUnmatched', to)
      }
    }
    if (scope === 'policy') {
      const cur = next.db.skipIfProbeUnmatched
      const to = true
      if (to !== cur) {
        changes.push({ path: 'db.skipIfProbeUnmatched', from: cur, to, reason })
        apply(next, 'db.skipIfProbeUnmatched', to)
      }
    }
    if (scope === 'memory') {
      const cur = next.multi.maxParallel
      const to = Math.max(2, cur)
      if (to !== cur) {
        changes.push({ path: 'multi.maxParallel', from: cur, to, reason })
        apply(next, 'multi.maxParallel', to)
      }
    }
  }

  if (!changes.length) return null
  const nextVersion = Number(active.version || 1) + 1
  next.version = nextVersion
  next.updatedAt = new Date().toISOString()
  const totalSeverity = insights.fixSuggestions.reduce((sum, b) => sum + (b.severity === 'high' ? 2 : b.severity === 'medium' ? 1 : 0.5), 0)
  const confidence = clampNumber(totalSeverity / Math.max(1, insights.fixSuggestions.length * 2), 0.2, 0.95)
  return { version: nextVersion, rationale: insights.strongestSignals.join(', '), changes, confidence, source: 'shadow' }
}

export function evaluateShadowPromotion(
  insights: FailureInsightBundle,
  metrics: { recentSamples: number; baselineSampleCount: number; failureConcentration: number }
): ShadowEvaluation {
  const requiredSamples = Math.max(12, Math.min(40, Math.round((insights.samples || 0) / 2) || 12))
  const reasons: string[] = []
  let confidence = 0.5
  if (metrics.recentSamples < requiredSamples) {
    reasons.push('insufficient_samples')
    confidence -= 0.15
  } else {
    confidence += 0.1
  }
  if (metrics.failureConcentration > 0.42) {
    reasons.push('failure_concentration_too_high')
    confidence -= 0.15
  } else {
    confidence += 0.08
  }
  if ((insights.fixSuggestions?.length || 0) > 0) confidence += 0.08
  const actionWeight = Array.from(countActions(insights).values()).reduce((a, b) => a + b, 0)
  confidence += clampNumber(actionWeight / 25, 0, 0.1)
  confidence = clampNumber(confidence, 0.05, 0.98)
  return { eligible: reasons.length === 0 && confidence >= 0.72, confidence, reasons, requiredSamples, recentSamples: metrics.recentSamples }
}

export async function maybeWriteManagerPolicyShadow(policyDir: string, insights: FailureInsightBundle) {
  const active = await loadManagerPolicy(policyDir)
  const candidate = buildEvolutionCandidate(active, insights)
  if (!candidate || !candidate.changes.length) return { written: false as const }
  const currentShadowPath = path.join(policyDir, 'manager-policy.shadow.json')
  const next = JSON.parse(JSON.stringify(active)) as ManagerPolicy
  for (const ch of candidate.changes) {
    const parts = ch.path.split('.')
    let cur: any = next
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]]
    cur[parts[parts.length - 1]] = ch.to
  }
  await fs.mkdir(policyDir, { recursive: true }).catch(() => undefined)
  await backupManagerPolicyFile(policyDir).catch(() => undefined)
  next.version = candidate.version
  next.updatedAt = new Date().toISOString()
  await fs.writeFile(currentShadowPath, JSON.stringify(next, null, 2), 'utf8')
  await syncEvoPolicyShadowWrite(policyDir, 'policy', next as unknown as Record<string, unknown>).catch(
    () => undefined
  )
  const auditPath = path.join(policyDir, 'manager-evolution-candidates.jsonl')
  await fs.appendFile(
    auditPath,
    `${JSON.stringify({ ts: new Date().toISOString(), version: candidate.version, rationale: candidate.rationale, confidence: candidate.confidence, changes: candidate.changes })}\n`,
    'utf8'
  ).catch(() => undefined)
  return { written: true as const, candidate }
}

export async function maybePromoteManagerPolicyShadow(policyDir: string, opts?: { minConfidence?: number }) {
  const shadowPath = path.join(policyDir, 'manager-policy.shadow.json')
  const raw = await fs.readFile(shadowPath, 'utf8').catch(() => '')
  if (!raw.trim()) return { promoted: false as const, reason: 'no_shadow' }
  let parsed: ManagerPolicy
  try {
    parsed = JSON.parse(raw) as ManagerPolicy
  } catch {
    return { promoted: false as const, reason: 'invalid_shadow' }
  }
  const active = await loadManagerPolicy(policyDir)
  if (Number(parsed.version || 0) <= Number(active.version || 0)) return { promoted: false as const, reason: 'not_newer' }
  const minConf = Number.isFinite(Number(opts?.minConfidence)) ? Number(opts?.minConfidence) : 0.72
  const auditPath = path.join(policyDir, 'manager-evolution-candidates.jsonl')
  const auditRaw = await fs.readFile(auditPath, 'utf8').catch(() => '')
  const lines = auditRaw.split('\n').filter((l) => l.trim()).slice(-20)
  const last = [...lines].reverse().map((l) => { try { return JSON.parse(l) } catch { return null } }).find(Boolean)
  const confidence = Number(last?.confidence ?? 0)
  if (!Number.isFinite(confidence) || confidence < minConf) return { promoted: false as const, reason: 'low_confidence' }
  await backupManagerPolicyFile(policyDir).catch(() => undefined)
  await fs.writeFile(path.join(policyDir, 'manager-policy.json'), JSON.stringify(parsed, null, 2), 'utf8')
  await syncEvoPolicyPromote(policyDir, 'policy', parsed as unknown as Record<string, unknown>, {
    verifyOk: true
  }).catch(() => undefined)
  return { promoted: true as const, fromVersion: Number(active.version || 0), toVersion: Number(parsed.version || 0), confidence }
}
