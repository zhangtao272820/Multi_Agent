/**
 * 正反馈后把本 run 晋升为可入库 experience（过 AMP 门槛），并尝试向量索引。
 * 显式来源（口语记住 / 👍）默认先入候选队列，控制面人审 promote 后才参与召回。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { AMP_EXPERIENCE_SUCCESS_THRESHOLD } from '#agent-shared/agentMemoryPolicy'
import { appendManagerMemory } from '../../../utils/session/managerMemoryStore'
import { indexMemoryEntry, isVectorMemoryEnabled } from '../memory/vectorMemory'
import { deriveScenarioKey } from '../text'
import type { UnifiedLearningSignal } from './record'
import { readSignals } from './indexers'
import {
  isExperienceReviewRequired,
  upsertExperienceCandidate,
  type ExperienceCandidateSource,
} from '../memory/experienceCandidateStore'

async function findPlanOutcome(
  policyDir: string,
  runId: string
): Promise<{ user?: string; intent?: string; path?: string[] } | null> {
  const p = path.join(policyDir, 'manager-memory.jsonl')
  const raw = await fs.readFile(p, 'utf8').catch(() => '')
  if (!raw.trim()) return null
  const rid = String(runId || '').trim()
  for (const line of raw.split('\n').filter(Boolean).reverse()) {
    try {
      const o = JSON.parse(line)
      if (String(o?.type || '') !== 'plan_outcome') continue
      if (String(o?.runId || '').trim() !== rid) continue
      const agents = Array.isArray(o?.plan)
        ? o.plan.map((s: { agent?: string }) => String(s?.agent || '')).filter(Boolean)
        : []
      return {
        user: typeof o.user === 'string' ? o.user : undefined,
        intent: typeof o.intent === 'string' ? o.intent : undefined,
        path: agents.length ? agents : undefined,
      }
    } catch {
      /* skip */
    }
  }
  return null
}

export type ResolvedExperienceContext = {
  userText: string
  successScore: number
  intent: string
  agentPath: string[]
  scenarioKey: string
  signal?: UnifiedLearningSignal
}

export async function resolveExperiencePromoteContext(input: {
  policyDir: string
  runId: string
  feedbackScore: number
  userTaskOverride?: string
  intentOverride?: string
  pathOverride?: string[]
}): Promise<ResolvedExperienceContext | { error: string }> {
  const rid = String(input.runId || '').trim()
  const fb = Number(input.feedbackScore)
  if (!rid || !Number.isFinite(fb) || fb < 0.78) {
    return { error: 'feedback_not_positive' }
  }

  const signals = await readSignals(input.policyDir, 200)
  const signal: UnifiedLearningSignal | undefined = signals
    .slice()
    .reverse()
    .find((s) => String(s.runId || '') === rid)

  const plan = await findPlanOutcome(input.policyDir, rid)
  const userText = String(plan?.user || input.userTaskOverride || '').trim()
  if (userText.length < 4) {
    return { error: 'missing_user_task' }
  }

  const successScore = Math.max(
    AMP_EXPERIENCE_SUCCESS_THRESHOLD,
    typeof signal?.successScore === 'number' ? signal.successScore : 0,
    fb
  )
  const intent = String(plan?.intent || input.intentOverride || signal?.intent || 'unknown')
  const agentPath = plan?.path?.length
    ? plan.path
    : input.pathOverride?.length
      ? input.pathOverride
      : [intent]

  return {
    userText,
    successScore,
    intent,
    agentPath,
    scenarioKey: deriveScenarioKey(userText),
    signal,
  }
}

