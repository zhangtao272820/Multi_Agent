import path from 'node:path'
import { z } from 'zod'
import {
  sanitizeWorkbenchMode,
  writeSessionWorkbenchMode
} from '../../utils/session/managerSessionMeta'
import { bindSessionToUser, resolveUserId } from '../../graph/core/task/userIdentity'

const BodySchema = z.object({
  sessionId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  workbenchMode: z.enum(['chat', 'professional'])
})

export default defineEventHandler(async (event) => {
  const body = BodySchema.parse(await readBody(event))
  const policyDir = path.join(process.cwd(), '.data')
  const userId = await resolveUserId(policyDir, body.sessionId, body.userId)
  if (!userId) {
    throw createError({ statusCode: 403, statusMessage: '无法验证会话归属' })
  }

  const workbenchMode = sanitizeWorkbenchMode(body.workbenchMode)
  if (!workbenchMode) {
    throw createError({ statusCode: 400, statusMessage: 'workbenchMode 无效' })
  }

  const dataRoot = path.join(process.cwd(), '.data')
  await bindSessionToUser(policyDir, body.sessionId, userId)
  await writeSessionWorkbenchMode(dataRoot, body.sessionId, workbenchMode)

  return { ok: true, sessionId: body.sessionId, workbenchMode }
})
