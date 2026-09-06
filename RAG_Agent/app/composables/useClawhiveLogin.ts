/**
 * ClawHive 本地登录（浏览器不验签；服务端 /api/auth/validate 验 JWT）
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

  function clearLocalSession() {
    token.value = ''
    user.value = null
    syncAuthCookie('')
    try {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
    } catch {
      /* ignore */
    }
  }

  async function validateWithServer(access: string): Promise<'ok' | 'invalid' | 'error'> {
    try {
      const res = await fetch('/api/auth/validate', {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${access}` },
        credentials: 'same-origin'
      })
      if (!res.ok && res.status >= 500) return 'error'
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (data.ok === true) return 'ok'
      const reason = String(data.reason || '')
      if (reason === 'invalid_user_token' || reason === 'login_required') return 'invalid'
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
    for (let i = 0; i < 5; i++) {
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
      if (i + 1 < 5) await new Promise((r) => setTimeout(r, Math.min(2500, 400 * Math.pow(1.5, i))))
    }
    ready.value = true
  }

  function loadFromStorage() {
    if (!import.meta.client) {
      ready.value = true
      return
    }
    ready.value = false
    const t = String(localStorage.getItem(TOKEN_KEY) || '').trim()
    token.value = t
    const u = t ? decodePayload(t) : null
    user.value = u
    if (u) {
      localStorage.setItem(USER_KEY, JSON.stringify(u))
      syncAuthCookie(t)
      void bootValidate()
    } else {
      if (t) clearLocalSession()
      else syncAuthCookie('')
      ready.value = true
    }
  }

  async function login(username: string, password: string) {
    const maxWarming = 1
    let lastDetail = `HTTP error`
    for (let i = 0; i <= maxWarming; i++) {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: username.trim(), password })
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
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
        ready.value = true
        return u
      }
      lastDetail = String((data as any).detail || `HTTP ${res.status}`)
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
    return token.value ? { Authorization: `Bearer ${token.value}` } : {}
  }

  const isLoggedIn = computed(() => Boolean(token.value && user.value?.userId))

  return { token, user, ready, isLoggedIn, loadFromStorage, login, logout, authHeaders }
}
