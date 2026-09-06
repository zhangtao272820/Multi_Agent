/**
 * Manager 用户 JWT（与服务级 MANAGER_WS_TOKEN 正交）
 * AGENT_BROWSER_AUTH=1 时必须验浏览器 JWT；禁止仅靠客户端 userId 冒充登录。
 */

import {
  extractBearer,
  isAgentBrowserAuthEnabled,
  resolveBrowserUser,
  type ClawhiveUser
} from '#agent-shared/clawhiveJwt'
import {
  CLAWHIVE_ACCESS_COOKIE,
  extractCookieValue
} from '#agent-shared/nitroClawhiveAuth'

export function isManagerUserAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = String(env.MANAGER_USER_AUTH ?? '').trim()
  if (explicit === '0' || explicit.toLowerCase() === 'false') return false
  if (explicit === '1' || explicit.toLowerCase() === 'true') return true
  return isAgentBrowserAuthEnabled(env)
}

export function extractUserTokenFromPayload(payloadRaw: Record<string, unknown> | null | undefined): string {
  if (!payloadRaw || typeof payloadRaw !== 'object') return ''
  const direct =
    String((payloadRaw as any).userToken || (payloadRaw as any).accessToken || (payloadRaw as any).clawhiveToken || '').trim()
  if (direct) return direct
  const auth = String((payloadRaw as any).authorization || (payloadRaw as any).Authorization || '').trim()
  return extractBearer(auth)
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string {
  if (!headers) return ''
  const raw = headers[name] ?? headers[name.toLowerCase()]
  return String(Array.isArray(raw) ? raw[0] : raw || '').trim()
}

/** 从 WS peer 请求头 / Cookie 提取浏览器 JWT（与 HTTP 对齐） */
export function extractUserTokenFromPeerHeaders(
  headers?: Record<string, string | string[] | undefined>
): string {
  if (!headers) return ''
  const bearer = extractBearer(headerValue(headers, 'authorization'))
  if (bearer) return bearer
  const alt = headerValue(headers, 'x-clawhive-user-token')
  if (alt) return alt
  return extractCookieValue(headerValue(headers, 'cookie'), CLAWHIVE_ACCESS_COOKIE)
}

export function resolveManagerUserFromMessage(
  payloadRaw: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  peerHeaders?: Record<string, string | string[] | undefined>
): { ok: true; user: ClawhiveUser } | { ok: false; reason: string } {
  if (!isManagerUserAuthEnabled(env)) {
    return { ok: true, user: { userId: '', username: '', role: 'viewer', tenantId: 'default' } }
  }
  const token =
    extractUserTokenFromPayload(payloadRaw) || extractUserTokenFromPeerHeaders(peerHeaders)
  if (!token) return { ok: false, reason: '需要登录：请先使用 ClawHive 账号登录（无需打开控制端）' }
  try {
    const user = resolveBrowserUser(token, env)
    return { ok: true, user }
  } catch {
    return { ok: false, reason: '用户令牌无效或已过期，请重新登录' }
  }
}
