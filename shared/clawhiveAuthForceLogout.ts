/**
 * 浏览器 401 → 是否强制清登录态。
 * 禁止「任意 401 就 logout」：暖机竞态 / 漏带头会误杀仍有效的 JWT。
 */

function extractDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const o = body as Record<string, unknown>
  return String(o.login_required ?? o.detail ?? o.statusMessage ?? o.reason ?? '').trim()
}

export function shouldForceLogoutOn401(opts: {
  status?: number
  statusMessage?: string
  body?: unknown
  /** 本地仍持有 token 时，login_required 多半是漏带头/竞态，勿清 */
  hasLocalToken?: boolean
}): boolean {
  if (opts.status !== 401) return false
  const msg = String(opts.statusMessage || '').toLowerCase()
  const detail = extractDetail(opts.body)
  const detailLower = detail.toLowerCase()

  if (msg.includes('invalid_user_token') || detailLower.includes('invalid_user_token')) {
    return true
  }

  const loginRequired =
    msg.includes('login_required') ||
    detail === 'true' ||
    detailLower.includes('login_required')

  if (loginRequired) {
    // 本地无 token：确认未登录；有 token：保留，等 boot validate / 重试
    return !opts.hasLocalToken
  }

  return false
}
