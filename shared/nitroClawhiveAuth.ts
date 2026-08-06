/**
 * Nitro：浏览器 JWT 或 ClawHive internal token 二选一。
 * health/ready/metrics 由调用方自行跳过；本函数只做门禁。
 */

import {
  extractBearer,
  isAgentBrowserAuthEnabled,
  resolveBrowserUser,
  type ClawhiveUser
} from './clawhiveJwt'

export type AuthEventLike = {
  node?: { req?: { headers?: Record<string, string | string[] | undefined> } }
  context?: Record<string, unknown>
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string {
  if (!headers) return ''
  const raw = headers[name] ?? headers[name.toLowerCase()]
  return String(Array.isArray(raw) ? raw[0] : raw || '').trim()
}

export function extractInternalToken(event: AuthEventLike): string {
  const headers = event?.node?.req?.headers || {}
  return (
    headerValue(headers, 'x-clawhive-internal-token') ||
    headerValue(headers, 'x-internal-token') ||
    ''
  )
}

export function isInternalTokenValid(event: AuthEventLike, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = String(env.CLAWHIVE_INTERNAL_TOKEN || env.AGENT_INTERNAL_TOKEN || '').trim()
  if (!expected) return false
  const got = extractInternalToken(event)
  return Boolean(got && got === expected)
}

/** 与浏览器 localStorage / document.cookie 同名，供同域 $fetch 自动携带 */
export const CLAWHIVE_ACCESS_COOKIE = 'clawhive_access_token'

export function extractCookieValue(cookieHeader: string, name: string): string {
  const target = String(name || '').trim()
  if (!target) return ''
  for (const part of String(cookieHeader || '').split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const k = part.slice(0, idx).trim()
    if (k !== target) continue
    const raw = part.slice(idx + 1).trim()
    if (!raw) return ''
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return ''
}

export function extractBrowserToken(event: AuthEventLike, bodyToken?: string): string {
  const headers = event?.node?.req?.headers || {}
  const bearer = extractBearer(headerValue(headers, 'authorization'))
  if (bearer) return bearer
  const alt = headerValue(headers, 'x-clawhive-user-token')
  if (alt) return alt
  const fromCookie = extractCookieValue(headerValue(headers, 'cookie'), CLAWHIVE_ACCESS_COOKIE)
  if (fromCookie) return fromCookie
  const rawUrl = String(event?.node?.req?.url || '')
  const qIdx = rawUrl.indexOf('?')
  if (qIdx >= 0) {
    const sp = new URLSearchParams(rawUrl.slice(qIdx + 1))
    const fromQ = String(sp.get('access_token') || sp.get('token') || '').trim()
    if (fromQ) return fromQ
  }
  return String(bodyToken || '').trim()
}

/**
 * @returns { mode, user? }
 * - internal：Manager 调度
 * - browser：终端用户 JWT
 * 未启用 AGENT_BROWSER_AUTH 且无 internal 要求时：放行 anonymous（兼容本地 smoke）
 */
export function requireBrowserOrInternalAuth(
  event: AuthEventLike,
  opts?: { bodyToken?: string; env?: NodeJS.ProcessEnv; createError?: (input: { statusCode: number; statusMessage: string }) => never }
): { mode: 'internal' | 'browser' | 'open'; user?: ClawhiveUser } {
  const env = opts?.env || process.env
  const fail =
    opts?.createError ||
    ((input: { statusCode: number; statusMessage: string }) => {
      throw Object.assign(new Error(input.statusMessage), { statusCode: input.statusCode, statusMessage: input.statusMessage })
    })

  if (isInternalTokenValid(event, env)) {
    return { mode: 'internal' }
  }

  const browserEnabled = isAgentBrowserAuthEnabled(env)
  if (!browserEnabled) {
    return { mode: 'open' }
  }

  const token = extractBrowserToken(event, opts?.bodyToken)
  if (!token) {
    return fail({ statusCode: 401, statusMessage: 'login_required' })
  }
  try {
    const user = resolveBrowserUser(token, env)
    if (event.context) event.context.clawhiveUser = user
    return { mode: 'browser', user }
  } catch {
    return fail({ statusCode: 401, statusMessage: 'invalid_user_token' })
  }
}

/**
 * AGENT_BROWSER_AUTH=1 时必须配置 internal token，否则 Manager 调度 /api/plan|/api/retrieve 会 401。
 * 供 /api/ready 暴露，避免「进程 healthy 但业务 API 全拒」。
 */
export function resolveInternalAuthReady(env: NodeJS.ProcessEnv = process.env): {
  browserAuthEnabled: boolean
  internalTokenConfigured: boolean
  ok: boolean
  detail?: string
} {
  const browserAuthEnabled = isAgentBrowserAuthEnabled(env)
  const internalTokenConfigured = Boolean(
    String(env.CLAWHIVE_INTERNAL_TOKEN || env.AGENT_INTERNAL_TOKEN || '').trim()
  )
  if (!browserAuthEnabled) {
    return { browserAuthEnabled, internalTokenConfigured, ok: true }
  }
  if (internalTokenConfigured) {
    return { browserAuthEnabled, internalTokenConfigured, ok: true }
  }
  return {
    browserAuthEnabled,
    internalTokenConfigured,
    ok: false,
    detail: 'internal_token_missing_with_browser_auth'
  }
}

/** Nitro middleware 路径白名单 */
export function isPublicAgentPath(path: string): boolean {
  const p = String(path || '').split('?')[0] || ''
  if (p === '/' || p === '') return true
  if (p.startsWith('/_nuxt') || p.startsWith('/__nuxt') || p.startsWith('/favicon')) return true
  if (
    p === '/api/health' ||
    p === '/api/ready' ||
    p === '/api/metrics' ||
    p.startsWith('/api/metrics/') ||
    p === '/api/probe' ||
    p === '/api/auth/config' ||
    p === '/api/auth/login'
  ) {
    return true
  }
  return false
}
