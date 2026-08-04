import fs from 'node:fs/promises'
import path from 'node:path'
import {
  appendUnifiedLearningSignal,
  attachLearnEligibility,
  computeCompositeScore,
  isUnifiedLearningEnabled,
  readSignals,
  type UnifiedLearningSignal
} from '../unifiedLearning'
import { recordBanditReward, shouldRecordRouteBanditReward } from '../routing/routeBandit'
import { recordRouteLearningExtensions } from '../unifiedLearning'
import { evaluateLearnEligibility } from './learnEligibility'

export type ImplicitKind = 'user_cancel' | 'new_chat_interrupt' | 'human_reject' | 'retry_penalty'

/** 隐式负向分（写入 feedbackScore / composite 计算） */
const IMPLICIT_FEEDBACK: Record<ImplicitKind, number> = {
  user_cancel: 0.22,
  new_chat_interrupt: 0.28,
  human_reject: 0.32,
  retry_penalty: 0.42
}

const SIGNAL_FILE = 'manager-learning-signals.jsonl'

export function isImplicitLearningEnabled() {
  return (
    isUnifiedLearningEnabled() &&
    String(process.env.MANAGER_IMPLICIT_LEARNING ?? '1').trim() !== '0'
  )
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

function implicitBaseScores(kind: ImplicitKind) {
  const fb = IMPLICIT_FEEDBACK[kind]
  return {
    feedbackScore: fb,
    finalConfidence: Math.max(0.12, fb - 0.05),
    routeConfidence: Math.max(0.15, fb),
    successScore: Math.max(0.08, fb - 0.12)
  }
}

function buildImplicitSignal(input: {
  runId: string
  sessionId?: string
  intent?: string
  kind: ImplicitKind
  durationMs?: number
}): UnifiedLearningSignal {
  const base = implicitBaseScores(input.kind)
  const compositeScore = computeCompositeScore({
    ...base,
    durationMs: input.durationMs,
    firstPassSuccess: false
  })
  return attachLearnEligibility({
    ts: new Date().toISOString(),
    runId: input.runId,
    sessionId: input.sessionId,
    intent: String(input.intent || 'interrupted').trim() || 'interrupted',
    compositeScore,
    finalConfidence: base.finalConfidence,
    routeConfidence: base.routeConfidence,
    successScore: base.successScore,
    feedbackScore: base.feedbackScore,
    durationMs: Math.max(0, Number(input.durationMs ?? 0) || 0),
    usedTokens: 0,
    usedUsd: 0,
    firstPassSuccess: false,
    needsClarify: false,
    signalSource: 'implicit',
    implicitKind: input.kind
  })
}

async function writeSignalLines(policyDir: string, lines: string[]) {
  await fs.mkdir(policyDir, { recursive: true }).catch(() => undefined)
  await fs.writeFile(path.join(policyDir, SIGNAL_FILE), `${lines.join('\n')}\n`, 'utf8')
}

/** 用户取消 / 新对话打断 / 人工拒绝等隐式负向信号 */
export async function recordImplicitLearningSignal(
  policyDir: string,
  input: {
    runId: string
    sessionId?: string
    intent?: string
    kind: ImplicitKind
    durationMs?: number
  }
): Promise<{ recorded: boolean; compositeScore?: number; patched?: boolean }> {
  if (!isImplicitLearningEnabled()) return { recorded: false }
  const rid = String(input.runId || '').trim()
  if (!rid) return { recorded: false }

  const p = path.join(policyDir, SIGNAL_FILE)
  const raw = await fs.readFile(p, 'utf8').catch(() => '')
  const lines = raw.trim() ? raw.split('\n').filter((l) => l.trim()) : []

  let patched = false
  let compositeScore: number | undefined
  const next = lines.map((line) => {
    try {
      const o = JSON.parse(line) as UnifiedLearningSignal
      if (String(o.runId || '') !== rid) return line
      patched = true
      const base = implicitBaseScores(input.kind)
      compositeScore = computeCompositeScore({
        finalConfidence: o.finalConfidence,
        routeConfidence: o.routeConfidence,
        successScore: Math.min(o.successScore, base.successScore),
        feedbackScore: base.feedbackScore,
        durationMs: o.durationMs || input.durationMs,
        firstPassSuccess: false
      })
      return JSON.stringify({
        ...o,
        compositeScore,
        feedbackScore: base.feedbackScore,
        firstPassSuccess: false,
        signalSource: 'implicit',
        implicitKind: input.kind,
        ts: new Date().toISOString()
      })
    } catch {
      return line
    }
  })

  if (patched) {
    await writeSignalLines(policyDir, next)
    const patchedRow = next
      .map((line) => {
        try {
          return JSON.parse(line) as UnifiedLearningSignal
        } catch {
          return null
        }
      })
      .find((o) => o && String(o.runId || '') === rid)
    const decision = evaluateLearnEligibility({
      intent: input.intent || 'interrupted',
      signalSource: 'implicit',
      implicitKind: input.kind,
      firstPassSuccess: false,
      compositeScore
    })
    if (
      decision.eligibleForBandit &&
      shouldRecordRouteBanditReward(patchedRow ?? undefined) &&
      compositeScore != null
    ) {
      await recordBanditReward(policyDir, input.intent || 'interrupted', compositeScore).catch(() => undefined)
    }
    if (patchedRow && decision.eligibleForBandit) {
      await recordRouteLearningExtensions(policyDir, patchedRow).catch(() => undefined)
    }
    return { recorded: true, compositeScore, patched: true }
  }

  const signal = buildImplicitSignal(input)
  await appendUnifiedLearningSignal(policyDir, signal)
  if (signal.learnBanditEligible !== false && shouldRecordRouteBanditReward(signal)) {
    await recordBanditReward(policyDir, signal.intent, signal.compositeScore).catch(() => undefined)
  }
  if (signal.learnBanditEligible !== false) {
    await recordRouteLearningExtensions(policyDir, signal).catch(() => undefined)
  }
  return { recorded: true, compositeScore: signal.compositeScore, patched: false }
}

/** finalize 侧重试惩罚：retryCount>0 时下调 composite */
export function applyRetryImplicitPenalty(
  compositeScore: number,
  retryCount: number
): { compositeScore: number; implicitKind?: ImplicitKind } {
  if (!isImplicitLearningEnabled() || retryCount <= 0) {
    return { compositeScore }
  }
  const penalty = Math.min(0.15, retryCount * 0.05)
  return {
    compositeScore: Math.round(clamp01(compositeScore - penalty) * 1000) / 1000,
    implicitKind: 'retry_penalty'
  }
}

/** 路由策略：统计会话近期隐式负向信号占比 */
export async function implicitStressForSession(
  policyDir: string,
  sessionId: string,
  limit = 10
): Promise<{ count: number; ratio: number; kinds: ImplicitKind[] }> {
  if (!isImplicitLearningEnabled()) return { count: 0, ratio: 0, kinds: [] }
  const signals = await readSignals(policyDir, 200)
  const sess = signals.filter((s) => s.sessionId === sessionId).slice(-limit)
  if (!sess.length) return { count: 0, ratio: 0, kinds: [] }
  const implicit = sess.filter((s) => s.signalSource === 'implicit' || s.implicitKind)
  const kinds = implicit
    .map((s) => s.implicitKind)
    .filter((k): k is ImplicitKind => Boolean(k))
  return {
    count: implicit.length,
    ratio: implicit.length / sess.length,
    kinds: [...new Set(kinds)]
  }
}
