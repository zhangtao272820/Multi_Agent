import { deleteDbSession } from '../../../utils/dbSessionStore'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}))
  const sessionId = String(body?.sessionId ?? '').trim()
  if (!sessionId) {
    throw createError({ statusCode: 400, statusMessage: 'sessionId required' })
  }
  await deleteDbSession(sessionId)
  return { ok: true }
})
