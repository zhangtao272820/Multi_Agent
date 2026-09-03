/**
 * P0-1：企业安全档 fail-closed 契约（纯函数；不改 LAN 默认）。
 * 运行：cd Manager_Agent && npm run smoke:security-profile
 */
import {
  getAgentServiceAuthConfigStatus,
  resolveAgentServiceAuthMode,
  verifyAgentServiceAuth
} from '#agent-shared/agentServiceAuth'
import { isEnterpriseSecurityProfile, resolveAgentSecurityProfile } from '#agent-shared/securityProfile'
import { isTenantFailClosed, requireTenantId, ScopeRequiredError } from '#agent-shared/tenantScope'
import { resolveManagerAuthMode } from '../../../server/utils/platform/managerEnvModes'
import { getManagerWsAuthConfigStatus, isManagerWsAuthEnabled } from '../../../server/graph/core/runtime/wsAuth'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-security-profile] ${msg}`)
}

console.log('smoke-security-profile: start')

assert(resolveAgentSecurityProfile({} as NodeJS.ProcessEnv) === 'lan', 'default lan')
assert(
  resolveAgentSecurityProfile({ AGENT_SECURITY_PROFILE: 'enterprise' } as NodeJS.ProcessEnv) === 'enterprise',
  'enterprise'
)
assert(
  resolveAgentSecurityProfile({ MANAGER_SECURITY_MODE: 'prod' } as NodeJS.ProcessEnv) === 'enterprise',
  'prod alias'
)
assert(isEnterpriseSecurityProfile({ AGENT_SECURITY_PROFILE: 'enterprise' } as NodeJS.ProcessEnv), 'is enterprise')

const ent = { AGENT_SECURITY_PROFILE: 'enterprise' } as NodeJS.ProcessEnv
assert(resolveAgentServiceAuthMode(ent) === 'require', 'enterprise → service auth require')
assert(getAgentServiceAuthConfigStatus(ent).ok === false, 'enterprise without token: config fail')
assert(verifyAgentServiceAuth({}, ent).ok === false, 'enterprise without token: verify fail')

const entTok = { ...ent, AGENT_SERVICE_TOKEN: 'ent-secret' } as NodeJS.ProcessEnv
assert(getAgentServiceAuthConfigStatus(entTok).ok, 'enterprise with token ok')
assert(verifyAgentServiceAuth({ 'x-agent-service-token': 'ent-secret' }, entTok).ok, 'enterprise verify ok')

assert(resolveManagerAuthMode(ent) === 'token', 'enterprise → auth token')
assert(isManagerWsAuthEnabled(ent), 'enterprise ws auth on')
assert(getManagerWsAuthConfigStatus(ent).ok === false, 'enterprise ws without token: not ok')
assert(
  getManagerWsAuthConfigStatus({ ...ent, MANAGER_WS_TOKEN: 'ws' } as NodeJS.ProcessEnv).ok,
  'enterprise ws with token ok'
)

assert(isTenantFailClosed(ent), 'enterprise tenant fail-closed')
let threw = false
try {
  requireTenantId(undefined, ent)
} catch (e) {
  threw = e instanceof ScopeRequiredError
}
assert(threw, 'enterprise requireTenantId throws')

assert(
  resolveAgentServiceAuthMode({ AGENT_SECURITY_PROFILE: 'enterprise', AGENT_SERVICE_AUTH: 'off' } as NodeJS.ProcessEnv) ===
    'off',
  'explicit AUTH=off wins'
)
assert(
  resolveManagerAuthMode({ AGENT_SECURITY_PROFILE: 'enterprise', MANAGER_AUTH_MODE: 'open' } as NodeJS.ProcessEnv) ===
    'open',
  'explicit AUTH_MODE=open wins'
)
assert(
  !isTenantFailClosed({ AGENT_SECURITY_PROFILE: 'enterprise', MGR_TENANT_FAIL_CLOSED: '0' } as NodeJS.ProcessEnv),
  'explicit FAIL_CLOSED=0 wins'
)

// LAN 默认不被 enterprise 逻辑误伤
assert(resolveAgentServiceAuthMode({} as NodeJS.ProcessEnv) === 'off', 'lan default service auth off')
assert(resolveManagerAuthMode({} as NodeJS.ProcessEnv) == null, 'lan default auth mode unset')

console.log('smoke-security-profile: OK')
