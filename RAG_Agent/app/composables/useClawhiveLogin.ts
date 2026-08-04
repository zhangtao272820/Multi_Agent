/**
 * ClawHive 本地登录（浏览器不验签；服务端验 JWT）
 * 同域 Cookie 与 localStorage 同步，避免 Nuxt $fetch 拦截器失效导致 401。
 */
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
      tenantId: String(p.tenant_id || 'default')
    }
  } catch {
    return null
  }
}

function syncAuthCookie(token: string) {
  if (typeof document === 'undefined') return
  if (!token) {
    document.cookie = `${TOKEN_KEY}=; Path=/; Max-Age=0; SameSite=Lax`
    return
  }
  let maxAge = 60 * 60 * 24 * 7
  try {
    const part = String(token).split('.')[1]
    if (part) {
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
      const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
      const exp = Number(JSON.parse(atob(b64 + pad))?.exp)
      if (Number.isFinite(exp) && exp > 0) maxAge = Math.max(60, Math.floor(exp - Date.now() / 1000))
    }
  } catch {
    /* keep default */
  }
  document.cookie = `${TOKEN_KEY}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`
}

export function useClawhiveLogin() {
  const token = useState('clawhive_token', () => '')
  const user = useState<ClawhiveUserSnap | null>('clawhive_user', () => null)
  const ready = useState('clawhive_auth_ready', () => false)

  function loadFromStorage() {
    if (!import.meta.client) {
      ready.value = true
      return
    }
    const t = String(localStorage.getItem(TOKEN_KEY) || '').trim()
    token.value = t
    const u = t ? decodePayload(t) : null
    user.value = u
    if (u) {
      localStorage.setItem(USER_KEY, JSON.stringify(u))
      syncAuthCookie(t)
    } else {
      if (t) {
        token.value = ''
        localStorage.removeItem(TOKEN_KEY)
      }
      syncAuthCookie('')
    }
    ready.value = true
  }

  async function login(username: string, password: string) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: username.trim(), password })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(String((data as any).detail || `HTTP ${res.status}`))
    const access = String((data as any).access_token || '').trim()
    if (!access) throw new Error('缺少 access_token')
    const u = decodePayload(access) || {
      userId: String((data as any).username || username),
      username: String((data as any).username || username),
      role: String((data as any).role || 'viewer'),
      tenantId: String((data as any).tenant_id || 'default')
    }
    token.value = access
    user.value = u
    localStorage.setItem(TOKEN_KEY, access)
    localStorage.setItem(USER_KEY, JSON.stringify(u))
    syncAuthCookie(access)
    return u
  }

  function logout() {
    token.value = ''
    user.value = null
    syncAuthCookie('')
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  }

  function authHeaders(): Record<string, string> {
    return token.value ? { Authorization: `Bearer ${token.value}` } : {}
  }

  const isLoggedIn = computed(() => Boolean(token.value && user.value?.userId))

  return { token, user, ready, isLoggedIn, loadFromStorage, login, logout, authHeaders }
}
