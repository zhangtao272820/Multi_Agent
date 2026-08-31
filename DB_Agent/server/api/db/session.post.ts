import { writeDbSession, updateDbSessionMeta, type DbSessionMessage } from '../../../utils/dbSessionStore'
import { assertDbSessionAccess, resolveDbHttpUser } from '../../utils/dbRequestUser'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}))
  const sessionId = String(body?.sessionId ?? '').trim()
  const claimed = String(body?.userId ?? '').trim()
  if (!sessionId) {
    throw createError({ statusCode: 400, statusMessage: 'sessionId required' })
  }
  const auth = resolveDbHttpUser(event, claimed || undefined)
  const userId = auth.userId
  await assertDbSessionAccess({ sessionId, userId })

  const title = String(body?.title ?? '').trim().slice(0, 80) || undefined
  const customTitle = body?.customTitle === true
  const hasMessages = Array.isArray(body?.messages)

  if (!hasMessages) {
    await updateDbSessionMeta(sessionId, { userId, title, customTitle: customTitle || undefined })
    return { ok: true, metaOnly: true }
  }

  const messages = (body.messages as Array<{ role?: string; content?: string }>)
    .map((m) => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      content: String(m?.content ?? '').trim()
    }))
    .filter((m: DbSessionMessage) => m.content) as DbSessionMessage[]

  await writeDbSession(sessionId, { messages }, { userId, title, customTitle })
  return { ok: true, messageCount: messages.length }
})
