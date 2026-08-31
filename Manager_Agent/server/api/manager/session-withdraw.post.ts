import { z } from 'zod'
import { readManagerSession, writeManagerSession } from '../../utils/session/managerSessionStore'
import { deleteSessionFeedbackFromUserIndex } from '#agent-shared/sessionFeedbackStore'
import {
  assertManagerSessionAccess,
  resolveManagerHttpUser
} from '../../utils/platform/managerRequestUser'
import {
  resolveUserMessageAnchor,
  type UserMessageAnchor
} from '../manager-ws/wsSessionHelpers'
import type { SessionMessage } from '../../utils/session/managerSessionStore'
import { resolveManagerPolicyDir } from '../../utils/session/managerPolicyDir'
import { supersedeLearningSignalsForRevision } from '../../graph/core/unifiedLearning'

const BodySchema = z.object({
  sessionId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  userMessageIndex: z.number().int().min(0).max(199).optional(),
  text: z.string().max(8000).optional(),
  tenantId: z.string().min(1).max(64).optional()
})

async function readSession(sessionId: string): Promise<{ messages: SessionMessage[] }> {
  return readManagerSession(sessionId)
}

async function writeSession(sessionId: string, messages: SessionMessage[]) {
  await writeManagerSession(sessionId, { messages })
}

export default defineEventHandler(async (event) => {
  const body = BodySchema.parse(await readBody(event))
  if (typeof body.userMessageIndex !== 'number' && !String(body.text || '').trim()) {
    throw createError({ statusCode: 400, statusMessage: '需要 userMessageIndex 或 text' })
  }
  const auth = resolveManagerHttpUser(event, body.userId)
  await assertManagerSessionAccess({ sessionId: body.sessionId, userId: auth.userId })

  const session = await readSession(body.sessionId)
  const hit: UserMessageAnchor | null = resolveUserMessageAnchor(session.messages, {
    userMessageIndex: body.userMessageIndex,
    text: body.text
  })
  if (!hit) {
    throw createError({ statusCode: 404, statusMessage: '找不到对应用户消息，无法撤回' })
  }

  const withdrawnText =
    hit.arrayIndex >= 0 && session.messages[hit.arrayIndex]
      ? String(session.messages[hit.arrayIndex]?.content || '')
      : String(body.text || '')
  session.messages = session.messages.slice(0, hit.arrayIndex)
  await writeSession(body.sessionId, session.messages)
  const feedbackDeleted = await deleteSessionFeedbackFromUserIndex(
    'manager',
    body.sessionId,
    hit.userMessageIndex
  )
  const learnDir = resolveManagerPolicyDir(body.tenantId || 'default')
  const learning = await supersedeLearningSignalsForRevision({
    policyDir: learnDir,
    sessionId: body.sessionId,
    userMessageIndex: hit.userMessageIndex,
    fromUserMessageIndex: hit.userMessageIndex,
    userText: withdrawnText,
    reason: 'withdraw'
  }).catch(() => ({ superseded: 0 }))

  return {
    ok: true,
    userMessageIndex: hit.userMessageIndex,
    messageCount: session.messages.length,
    userMessageCount: session.messages.filter((m) => m.role === 'user').length,
    feedbackDeleted,
    learningSuperseded: learning.superseded
  }
})
