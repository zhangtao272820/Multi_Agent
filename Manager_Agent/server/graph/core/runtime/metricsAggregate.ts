import fs from 'node:fs/promises'
import path from 'node:path'
import { readHistoryEntries } from '../shared'
import { aggregateDownstreamMetrics } from '../output/downstreamMetrics'
import { vectorIndexStats } from '../memory/vectorMemory'
import { loadActivePromptPatches, loadShadowPromptPatches, summarizePromptPatchDiff } from '../evolution/promptPatches'
import { loadActivePlannerRules, loadShadowPlannerRules, summarizePlannerRulesDiff } from '../evolution/plannerRules'
import { buildEvolutionExperimentDashboard } from '../evolution/evolutionExperiments'
import { buildLayeredMemoryDashboard, isLayeredMemoryEnabled } from '../layeredMemory'
import { buildUnifiedLearningDashboard, isUnifiedLearningEnabled } from '../unifiedLearning'
import { buildProactiveDashboard, isProactiveLoopEnabled } from '../task/proactiveLoop'
import { buildUserGoalsDashboard, isUserGoalsEnabled } from '../task/userGoals'
import { buildAutonomousQueueDashboard } from '../task/autonomousQueue'
import { isRouteStrategyEnabled } from '../routing/routeStrategy'
import { promptCanaryPercent, plannerRulesCanaryPercent } from '../evolution/artifactCanary'
import { aggregateManagerSli } from './sliAggregate'
import { readHistoryEntries as readHistForSli } from '../shared'

