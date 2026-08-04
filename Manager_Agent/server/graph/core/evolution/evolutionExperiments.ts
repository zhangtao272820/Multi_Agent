import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { FailureInsightBundle } from './failureInsights'
import { maybeWriteManagerPolicyShadow, maybePromoteManagerPolicyShadow } from './autoEvolution'
import { maybeEvolvePromptPatches } from './promptEvolution'
import { maybeEvolvePlannerRules } from './plannerRuleEvolution'
import { promoteShadowPromptPatches } from './promptPatches'
import { promoteShadowPlannerRules } from './plannerRules'
import { maybeRollbackPolicyFromNluMetrics, recordPolicyRolloutBaseline } from './policyRollout'
import { restoreManagerPolicyFromPrevious } from '../shared'
import { readHistoryEntries } from '../shared'
import {
  filterInsightsForEvolution,
  isChitchatOrOffTopicIntent,
  isFailureCategoryEvolutionEligible
} from './learnEligibility'
import {
  discardEvoShadowArtifact,
  syncEvoPolicyRollback
} from './evoPolicySync'

export type EvolutionArtifact = 'policy' | 'prompt_patches' | 'planner_rules'
export type ExperimentStatus = 'hypothesis' | 'running' | 'promoted' | 'rolled_back' | 'rejected' | 'insufficient_data'

export type EvolutionHypothesis = {
  id: string
  createdAt: string
  category: string
  statement: string
  artifact: EvolutionArtifact
  expectedEffect: string
  confidence: number
  sourceSignals: string[]
}

export type ExperimentMetrics = {
  sampleCount: number
  avgFinalConfidence: number | null
  avgRouteConfidence: number | null
  firstPassRate: number | null
  avgCompositeScore?: number | null
  avgFeedbackScore?: number | null
}

export type IntentSliceVerdict = {
  intent: string
  lift: number
  controlN: number
  treatmentN: number
  regressing: boolean
}

export type EvolutionExperiment = {
  id: string
  hypothesisId: string
  artifact: EvolutionArtifact
  status: ExperimentStatus
  createdAt: string
  startedAt?: string
  closedAt?: string
  rationale: string
  baseline: ExperimentMetrics
  treatment: ExperimentMetrics
  verdict?: {
    winner: 'control' | 'treatment' | 'tie'
    liftFinalConfidence: number
    reason: string
    intentSlices?: IntentSliceVerdict[]
  }
}

const HYP_FILE = 'manager-evolution-hypotheses.jsonl'
const EXP_FILE = 'manager-evolution-experiments.jsonl'

function nowIso() {
  return new Date().toISOString()
}

function avg(nums: number[]) {
  if (!nums.length) return null
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000
}

