import fs from 'node:fs/promises'
import path from 'node:path'
import { buildEvolutionVersionLift } from '../evolution/evolutionVersionLift'
import { isImplicitLearningEnabled } from '../evolution/implicitLearning'
import {
  type UnifiedLearningSignal,
  computeCompositeScore,
  isUnifiedLearningEnabled,
  isLearningWeightTuneEnabled,
  getEffectiveLearningWeights,
  getCachedLearningWeights,
  refreshLearningWeightsCache,
  normalizeWeights,
  persistLearningWeights,
  maxSignalLines,
  recordRouteLearningExtensions,
  clamp01,
  SIGNAL_FILE
} from './record'
import { shouldRecordRouteBanditReward, recordBanditReward } from '../routing/routeBandit'

function searchSignalsSummary(signals: UnifiedLearningSignal[]) {
  const requested = signals.filter((s) => s.searchRequested)
  if (!requested.length) return null
  const hits = requested.filter((s) => (s.searchHitCount ?? 0) > 0)
  const failed = requested.filter((s) => s.searchFailed || (s.searchHitCount ?? 0) === 0)
  return {
    runsWithSearch: requested.length,
    hitRate: Math.round((hits.length / requested.length) * 1000) / 1000,
    zeroHitRate: Math.round((failed.length / requested.length) * 1000) / 1000,
    avgHits:
      hits.length > 0
        ? Math.round((hits.reduce((a, s) => a + (s.searchHitCount ?? 0), 0) / hits.length) * 10) / 10
        : null
  }
}

export async function readSignals(policyDir: string, maxLines = 500): Promise<UnifiedLearningSignal[]> {
  const p = path.join(policyDir, SIGNAL_FILE)
  const raw = await fs.readFile(p, 'utf8').catch(() => '')
  if (!raw.trim()) return []
  const lines = raw.split('\n').filter((l) => l.trim()).slice(-maxLines)
  const out: UnifiedLearningSignal[] = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as UnifiedLearningSignal)
    } catch {}
  }
  return out
}

/** 看板/调参默认排除已被重新生成作废的信号 */
export function activeLearningSignals(signals: UnifiedLearningSignal[]): UnifiedLearningSignal[] {
  return signals.filter((s) => !s.superseded)
}

function normUserTask(s: string) {
  return String(s || '')
    .replace(/\s+/g, '')
    .trim()
    .slice(0, 240)
}

/**
 * 重新生成 / 编辑重发 / 撤回：作废同会话同轮（或撤回点及之后）旧学习信号，避免幽灵 run 拉低平均分。
 * 优先按 userMessageIndex；无 index 的历史信号用 plan_outcome 用户原文匹配 runId。
 * withdraw：作废 userMessageIndex >= fromIndex 的全部信号。
 */
export async function supersedeLearningSignalsForRevision(input: {
  policyDir: string
  sessionId: string
  userMessageIndex?: number | null
  /** withdraw：作废从此序号起的全部轮次 */
  fromUserMessageIndex?: number | null
  userText?: string
  reason: 'regenerate' | 'edit_resend' | 'withdraw'
}): Promise<{ superseded: number }> {
  if (!isUnifiedLearningEnabled()) return { superseded: 0 }
  const sid = String(input.sessionId || '').trim()
  if (!sid) return { superseded: 0 }
  const p = path.join(input.policyDir, SIGNAL_FILE)
  const raw = await fs.readFile(p, 'utf8').catch(() => '')
  if (!raw.trim()) return { superseded: 0 }

  const uidx =
    typeof input.userMessageIndex === 'number' && Number.isFinite(input.userMessageIndex)
      ? Math.floor(input.userMessageIndex)
      : null
  const fromIdx =
    typeof input.fromUserMessageIndex === 'number' && Number.isFinite(input.fromUserMessageIndex)
      ? Math.floor(input.fromUserMessageIndex)
      : input.reason === 'withdraw' && uidx != null
        ? uidx
        : null
  const wantUser = normUserTask(input.userText || '')
  const runIdsFromPlan = new Set<string>()
  if (wantUser) {
    const memRaw = await fs
      .readFile(path.join(input.policyDir, 'manager-memory.jsonl'), 'utf8')
      .catch(() => '')
    for (const line of memRaw.split('\n').filter(Boolean)) {
      try {
        const o = JSON.parse(line)
        if (String(o?.type || '') !== 'plan_outcome') continue
        if (normUserTask(String(o?.user || '')) !== wantUser) continue
        const rid = String(o?.runId || '').trim()
        if (rid) runIdsFromPlan.add(rid)
      } catch {
        /* skip */
      }
    }
  }

  const now = new Date().toISOString()
  let superseded = 0
  const next = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      try {
        const o = JSON.parse(line) as UnifiedLearningSignal
        if (o.superseded) return line
        if (String(o.sessionId || '') !== sid) return line
        const sigIdx =
          typeof o.userMessageIndex === 'number' && Number.isFinite(o.userMessageIndex)
            ? Math.floor(o.userMessageIndex)
            : null
        const sameTurn = uidx != null && sigIdx === uidx
        const fromTurn = fromIdx != null && sigIdx != null && sigIdx >= fromIdx
        // 撤回且无 index 的历史幽灵：同会话全部作废（该会话已截断，旧样本不应再进看板）
        const withdrawLegacy =
          input.reason === 'withdraw' && fromIdx != null && sigIdx == null
        const sameLegacyRun = runIdsFromPlan.has(String(o.runId || ''))
        if (!sameTurn && !fromTurn && !withdrawLegacy && !sameLegacyRun) return line
        superseded += 1
        return JSON.stringify({
          ...o,
          superseded: true,
          supersededReason: input.reason,
          supersededAt: now,
          learnEligible: false,
          learnBanditEligible: false
        })
      } catch {
        return line
      }
    })
  if (superseded > 0) {
    await fs.writeFile(p, `${next.join('\n')}\n`, 'utf8')
  }
  return { superseded }
}

