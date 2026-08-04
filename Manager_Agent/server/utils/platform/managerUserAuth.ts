/**
 * Manager 用户 JWT（与服务级 MANAGER_WS_TOKEN 正交）
 */

import {
  extractBearer,
  isAgentBrowserAuthEnabled,
  resolveBrowserUser,
  type ClawhiveUser
} from '#agent-shared/clawhiveJwt'

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

export function resolveManagerUserFromMessage(
  payloadRaw: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): { ok: true; user: ClawhiveUser } | { ok: false; reason: string } {
  if (!isManagerUserAuthEnabled(env)) {
    return { ok: true, user: { userId: '', username: '', role: 'viewer', tenantId: 'default' } }
  }
  const token = extractUserTokenFromPayload(payloadRaw)
  if (!token) return { ok: false, reason: '需要登录：请先使用 ClawHive 账号登录' }
  try {
    const user = resolveBrowserUser(token, env)
    return { ok: true, user }
  } catch {
    return { ok: false, reason: '用户令牌无效或已过期，请重新登录' }
  }
}
