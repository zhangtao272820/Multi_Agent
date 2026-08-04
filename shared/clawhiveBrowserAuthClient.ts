/**
 * 浏览器侧 ClawHive 登录客户端（各 Agent UI 复用）。
 * 登录打 ClawHive /api/auth/login；业务请求带 Authorization: Bearer。
 */

const TOKEN_KEY = 'clawhive_access_token'
const USER_KEY = 'clawhive_username'

export type ClawhiveLoginResult = {
  access_token: string
  role?: string
  tenant_id?: string
}

export function resolveClawhiveAuthBase(envPublic?: { clawhiveAuthUrl?: string; clawhiveBackendUrl?: string }): string {
  const fromEnv =
    (typeof process !== 'undefined' &&
      (process.env?.NUXT_PUBLIC_CLAWHIVE_AUTH_URL ||
        process.env?.NUXT_PUBLIC_CLAWHIVE_BACKEND_URL ||
        process.env?.VITE_CLAWHIVE_AUTH_URL ||
        process.env?.CLAWHIVE_PUBLIC_URL)) ||
    ''
  const fromOpts = envPublic?.clawhiveAuthUrl || envPublic?.clawhiveBackendUrl || ''
  // Empty = same-origin /api/auth/login proxy (preferred). Do not default to a LAN IP.
  return String(fromOpts || fromEnv || '').trim().replace(/\/+$/, '')
}

export function getStoredClawhiveToken(): string {
  try {
    return String(localStorage.getItem(TOKEN_KEY) || '').trim()
  } catch {
    return ''
  }
}

export function getStoredClawhiveUsername(): string {
  try {
    return String(localStorage.getItem(USER_KEY) || '').trim()
  } catch {
    return ''
  }
}

export function storeClawhiveSession(token: string, username?: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token)
    if (username) localStorage.setItem(USER_KEY, username)
  } catch {
    /* ignore */
  }
}

export function clearClawhiveSession() {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  } catch {
    /* ignore */
  }
}

/** 仅解码 payload 展示用（不验签；验签在服务端） */
export function peekJwtSub(token: string): string {
  try {
    const part = String(token || '').split('.')[1]
    if (!part) return ''
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    const o = JSON.parse(json)
    return String(o?.sub || '').trim()
  } catch {
    return ''
  }
}

export async function loginWithClawhive(opts: {
  authBase?: string
  username: string
  password: string
}): Promise<ClawhiveLoginResult & { username: string }> {
  const base = String(opts.authBase ?? resolveClawhiveAuthBase()).replace(/\/+$/, '')
  const url = base ? `${base}/api/auth/login` : '/api/auth/login'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: opts.username, password: opts.password })
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(String(data.detail || data.message || `login_failed_${res.status}`))
  }
  const access_token = String(data.access_token || '').trim()
  if (!access_token) throw new Error('login_missing_token')
  const username = String(opts.username || peekJwtSub(access_token)).trim()
  storeClawhiveSession(access_token, username)
  return {
    access_token,
    role: data.role != null ? String(data.role) : undefined,
    tenant_id: data.tenant_id != null ? String(data.tenant_id) : undefined,
    username
  }
}

export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getStoredClawhiveToken()
  const h: Record<string, string> = { ...(extra || {}) }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}
