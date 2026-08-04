import fs from 'node:fs/promises'
import path from 'node:path'
import { agentPgQuery } from '#agent-shared/agentPgClient'
import { readHistoryEntries } from '../shared'
import { evaluateShadowPromotion } from './autoEvolution'
import type { FailureInsightBundle } from './failureInsights'
import { loadExperiments } from './evolutionExperiments'

export type GovernanceSnapshot = {
  updatedAt: string
  policyVersion?: number
  activeSamples: number
  failureConcentration: number
  canPromote: boolean
  confidence: number
  reasons: string[]
  recommendedActions: string[]
  /** 门 1：学习准入拒绝率 */
  learnRejectRate?: number | null
  learnRejectCount?: number
  learnSignalCount?: number
  /** 实验胜率 / 回滚率 */
  experimentPromoteRate?: number | null
  experimentRollbackRate?: number | null
  experimentDiscardRate?: number | null
  experimentClosedCount?: number
  /** 全局候选通过率 */
  globalCandidatePassRate?: number | null
  globalCandidateApproved?: number
  globalCandidateTotal?: number
}

function avg(nums: number[]) {
  if (!nums.length) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function rate(num: number, den: number): number | null {
  if (!den) return null
  return Math.round((num / den) * 1000) / 1000
}

async function readLearnEligibilityStats(policyDir: string) {
  const auditPath = path.join(policyDir, 'manager-learn-eligibility.jsonl')
  const signalPath = path.join(policyDir, 'manager-learning-signals.jsonl')
  const auditRaw = await fs.readFile(auditPath, 'utf8').catch(() => '')
  const signalRaw = await fs.readFile(signalPath, 'utf8').catch(() => '')
  const rejectCount = auditRaw.trim()
    ? auditRaw.split('\n').filter((l) => l.trim()).slice(-500).length
    : 0
  let signalCount = 0
  let ineligibleOnSignal = 0
  if (signalRaw.trim()) {
    for (const line of signalRaw.split('\n').filter((l) => l.trim()).slice(-500)) {
      try {
        const o = JSON.parse(line)
        signalCount += 1
        if (o?.learnEligible === false) ineligibleOnSignal += 1
      } catch {
        /* skip */
      }
    }
  }
  const rejectTotal = Math.max(rejectCount, ineligibleOnSignal)
  return {
    learnRejectCount: rejectTotal,
    learnSignalCount: signalCount,
    learnRejectRate: rate(rejectTotal, Math.max(signalCount, rejectTotal))
  }
}

async function readExperimentRates(policyDir: string) {
  const experiments = await loadExperiments(policyDir).catch(() => [])
  const closed = experiments.filter((e) =>
    ['promoted', 'rolled_back', 'rejected', 'insufficient_data'].includes(e.status)
  )
  const promoted = closed.filter((e) => e.status === 'promoted').length
  const rolled = closed.filter((e) => e.status === 'rolled_back').length
  const discarded = closed.filter((e) => e.status === 'rejected').length
  return {
    experimentClosedCount: closed.length,
    experimentPromoteRate: rate(promoted, closed.length),
    experimentRollbackRate: rate(rolled, closed.length),
    experimentDiscardRate: rate(discarded, closed.length)
  }
}

async function readGlobalCandidatePassRate() {
  const res = await agentPgQuery<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM evo_global_candidates
     WHERE status IN ('approved', 'rejected', 'pending')
     GROUP BY status`,
    []
  ).catch(() => null)
  let approved = 0
  let rejected = 0
  let pending = 0
  for (const row of res?.rows ?? []) {
    const n = Number(row.n) || 0
    if (row.status === 'approved') approved = n
    else if (row.status === 'rejected') rejected = n
    else if (row.status === 'pending') pending = n
  }
  const decided = approved + rejected
  return {
    globalCandidateApproved: approved,
    globalCandidateTotal: decided + pending,
    globalCandidatePassRate: rate(approved, decided)
  }
}

export async function buildGovernanceSnapshot(policyDir: string, insights: FailureInsightBundle): Promise<GovernanceSnapshot> {
  const jsonl = path.join(policyDir, 'manager-nlu-metrics.jsonl')
  const json = path.join(policyDir, 'manager-nlu-metrics.json')
  const metrics = await readHistoryEntries(jsonl, json, 260)
  const finals = metrics.map((m) => Number(m?.finalConfidence)).filter((x) => Number.isFinite(x))
  const route = metrics.map((m) => Number(m?.routeConfidence)).filter((x) => Number.isFinite(x))
  const activeSamples = metrics.length
  const failureConcentration = insights.failures.length
    ? Math.max(...insights.failures.map((f) => f.count)) / Math.max(1, insights.samples)
    : 0
  const evalResult = evaluateShadowPromotion(insights, {
    recentSamples: activeSamples,
    baselineSampleCount: finals.length,
    failureConcentration
  })
  const learn = await readLearnEligibilityStats(policyDir)
  const exp = await readExperimentRates(policyDir)
  const global = await readGlobalCandidatePassRate()

  const recommendedActions = [] as string[]
  if (avg(finals) < 0.68) recommendedActions.push('prioritize_synth_and_verifier')
  if (avg(route) < 0.62) recommendedActions.push('prioritize_router_recall')
  if (failureConcentration > 0.4) recommendedActions.push('focus_top_failure_cluster')
  if (evalResult.eligible) recommendedActions.push('shadow_candidate_can_promote')
  if ((learn.learnRejectRate ?? 0) > 0.55) recommendedActions.push('high_noise_traffic_gate_holding')
  if ((exp.experimentRollbackRate ?? 0) > 0.35) recommendedActions.push('review_shadow_quality')
  if ((exp.experimentPromoteRate ?? 0) > 0 && (exp.experimentRollbackRate ?? 0) < 0.2) {
    recommendedActions.push('evolution_net_positive')
  }

  return {
    updatedAt: new Date().toISOString(),
    activeSamples,
    failureConcentration,
    canPromote: evalResult.eligible,
    confidence: evalResult.confidence,
    reasons: evalResult.reasons,
    recommendedActions,
    ...learn,
    ...exp,
    ...global
  }
}

export async function writeGovernanceSnapshot(policyDir: string, snapshot: GovernanceSnapshot) {
  const p = path.join(policyDir, 'manager-governance.json')
  await fs.mkdir(policyDir, { recursive: true }).catch(() => undefined)
  await fs.writeFile(p, JSON.stringify(snapshot, null, 2), 'utf8')
}