export async function commitActiveExperience(input: {
  policyDir: string
  runId: string
  sessionId?: string | null
  userId?: string | null
  tenantId?: string | null
  feedbackScore: number
  memorySource?: ExperienceCandidateSource
  ctx: ResolvedExperienceContext
  /** 人审 promote 后不再重复提议热路径 prefs */
  skipHotPathPrefs?: boolean
}): Promise<{ promoted: boolean; reason?: string; indexed?: boolean }> {
  const rid = String(input.runId || '').trim()
  const fb = Number(input.feedbackScore)
  const { ctx } = input
  const source =
    input.memorySource === 'explicit_user_request' ? 'explicit_user_request' : 'explicit_feedback'

  await appendManagerMemory({
    type: 'experience',
    user: ctx.userText,
    scenarioKey: ctx.scenarioKey,
    intent: ctx.intent,
    path: ctx.agentPath,
    successScore: ctx.successScore,
    feedbackScore: fb,
    finalConfidence: ctx.signal?.finalConfidence,
    routeConfidence: ctx.signal?.routeConfidence,
    firstPassSuccess: ctx.signal?.firstPassSuccess,
    failureCategory: ctx.signal?.failureCategory || 'success',
    learningQualified: true,
    source,
    runId: rid,
    sessionId: input.sessionId || ctx.signal?.sessionId,
    userId: input.userId,
    tenantId: input.tenantId,
  })

  let indexed = false
  if (isVectorMemoryEnabled()) {
    const r = await indexMemoryEntry(input.policyDir, {
      user: ctx.userText,
      memoryType: 'experience',
      intent: ctx.intent,
      scenarioKey: ctx.scenarioKey,
      successScore: ctx.successScore,
      ts: new Date().toISOString(),
    }).catch(() => ({ indexed: false as const }))
    indexed = Boolean((r as { indexed?: boolean })?.indexed)
  }

  if (!input.skipHotPathPrefs) {
    const { applyHotPathPrefsFromSignal } = await import('../memory/userProfile')
    await applyHotPathPrefsFromSignal(input.policyDir, input.userId || undefined, {
      feedbackScore: fb,
      successScore: ctx.successScore,
      preferredAgentsHint: ctx.agentPath,
      tenantId: input.tenantId ? String(input.tenantId) : undefined,
    }).catch(() => null)
  }

  return { promoted: true, indexed }
}

export async function promoteExperienceFromPositiveFeedback(input: {
  policyDir: string
  runId: string
  sessionId?: string | null
  userId?: string | null
  tenantId?: string | null
  feedbackScore: number
  userTaskOverride?: string
  intentOverride?: string
  pathOverride?: string[]
  memorySource?: ExperienceCandidateSource
}): Promise<{
  promoted: boolean
  reason?: string
  indexed?: boolean
  candidateId?: string
  conflictNote?: string
}> {
  const resolved = await resolveExperiencePromoteContext(input)
  if ('error' in resolved) {
    return { promoted: false, reason: resolved.error }
  }

  const source: ExperienceCandidateSource =
    input.memorySource === 'explicit_user_request' ? 'explicit_user_request' : 'explicit_feedback'

  if (isExperienceReviewRequired()) {
    const row = await upsertExperienceCandidate(input.policyDir, {
      userText: resolved.userText,
      intent: resolved.intent,
      path: resolved.agentPath,
      successScore: resolved.successScore,
      feedbackScore: input.feedbackScore,
      source,
      sourceRunId: input.runId,
      sessionId: input.sessionId || undefined,
      userId: input.userId || undefined,
      tenantId: input.tenantId || undefined,
    })
    if (!row) return { promoted: false, reason: 'candidate_write_failed' }
    return {
      promoted: false,
      reason: 'pending_review',
      candidateId: row.id,
      conflictNote: row.conflictNote,
    }
  }

  return commitActiveExperience({
    policyDir: input.policyDir,
    runId: input.runId,
    sessionId: input.sessionId,
    userId: input.userId,
    tenantId: input.tenantId,
    feedbackScore: input.feedbackScore,
    memorySource: source,
    ctx: resolved,
  })
}

export async function promoteExperienceCandidateById(
  policyDir: string,
  candidateId: string
): Promise<{ ok: boolean; reason?: string; indexed?: boolean }> {
  const { getExperienceCandidate, setExperienceCandidateStatus } = await import(
    '../memory/experienceCandidateStore'
  )
  const row = await getExperienceCandidate(policyDir, candidateId)
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.status === 'promoted') return { ok: true, reason: 'already_promoted' }
  if (row.status === 'rejected') return { ok: false, reason: 'already_rejected' }

  const fb = typeof row.feedbackScore === 'number' ? row.feedbackScore : 0.85
  const ctx: ResolvedExperienceContext = {
    userText: row.userText,
    successScore: row.successScore,
    intent: row.intent,
    agentPath: row.path,
    scenarioKey: row.scenarioKey,
  }

  const out = await commitActiveExperience({
    policyDir,
    runId: row.sourceRunId || candidateId,
    sessionId: row.sessionId,
    userId: row.userId,
    tenantId: row.tenantId,
    feedbackScore: fb,
    memorySource: row.source,
    ctx,
    skipHotPathPrefs: true,
  })

  if (!out.promoted) return { ok: false, reason: out.reason || 'commit_failed' }

  if (row.sourceRunId) {
    const { tagMgrRunArtifactCaptureSource } = await import('#agent-shared/artifactStore')
    await tagMgrRunArtifactCaptureSource(row.sourceRunId, row.source).catch(() => false)
  }

  await setExperienceCandidateStatus(policyDir, candidateId, 'promoted')
  return { ok: true, indexed: out.indexed }
}
