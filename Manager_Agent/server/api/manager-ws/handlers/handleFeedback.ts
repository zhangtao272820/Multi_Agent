import type { WsHandlerContext, ParsedWsMessage } from './types'
import { processManagerFeedback } from '../../manager/processManagerFeedback'

export async function handleFeedback(ctx: WsHandlerContext, payload: ParsedWsMessage) {
  const { send, sessionId, boundUserId, tenantId } = ctx
  const rid = payload.runId
  const score = payload.score ?? payload.rating ?? payload.value
  const uidx =
    typeof payload.userMessageIndex === 'number' && Number.isFinite(payload.userMessageIndex)
      ? Math.floor(payload.userMessageIndex)
      : null

  const result = await processManagerFeedback({
    sessionId,
    userId: boundUserId,
    tenantId,
    runId: rid ? String(rid) : null,
    turnId: typeof payload.turnId === 'number' ? payload.turnId : null,
    userMessageIndex: uidx,
    score,
    artifact: (payload.artifact as Record<string, unknown> | null | undefined) ?? null
  })

  if (!result.ok) {
    send(
      'status',
      { status: 'feedback_save_failed', error: result.error || 'unknown error' },
      'manager',
      rid
    )
    return
  }

  send(
    'status',
    {
      status: 'feedback_saved',
      runId: rid,
      userMessageIndex: result.userMessageIndex ?? undefined,
      feedbackKey: result.feedbackKey,
      feedbackScore: result.feedbackScore,
      learningPatched: result.learningPatched,
      compositeScore: result.compositeScore,
      weightsTuned: result.weightsTuned,
      experiencePromoted: result.experiencePromoted,
      experienceIndexed: result.experienceIndexed,
      note: result.note || '反馈已记录。'
    },
    'manager',
    rid
  )
}
