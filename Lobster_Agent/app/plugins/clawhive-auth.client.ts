/**
 * 浏览器 JWT：Cookie 同步（主路径）+ $fetch/fetch 头注入（兜底）。
 * 仅 invalid_user_token（或无本地 token 的 login_required）时清登录态。
 */
import { shouldForceLogoutOn401 } from '#agent-shared/clawhiveAuthForceLogout'

export default defineNuxtPlugin({
  name: 'clawhive-auth',
  enforce: 'pre',
  setup() {
    if (!import.meta.client) return
    const { loadFromStorage, authHeaders, logout, token } = useClawhiveLogin()
    loadFromStorage()

    function shouldForceLogout(status?: number, statusMessage?: string, body?: unknown): boolean {
      return shouldForceLogoutOn401({
        status,
        statusMessage,
        body,
        hasLocalToken: Boolean(String(token.value || '').trim())
      })
    }

    function mergeAuthHeaders(existing?: HeadersInit): Record<string, string> {
      const h = authHeaders()
      const out: Record<string, string> = {}
      if (existing) {
        const src = new Headers(existing)
        src.forEach((v, k) => {
          out[k] = v
        })
      }
      for (const [k, v] of Object.entries(h)) {
        if (!Object.keys(out).some((x) => x.toLowerCase() === k.toLowerCase())) {
          out[k] = v
        }
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
        if (shouldForceLogout(response.status, statusMessage, (response as any)?._data)) {
          logout()
        }
      }
    })

    const _fetch = window.fetch.bind(window)
    window.fetch = async (input, init = {}) => {
      const h = authHeaders()
      let nextInit = { ...init, credentials: init.credentials ?? ('same-origin' as RequestCredentials) }
      if (Object.keys(h).length) {
        nextInit = { ...nextInit, headers: mergeAuthHeaders(init.headers) }
      }
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