export async function buildUnifiedLearningDashboard(policyDir: string, sessionId?: string) {
  const effectiveWeights = await getEffectiveLearningWeights(policyDir).catch(() => getCachedLearningWeights())
  const signals = await readSignals(policyDir, 400)
  const active = activeLearningSignals(signals)
  const filtered = sessionId ? active.filter((s) => s.sessionId === sessionId) : active
  const slice = filtered.length ? filtered : active
  if (!slice.length) {
    return {
      enabled: isUnifiedLearningEnabled(),
      sampleCount: 0,
      supersededCount: signals.filter((s) => s.superseded).length,
      avgComposite: null as number | null,
      weights: effectiveWeights,
      weightTuneEnabled: isLearningWeightTuneEnabled()
    }
  }
  const composites = slice.map((s) => s.compositeScore).filter((x) => Number.isFinite(x))
  const avg = composites.length ? composites.reduce((a, b) => a + b, 0) / composites.length : null
  const withFb = slice.filter((s) => typeof s.feedbackScore === 'number').length
  const implicitCount = slice.filter((s) => s.signalSource === 'implicit' || s.implicitKind).length
  const fbScores = slice
    .map((s) => s.feedbackScore)
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  const avgFeedback = fbScores.length ? fbScores.reduce((a, b) => a + b, 0) / fbScores.length : null
  const recent = slice.slice(-8).reverse()
  const chartPoints = slice.slice(-20).map((s, i) => ({
    i: i + 1,
    composite: s.compositeScore,
    feedback: typeof s.feedbackScore === 'number' ? s.feedbackScore : null,
    intent: s.intent,
    implicit: s.signalSource === 'implicit' || Boolean(s.implicitKind)
  }))
  return {
    enabled: isUnifiedLearningEnabled(),
    implicitLearningEnabled: isImplicitLearningEnabled(),
    sampleCount: slice.length,
    supersededCount: signals.filter((s) => s.superseded).length,
    avgComposite: avg != null ? Math.round(avg * 1000) / 1000 : null,
    avgFeedback: avgFeedback != null ? Math.round(avgFeedback * 1000) / 1000 : null,
    feedbackCoverage: slice.length ? Math.round((withFb / slice.length) * 1000) / 1000 : null,
    implicitSignalRatio: slice.length ? Math.round((implicitCount / slice.length) * 1000) / 1000 : null,
    searchMetrics: searchSignalsSummary(slice),
    versionLift: buildEvolutionVersionLift(slice),
    weights: effectiveWeights,
    weightTuneEnabled: isLearningWeightTuneEnabled(),
    recent,
    chartPoints
  }
}