function avg(nums: number[]) {
  if (!nums.length) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

export async function buildManagerMetricsDashboard(policyDir: string) {
  const memJsonl = path.join(policyDir, 'manager-memory.jsonl')
  const memJson = path.join(policyDir, 'manager-memory.json')
  const metJsonl = path.join(policyDir, 'manager-nlu-metrics.jsonl')
  const metJson = path.join(policyDir, 'manager-metrics.json')
  const runMetJsonl = path.join(policyDir, 'manager-metrics.jsonl')

  const memory = await readHistoryEntries(memJsonl, memJson, 600)
  const nlu = await readHistoryEntries(metJsonl, metJson, 1200)
  const runMetricRows = await readHistoryEntries(runMetJsonl, metJson, 2400)
  const downstreamQuality = aggregateDownstreamMetrics(runMetricRows as Array<Record<string, unknown>>)

  const experiences = memory.filter((m) => m?.type === 'experience')
  const byIntent: Record<string, { count: number; successSum: number; clarify: number; lowFinal: number }> = {}
  const byAgent: Record<string, { count: number; successSum: number }> = {}
  const byPolicy: Record<string, { count: number; finalSum: number }> = {}

  for (const e of experiences) {
    const intent = String(e.intent || 'unknown')
    const succ = typeof e.successScore === 'number' ? e.successScore : 0.5
    if (!byIntent[intent]) byIntent[intent] = { count: 0, successSum: 0, clarify: 0, lowFinal: 0 }
    byIntent[intent].count += 1
    byIntent[intent].successSum += succ
    if (e.needsClarify) byIntent[intent].clarify += 1
    if (typeof e.finalConfidence === 'number' && e.finalConfidence < 0.55) byIntent[intent].lowFinal += 1

    const agents = Array.isArray(e.path) ? e.path : [intent]
    for (const a of agents) {
      const ag = String(a || '').trim() || 'unknown'
      if (!byAgent[ag]) byAgent[ag] = { count: 0, successSum: 0 }
      byAgent[ag].count += 1
      byAgent[ag].successSum += succ
    }
  }

  for (const m of nlu) {
    const pv = String(m.policyVersion ?? 'unknown')
    const fc = typeof m.finalConfidence === 'number' ? m.finalConfidence : null
    if (fc == null) continue
    if (!byPolicy[pv]) byPolicy[pv] = { count: 0, finalSum: 0 }
    byPolicy[pv].count += 1
    byPolicy[pv].finalSum += fc
  }

  const intentStats = Object.fromEntries(
    Object.entries(byIntent).map(([k, v]) => [
      k,
      {
        count: v.count,
        avgSuccess: v.count ? Math.round((v.successSum / v.count) * 1000) / 1000 : 0,
        clarifyRate: v.count ? Math.round((v.clarify / v.count) * 1000) / 1000 : 0,
        lowFinalRate: v.count ? Math.round((v.lowFinal / v.count) * 1000) / 1000 : 0
      }
    ])
  )

  const agentStats = Object.fromEntries(
    Object.entries(byAgent).map(([k, v]) => [
      k,
      { count: v.count, avgSuccess: v.count ? Math.round((v.successSum / v.count) * 1000) / 1000 : 0 }
    ])
  )

  const policyVersions = Object.fromEntries(
    Object.entries(byPolicy).map(([k, v]) => [
      k,
      { count: v.count, avgFinalConfidence: v.count ? Math.round((v.finalSum / v.count) * 1000) / 1000 : 0 }
    ])
  )

  const finals = nlu.map((m) => Number(m?.finalConfidence)).filter((x) => Number.isFinite(x))
  const routes = nlu.map((m) => Number(m?.routeConfidence)).filter((x) => Number.isFinite(x))
  const firstPass = nlu.filter((m) => m?.firstPassSuccess === true).length
  const replayUsed = nlu.filter((m) => Number(m?.experienceReplayCount) > 0).length
  const canaryRuns = nlu.filter((m) => m?.policyCanary === true).length
  const canaryFinals = nlu
    .filter((m) => m?.policyCanary === true)
    .map((m) => Number(m?.finalConfidence))
    .filter((x) => Number.isFinite(x))
  const activeFinals = nlu
    .filter((m) => !m?.policyCanary)
    .map((m) => Number(m?.finalConfidence))
    .filter((x) => Number.isFinite(x))

  const promptCanaryRuns = nlu.filter((m) => m?.promptCanary === true).length
  const promptCanaryFinals = nlu
    .filter((m) => m?.promptCanary === true)
    .map((m) => Number(m?.finalConfidence))
    .filter((x) => Number.isFinite(x))
  const promptActiveFinals = nlu
    .filter((m) => !m?.promptCanary)
    .map((m) => Number(m?.finalConfidence))
    .filter((x) => Number.isFinite(x))
  const plannerCanaryRuns = nlu.filter((m) => m?.plannerRulesCanary === true).length
  const plannerCanaryFinals = nlu
    .filter((m) => m?.plannerRulesCanary === true)
    .map((m) => Number(m?.finalConfidence))
    .filter((x) => Number.isFinite(x))

  const vector = await vectorIndexStats(policyDir).catch(() => ({ enabled: false, total: 0, experience: 0, planOutcome: 0 }))
  const activePatches = await loadActivePromptPatches(policyDir)
  const shadowPatches = await loadShadowPromptPatches(policyDir)
  const promptDiff = summarizePromptPatchDiff(activePatches, shadowPatches)
  const activeRules = await loadActivePlannerRules(policyDir)
  const shadowRules = await loadShadowPlannerRules(policyDir)
  const plannerRulesDiff = summarizePlannerRulesDiff(activeRules, shadowRules)
  const experiments = await buildEvolutionExperimentDashboard(policyDir).catch(() => null)
  const layeredMemory = await buildLayeredMemoryDashboard(policyDir).catch(() => null)
  const unifiedLearning = await buildUnifiedLearningDashboard(policyDir).catch(() => null)
  const proactive = await buildProactiveDashboard(policyDir).catch(() => null)
  const userGoals = await buildUserGoalsDashboard(policyDir).catch(() => null)
  const autonomousQueue = await buildAutonomousQueueDashboard(policyDir).catch(() => null)

  const hitlJsonl = path.join(policyDir, 'manager-hitl-decisions.jsonl')
  const hitlRows = await readHistForSli(hitlJsonl, path.join(policyDir, 'manager-hitl-decisions.json'), 800).catch(
    () => []
  )
  const sli = aggregateManagerSli(runMetricRows as Array<Record<string, unknown>>, nlu, hitlRows)

  return {
    experienceCount: experiences.length,
    nluSampleCount: nlu.length,
    avgFinalConfidence: finals.length ? Math.round(avg(finals) * 1000) / 1000 : null,
    avgRouteConfidence: routes.length ? Math.round(avg(routes) * 1000) / 1000 : null,
    firstPassSuccessRate: nlu.length ? Math.round((firstPass / nlu.length) * 1000) / 1000 : null,
    experienceReplayUsageRate: nlu.length ? Math.round((replayUsed / nlu.length) * 1000) / 1000 : null,
    policyCanary: {
      sampleCount: canaryRuns,
      share: nlu.length ? Math.round((canaryRuns / nlu.length) * 1000) / 1000 : null,
      avgFinalConfidence: canaryFinals.length ? Math.round(avg(canaryFinals) * 1000) / 1000 : null,
      activeAvgFinalConfidence: activeFinals.length ? Math.round(avg(activeFinals) * 1000) / 1000 : null
    },
    promptCanary: {
      percent: promptCanaryPercent(),
      sampleCount: promptCanaryRuns,
      avgFinalConfidence: promptCanaryFinals.length ? Math.round(avg(promptCanaryFinals) * 1000) / 1000 : null,
      activeAvgFinalConfidence: promptActiveFinals.length ? Math.round(avg(promptActiveFinals) * 1000) / 1000 : null
    },
    plannerRulesCanary: {
      percent: plannerRulesCanaryPercent(),
      sampleCount: plannerCanaryRuns,
      avgFinalConfidence: plannerCanaryFinals.length ? Math.round(avg(plannerCanaryFinals) * 1000) / 1000 : null
    },
    experiments,
    layeredMemory: layeredMemory
      ? { ...layeredMemory, enabled: isLayeredMemoryEnabled() }
      : { enabled: isLayeredMemoryEnabled() },
    unifiedLearning: unifiedLearning
      ? { ...unifiedLearning, enabled: isUnifiedLearningEnabled() }
      : { enabled: isUnifiedLearningEnabled() },
    proactive: proactive ? { ...proactive, enabled: isProactiveLoopEnabled() } : { enabled: isProactiveLoopEnabled() },
    userGoals: userGoals ? { ...userGoals, enabled: isUserGoalsEnabled() } : { enabled: isUserGoalsEnabled() },
    autonomousQueue: autonomousQueue ?? { enabled: false, pending: 0, running: 0, recent: [] },
    routeStrategy: { enabled: isRouteStrategyEnabled() },
    byIntent: intentStats,
    byAgent: agentStats,
    policyVersions,
    vectorIndex: vector,
    promptPatches: promptDiff,
    plannerRules: plannerRulesDiff,
    downstreamQuality,
    sli
  }
}
