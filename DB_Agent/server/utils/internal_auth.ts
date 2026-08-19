/** 校验 Agent 服务身份（E5.2）。未配置 token 时跳过（LAN 开发）；AGENT_SERVICE_AUTH=require 时必验。 */
import {
  resolveAgentServiceAuthMode,
  resolveAgentServiceToken,
  verifyAgentServiceAuth
} from '#agent-shared/agentServiceAuth'

function headersAsRecord(
  headers: Record<string, string | string[] | undefined> | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = String(Array.isArray(v) ? v[0] : v || '')
  }
  return out
}

export function ensureInternalAgentAccess(event: {
  node?: { req?: { headers?: Record<string, string | string[] | undefined> } }
}) {
  const mode = resolveAgentServiceAuthMode()
  const expected = resolveAgentServiceToken()
  if (!expected) {
    if (mode === 'require') {
      throw createError({ statusCode: 503, statusMessage: 'agent_service_token_not_configured' })
    }
    return
  }
  const v = verifyAgentServiceAuth(headersAsRecord(event?.node?.req?.headers))
  if (!v.ok) {
    throw createError({ statusCode: 401, statusMessage: v.reason || 'invalid internal token' })
  }
}
