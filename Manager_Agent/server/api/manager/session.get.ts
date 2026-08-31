import { z } from 'zod'
import { readManagerSession } from '../../utils/session/managerSessionStore'
import {
  assertManagerSessionAccess,
  resolveManagerHttpUser
} from '../../utils/platform/managerRequestUser'

const QuerySchema = z.object({
  sessionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional()
})

export default defineEventHandler(async (event) => {
  const query = QuerySchema.parse(getQuery(event))
  const auth = resolveManagerHttpUser(event, query.userId)
  await assertManagerSessionAccess({ sessionId: query.sessionId, userId: auth.userId })
  const session = await readManagerSession(query.sessionId)
  return {
    sessionId: query.sessionId,
    messages: session.messages || []
  }
})
