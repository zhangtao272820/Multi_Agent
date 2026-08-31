import { readDbSession } from '../../../utils/dbSessionStore'
import { assertDbSessionAccess, resolveDbHttpUser } from '../../utils/dbRequestUser'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const sessionId = String(query.sessionId ?? '').trim()
  if (!sessionId) return { messages: [] }
  const auth = resolveDbHttpUser(event, query.userId ? String(query.userId) : undefined)
  await assertDbSessionAccess({ sessionId, userId: auth.userId })
  const session = await readDbSession(sessionId)
  return { messages: session.messages || [] }
})
