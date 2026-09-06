/**
 * Nitro: proxy browser login to ClawHive backend (container DNS).
 * Docker 暖机时 backend 可能短暂不可达 → 有限退避重试，失败返回 clawhive_login_warming。
 */

export function clawhiveBackendBase(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.CLAWHIVE_BACKEND_URL || env.CLAWHIVE_INTERNAL_URL || 'http://clawhive_backend:8000')
    .trim()
    .replace(/\/+$/, '')
}

export type ProxyClawhiveLoginOptions = {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  fetchImpl?: typeof fetch
}

export function cookieMaxAgeFromJwt(access: string, fallback = 60 * 60 * 24 * 7): number {
  try {
    const payloadPart = String(access || '').split('.')[1]
    if (!payloadPart) return fallback
    const json = Buffer.from(payloadPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const exp = Number(JSON.parse(json)?.exp)
    if (Number.isFinite(exp) && exp > 0) {
      return Math.max(60, Math.floor(exp - Date.now() / 1000))
    }
  } catch {
    /* keep fallback */
  }
  return fallback
}

function isRetryableLoginFailure(status: number, detail: string): boolean {
  if (status === 502 || status === 503 || status === 504) return true
  if (/unreachable|econnrefused|enotfound|etimedout|fetch failed|network/i.test(detail)) return true
  return false
}

export async function proxyClawhiveLogin(
  username: string,
  password: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: ProxyClawhiveLoginOptions = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `${clawhiveBackendBase(env)}/api/auth/login`
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 5))
  const base = Math.max(50, Math.floor(opts.baseDelayMs ?? 400))
  const maxDelay = Math.max(base, Math.floor(opts.maxDelayMs ?? 8000))
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const fetchImpl = opts.fetchImpl ?? fetch

  let last: { status: number; body: Record<string, unknown> } = {
    status: 502,
    body: { detail: 'clawhive_login_warming' }
  }

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          username: String(username || '').trim(),
          password: String(password || '')
        })
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      const body = data && typeof data === 'object' ? data : { detail: 'invalid_response' }
      last = { status: res.status, body }
      if (res.status >= 200 && res.status < 300) return last
      // 业务拒绝（401 密码错等）不重试
      if (!isRetryableLoginFailure(res.status, String(body.detail || ''))) return last
    } catch (exc: any) {
      last = {
        status: 502,
        body: { detail: `clawhive_login_unreachable:${exc?.message || exc}` }
      }
    }
    if (i + 1 >= attempts) break
    const delay = Math.min(maxDelay, Math.round(base * Math.pow(1.5, i)))
    await sleep(delay)
  }

  const detail = String(last.body.detail || '')
  if (isRetryableLoginFailure(last.status, detail) || /unreachable/i.test(detail)) {
    return { status: 502, body: { detail: 'clawhive_login_warming', cause: detail || undefined } }
  }
  return last
}
