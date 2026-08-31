import { deleteDbSession } from '../../../utils/dbSessionStore'
import { assertDbSessionAccess, resolveDbHttpUser } from '../../utils/dbRequestUser'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}))
  const sessionId = String(body?.sessionId ?? '').trim()
  if (!sessionId) {
    throw createError({ statusCode: 400, statusMessage: 'sessionId required' })
  }
  const auth = resolveDbHttpUser(event, body?.userId ? String(body.userId) : undefined)
  await assertDbSessionAccess({ sessionId, userId: auth.userId })
  await deleteDbSession(sessionId)
  return { ok: true }
})
