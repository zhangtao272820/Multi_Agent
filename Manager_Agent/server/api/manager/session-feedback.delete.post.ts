import { z } from 'zod'
import {
  deleteAllSessionFeedback,
  deleteSessionFeedbackAtUserMessageIndex,
  deleteSessionFeedbackFromTurn,
  deleteSessionFeedbackFromUserIndex
} from '#agent-shared/sessionFeedbackStore'
import {
  assertManagerSessionAccess,
  resolveManagerHttpUser
} from '../../utils/platform/managerRequestUser'

const BodySchema = z.object({
  sessionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  fromTurnId: z.number().int().min(0).max(500).optional(),
  fromUserIndex: z.number().int().min(0).max(500).optional(),
  /** 重新生成：仅删除当前 userMessageIndex，不影响后续轮次 */
  atUserIndexOnly: z.boolean().optional(),
  deleteAll: z.boolean().optional()
})

export default defineEventHandler(async (event) => {
  const body = BodySchema.parse(await readBody(event))
  const auth = resolveManagerHttpUser(event, body.userId)
  await assertManagerSessionAccess({ sessionId: body.sessionId, userId: auth.userId })

  let deleted = 0
  if (body.deleteAll) {
    deleted = await deleteAllSessionFeedback('manager', body.sessionId)
  } else if (body.atUserIndexOnly && body.fromUserIndex != null) {
    deleted = await deleteSessionFeedbackAtUserMessageIndex('manager', body.sessionId, body.fromUserIndex)
  } else if (body.fromUserIndex != null) {
    deleted = await deleteSessionFeedbackFromUserIndex('manager', body.sessionId, body.fromUserIndex)
    if (body.fromTurnId != null) {
      deleted += await deleteSessionFeedbackFromTurn('manager', body.sessionId, body.fromTurnId)
    }
  } else if (body.fromTurnId != null) {
    deleted = await deleteSessionFeedbackFromTurn('manager', body.sessionId, body.fromTurnId)
  } else {
    throw createError({ statusCode: 400, statusMessage: '请指定 fromTurnId、fromUserIndex 或 deleteAll' })
  }
  return { ok: true, deleted }
})
