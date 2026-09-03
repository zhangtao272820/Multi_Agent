/**
 * 集群安全档位：LAN 开发友好 vs 企业生产 fail-closed。
 *
 * AGENT_SECURITY_PROFILE / MANAGER_SECURITY_MODE = lan | enterprise
 * 单项 env（AGENT_SERVICE_AUTH、MANAGER_AUTH_MODE、MGR_TENANT_FAIL_CLOSED）仍优先于档位。
 */

export type AgentSecurityProfile = 'lan' | 'enterprise'

export function resolveAgentSecurityProfile(env: NodeJS.ProcessEnv = process.env): AgentSecurityProfile {
  const raw = String(env.AGENT_SECURITY_PROFILE || env.MANAGER_SECURITY_MODE || '')
    .trim()
    .toLowerCase()
  if (
    raw === 'enterprise' ||
    raw === 'prod' ||
    raw === 'production' ||
    raw === 'strict' ||
    raw === 'fail_closed' ||
    raw === 'fail-closed'
  ) {
    return 'enterprise'
  }
  if (raw === 'lan' || raw === 'dev' || raw === 'local' || raw === 'open' || raw === 'lab') {
    return 'lan'
  }
  return 'lan'
}

export function isEnterpriseSecurityProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAgentSecurityProfile(env) === 'enterprise'
}
