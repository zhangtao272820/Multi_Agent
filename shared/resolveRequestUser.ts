/**
 * 权威请求身份：middleware 已验 JWT 后，业务 handler 必须用本模块取 userId，
 * 禁止信任客户端 body/query 覆盖（browser 模式）。
 *
 * - browser：强制 JWT.sub；claimed 不一致 → 403
 * - internal：允许 X-User-Id / claimed（Manager 调度）
 * - open：允许 claimed，否则 fallback（默认 local）
 */

import type { ClawhiveUser } from './clawhiveJwt'
import { sanitizeUserId } from './userSessionMapStore'
import {
  requireBrowserOrInternalAuth,
  type AuthEventLike
} from './nitroClawhiveAuth'

export type AuthMode = 'browser' | 'internal' | 'open'

export type ResolveRequestUserResult = {
  userId: string
  mode: AuthMode
  user?: ClawhiveUser
  tenantId: string
}

export type CreateErrorFn = (input: { statusCode: number; statusMessage: string }) => never

function defaultCreateError(input: { statusCode: number; statusMessage: string }): never {
  throw Object.assign(new Error(input.statusMessage), {
    statusCode: input.statusCode,
    statusMessage: input.statusMessage
  })
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string {
  if (!headers) return ''
  const raw = headers[name] ?? headers[name.toLowerCase()]
  return String(Array.isArray(raw) ? raw[0] : raw || '').trim()
}

/** 纯函数：按 auth mode 裁定权威 userId（便于契约 smoke） */
export function pickAuthoritativeUserId(input: {
  mode: AuthMode
  jwtUserId?: string | null
  claimedUserId?: string | null
  headerUserId?: string | null
  fallbackUserId?: string
}): { ok: true; userId: string } | { ok: false; statusCode: number; statusMessage: string } {
  const claimed = sanitizeUserId(input.claimedUserId)
  const headerUid = sanitizeUserId(input.headerUserId)
  const jwtUid = sanitizeUserId(input.jwtUserId)
  const fallback = sanitizeUserId(input.fallbackUserId) || 'local'

  if (input.mode === 'browser') {
    if (!jwtUid) {
      return { ok: false, statusCode: 401, statusMessage: 'login_required' }
    }
    if (claimed && claimed !== jwtUid) {
      return { ok: false, statusCode: 403, statusMessage: 'forbidden: user_id mismatch' }
    }
    if (headerUid && headerUid !== jwtUid) {
      return { ok: false, statusCode: 403, statusMessage: 'forbidden: user_id mismatch' }
    }
    return { ok: true, userId: jwtUid }
  }

  if (input.mode === 'internal') {
    const uid = headerUid || claimed || fallback
    return { ok: true, userId: uid }
  }

  // open
  return { ok: true, userId: claimed || headerUid || fallback }
}

/**
 * 从 Nitro event 解析权威 userId。
 * 优先复用 middleware 写入的 context.clawhiveUser；必要时再跑一次门禁拿 mode。
 */
export function resolveRequestUserId(
  event: AuthEventLike,
  opts?: {
    claimedUserId?: string | null
    bodyToken?: string
    fallbackUserId?: string
    env?: NodeJS.ProcessEnv
    createError?: CreateErrorFn
  }
): ResolveRequestUserResult {
  const createError = opts?.createError || defaultCreateError
  const auth = requireBrowserOrInternalAuth(event, {
    bodyToken: opts?.bodyToken,
    env: opts?.env,
    createError
  })

  const ctxUser =
    event.context?.clawhiveUser && typeof event.context.clawhiveUser === 'object'
      ? (event.context.clawhiveUser as ClawhiveUser)
      : undefined
  const jwtUserId = String(auth.user?.userId || ctxUser?.userId || '').trim()
  const headerUserId = headerValue(event.node?.req?.headers, 'x-user-id')

  const picked = pickAuthoritativeUserId({
    mode: auth.mode,
    jwtUserId,
    claimedUserId: opts?.claimedUserId,
    headerUserId,
    fallbackUserId: opts?.fallbackUserId
  })
  if (!picked.ok) {
    return createError({ statusCode: picked.statusCode, statusMessage: picked.statusMessage })
  }

  const tenantId = String(auth.user?.tenantId || ctxUser?.tenantId || 'default').trim() || 'default'
  return {
    userId: picked.userId,
    mode: auth.mode,
    user: auth.user || ctxUser,
    tenantId
  }
}

/** 纯函数：会话归属判定 */
export function evaluateSessionOwnership(input: {
  userId: string
  ownerUserId?: string | null
  /** 无归属时是否允许（首触绑定）；默认 true */
  allowUnbound?: boolean
}): { ok: true; unbound: boolean } | { ok: false; statusCode: number; statusMessage: string } {
  const uid = sanitizeUserId(input.userId)
  if (!uid) {
    return { ok: false, statusCode: 401, statusMessage: 'login_required' }
  }
  const owner = sanitizeUserId(input.ownerUserId)
  if (!owner) {
    if (input.allowUnbound === false) {
      return { ok: false, statusCode: 403, statusMessage: 'forbidden: session unbound' }
    }
    return { ok: true, unbound: true }
  }
  if (owner !== uid) {
    return { ok: false, statusCode: 403, statusMessage: 'forbidden: session ownership' }
  }
  return { ok: true, unbound: false }
}

/**
 * 校验 session 归属；不匹配抛 403。
 * resolveOwner 由各 Agent 注入（mgr map / db_sessions.user_id / …）。
 */
export async function assertSessionOwnedByUser(input: {
  sessionId: string
  userId: string
  resolveOwner: (sessionId: string) => Promise<string | null>
  allowUnbound?: boolean
  createError?: CreateErrorFn
}): Promise<{ unbound: boolean; owner: string | null }> {
  const createError = input.createError || defaultCreateError
  const sid = String(input.sessionId || '').trim()
  if (!sid) {
    return createError({ statusCode: 400, statusMessage: 'sessionId required' })
  }
  const owner = await input.resolveOwner(sid)
  const ev = evaluateSessionOwnership({
    userId: input.userId,
    ownerUserId: owner,
    allowUnbound: input.allowUnbound
  })
  if (!ev.ok) {
    return createError({ statusCode: ev.statusCode, statusMessage: ev.statusMessage })
  }
  return { unbound: ev.unbound, owner }
}
