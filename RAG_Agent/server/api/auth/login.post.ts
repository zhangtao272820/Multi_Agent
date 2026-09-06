/**
 * POST /api/auth/login — same-origin proxy to ClawHive backend（带暖机重试）。
 * 成功时写入同域 Cookie，供后续 $fetch 自动携带。
 */
import { CLAWHIVE_ACCESS_COOKIE } from '#agent-shared/nitroClawhiveAuth'
import { cookieMaxAgeFromJwt, proxyClawhiveLogin } from '#agent-shared/clawhiveLoginProxy'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}))
  const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const { status, body: data } = await proxyClawhiveLogin(
    String(payload.username || '').trim(),
    String(payload.password || '')
  )
  if (status >= 200 && status < 300) {
    const access = String(data.access_token || '').trim()
    if (access) {
      setCookie(event, CLAWHIVE_ACCESS_COOKIE, access, {
        httpOnly: false,
        path: '/',
        sameSite: 'lax',
        maxAge: cookieMaxAgeFromJwt(access)
      })
    }
  }
  setResponseStatus(event, status)
  return data
})
