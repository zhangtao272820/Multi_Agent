import { readDbSession, listDbSessionsForUser, getDbSessionMeta } from '../../../utils/dbSessionStore'

function previewTitle(messages: Array<{ role?: string; content?: string }>) {
  const firstUser = messages.find((m) => String(m?.role || '').toLowerCase() === 'user')
  const raw = String(firstUser?.content || '').trim()
  if (!raw) return '新会话'
  return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw
}

/** 会话列表：仅服务端权威（按 userId） */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const userId = String(query.userId ?? '').trim()
  const anchor = String(query.sessionId ?? '').trim()
  if (!userId) return { items: [] }

  const ids = new Set(await listDbSessionsForUser(userId))
  if (anchor) ids.add(anchor)

  const items: Array<{
    id: string
    title: string
    updatedAt: string
    messageCount: number
    userMessageCount: number
    customTitle?: boolean
  }> = []

  for (const sid of ids) {
    const session = await readDbSession(sid)
    const messages = session.messages || []
    const meta = await getDbSessionMeta(sid)
    const userMessageCount = messages.filter((m) => m.role === 'user').length
    if (!messages.length && !(meta.customTitle && meta.title)) continue
    items.push({
      id: sid,
      title: meta.customTitle && meta.title ? meta.title : previewTitle(messages),
      updatedAt: meta.updatedAt || new Date().toISOString(),
      messageCount: messages.length,
      userMessageCount,
      customTitle: Boolean(meta.customTitle && meta.title)
    })
  }

  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return { items }
})
