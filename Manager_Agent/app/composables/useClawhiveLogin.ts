/**
 * ClawHive 用户登录态（localStorage JWT）；userId = JWT.sub
 * 注意：浏览器不验签（无 JWT_SECRET）；验签在服务端。
 *
 * 同域 Cookie 与 localStorage 同步：Nuxt 自动导入的 $fetch 往往不走
 * globalThis.$fetch 拦截器，但浏览器会自动带 Cookie，避免 HTTP 401 login_required。
 */

const TOKEN_KEY = 'clawhive_access_token'
const USER_KEY = 'clawhive_user_snapshot'

function syncAuthCookie(token: string) {
  if (typeof document === 'undefined') return
  const name = TOKEN_KEY
  if (!token) {
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`
    return
  }
  let maxAge = 60 * 60 * 24 * 7
  const p = decodeJwtPayloadUnsafe(token)
  const exp = Number(p?.exp)
  if (Number.isFinite(exp) && exp > 0) {
    maxAge = Math.max(60, Math.floor(exp - Date.now() / 1000))
  }
  document.cookie = `${name}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`
}

export type ClawhiveUserSnap = {
  userId: string
  username: string
  role: string
  tenantId: string
}

function publicAuthBase(): string {
  try {
    const cfg = useRuntimeConfig()
    const fromCfg = String((cfg.public as any)?.clawhiveAuthUrl || '').trim()
    if (fromCfg) return fromCfg.replace(/\/+$/, '')
  } catch {
    /* SSR / early */
  }
  return ''
}

/** 仅解码 payload（不验签），供 UI 展示 */
function decodeJwtPayloadUnsafe(token: string): Record<string, unknown> | null {
  try {
    const parts = String(token || '').split('.')
    if (parts.length < 2) return null
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    const json = typeof atob === 'function' ? atob(b64 + pad) : Buffer.from(b64 + pad, 'base64').toString('utf8')
    const o = JSON.parse(json)
    return o && typeof o === 'object' ? o : null
  } catch {
    return null
  }
}

function snapFromToken(token: string, fallbackUser?: string): ClawhiveUserSnap | null {
  const p = decodeJwtPayloadUnsafe(token)
  if (!p) return null
  const sub = String(p.sub || fallbackUser || '').trim()
  if (!sub) return null
  const exp = Number(p.exp)
  if (Number.isFinite(exp) && exp > 0 && Date.now() / 1000 >= exp) return null
  return {
    userId: sub,
    username: sub,
    role: String(p.role || 'viewer'),
    tenantId: String(p.tenant_id || 'default')
  }
}

export function useClawhiveLogin() {
  const token = useState<string>('clawhive_token', () => '')
  const user = useState<ClawhiveUserSnap | null>('clawhive_user', () => null)
  const ready = useState<boolean>('clawhive_auth_ready', () => false)

  function loadFromStorage() {
    if (!import.meta.client) {
      ready.value = true
      return
    }
    try {
      const t = String(localStorage.getItem(TOKEN_KEY) || '').trim()
      token.value = t
      if (!t) {
        user.value = null
        syncAuthCookie('')
        ready.value = true
        return
      }
      const fromJwt = snapFromToken(t)
      if (fromJwt) {
        user.value = fromJwt
        localStorage.setItem(USER_KEY, JSON.stringify(fromJwt))
        localStorage.setItem('manager_user_id', fromJwt.userId)
        syncAuthCookie(t)
      } else {
        token.value = ''
        user.value = null
        localStorage.removeItem(TOKEN_KEY)
        localStorage.removeItem(USER_KEY)
        syncAuthCookie('')
      }
    } catch {
      token.value = ''
      user.value = null
      syncAuthCookie('')
    }
    ready.value = true
  }

  async function login(username: string, password: string) {
    // Always same-origin proxy — ignores baked LAN IP that may drift
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: String(username || '').trim(), password: String(password || '') })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(String((data as any)?.detail || (data as any)?.message || `登录失败 HTTP ${res.status}`))
    }
    const access = String((data as any)?.access_token || '').trim()
    if (!access) throw new Error('登录响应缺少 access_token')
    const u =
      snapFromToken(access, username) ||
      ({
        userId: String((data as any)?.username || username).trim(),
        username: String((data as any)?.username || username).trim(),
        role: String((data as any)?.role || 'viewer'),
        tenantId: String((data as any)?.tenant_id || 'default')
      } satisfies ClawhiveUserSnap)
    token.value = access
    user.value = u
    localStorage.setItem(TOKEN_KEY, access)
    localStorage.setItem(USER_KEY, JSON.stringify(u))
    syncAuthCookie(access)
    try {
      const prev = String(localStorage.getItem('manager_user_id') || '').trim()
      if (prev.startsWith('uid_') && prev !== u.userId) {
        localStorage.setItem('manager_prev_anonymous_user_id', prev)
      }
    } catch {}
    localStorage.setItem('manager_user_id', u.userId)
    return u
  }

  function logout() {
    token.value = ''
    user.value = null
    syncAuthCookie('')
    try {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
      localStorage.removeItem('manager_user_id')
    } catch {}
  }

  function authHeaders(): Record<string, string> {
    const t = String(token.value || '').trim()
    return t ? { Authorization: `Bearer ${t}` } : {}
  }

  function withUserAuth<T extends Record<string, unknown>>(payload: T): T & { userToken?: string; userId?: string } {
    const t = String(token.value || '').trim()
    const uid = user.value?.userId
    return {
      ...payload,
      ...(t ? { userToken: t } : {}),
      ...(uid ? { userId: uid } : {})
    }
  }

  const isLoggedIn = computed(() => Boolean(token.value && user.value?.userId))

  return {
    token,
    user,
    ready,
    isLoggedIn,
    loadFromStorage,
    login,
    logout,
    authHeaders,
    withUserAuth,
    publicAuthBase
  }
}
