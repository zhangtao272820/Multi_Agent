/**
 * 多租户 scope：鉴权派生，贯穿记忆 / 历史 / 进化读写。
 * Key 规范：{service}:{tenant}:{type}:{id}
 */

export const GLOBAL_BASELINE_TENANT_ID = '_global_'

export type TenantScope = {
  tenantId: string
  userId?: string
  sessionId?: string
}

export class ScopeRequiredError extends Error {
  constructor(message = 'tenant scope required') {
    super(message)
    this.name = 'ScopeRequiredError'
  }
}

export function isTenantScopeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_TENANT_SCOPE ?? '1').trim() !== '0'
}

/** 生产默认 fail-closed：禁止静默用 default 做跨租户召回 */
export function isTenantFailClosed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isTenantScopeEnabled(env)) return false
  const v = String(env.MGR_TENANT_FAIL_CLOSED ?? '').trim()
  if (v === '0' || v.toLowerCase() === 'false') return false
  if (v === '1' || v.toLowerCase() === 'true') return true
  return String(env.NODE_ENV || '').trim() === 'production'
}

export function normalizeTenantId(raw: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(raw ?? '').trim()
  if (explicit) return explicit.slice(0, 64)
  const fromEnv = String(env.MGR_DEFAULT_TENANT_ID ?? env.TENANT_ID ?? 'default').trim()
  return (fromEnv || 'default').slice(0, 64)
}

/**
 * 解析租户 ID。fail-closed 开启且未显式传入时抛 ScopeRequiredError。
 * 开发环境可回落到 default / env。
 */
export function requireTenantId(raw: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(raw ?? '').trim()
  if (explicit) return explicit.slice(0, 64)
  if (isTenantFailClosed(env)) {
    throw new ScopeRequiredError('tenantId required (fail-closed)')
  }
  return normalizeTenantId(undefined, env)
}

export function resolveTenantScope(
  input: { tenantId?: unknown; userId?: unknown; sessionId?: unknown },
  env: NodeJS.ProcessEnv = process.env
): TenantScope {
  const tenantId = requireTenantId(input.tenantId, env)
  const userId = String(input.userId ?? '').trim() || undefined
  const sessionId = String(input.sessionId ?? '').trim() || undefined
  return { tenantId, userId, sessionId }
}

/** 文件侧命名空间：.data/tenants/{tenantId}/… */
export function tenantPolicyDir(baseDataDir: string, tenantId: string): string {
  const tid = String(tenantId || 'default').trim().slice(0, 64) || 'default'
  const safe = tid.replace(/[^a-zA-Z0-9._-]/g, '_')
  return `${baseDataDir.replace(/[/\\]+$/, '')}/tenants/${safe}`
}

/** Redis / 进程 cache key：{service}:{tenant}:{type}:{id} */
export function tenantCacheKey(service: string, tenantId: string, type: string, id: string): string {
  const tid = String(tenantId || 'default').trim().slice(0, 64) || 'default'
  return `${service}:${tid}:${type}:${id}`
}

export function isGlobalBaselineTenant(tenantId: string): boolean {
  return String(tenantId || '').trim() === GLOBAL_BASELINE_TENANT_ID
}
