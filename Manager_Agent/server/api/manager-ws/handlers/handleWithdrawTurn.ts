import type { WsHandlerContext, ParsedWsMessage } from './types'
import { readSession, sessions, writeSession, resolveUserMessageAnchor } from './wsBarrel'

export async function handleWithdrawTurn(ctx: WsHandlerContext, payload: ParsedWsMessage) {
  const { send, sessionId, tenantId } = ctx

  const userMessageIndex = payload.userMessageIndex
  const anchorText =
    'text' in payload && typeof (payload as { text?: unknown }).text === 'string'
      ? String((payload as { text?: string }).text || '').trim()
      : ''
  let session = sessions.get(sessionId)
  if (!session) {
    session = await readSession(sessionId)
    sessions.set(sessionId, session)
  }
  const hit = resolveUserMessageAnchor(session.messages, {
    userMessageIndex:
      typeof userMessageIndex === 'number' && Number.isFinite(userMessageIndex)
        ? Math.floor(userMessageIndex)
        : undefined,
    text: anchorText || undefined
  })
  if (!hit) {
    send('error', '找不到对应用户消息，无法撤回', 'manager')
    return
  }
  const withdrawnText =
    hit.arrayIndex >= 0 && session.messages[hit.arrayIndex]
      ? String(session.messages[hit.arrayIndex]?.content || '')
      : anchorText
  session.messages = session.messages.slice(0, hit.arrayIndex)
  sessions.set(sessionId, session)
  await writeSession(sessionId, session)
  try {
    const { deleteSessionFeedbackFromUserIndex } = await import('#agent-shared/sessionFeedbackStore')
    await deleteSessionFeedbackFromUserIndex('manager', sessionId, hit.userMessageIndex)
  } catch {}
  let learningSuperseded = 0
  try {
    const { resolveManagerPolicyDir } = await import('../../../utils/session/managerPolicyDir')
    const { supersedeLearningSignalsForRevision } = await import(
      '../../../graph/core/unifiedLearning'
    )
    const r = await supersedeLearningSignalsForRevision({
      policyDir: resolveManagerPolicyDir(tenantId),
      sessionId,
      userMessageIndex: hit.userMessageIndex,
      fromUserMessageIndex: hit.userMessageIndex,
      userText: withdrawnText,
      reason: 'withdraw'
    })
    learningSuperseded = r.superseded
  } catch {
    /* optional */
  }
  send(
    'status',
    {
      status: 'turn_withdrawn',
      userMessageIndex: hit.userMessageIndex,
      messageCount: session.messages.length,
      userMessageCount: session.messages.filter((m) => m.role === 'user').length,
      learningSuperseded
    },
    'manager'
  )
}
