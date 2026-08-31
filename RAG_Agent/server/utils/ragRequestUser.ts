/**
 * RAG Agent HTTP：权威 userId + 会话归属
 */
import {
  assertSessionOwnedByUser,
  resolveRequestUserId,
  type ResolveRequestUserResult
} from '#agent-shared/resolveRequestUser'
import { bindRagSessionUser, getRagSessionUserId } from './ragSessionStore'

function nitroCreateError(input: { statusCode: number; statusMessage: string }): never {
  throw createError({ statusCode: input.statusCode, statusMessage: input.statusMessage })
}

export function resolveRagHttpUser(
  event: Parameters<typeof resolveRequestUserId>[0],
  claimedUserId?: string | null
): ResolveRequestUserResult {
  return resolveRequestUserId(event, {
    claimedUserId,
    fallbackUserId: 'local',
    createError: nitroCreateError
  })
}

export async function assertRagSessionAccess(input: {
  sessionId: string
  userId: string
  bindIfUnbound?: boolean
}): Promise<void> {
  const { unbound } = await assertSessionOwnedByUser({
    sessionId: input.sessionId,
    userId: input.userId,
    allowUnbound: true,
    resolveOwner: (sid) => getRagSessionUserId(sid),
    createError: nitroCreateError
  })
  if (unbound && input.bindIfUnbound !== false) {
    await bindRagSessionUser(input.sessionId, input.userId)
  }
}
