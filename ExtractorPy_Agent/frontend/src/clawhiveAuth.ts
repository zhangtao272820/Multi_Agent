/** ClawHive 浏览器登录：JWT 存 localStorage，fetch/WS 自动带凭证 */

const TOKEN_KEY = 'clawhive_access_token'
const USER_KEY = 'clawhive_user_snapshot'

export type ClawhiveUserSnap = {
  userId: string
  username: string
  role: string
  tenantId: string
}

function decodePayload(token: string): ClawhiveUserSnap | null {
  try {
    const parts = String(token || '').split('.')
    if (parts.length < 2) return null
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    const json = atob(b64 + pad)
    const p = JSON.parse(json)
    const sub = String(p.sub || '').trim()
    if (!sub) return null
    const exp = Number(p.exp)
    if (Number.isFinite(exp) && exp > 0 && Date.now() / 1000 >= exp) return null
    return {
      userId: sub,
      username: sub,
      role: String(p.role || 'viewer'),
      tenantId: String(p.tenant_id || 'default'),
    }
  } catch {
    return null
  }
}

export function getStoredToken(): string {
  try {
    return String(localStorage.getItem(TOKEN_KEY) || '').trim()
  } catch {
    return ''
  }
}

export function getStoredUser(): ClawhiveUserSnap | null {
  const t = getStoredToken()
  return t ? decodePayload(t) : null
}

export function isLoggedIn(): boolean {
  return Boolean(getStoredUser()?.userId)
}

export function authHeaders(): Record<string, string> {
  const t = getStoredToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export function withAccessToken(url: string): string {
  const t = getStoredToken()
  if (!t) return url
  const u = new URL(url, location.origin)
  u.searchParams.set('access_token', t)
  return u.toString()
}

export async function resolveAuthBase(): Promise<string> {
  // Same-origin login proxy is the durable path; optional VITE override for direct mode
  const fromEnv = String(import.meta.env.VITE_CLAWHIVE_AUTH_URL || '').trim().replace(/\/+$/, '')
  return fromEnv
}

export async function login(username: string, password: string): Promise<ClawhiveUserSnap> {
  const base = await resolveAuthBase()
  const url = base ? `${base}/api/auth/login` : '/api/auth/login'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: username.trim(), password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(String((data as { detail?: string }).detail || `HTTP ${res.status}`))
  const access = String((data as { access_token?: string }).access_token || '').trim()
  if (!access) throw new Error('缺少 access_token')
  const u =
    decodePayload(access) ||
    ({
      userId: String((data as { username?: string }).username || username),
      username: String((data as { username?: string }).username || username),
      role: String((data as { role?: string }).role || 'viewer'),
      tenantId: String((data as { tenant_id?: string }).tenant_id || 'default'),
    } satisfies ClawhiveUserSnap)
  localStorage.setItem(TOKEN_KEY, access)
  localStorage.setItem(USER_KEY, JSON.stringify(u))
  return u
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

let fetchPatched = false
export function installFetchAuth(): void {
  if (fetchPatched || typeof window === 'undefined') return
  fetchPatched = true
  const _fetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    // 登录 ClawHive 与拉 config 不加本地 JWT
    if (url.includes('/api/auth/login') || url.includes('/api/auth/config')) {
      return _fetch(input, init)
    }
    const h = authHeaders()
    if (!Object.keys(h).length) return _fetch(input, init)
    const headers = new Headers(init.headers || (typeof input !== 'string' && !(input instanceof URL) ? input.headers : undefined))
    for (const [k, v] of Object.entries(h)) {
      if (!headers.has(k)) headers.set(k, v)
    }
    return _fetch(input, { ...init, headers })
  }
}