function hashId(prefix: string, parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12)}`
}

function scopeToArtifact(scope: string): EvolutionArtifact {
  if (scope === 'router' || scope === 'policy' || scope === 'verifier') return 'policy'
  if (scope === 'planner' || scope === 'execution') return 'planner_rules'
  return 'prompt_patches'
}

export function isEvolutionAutoExperimentEnabled() {
  return String(process.env.MANAGER_EVOLUTION_AUTO_EXPERIMENT ?? '1').trim() !== '0'
}

function minSamplesPerArm() {
  const n = Number(process.env.MANAGER_EVOLUTION_MIN_SAMPLES ?? 8)
  return Number.isFinite(n) && n >= 4 ? Math.min(40, Math.floor(n)) : 8
}

function promoteLiftThreshold() {
  const n = Number(process.env.MANAGER_EVOLUTION_PROMOTE_LIFT ?? 0.03)
  return Number.isFinite(n) && n > 0.005 && n < 0.2 ? n : 0.03
}

function rollbackDropThreshold() {
  const n = Number(process.env.MANAGER_EVOLUTION_ROLLBACK_DROP ?? 0.06)
  return Number.isFinite(n) && n > 0.02 && n < 0.25 ? n : 0.06
}

async function readJsonlTail(filePath: string, maxLines = 200): Promise<any[]> {
  const raw = await fs.readFile(filePath, 'utf8').catch(() => '')
  if (!raw.trim()) return []
  const lines = raw.split('\n').filter((l) => l.trim()).slice(-Math.max(1, maxLines))
  const out: any[] = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}

async function appendJsonl(filePath: string, row: Record<string, unknown>) {
  await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => undefined)
  await fs.appendFile(filePath, `${JSON.stringify({ ts: nowIso(), ...row })}\n`, 'utf8')
}

export async function loadHypotheses(policyDir: string): Promise<EvolutionHypothesis[]> {
  const rows = await readJsonlTail(path.join(policyDir, HYP_FILE), 120)
  const out: EvolutionHypothesis[] = []
  for (const r of rows) {
    if (!r?.id || !r?.statement) continue
    out.push({
      id: String(r.id),
      createdAt: String(r.createdAt || r.ts || nowIso()),
      category: String(r.category || 'unknown'),
      statement: String(r.statement),
      artifact: (['policy', 'prompt_patches', 'planner_rules'].includes(String(r.artifact))
        ? r.artifact
        : 'prompt_patches') as EvolutionArtifact,
      expectedEffect: String(r.expectedEffect || ''),
      confidence: Number(r.confidence ?? 0.5),
      sourceSignals: Array.isArray(r.sourceSignals) ? r.sourceSignals.map(String).slice(0, 5) : []
    })
  }
  return out
}

export async function loadExperiments(policyDir: string): Promise<EvolutionExperiment[]> {
  const rows = await readJsonlTail(path.join(policyDir, EXP_FILE), 160)
  const byId = new Map<string, EvolutionExperiment>()
  for (const r of rows) {
    if (!r?.id) continue
    byId.set(String(r.id), {
      id: String(r.id),
      hypothesisId: String(r.hypothesisId || ''),
      artifact: (['policy', 'prompt_patches', 'planner_rules'].includes(String(r.artifact))
        ? r.artifact
        : 'policy') as EvolutionArtifact,
      status: (['hypothesis', 'running', 'promoted', 'rolled_back', 'rejected', 'insufficient_data'].includes(String(r.status))
        ? r.status
        : 'hypothesis') as ExperimentStatus,
      createdAt: String(r.createdAt || r.ts || nowIso()),
      startedAt: r.startedAt ? String(r.startedAt) : undefined,
      closedAt: r.closedAt ? String(r.closedAt) : undefined,
      rationale: String(r.rationale || ''),
      baseline: normalizeMetrics(r.baseline),
      treatment: normalizeMetrics(r.treatment),
      verdict: r.verdict
        ? {
            winner: r.verdict.winner === 'treatment' || r.verdict.winner === 'tie' ? r.verdict.winner : 'control',
            liftFinalConfidence: Number(r.verdict.liftFinalConfidence ?? 0),
            reason: String(r.verdict.reason || ''),
            intentSlices: Array.isArray(r.verdict.intentSlices)
              ? (r.verdict.intentSlices as IntentSliceVerdict[]).slice(0, 24)
              : undefined
          }
        : undefined
    })
  }
  return Array.from(byId.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

function normalizeMetrics(raw: unknown): ExperimentMetrics {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    sampleCount: Number(o.sampleCount ?? 0) || 0,
    avgFinalConfidence: o.avgFinalConfidence == null ? null : Number(o.avgFinalConfidence),
    avgRouteConfidence: o.avgRouteConfidence == null ? null : Number(o.avgRouteConfidence),
    firstPassRate: o.firstPassRate == null ? null : Number(o.firstPassRate)
  }
}

export function generateHypothesesFromInsights(insights: FailureInsightBundle): EvolutionHypothesis[] {
  const gated = filterInsightsForEvolution(insights)
  if (!gated.samples || !gated.fixSuggestions?.length) return []
  const samples = Math.max(1, Number(gated.samples) || 1)
  const out: EvolutionHypothesis[] = []
  const seen = new Set<string>()
  for (const bundle of gated.fixSuggestions.slice(0, 6)) {
    const conc =
      (gated.failures.find((f) => f.category === bundle.category)?.count || 0) / samples
    if (!isFailureCategoryEvolutionEligible(bundle.category, { clarifyConcentration: conc })) continue
    for (const s of bundle.suggestions.slice(0, 2)) {
      const artifact = scopeToArtifact(s.scope)
      const key = `${bundle.category}|${artifact}|${s.title}`
      if (seen.has(key)) continue
      seen.add(key)
      const failure = gated.failures.find((f) => f.category === bundle.category)
      const conf =
        0.45 +
        (s.priority === 'high' ? 0.18 : s.priority === 'medium' ? 0.1 : 0.04) +
        Math.min(0.15, (failure?.count || 0) / 20)
      out.push({
        id: hashId('hyp', [bundle.category, artifact, s.title]),
        createdAt: nowIso(),
        category: bundle.category,
        statement: `${s.title}：${s.action}`,
        artifact,
        expectedEffect: `降低 ${bundle.category} 类失败（当前约 ${failure?.count ?? '?'} 次）`,
        confidence: Math.min(0.92, Math.round(conf * 1000) / 1000),
        sourceSignals: failure?.topReasons?.slice(0, 3) || gated.strongestSignals.slice(0, 2)
      })
    }
  }
  return out.slice(0, 8)
}

export async function persistHypotheses(policyDir: string, hypotheses: EvolutionHypothesis[]) {
  const existing = await loadHypotheses(policyDir)
  const ids = new Set(existing.map((h) => h.id))
  let added = 0
  for (const h of hypotheses) {
    if (ids.has(h.id)) continue
    await appendJsonl(path.join(policyDir, HYP_FILE), h as unknown as Record<string, unknown>)
    added += 1
  }
  return added
}

function canaryFieldForArtifact(artifact: EvolutionArtifact): 'policyCanary' | 'promptCanary' | 'plannerRulesCanary' {
  if (artifact === 'policy') return 'policyCanary'
  if (artifact === 'planner_rules') return 'plannerRulesCanary'
  return 'promptCanary'
}

async function readNluMetrics(policyDir: string, sinceMs?: number) {
  const jsonl = path.join(policyDir, 'manager-nlu-metrics.jsonl')
  const json = path.join(policyDir, 'manager-nlu-metrics.json')
  const rows = await readHistoryEntries(jsonl, json, 1500)
  if (!sinceMs) return rows
  return rows.filter((r) => {
    const t = Date.parse(String(r?.ts || ''))
    return Number.isFinite(t) && t >= sinceMs
  })
}

async function readLearningSignals(policyDir: string, sinceMs?: number) {
  const p = path.join(policyDir, 'manager-learning-signals.jsonl')
  const raw = await fs.readFile(p, 'utf8').catch(() => '')
  if (!raw.trim()) return [] as any[]
  const lines = raw.split('\n').filter((l) => l.trim()).slice(-800)
  const out: any[] = []
  for (const line of lines) {
    try {
      const o = JSON.parse(line)
      if (sinceMs) {
        const t = Date.parse(String(o?.ts || ''))
        if (!Number.isFinite(t) || t < sinceMs) continue
      }
      out.push(o)
    } catch {}
  }
  return out
}

function computeArmMetrics(rows: any[], canaryField: string, treatment: boolean): ExperimentMetrics {
  const filtered = rows.filter((r) => Boolean(r?.[canaryField]) === treatment)
  const finals = filtered.map((r) => Number(r?.finalConfidence)).filter((x) => Number.isFinite(x))
  const routes = filtered.map((r) => Number(r?.routeConfidence)).filter((x) => Number.isFinite(x))
  const firstPass = filtered.filter((r) => r?.firstPassSuccess === true).length
  return {
    sampleCount: filtered.length,
    avgFinalConfidence: avg(finals),
    avgRouteConfidence: avg(routes),
    firstPassRate: filtered.length ? Math.round((firstPass / filtered.length) * 1000) / 1000 : null
  }
}

function enrichArmWithLearningSignals(base: ExperimentMetrics, signals: any[], canaryField: string, treatment: boolean) {
  const filtered = signals.filter((s) => Boolean(s?.[canaryField]) === treatment)
  if (!filtered.length) return base
  const composites = filtered.map((s) => Number(s?.compositeScore)).filter((x) => Number.isFinite(x))
  const fbs = filtered.map((s) => Number(s?.feedbackScore)).filter((x) => Number.isFinite(x))
  return {
    ...base,
    sampleCount: Math.max(base.sampleCount, filtered.length),
    avgCompositeScore: avg(composites),
    avgFeedbackScore: avg(fbs)
  }
}

function blendedArmScore(m: ExperimentMetrics) {
  const final = m.avgFinalConfidence ?? 0
  const comp = m.avgCompositeScore
  if (comp != null && Number.isFinite(comp)) return 0.55 * final + 0.45 * comp
  return final
}

function compareArms(control: ExperimentMetrics, treatment: ExperimentMetrics) {
  const minN = minSamplesPerArm()
  if (control.sampleCount < minN || treatment.sampleCount < minN) {
    return { sufficient: false as const, lift: 0, winner: 'tie' as const, reason: 'insufficient_samples' }
  }
  const c = blendedArmScore(control)
  const t = blendedArmScore(treatment)
  const lift = Math.round((t - c) * 1000) / 1000
  if (lift >= promoteLiftThreshold()) {
    return { sufficient: true as const, lift, winner: 'treatment' as const, reason: 'treatment_better' }
  }
  if (lift <= -rollbackDropThreshold()) {
    return { sufficient: true as const, lift, winner: 'control' as const, reason: 'treatment_regression' }
  }
  return { sufficient: true as const, lift, winner: 'tie' as const, reason: 'within_tolerance' }
}

function rowIntent(row: any): string {
  return String(row?.intent || row?.intentHint || 'unknown').trim() || 'unknown'
}

function sliceMinSamples() {
  return Math.max(4, Math.floor(minSamplesPerArm() / 2))
}

/** 按 intent 分片评估：核心意图显著退化则强制 rollback */
export function compareArmsByIntent(
  rows: any[],
  signals: any[],
  canaryField: string
): { slices: IntentSliceVerdict[]; forcedRollback: boolean; reason?: string } {
  const intents = new Set<string>()
  for (const r of rows) intents.add(rowIntent(r))
  for (const s of signals) intents.add(rowIntent(s))

  const minN = sliceMinSamples()
  const drop = rollbackDropThreshold()
  const slices: IntentSliceVerdict[] = []
  let forcedRollback = false
  let reason: string | undefined

  for (const intent of intents) {
    if (isChitchatOrOffTopicIntent(intent) || intent === 'unknown' || intent === 'interrupted') continue
    const controlRows = rows.filter((r) => rowIntent(r) === intent && !Boolean(r?.[canaryField]))
    const treatmentRows = rows.filter((r) => rowIntent(r) === intent && Boolean(r?.[canaryField]))
    const control = enrichArmWithLearningSignals(
      computeArmMetrics(controlRows, canaryField, false),
      signals.filter((s) => rowIntent(s) === intent),
      canaryField,
      false
    )
    const treatment = enrichArmWithLearningSignals(
      computeArmMetrics(treatmentRows, canaryField, true),
      signals.filter((s) => rowIntent(s) === intent),
      canaryField,
      true
    )
    if (control.sampleCount < minN || treatment.sampleCount < minN) continue
    const lift = Math.round((blendedArmScore(treatment) - blendedArmScore(control)) * 1000) / 1000
    const regressing = lift <= -drop
    slices.push({
      intent,
      lift,
      controlN: control.sampleCount,
      treatmentN: treatment.sampleCount,
      regressing
    })
    if (regressing && !forcedRollback) {
      forcedRollback = true
      reason = `intent_regression:${intent}`
    }
  }

  slices.sort((a, b) => a.lift - b.lift)
  return { slices: slices.slice(0, 16), forcedRollback, reason }
}

async function snapshotBaselineMetrics(policyDir: string): Promise<ExperimentMetrics> {
  const rows = await readNluMetrics(policyDir)
  const finals = rows.map((r) => Number(r?.finalConfidence)).filter((x) => Number.isFinite(x))
  const routes = rows.map((r) => Number(r?.routeConfidence)).filter((x) => Number.isFinite(x))
  const firstPass = rows.filter((r) => r?.firstPassSuccess === true).length
  return {
    sampleCount: rows.length,
    avgFinalConfidence: avg(finals),
    avgRouteConfidence: avg(routes),
    firstPassRate: rows.length ? Math.round((firstPass / rows.length) * 1000) / 1000 : null
  }
}

async function startExperiment(
  policyDir: string,
  hypothesis: EvolutionHypothesis,
  rationale: string
): Promise<EvolutionExperiment> {
  const exp: EvolutionExperiment = {
    id: hashId('exp', [hypothesis.id, hypothesis.artifact, String(Date.now())]),
    hypothesisId: hypothesis.id,
    artifact: hypothesis.artifact,
    status: 'running',
    createdAt: nowIso(),
    startedAt: nowIso(),
    rationale,
    baseline: await snapshotBaselineMetrics(policyDir),
    treatment: { sampleCount: 0, avgFinalConfidence: null, avgRouteConfidence: null, firstPassRate: null }
  }
  await appendJsonl(path.join(policyDir, EXP_FILE), exp as unknown as Record<string, unknown>)
  return exp
}

async function closeExperiment(
  policyDir: string,
  exp: EvolutionExperiment,
  status: ExperimentStatus,
  verdict?: EvolutionExperiment['verdict']
) {
  await appendJsonl(path.join(policyDir, EXP_FILE), {
    ...exp,
    status,
    closedAt: nowIso(),
    verdict
  })
}

async function promoteArtifact(policyDir: string, artifact: EvolutionArtifact) {
  if (artifact === 'policy') {
    const r = await maybePromoteManagerPolicyShadow(policyDir, { minConfidence: 0.68 })
    if (r.promoted && typeof r.fromVersion === 'number' && typeof r.toVersion === 'number') {
      await recordPolicyRolloutBaseline(policyDir, r.fromVersion, r.toVersion).catch(() => undefined)
    }
    return { promoted: r.promoted, detail: r }
  }
  if (artifact === 'prompt_patches') {
    return { promoted: (await promoteShadowPromptPatches(policyDir, { minConfidence: 0.65 })).promoted }
  }
  return { promoted: (await promoteShadowPlannerRules(policyDir, { minConfidence: 0.65 })).promoted }
}

async function rollbackArtifact(policyDir: string, artifact: EvolutionArtifact) {
  if (artifact === 'policy') {
    const r = await restoreManagerPolicyFromPrevious(policyDir)
    await syncEvoPolicyRollback(policyDir, artifact).catch(() => undefined)
    return r
  }
  if (artifact === 'prompt_patches') {
    await fs.unlink(path.join(policyDir, 'manager-prompt-patches.shadow.json')).catch(() => undefined)
    await syncEvoPolicyRollback(policyDir, artifact).catch(() => undefined)
    return { ok: true, message: 'prompt_shadow_removed' }
  }
  await fs.unlink(path.join(policyDir, 'manager-planner-rules.shadow.json')).catch(() => undefined)
  await syncEvoPolicyRollback(policyDir, artifact).catch(() => undefined)
  return { ok: true, message: 'planner_shadow_removed' }
}

export async function evaluateRunningExperiments(policyDir: string): Promise<{
  evaluated: number
  promoted: string[]
  rolledBack: string[]
  pending: string[]
  discarded: string[]
}> {
  const experiments = (await loadExperiments(policyDir)).filter((e) => e.status === 'running')
  const promoted: string[] = []
  const rolledBack: string[] = []
  const pending: string[] = []
  const discarded: string[] = []

  for (const exp of experiments) {
    const sinceMs = Date.parse(String(exp.startedAt || exp.createdAt))
    const rows = await readNluMetrics(policyDir, Number.isFinite(sinceMs) ? sinceMs : undefined)
    const signals = await readLearningSignals(policyDir, Number.isFinite(sinceMs) ? sinceMs : undefined)
    const field = canaryFieldForArtifact(exp.artifact)
    const control = enrichArmWithLearningSignals(computeArmMetrics(rows, field, false), signals, field, false)
    const treatment = enrichArmWithLearningSignals(computeArmMetrics(rows, field, true), signals, field, true)
    const cmp = compareArms(control, treatment)
    const sliced = compareArmsByIntent(rows, signals, field)
    const updated: EvolutionExperiment = { ...exp, baseline: control, treatment }

    if (!cmp.sufficient) {
      pending.push(exp.id)
      await appendJsonl(path.join(policyDir, EXP_FILE), { ...updated, status: 'running' })
      continue
    }

    if (sliced.forcedRollback && isEvolutionAutoExperimentEnabled()) {
      await rollbackArtifact(policyDir, exp.artifact)
      await discardEvoShadowArtifact(policyDir, exp.artifact).catch(() => undefined)
      await closeExperiment(policyDir, updated, 'rolled_back', {
        winner: 'control',
        liftFinalConfidence: cmp.lift,
        reason: sliced.reason || 'intent_regression',
        intentSlices: sliced.slices
      })
      rolledBack.push(exp.id)
      continue
    }

    const verdict = {
      winner: cmp.winner,
      liftFinalConfidence: cmp.lift,
      reason: cmp.reason,
      intentSlices: sliced.slices
    }

    if (cmp.winner === 'treatment' && isEvolutionAutoExperimentEnabled()) {
      const pr = await promoteArtifact(policyDir, exp.artifact)
      if (pr.promoted) {
        await closeExperiment(policyDir, updated, 'promoted', verdict)
        promoted.push(exp.id)
        continue
      }
    }

    if (cmp.winner === 'control' && cmp.reason === 'treatment_regression' && isEvolutionAutoExperimentEnabled()) {
      await rollbackArtifact(policyDir, exp.artifact)
      await closeExperiment(policyDir, updated, 'rolled_back', verdict)
      rolledBack.push(exp.id)
      continue
    }

    if (cmp.winner === 'tie') {
      await discardEvoShadowArtifact(policyDir, exp.artifact).catch(() => undefined)
      await closeExperiment(policyDir, updated, 'rejected', {
        ...verdict,
        reason: 'within_tolerance_discard'
      })
      discarded.push(exp.id)
      continue
    }

    pending.push(exp.id)
    await appendJsonl(path.join(policyDir, EXP_FILE), { ...updated, status: 'running', verdict })
  }

  await maybeRollbackPolicyFromNluMetrics(policyDir).catch(() => ({ rolledBack: false }))
  return { evaluated: experiments.length, promoted, rolledBack, pending, discarded }
}

export async function runEvolutionExperimentCycle(
  policyDir: string,
  insights: FailureInsightBundle,
  opts?: {
    force?: boolean
    llmInvoke?: (stage: 'critic', state: any, messages: any[]) => Promise<{ text: string }>
  }
): Promise<{
  hypothesesAdded: number
  experimentsStarted: number
  evaluation: Awaited<ReturnType<typeof evaluateRunningExperiments>>
  shadows: { policy?: boolean; prompt?: boolean; planner?: boolean }
}> {
  const gated = filterInsightsForEvolution(insights)
  const hypotheses = generateHypothesesFromInsights(gated)
  let hypothesesAdded = await persistHypotheses(policyDir, hypotheses)
  try {
    const { maybeGenerateLlmEvolutionHypotheses } = await import('./evolutionLlmHypothesis')
    const llm = await maybeGenerateLlmEvolutionHypotheses(policyDir, gated)
    hypothesesAdded += llm.added
  } catch {}
  const allHypos = (await loadHypotheses(policyDir)).filter((h) =>
    isFailureCategoryEvolutionEligible(h.category)
  )
  const running = await loadExperiments(policyDir)
  const runningHypothesisIds = new Set(running.filter((e) => e.status === 'running').map((e) => e.hypothesisId))

  const shadows = {
    policy: false,
    prompt: false,
    planner: false
  }

  if ((gated.samples || 0) >= 5 && gated.fixSuggestions?.length) {
    const pol = await maybeWriteManagerPolicyShadow(policyDir, gated).catch(() => ({ written: false as const }))
    shadows.policy = Boolean(pol.written)
    const prompt = await maybeEvolvePromptPatches(policyDir, gated, {
      force: opts?.force,
      llmInvoke: opts?.llmInvoke
    }).catch(() => ({ evolved: false as const }))
    shadows.prompt = Boolean(prompt.evolved)
    const rules = await maybeEvolvePlannerRules(policyDir, gated, { force: opts?.force }).catch(() => ({
      evolved: false as const
    }))
    shadows.planner = Boolean(rules.evolved)
  }

  let experimentsStarted = 0
  for (const h of allHypos.slice(0, 8)) {
    if (runningHypothesisIds.has(h.id)) continue
    const hasShadow =
      (h.artifact === 'policy' && shadows.policy) ||
      (h.artifact === 'prompt_patches' && shadows.prompt) ||
      (h.artifact === 'planner_rules' && shadows.planner)
    if (!hasShadow) continue
    await startExperiment(policyDir, h, h.statement)
    experimentsStarted += 1
    runningHypothesisIds.add(h.id)
  }

  const evaluation = await evaluateRunningExperiments(policyDir)
  return { hypothesesAdded, experimentsStarted, evaluation, shadows }
}

export async function buildEvolutionExperimentDashboard(policyDir: string) {
  const hypotheses = await loadHypotheses(policyDir)
  const experiments = await loadExperiments(policyDir)
  const running = experiments.filter((e) => e.status === 'running')
  const recent = experiments.slice(0, 8)
  return {
    autoExperimentEnabled: isEvolutionAutoExperimentEnabled(),
    hypothesisCount: hypotheses.length,
    experimentCount: experiments.length,
    runningCount: running.length,
    recentHypotheses: hypotheses.slice(-6).reverse(),
    recentExperiments: recent,
    runningExperiments: running
  }
}

export async function forcePromoteExperiment(policyDir: string, experimentId: string) {
  const experiments = await loadExperiments(policyDir)
  const exp = experiments.find((e) => e.id === experimentId && e.status === 'running')
  if (!exp) return { ok: false, reason: 'not_found_or_not_running' }
  const pr = await promoteArtifact(policyDir, exp.artifact)
  if (!pr.promoted) return { ok: false, reason: 'promote_failed', detail: pr }
  await closeExperiment(policyDir, exp, 'promoted', {
    winner: 'treatment',
    liftFinalConfidence: 0,
    reason: 'manual_promote'
  })
  return { ok: true, experimentId, artifact: exp.artifact }
}

export async function forceRollbackExperiment(policyDir: string, experimentId: string) {
  const experiments = await loadExperiments(policyDir)
  const exp = experiments.find((e) => e.id === experimentId && e.status === 'running')
  if (!exp) return { ok: false, reason: 'not_found_or_not_running' }
  await rollbackArtifact(policyDir, exp.artifact)
  await closeExperiment(policyDir, exp, 'rolled_back', {
    winner: 'control',
    liftFinalConfidence: 0,
    reason: 'manual_rollback'
  })
  return { ok: true, experimentId, artifact: exp.artifact }
}
