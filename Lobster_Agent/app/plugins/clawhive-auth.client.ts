/**
 * 浏览器 JWT：Cookie 同步（主路径）+ $fetch/fetch 头注入（兜底）。
 */
export default defineNuxtPlugin({
  name: 'clawhive-auth',
  enforce: 'pre',
  setup() {
    if (!import.meta.client) return
    const { loadFromStorage, authHeaders, logout } = useClawhiveLogin()
    loadFromStorage()

    function shouldForceLogout(status?: number, statusMessage?: string, body?: unknown): boolean {
      if (status !== 401) return false
      const msg = String(statusMessage || '').toLowerCase()
      if (msg.includes('login_required') || msg.includes('invalid_user_token')) return true
      const detail =
        body && typeof body === 'object'
          ? String((body as any).login_required ?? (body as any).detail ?? (body as any).statusMessage ?? '')
          : ''
      return detail === 'true' || /login_required|invalid_user_token/i.test(detail) || true
    }

    function mergeAuthHeaders(existing?: HeadersInit): Record<string, string> {
      const h = authHeaders()
      const out: Record<string, string> = {}
      if (existing) {
        new Headers(existing).forEach((v, k) => {
          out[k] = v
        })
      }
      for (const [k, v] of Object.entries(h)) {
        if (!Object.keys(out).some((x) => x.toLowerCase() === k.toLowerCase())) out[k] = v
      }
      return out
    }

    // @ts-expect-error replace global $fetch
    globalThis.$fetch = $fetch.create({
      credentials: 'same-origin',
      onRequest({ options }) {
        const h = authHeaders()
        if (!Object.keys(h).length) return
        options.headers = mergeAuthHeaders(options.headers as HeadersInit | undefined)
      },
      onResponseError({ response }) {
        const statusMessage = String((response as any)?._data?.statusMessage || response.statusText || '')
        if (shouldForceLogout(response.status, statusMessage, (response as any)?._data)) logout()
      }
    })

    const _fetch = window.fetch.bind(window)
    window.fetch = async (input, init = {}) => {
      const h = authHeaders()
      let nextInit = { ...init, credentials: init.credentials ?? ('same-origin' as RequestCredentials) }
      if (Object.keys(h).length) nextInit = { ...nextInit, headers: mergeAuthHeaders(init.headers) }
      const res = await _fetch(input, nextInit)
      if (res.status === 401) {
        let body: unknown
        try {
          body = await res.clone().json()
        } catch {
          body = undefined
        }
        if (shouldForceLogout(401, res.statusText, body)) logout()
      }
      return res
    }
  }
})
