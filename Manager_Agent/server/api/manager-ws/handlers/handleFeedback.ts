import type { WsHandlerContext, ParsedWsMessage } from './types'
import { fs, path, normalizeFeedbackScore, patchLearningSignalWithFeedback, maybeTuneLearningWeights } from './wsBarrel'
import { resolveManagerPolicyDir } from '../../../utils/session/managerPolicyDir'
import { promoteExperienceFromPositiveFeedback } from '../../../graph/core/unifiedLearning'

export async function handleFeedback(ctx: WsHandlerContext, payload: ParsedWsMessage) {
  const { send, sessionId, boundUserId, tenantId } = ctx

  const rid = payload.runId
  const score = payload.score ?? payload.rating ?? payload.value
  const uidx =
    typeof payload.userMessageIndex === 'number' && Number.isFinite(payload.userMessageIndex)
      ? Math.floor(payload.userMessageIndex)
      : null
  try {
    const dir = resolveManagerPolicyDir(tenantId)
    await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
    const fb = normalizeFeedbackScore(score)
    const entry = {
      ts: new Date().toISOString(),
      type: 'feedback',
      sessionId,
      userId: boundUserId,
      tenantId,
      runId: rid,
      userMessageIndex: uidx,
      score: fb,
      artifact: payload.artifact ?? null
    }
    // 反馈必须落租户 jsonl（postgres-only 时 recordMemory 不收 feedback 类型）
    const feedbackPath = path.join(dir, 'manager-memory.jsonl')
    await fs.appendFile(feedbackPath, `${JSON.stringify({ ...entry, tenantId: tenantId || 'default' })}\n`, 'utf8')
    try {
      const { upsertSessionFeedback, userMessageFeedbackKey } = await import(
        '#agent-shared/sessionFeedbackStore'
      )
      const { normalizeArtifact } = await import('#agent-shared/artifactFeedbackPolicy')
      const { confirmRunArtifacts, revokeRunArtifacts } = await import(
        '#agent-shared/artifactFeedbackOrchestrator'
      )
      const artifact = normalizeArtifact(payload.artifact)
      const feedbackKey =
        uidx != null && uidx >= 0 ? userMessageFeedbackKey(uidx) : String(rid)
      await upsertSessionFeedback({
        agent: 'manager',
        sessionId,
        tenantId,
        feedbackKey,
        score: fb ?? 0,
        runId: String(rid),
        turnId: typeof payload.turnId === 'number' ? payload.turnId : null,
        userMessageIndex: uidx,
        artifact: artifact ?? undefined
      })
      let artifactResult: { promoted?: string[]; revoked?: string[] } = {}
      if (fb === 1) {
        artifactResult = await confirmRunArtifacts(String(rid), artifact).catch(() => ({ promoted: [] }))
      } else if (fb === 0) {
        artifactResult = await revokeRunArtifacts(String(rid), artifact).catch(() => ({ revoked: [] }))
      }
      const patched = await patchLearningSignalWithFeedback(dir, rid, fb).catch(() => ({ patched: false }))
      const tuned = await maybeTuneLearningWeights(dir).catch(() => ({ tuned: false }))
      let experiencePromote: { promoted?: boolean; indexed?: boolean; reason?: string } = {}
      if (typeof fb === 'number' && fb >= 0.78 && rid) {
        experiencePromote = await promoteExperienceFromPositiveFeedback({
          policyDir: dir,
          runId: String(rid),
          sessionId,
          userId: boundUserId,
          tenantId,
          feedbackScore: fb
        }).catch((e: any) => ({ promoted: false, reason: String(e?.message || e || 'promote_failed') }))
      }
      send(
        'status',
        {
          status: 'feedback_saved',
          runId: rid,
          userMessageIndex: uidx ?? undefined,
          feedbackKey: uidx != null && uidx >= 0 ? userMessageFeedbackKey(uidx) : rid,
          feedbackScore: fb,
          learningPatched: patched.patched,
          compositeScore: patched.compositeScore,
          weightsTuned: tuned.tuned,
          weights: tuned.weights,
          experiencePromoted: experiencePromote.promoted === true,
          experienceIndexed: experiencePromote.indexed === true,
          experiencePromoteReason: experiencePromote.reason,
          artifactPromoted: artifactResult.promoted ?? [],
          artifactRevoked: artifactResult.revoked ?? [],
          note:
            fb === 1
              ? experiencePromote.promoted
                ? '已确认本轮产物并写入经验；同类问题将优先复用（无需再等人审）。'
                : '已确认本轮产物；学习信号已回填（经验晋升待补全上下文）。'
              : fb === 0
                ? '已吊销本轮产物；相关 SQL/检索/工具路径已降权。'
                : '反馈已记录。'
        },
        'manager',
        rid
      )
      return
    } catch {}
    const patched = await patchLearningSignalWithFeedback(dir, rid, fb).catch(() => ({ patched: false }))
    const tuned = await maybeTuneLearningWeights(dir).catch(() => ({ tuned: false }))
    let experiencePromote: { promoted?: boolean; indexed?: boolean; reason?: string } = {}
    if (typeof fb === 'number' && fb >= 0.78 && rid) {
      experiencePromote = await promoteExperienceFromPositiveFeedback({
        policyDir: dir,
        runId: String(rid),
        sessionId,
        userId: boundUserId,
        tenantId,
        feedbackScore: fb
      }).catch((e: any) => ({ promoted: false, reason: String(e?.message || e || 'promote_failed') }))
    }
    send(
      'status',
      {
        status: 'feedback_saved',
        runId: rid,
        feedbackScore: fb,
        learningPatched: patched.patched,
        compositeScore: patched.compositeScore,
        weightsTuned: tuned.tuned,
        weights: tuned.weights,
        experiencePromoted: experiencePromote.promoted === true,
        experienceIndexed: experiencePromote.indexed === true,
        note: '反馈已记录（产物门控未启用或 PG 不可用）。'
      },
      'manager',
      rid
    )
  } catch (e: any) {
    send('status', { status: 'feedback_save_failed', error: String(e?.message || e || 'unknown error') }, 'manager', rid)
  }
  return
}
