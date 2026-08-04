/**
 * Nitro: proxy browser login to ClawHive backend (container DNS).
 */
export function clawhiveBackendBase(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.CLAWHIVE_BACKEND_URL || env.CLAWHIVE_INTERNAL_URL || 'http://clawhive_backend:8000')
    .trim()
    .replace(/\/+$/, '')
}

export async function proxyClawhiveLogin(
  username: string,
  password: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `${clawhiveBackendBase(env)}/api/auth/login`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: String(username || '').trim(), password: String(password || '') })
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { status: res.status, body: data && typeof data === 'object' ? data : { detail: 'invalid_response' } }
  } catch (exc: any) {
    return { status: 502, body: { detail: `clawhive_login_unreachable:${exc?.message || exc}` } }
  }
}
