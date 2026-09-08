import path from 'node:path'
import { z } from 'zod'
import { requireTenantId, ScopeRequiredError } from '#agent-shared/tenantScope'
import { bindSessionToUser, listSessionsForUser, sanitizeUserId } from '../../graph/core/task/userIdentity'
import {
  clearManagerMemory,
  clearSubAgentLearning,
  type MemoryClearScope
} from '../../utils/session/managerMemoryClear'
import { resolveManagerPolicyDir } from '../../utils/session/managerPolicyDir'

const BodySchema = z.object({
  scope: z.enum(['experience', 'summaries', 'evolution', 'all']),
  tenantId: z.string().min(1).max(64).optional(),
  userId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  sessionId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/).optional(),
  includeSubAgents: z.boolean().optional()
})

export default defineEventHandler(async (event) => {
  const body = BodySchema.parse(await readBody(event))
  let tid: string
  try {
    tid = requireTenantId(body.tenantId)
  } catch (e) {
    if (e instanceof ScopeRequiredError) {
      throw createError({ statusCode: 401, statusMessage: 'tenant_required' })
    }
    throw e
  }
  const policyDir = resolveManagerPolicyDir(tid)
  const uid = sanitizeUserId(body.userId)
  let sessionIds: string[] | undefined

  if (uid && body.sessionId) {
    await bindSessionToUser(policyDir, body.sessionId, uid)
    sessionIds = body.scope === 'summaries' ? [body.sessionId] : undefined
  } else if (uid && body.scope === 'summaries') {
    sessionIds = await listSessionsForUser(policyDir, uid)
  }

  const result = await clearManagerMemory(body.scope as MemoryClearScope, {
    tenantId: tid,
    sessionIds
  })

  let subAgents: Awaited<ReturnType<typeof clearSubAgentLearning>> | undefined
  if (body.includeSubAgents && (body.scope === 'evolution' || body.scope === 'all')) {
    subAgents = await clearSubAgentLearning(body.scope === 'all' ? 'all' : 'learning', tid)
  } else if (body.includeSubAgents && body.scope === 'experience') {
    subAgents = await clearSubAgentLearning('learning', tid)
  }

  return { ok: true, tenantId: tid, ...result, subAgents }
})
