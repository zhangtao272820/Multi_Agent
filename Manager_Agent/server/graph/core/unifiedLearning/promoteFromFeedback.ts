/**
 * 正反馈后把本 run 晋升为可入库 experience（过 AMP 门槛），并尝试向量索引。
 * Finalize 时分常 <0.72 被 PG 拒写；点「有用」后应以 feedback 为准写入。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { AMP_EXPERIENCE_SUCCESS_THRESHOLD } from '#agent-shared/agentMemoryPolicy'
import { appendManagerMemory } from '../../../utils/session/managerMemoryStore'
import { indexMemoryEntry, isVectorMemoryEnabled } from '../memory/vectorMemory'
import { deriveScenarioKey } from '../text'
import type { UnifiedLearningSignal } from './record'
import { readSignals } from './indexers'

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
        path: agents.length ? agents : undefined
      }
    } catch {
      /* skip */
    }
  }
  return null
}

export async function promoteExperienceFromPositiveFeedback(input: {
  policyDir: string
  runId: string
  sessionId?: string | null
  userId?: string | null
  tenantId?: string | null
  feedbackScore: number
}): Promise<{ promoted: boolean; reason?: string; indexed?: boolean }> {
  const rid = String(input.runId || '').trim()
  const fb = Number(input.feedbackScore)
  if (!rid || !Number.isFinite(fb) || fb < 0.78) {
    return { promoted: false, reason: 'feedback_not_positive' }
  }

  const signals = await readSignals(input.policyDir, 200)
  const signal: UnifiedLearningSignal | undefined = signals
    .slice()
    .reverse()
    .find((s) => String(s.runId || '') === rid)

  const plan = await findPlanOutcome(input.policyDir, rid)
  const userText = String(plan?.user || '').trim()
  if (userText.length < 4) {
    return { promoted: false, reason: 'missing_user_task' }
  }

  const successScore = Math.max(
    AMP_EXPERIENCE_SUCCESS_THRESHOLD,
    typeof signal?.successScore === 'number' ? signal.successScore : 0,
    fb
  )
  const intent = String(plan?.intent || signal?.intent || 'unknown')
  const agentPath = plan?.path?.length ? plan.path : [intent]
  const scenarioKey = deriveScenarioKey(userText)

  await appendManagerMemory({
    type: 'experience',
    user: userText,
    scenarioKey,
    intent,
    path: agentPath,
    successScore,
    feedbackScore: fb,
    finalConfidence: signal?.finalConfidence,
    routeConfidence: signal?.routeConfidence,
    firstPassSuccess: signal?.firstPassSuccess,
    failureCategory: signal?.failureCategory || 'success',
    learningQualified: true,
    source: 'explicit_feedback',
    runId: rid,
    sessionId: input.sessionId || signal?.sessionId,
    userId: input.userId,
    tenantId: input.tenantId
  })

  let indexed = false
  if (isVectorMemoryEnabled()) {
    const r = await indexMemoryEntry(input.policyDir, {
      user: userText,
      memoryType: 'experience',
      intent,
      scenarioKey,
      successScore,
      ts: new Date().toISOString()
    }).catch(() => ({ indexed: false as const }))
    indexed = Boolean((r as { indexed?: boolean })?.indexed)
  }

  return { promoted: true, indexed }
}