export async function patchLearningSignalWithFeedback(
  policyDir: string,
  runId: string,
  feedbackScore: number
): Promise<{ patched: boolean; compositeScore?: number }> {
  if (!isUnifiedLearningEnabled()) return { patched: false }
  await refreshLearningWeightsCache(policyDir).catch(() => undefined)
  const p = path.join(policyDir, SIGNAL_FILE)
  const raw = await fs.readFile(p, 'utf8').catch(() => '')
  if (!raw.trim()) return { patched: false }
  const lines = raw.split('\n').filter((l) => l.trim())
  let patched = false
  let compositeScore: number | undefined
  const next = lines.map((line) => {
    try {
      const o = JSON.parse(line) as UnifiedLearningSignal
      if (String(o.runId || '') !== runId) return line
      if (o.superseded) return line
      patched = true
      const fb = clamp01(feedbackScore)
      // 显式有用：抬高 successScore，避免仍被低自评拖死
      const successScore =
        fb >= 0.78 ? Math.max(clamp01(o.successScore), fb, 0.85) : clamp01(o.successScore)
      compositeScore = computeCompositeScore({
        finalConfidence: o.finalConfidence,
        routeConfidence: o.routeConfidence,
        successScore,
        feedbackScore: fb,
        durationMs: o.durationMs,
        firstPassSuccess: o.firstPassSuccess
      })
      return JSON.stringify({
        ...o,
        successScore,
        feedbackScore: fb,
        compositeScore,
        signalSource: 'explicit_feedback',
        ts: new Date().toISOString()
      })
    } catch {
      return line
    }
  })
  if (patched) {
    await fs.writeFile(p, `${next.join('\n')}\n`, 'utf8')
    if (compositeScore != null) {
      const row = next
        .map((line) => {
          try {
            return JSON.parse(line) as UnifiedLearningSignal
          } catch {
            return null
          }
        })
        .find((o) => o && String(o.runId || '') === runId)
      if (row) {
        await recordRouteLearningExtensions(policyDir, row).catch(() => undefined)
        if (shouldRecordRouteBanditReward(row)) {
          await recordBanditReward(policyDir, row.intent, compositeScore).catch(() => undefined)
        }
      }
    }
  }
  return { patched, compositeScore }
}

export async function maybeTuneLearningWeights(
  policyDir: string
): Promise<{ tuned: boolean; weights?: import('./record').LearningWeights }> {
  if (!isUnifiedLearningEnabled() || !isLearningWeightTuneEnabled()) return { tuned: false }
  const signals = activeLearningSignals(await readSignals(policyDir, 120))
  const withFb = signals.filter((s) => typeof s.feedbackScore === 'number')
  const minSamples = Number(process.env.MANAGER_LEARNING_TUNE_MIN_SAMPLES ?? 12)
  if (withFb.length < (Number.isFinite(minSamples) ? minSamples : 12)) return { tuned: false }

  const avgFb = withFb.reduce((a, s) => a + (s.feedbackScore ?? 0), 0) / withFb.length
  const avgComp = withFb.reduce((a, s) => a + s.compositeScore, 0) / withFb.length
  const current = await getEffectiveLearningWeights(policyDir)
  const next = { ...current }
  let reason = 'stable'

  if (avgFb < 0.45 || avgComp < 0.5) {
    next.feedback = Math.min(0.45, next.feedback + 0.04)
    next.success = Math.max(0.2, next.success - 0.02)
    reason = 'low_satisfaction_boost_feedback'
  } else if (avgFb > 0.75 && avgComp > 0.72) {
    next.final = Math.min(0.42, next.final + 0.02)
    next.feedback = Math.max(0.12, next.feedback - 0.02)
    reason = 'high_satisfaction_balance_quality'
  } else {
    return { tuned: false, weights: current }
  }

  const normalized = normalizeWeights({
    ...next,
    tunedAt: new Date().toISOString(),
    reason
  })
  await persistLearningWeights(policyDir, normalized)
  return { tuned: true, weights: normalized }
}

export async function maybeTrimLearningSignals(policyDir: string): Promise<{ trimmed: number }> {
  if (!isUnifiedLearningEnabled()) return { trimmed: 0 }
  const p = path.join(policyDir, SIGNAL_FILE)
  const raw = await fs.readFile(p, 'utf8').catch(() => '')
  if (!raw.trim()) return { trimmed: 0 }
  const lines = raw.split('\n').filter((l) => l.trim())
  const max = maxSignalLines()
  if (lines.length <= max) return { trimmed: 0 }
  const kept = lines.slice(-max)
  await fs.writeFile(p, `${kept.join('\n')}\n`, 'utf8')
  return { trimmed: lines.length - kept.length }
}

export async function lowScoreRunsForSession(policyDir: string, sessionId: string, limit = 3) {
  const signals = activeLearningSignals(await readSignals(policyDir, 200))
  return signals
    .filter((s) => s.sessionId === sessionId && s.compositeScore < 0.55)
    .slice(-limit)
    .reverse()
}
