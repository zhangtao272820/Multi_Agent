/**
 * Manager HTTP：权威 userId + 会话归属（读 shared/resolveRequestUser）
 */
import path from 'node:path'
import {
  assertSessionOwnedByUser,
  resolveRequestUserId,
  type ResolveRequestUserResult
} from '#agent-shared/resolveRequestUser'
import { resolveSessionUserId } from '#agent-shared/userSessionMapStore'
import { bindSessionToUser } from '../../graph/core/task/userIdentity'

function nitroCreateError(input: { statusCode: number; statusMessage: string }): never {
  throw createError({ statusCode: input.statusCode, statusMessage: input.statusMessage })
}

export function managerPolicyDir() {
  return path.join(process.cwd(), '.data')
}

export function resolveManagerHttpUser(
  event: Parameters<typeof resolveRequestUserId>[0],
  claimedUserId?: string | null
): ResolveRequestUserResult {
  return resolveRequestUserId(event, {
    claimedUserId,
    createError: nitroCreateError
  })
}

/** 校验归属；无归属时绑定到权威 userId（首触） */
export async function assertManagerSessionAccess(input: {
  sessionId: string
  userId: string
  bindIfUnbound?: boolean
}): Promise<void> {
  const policyDir = managerPolicyDir()
  const { unbound } = await assertSessionOwnedByUser({
    sessionId: input.sessionId,
    userId: input.userId,
    allowUnbound: true,
    resolveOwner: (sid) => resolveSessionUserId(sid, policyDir),
    createError: nitroCreateError
  })
  if (unbound && input.bindIfUnbound !== false) {
    await bindSessionToUser(policyDir, input.sessionId, input.userId)
  }
}
