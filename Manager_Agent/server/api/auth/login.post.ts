/**
 * POST /api/auth/login — same-origin proxy to ClawHive backend.
 * 成功时写入同域 Cookie，供后续 $fetch 自动携带（不依赖客户端 Authorization 拦截器）。
 */
import { CLAWHIVE_ACCESS_COOKIE } from '#agent-shared/nitroClawhiveAuth'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}))
  const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const base = String(
    process.env.CLAWHIVE_BACKEND_URL || process.env.CLAWHIVE_INTERNAL_URL || 'http://clawhive_backend:8000'
  )
    .trim()
    .replace(/\/+$/, '')
  let status = 502
  let data: Record<string, unknown> = { detail: 'clawhive_login_unreachable' }
  try {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        username: String(payload.username || '').trim(),
        password: String(payload.password || '')
      })
    })
    status = res.status
    data = ((await res.json().catch(() => ({}))) as Record<string, unknown>) || { detail: 'invalid_response' }
  } catch (exc: any) {
    data = { detail: `clawhive_login_unreachable:${exc?.message || exc}` }
  }
  if (status >= 200 && status < 300) {
    const access = String(data.access_token || '').trim()
    if (access) {
      let maxAge = 60 * 60 * 24 * 7
      try {
        const payloadPart = access.split('.')[1]
        if (payloadPart) {
          const json = Buffer.from(payloadPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
          const exp = Number(JSON.parse(json)?.exp)
          if (Number.isFinite(exp) && exp > 0) {
            maxAge = Math.max(60, Math.floor(exp - Date.now() / 1000))
          }
        }
      } catch {
        /* keep default maxAge */
      }
      setCookie(event, CLAWHIVE_ACCESS_COOKIE, access, {
        httpOnly: false,
        path: '/',
        sameSite: 'lax',
        maxAge
      })
    }
  }
  setResponseStatus(event, status)
  return data
})
