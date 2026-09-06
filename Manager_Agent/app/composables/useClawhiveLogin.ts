/**
 * ClawHive 用户登录态（localStorage JWT）；userId = JWT.sub
 * 注意：浏览器不验签（无 JWT_SECRET）；验签在服务端 /api/auth/validate。
 *
 * 同域 Cookie 与 localStorage 同步：Nuxt 自动导入的 $fetch 往往不走
 * globalThis.$fetch 拦截器，但浏览器会自动带 Cookie，避免 HTTP 401 login_required。
 */

import { shouldForceLogoutOn401 } from '#agent-shared/clawhiveAuthForceLogout'

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

  function clearLocalSession() {
    token.value = ''
    user.value = null
    syncAuthCookie('')
    try {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
      localStorage.removeItem('manager_user_id')
    } catch {
      /* ignore */
    }
  }

  async function validateWithServer(access: string): Promise<'ok' | 'invalid' | 'error'> {
    try {
      const res = await fetch('/api/auth/validate', {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${access}`
        },
        credentials: 'same-origin'
      })
      if (!res.ok && res.status >= 500) return 'error'
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (data.ok === true) return 'ok'
      const reason = String(data.reason || '')
      if (reason === 'invalid_user_token') return 'invalid'
      if (reason === 'login_required') return 'invalid'
      if (reason === 'auth_open') return 'ok'
      return res.ok ? 'ok' : 'error'
    } catch {
      return 'error'
    }
  }

  async function bootValidate() {
    const access = String(token.value || '').trim()
    if (!access) {
      ready.value = true
      return
    }
    const attempts = 5
    for (let i = 0; i < attempts; i++) {
      const v = await validateWithServer(access)
      if (v === 'ok') {
        ready.value = true
        return
      }
      if (v === 'invalid') {
        clearLocalSession()
        ready.value = true
        return
      }
      // error：保留 token，退避再验（Docker 暖机）
      if (i + 1 < attempts) {
        await new Promise((r) => setTimeout(r, Math.min(2500, 400 * Math.pow(1.5, i))))
      }
    }
    // 暖机仍失败：保留 token，允许 UI 继续（后续 API / visibility 再验）
    ready.value = true
  }

  function loadFromStorage() {
    if (!import.meta.client) {
      ready.value = true
      return
    }
    ready.value = false
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
        void bootValidate()
      } else {
        clearLocalSession()
        ready.value = true
      }
    } catch {
      clearLocalSession()
      ready.value = true
    }
  }

  async function login(username: string, password: string) {
    const maxWarming = 1
    let lastDetail = '登录失败'
    for (let i = 0; i <= maxWarming; i++) {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: String(username || '').trim(), password: String(password || '') })
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
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
        } catch {
          /* ignore */
        }
        localStorage.setItem('manager_user_id', u.userId)
        ready.value = true
        return u
      }
      lastDetail = String((data as any)?.detail || (data as any)?.message || `登录失败 HTTP ${res.status}`)
      const warming =
        /clawhive_login_warming|clawhive_login_unreachable/i.test(lastDetail) || res.status === 502
      if (!warming || i >= maxWarming) break
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
    if (/clawhive_login_warming/i.test(lastDetail)) {
      throw new Error('身份服务启动中，请稍后重试登录（无需打开控制端）')
    }
    throw new Error(lastDetail)
  }

  function logout() {
    clearLocalSession()
    ready.value = true
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
    publicAuthBase,
    shouldForceLogoutOn401
  }
}
