import { readDbSession } from '../../../utils/dbSessionStore'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const sessionId = String(query.sessionId ?? '').trim()
  if (!sessionId) return { messages: [] }
  const session = await readDbSession(sessionId)
  return { messages: session.messages || [] }
})
