/**
 * Manager 数据目录：多租户时隔离到 .data/tenants/{tenantId}/
 */
import path from 'node:path'
import { isTenantScopeEnabled, normalizeTenantId, tenantPolicyDir } from '#agent-shared/tenantScope'

export function managerDataRoot(cwd = process.cwd()): string {
  return path.join(cwd, '.data')
}

/** 租户隔离的 policy/memory 目录；关闭 MGR_TENANT_SCOPE 时退回全局 .data */
export function resolveManagerPolicyDir(
  tenantId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): string {
  const base = managerDataRoot(cwd)
  if (!isTenantScopeEnabled(env)) return base
  return tenantPolicyDir(base, normalizeTenantId(tenantId, env))
}

/** 从 policyDir 反解 tenantId（…/tenants/{id}）；非租户路径回落 default */
export function tenantIdFromPolicyDir(
  policyDir: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const norm = String(policyDir || '').replace(/\\/g, '/')
  const m = norm.match(/\/tenants\/([^/]+)\/?/)
  if (m?.[1]) return normalizeTenantId(m[1], env)
  return normalizeTenantId(undefined, env)
}
