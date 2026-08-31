import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeFeedbackScore } from '../../graph/core/runtime/runtimePersistence'
import { patchLearningSignalWithFeedback, maybeTuneLearningWeights } from '../manager-ws/handlers/wsBarrel'
import { resolveManagerPolicyDir } from '../../utils/session/managerPolicyDir'
import { promoteExperienceFromPositiveFeedback } from '../../graph/core/unifiedLearning'

export type ProcessManagerFeedbackInput = {
  sessionId: string
  userId?: string | null
  tenantId?: string | null
  runId?: string | null
  turnId?: number | null
  userMessageIndex?: number | null
  score?: unknown
  artifact?: Record<string, unknown> | null
}

export type ProcessManagerFeedbackResult = {
  ok: boolean
  feedbackScore: 0 | 1 | null
  feedbackKey: string
  userMessageIndex?: number | null
  runId?: string | null
  learningPatched?: boolean
  compositeScore?: number | null
  weightsTuned?: boolean
  experiencePromoted?: boolean
  experienceIndexed?: boolean
  note?: string
  error?: string
}

/**
 * 产物确认 / 学习回填 / 经验晋升可能触达 embedding、多表 PG、联邦同步。
 * 这些不得阻塞「有用/无用」HTTP/WS 回包，否则前端会长时间停在「提交中…」。
 */
async function runFeedbackSideEffects(input: {
  dir: string
  rid: string
  sessionId: string
  boundUserId: string
  tenantId: string
  fb: 0 | 1
  artifact: Record<string, unknown> | null | undefined
}): Promise<void> {
  const { dir, rid, sessionId, boundUserId, tenantId, fb, artifact } = input
  const { confirmRunArtifacts, revokeRunArtifacts } = await import('#agent-shared/artifactFeedbackOrchestrator')

  if (fb === 1 && rid) {
    await confirmRunArtifacts(rid, artifact).catch(() => ({ promoted: [] }))
  } else if (fb === 0 && rid) {
    await revokeRunArtifacts(rid, artifact).catch(() => ({ revoked: [] }))
  }

  if (rid) {
    await patchLearningSignalWithFeedback(dir, rid, fb).catch(() => ({ patched: false }))
  }
  await maybeTuneLearningWeights(dir).catch(() => ({ tuned: false }))

  if (fb >= 0.78 && rid) {
    const experiencePromote = await promoteExperienceFromPositiveFeedback({
      policyDir: dir,
      runId: rid,
      sessionId,
      userId: boundUserId,
      tenantId,
      feedbackScore: fb,
      memorySource: 'explicit_feedback'
    }).catch((e: unknown) => ({
      promoted: false,
      reason: String((e as Error)?.message || e || 'promote_failed')
    }))
    if (experiencePromote.promoted) {
      const { tagMgrRunArtifactCaptureSource } = await import('#agent-shared/artifactStore')
      await tagMgrRunArtifactCaptureSource(rid, 'explicit_feedback').catch(() => false)
    }
  }
}

export async function processManagerFeedback(
  input: ProcessManagerFeedbackInput
): Promise<ProcessManagerFeedbackResult> {
  const sessionId = String(input.sessionId || '').trim()
  const rid = input.runId ? String(input.runId).trim() : ''
  const uidx =
    typeof input.userMessageIndex === 'number' && Number.isFinite(input.userMessageIndex)
      ? Math.floor(input.userMessageIndex)
      : null
  const tenantId = input.tenantId ? String(input.tenantId) : 'default'
  const boundUserId = input.userId ? String(input.userId) : 'default'

  try {
    const dir = resolveManagerPolicyDir(tenantId)
    await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
    const fb = normalizeFeedbackScore(input.score)
    if (fb !== 0 && fb !== 1) {
      return { ok: false, feedbackScore: null, feedbackKey: '', error: 'invalid_score' }
    }

    const entry = {
      ts: new Date().toISOString(),
      type: 'feedback',
      sessionId,
      userId: boundUserId,
      tenantId,
      runId: rid || null,
      userMessageIndex: uidx,
      score: fb,
      artifact: input.artifact ?? null
    }
    const feedbackPath = path.join(dir, 'manager-memory.jsonl')
    await fs.appendFile(feedbackPath, `${JSON.stringify({ ...entry, tenantId: tenantId || 'default' })}\n`, 'utf8')

    const { upsertSessionFeedback, userMessageFeedbackKey } = await import('#agent-shared/sessionFeedbackStore')
    const { normalizeArtifact } = await import('#agent-shared/artifactFeedbackPolicy')
    const artifact = normalizeArtifact(input.artifact)
    const feedbackKey = uidx != null && uidx >= 0 ? userMessageFeedbackKey(uidx) : rid
    await upsertSessionFeedback({
      agent: 'manager',
      sessionId,
      tenantId,
      feedbackKey,
      score: fb,
      runId: rid || null,
      turnId: typeof input.turnId === 'number' ? input.turnId : null,
      userMessageIndex: uidx,
      artifact: artifact ?? undefined
    })

    void runFeedbackSideEffects({
      dir,
      rid,
      sessionId,
      boundUserId,
      tenantId,
      fb,
      artifact: artifact ?? null
    }).catch(() => undefined)

    return {
      ok: true,
      feedbackScore: fb,
      feedbackKey,
      userMessageIndex: uidx,
      runId: rid || null,
      learningPatched: false,
      compositeScore: null,
      weightsTuned: false,
      experiencePromoted: false,
      experienceIndexed: false,
      note:
        fb === 1
          ? '已记录有用反馈；产物确认与经验晋升在后台进行。'
          : fb === 0
            ? '已记录无用反馈；降权处理在后台进行。'
            : '反馈已记录。'
    }
  } catch (e: unknown) {
    return {
      ok: false,
      feedbackScore: null,
      feedbackKey: '',
      error: String((e as Error)?.message || e || 'unknown error')
    }
  }
}
