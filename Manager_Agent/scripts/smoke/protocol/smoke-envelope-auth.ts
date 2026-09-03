/**
 * E5.2：总管 → 专家服务身份。伪造 token 必须失败。
 */
import {
  AGENT_SERVICE_TOKEN_HEADER,
  CLAWHIVE_INTERNAL_TOKEN_HEADER,
  buildAgentServiceAuthHeaders,
  getAgentServiceAuthConfigStatus,
  mintHitlConfirmToken,
  resolveAgentServiceAuthMode,
  verifyAgentServiceAuth,
  verifyHitlConfirmToken
} from '#agent-shared/agentServiceAuth'
import { requireBrowserOrInternalAuth } from '#agent-shared/nitroClawhiveAuth'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const saved: Record<string, string | undefined> = {
  AGENT_SERVICE_AUTH: process.env.AGENT_SERVICE_AUTH,
  MANAGER_AGENT_SERVICE_AUTH: process.env.MANAGER_AGENT_SERVICE_AUTH,
  AGENT_SECURITY_PROFILE: process.env.AGENT_SECURITY_PROFILE,
  MANAGER_SECURITY_MODE: process.env.MANAGER_SECURITY_MODE,
  AGENT_SERVICE_TOKEN: process.env.AGENT_SERVICE_TOKEN,
  CLAWHIVE_INTERNAL_TOKEN: process.env.CLAWHIVE_INTERNAL_TOKEN,
  AGENT_INTERNAL_TOKEN: process.env.AGENT_INTERNAL_TOKEN,
  MANAGER_OPS_TOKEN: process.env.MANAGER_OPS_TOKEN,
  AGENT_BROWSER_AUTH: process.env.AGENT_BROWSER_AUTH,
  JWT_SECRET: process.env.JWT_SECRET
}

function restore() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

function clear() {
  delete process.env.AGENT_SERVICE_AUTH
  delete process.env.MANAGER_AGENT_SERVICE_AUTH
  delete process.env.AGENT_SECURITY_PROFILE
  delete process.env.MANAGER_SECURITY_MODE
  delete process.env.AGENT_SERVICE_TOKEN
  delete process.env.CLAWHIVE_INTERNAL_TOKEN
  delete process.env.AGENT_INTERNAL_TOKEN
  delete process.env.MANAGER_OPS_TOKEN
  delete process.env.AGENT_BROWSER_AUTH
  delete process.env.JWT_SECRET
}

try {
  clear()
  assert(resolveAgentServiceAuthMode() === 'off', 'default off')
  assert(verifyAgentServiceAuth({}).ok, 'off: no header ok')
  assert(Object.keys(buildAgentServiceAuthHeaders()).length === 0, 'off: no outbound headers')

  process.env.CLAWHIVE_INTERNAL_TOKEN = 'svc-secret'
  assert(resolveAgentServiceAuthMode() === 'optional', 'token present → optional')
  const hdrs = buildAgentServiceAuthHeaders()
  assert(hdrs[AGENT_SERVICE_TOKEN_HEADER] === 'svc-secret', 'outbound x-agent-service-token')
  assert(hdrs[CLAWHIVE_INTERNAL_TOKEN_HEADER] === 'svc-secret', 'outbound compat header')
  assert(!verifyAgentServiceAuth({}).ok, 'optional: missing header rejected')
  assert(!verifyAgentServiceAuth({ [AGENT_SERVICE_TOKEN_HEADER]: 'forged' }).ok, 'optional: forged rejected')
  assert(verifyAgentServiceAuth({ [AGENT_SERVICE_TOKEN_HEADER]: 'svc-secret' }).ok, 'optional: service token ok')
  assert(
    verifyAgentServiceAuth({ [CLAWHIVE_INTERNAL_TOKEN_HEADER]: 'svc-secret' }).ok,
    'optional: compat header ok'
  )

  clear()
  process.env.AGENT_SERVICE_AUTH = 'require'
  assert(getAgentServiceAuthConfigStatus().ok === false, 'require without token: config fail')
  assert(verifyAgentServiceAuth({}).ok === false, 'require without token: verify fail')

  process.env.AGENT_SERVICE_TOKEN = 'req-secret'
  assert(getAgentServiceAuthConfigStatus().ok, 'require with token: config ok')
  assert(!verifyAgentServiceAuth({ [AGENT_SERVICE_TOKEN_HEADER]: 'nope' }).ok, 'require: wrong token')
  assert(verifyAgentServiceAuth({ [AGENT_SERVICE_TOKEN_HEADER]: 'req-secret' }).ok, 'require: correct token')

  const minted = mintHitlConfirmToken('run-1', 'confirm-1')
  assert(minted.length > 0, 'mint confirm token')
  assert(verifyHitlConfirmToken(minted, 'run-1', 'confirm-1'), 'verify confirm token')
  assert(!verifyHitlConfirmToken(minted, 'run-1', 'other'), 'wrong confirmId rejected')

  const event = (headers: Record<string, string>) => ({
    node: { req: { headers } }
  })
  const okInternal = requireBrowserOrInternalAuth(event({ [AGENT_SERVICE_TOKEN_HEADER]: 'req-secret' }))
  assert(okInternal.mode === 'internal', 'nitro: valid service token → internal')

  let forgedStatus = 0
  try {
    requireBrowserOrInternalAuth(event({ [AGENT_SERVICE_TOKEN_HEADER]: 'forged' }))
  } catch (e) {
    forgedStatus = Number((e as { statusCode?: number }).statusCode || 0)
  }
  assert(forgedStatus === 401, 'nitro: forged service token → 401')

  // 企业档 require + 浏览器鉴权：无服务 token 时走 JWT，不得 agent_service_token_missing
  clear()
  process.env.AGENT_SECURITY_PROFILE = 'enterprise'
  process.env.AGENT_SERVICE_AUTH = 'require'
  process.env.AGENT_SERVICE_TOKEN = 'req-secret'
  process.env.AGENT_BROWSER_AUTH = '1'
  process.env.JWT_SECRET = 'jwt-test-secret'
  let loginRequired = ''
  try {
    requireBrowserOrInternalAuth(event({}))
  } catch (e) {
    loginRequired = String((e as { statusMessage?: string }).statusMessage || (e as Error).message || '')
  }
  assert(loginRequired === 'login_required', `enterprise browser without JWT → login_required, got ${loginRequired}`)

  console.log('smoke-envelope-auth: OK')
} finally {
  restore()
}
