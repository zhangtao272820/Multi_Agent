/** P1-11：Manager WebSocket 鉴权（默认关，公网部署 opt-in） */

import { isManagerWsAuthRequired } from '../../../utils/platform/managerEnvModes'

const wsAuthedPeers = new WeakSet<object>()

export function isManagerWsAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isManagerWsAuthRequired(env)
}

export function resolveManagerWsExpectedToken(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.MANAGER_WS_TOKEN || env.CLAWHIVE_INTERNAL_TOKEN || env.MANAGER_OPS_TOKEN || '').trim()
}

/** S1：AUTH_MODE=token（或 WS_AUTH=1）时必须配置期望 token，否则半开不可用 */
export function getManagerWsAuthConfigStatus(env: NodeJS.ProcessEnv = process.env): {
  required: boolean
  hasToken: boolean
  ok: boolean
  detail: string
} {
  const required = isManagerWsAuthRequired(env)
  const hasToken = Boolean(resolveManagerWsExpectedToken(env))
  if (!required) {
    return { required: false, hasToken, ok: true, detail: 'auth_open' }
  }
  if (!hasToken) {
    return {
      required: true,
      hasToken: false,
      ok: false,
      detail: 'auth_token_required_but_missing'
    }
  }
  return { required: true, hasToken: true, ok: true, detail: 'auth_token_ok' }
}

function headerValue(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw
  return String(v ?? '').trim()
}

function bearerToken(authHeader: string): string {
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader || '').trim())
  return m ? String(m[1] || '').trim() : ''
}

export function extractManagerWsToken(input: {
  url?: string
  headers?: Record<string, string | string[] | undefined>
  messageToken?: string
}): string {
  const fromMsg = String(input.messageToken ?? '').trim()
  if (fromMsg) return fromMsg

  const headers = input.headers || {}
  const direct =
    headerValue(headers['x-manager-ws-token']) ||
    headerValue(headers['x-clawhive-internal-token']) ||
    headerValue(headers['x-internal-token'])
  if (direct) return direct

  const bearer = bearerToken(headerValue(headers.authorization))
  if (bearer) return bearer

  try {
    const rawUrl = String(input.url || '').trim()
    if (!rawUrl) return ''
    const u = rawUrl.startsWith('ws') ? new URL(rawUrl.replace(/^ws/, 'http')) : new URL(rawUrl, 'http://localhost')
    return String(u.searchParams.get('token') || u.searchParams.get('wsToken') || '').trim()
  } catch {
    return ''
  }
}

export function validateManagerWsAuth(input: {
  url?: string
  headers?: Record<string, string | string[] | undefined>
  messageToken?: string
}): { ok: true } | { ok: false; reason: string } {
  if (!isManagerWsAuthEnabled()) return { ok: true }

  const expected = resolveManagerWsExpectedToken()
  if (!expected) {
    return { ok: false, reason: '服务端未配置 MANAGER_WS_TOKEN，无法启用 WS 鉴权' }
  }

  const got = extractManagerWsToken(input)
  if (!got || got !== expected) {
    return { ok: false, reason: 'WS 鉴权失败：token 无效或缺失' }
  }
  return { ok: true }
}

export function peerRequestMeta(peer: unknown): {
  url?: string
  headers?: Record<string, string | string[] | undefined>
} {
  const p = peer as { url?: string; request?: { url?: string; headers?: Record<string, string | string[] | undefined> } }
  return {
    url: String(p?.url || p?.request?.url || ''),
    headers: p?.request?.headers || {}
  }
}

export function isWsPeerAuthed(peer: object): boolean {
  if (!isManagerWsAuthEnabled()) return true
  return wsAuthedPeers.has(peer)
}

export function markWsPeerAuthed(peer: object): void {
  wsAuthedPeers.add(peer)
}

export function tryAuthenticateWsPeer(peer: object): { ok: true } | { ok: false; reason: string } {
  if (!isManagerWsAuthEnabled()) return { ok: true }
  if (wsAuthedPeers.has(peer)) return { ok: true }
  const meta = peerRequestMeta(peer)
  const verdict = validateManagerWsAuth(meta)
  if (verdict.ok) markWsPeerAuthed(peer)
  return verdict
}
