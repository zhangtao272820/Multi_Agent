/**
 * ClawHive JWT（HS256）本地验签 —— 与 Manage-platform auth.create_access_token 对齐。
 * claims：sub(=username=userId) / role / tenant_id / exp
 * 无 jose 依赖：Node crypto 验签。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export type ClawhiveJwtClaims = {
  sub: string
  role?: string
  tenant_id?: string
  exp?: number
  iat?: number
}

export type ClawhiveUser = {
  userId: string
  username: string
  role: string
  tenantId: string
}

function b64urlToBuf(input: string): Buffer {
  const s = String(input || '').replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s + pad, 'base64')
}

function b64urlJson(input: string): Record<string, unknown> {
  const raw = b64urlToBuf(input).toString('utf8')
  const o = JSON.parse(raw)
  return o && typeof o === 'object' ? (o as Record<string, unknown>) : {}
}

export function resolveJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.JWT_SECRET || env.CLAWHIVE_JWT_SECRET || '').trim()
}

export function isAgentBrowserAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.AGENT_BROWSER_AUTH ?? env.MANAGER_USER_AUTH ?? '').trim()
  if (v === '0' || v.toLowerCase() === 'false') return false
  if (v === '1' || v.toLowerCase() === 'true') return true
  // Docker / 配了 JWT_SECRET 时默认开
  return Boolean(resolveJwtSecret(env))
}

export function extractBearer(authorization?: string | null): string {
  const m = /^Bearer\s+(.+)$/i.exec(String(authorization || '').trim())
  return m ? String(m[1] || '').trim() : ''
}

export function verifyClawhiveJwt(
  token: string,
  env: NodeJS.ProcessEnv = process.env
): ClawhiveJwtClaims {
  const secret = resolveJwtSecret(env)
  if (!secret) throw new Error('JWT_SECRET_not_configured')
  const parts = String(token || '').trim().split('.')
  if (parts.length !== 3) throw new Error('jwt_malformed')
  const [h, p, s] = parts
  const data = `${h}.${p}`
  const expected = createHmac('sha256', secret).update(data).digest()
  let got: Buffer
  try {
    got = b64urlToBuf(s)
  } catch {
    throw new Error('jwt_sig_invalid')
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new Error('jwt_sig_invalid')
  }
  const header = b64urlJson(h)
  const alg = String(header.alg || '')
  if (alg && alg !== 'HS256') throw new Error('jwt_alg_unsupported')
  const payload = b64urlJson(p)
  const sub = String(payload.sub || '').trim()
  if (!sub) throw new Error('jwt_missing_sub')
  const exp = Number(payload.exp)
  if (Number.isFinite(exp) && exp > 0 && Date.now() / 1000 >= exp) {
    throw new Error('jwt_expired')
  }
  return {
    sub,
    role: payload.role != null ? String(payload.role) : undefined,
    tenant_id: payload.tenant_id != null ? String(payload.tenant_id) : undefined,
    exp: Number.isFinite(exp) ? exp : undefined,
    iat: Number.isFinite(Number(payload.iat)) ? Number(payload.iat) : undefined
  }
}

export function resolveBrowserUser(token: string, env: NodeJS.ProcessEnv = process.env): ClawhiveUser {
  const claims = verifyClawhiveJwt(token, env)
  return {
    userId: claims.sub,
    username: claims.sub,
    role: String(claims.role || 'viewer'),
    tenantId: String(claims.tenant_id || 'default')
  }
}

export function tryResolveBrowserUser(
  token: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env
): ClawhiveUser | null {
  const t = String(token || '').trim()
  if (!t) return null
  try {
    return resolveBrowserUser(t, env)
  } catch {
    return null
  }
}
