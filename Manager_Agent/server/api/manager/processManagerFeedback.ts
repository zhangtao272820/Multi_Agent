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
    const { confirmRunArtifacts, revokeRunArtifacts } = await import('#agent-shared/artifactFeedbackOrchestrator')
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

    let artifactResult: { promoted?: string[]; revoked?: string[] } = {}
    if (fb === 1 && rid) {
      artifactResult = await confirmRunArtifacts(rid, artifact).catch(() => ({ promoted: [] }))
    } else if (fb === 0 && rid) {
      artifactResult = await revokeRunArtifacts(rid, artifact).catch(() => ({ revoked: [] }))
    }

    const patched = rid
      ? await patchLearningSignalWithFeedback(dir, rid, fb).catch(() => ({ patched: false }))
      : { patched: false }
    const tuned = await maybeTuneLearningWeights(dir).catch(() => ({ tuned: false }))

    let experiencePromote: { promoted?: boolean; indexed?: boolean; reason?: string } = {}
    if (fb >= 0.78 && rid) {
      experiencePromote = await promoteExperienceFromPositiveFeedback({
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

    return {
      ok: true,
      feedbackScore: fb,
      feedbackKey,
      userMessageIndex: uidx,
      runId: rid || null,
      learningPatched: patched.patched,
      compositeScore: patched.compositeScore ?? null,
      weightsTuned: tuned.tuned,
      experiencePromoted: experiencePromote.promoted === true,
      experienceIndexed: experiencePromote.indexed === true,
      note:
        fb === 1
          ? experiencePromote.promoted
            ? '已确认本轮产物并写入经验（人审已关闭时直接生效）。'
            : experiencePromote.reason === 'pending_review'
              ? '已确认本轮产物；经验候选已提交控制面审核，通过后才参与召回。'
              : '已确认本轮产物；学习信号已回填（经验晋升待补全上下文）。'
          : fb === 0
            ? '已吊销本轮产物；相关 SQL/检索/工具路径已降权。'
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
